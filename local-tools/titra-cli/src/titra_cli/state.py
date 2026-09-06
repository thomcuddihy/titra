"""Private, atomic local state for timers, pending writes, and deletion receipts."""

from __future__ import annotations

import errno
import hashlib
import json
import os
import stat
import time
import uuid
from collections.abc import Callable, Iterable, Iterator
from contextlib import contextmanager, suppress
from pathlib import Path
from typing import Any, TypeVar

from platformdirs import user_state_path

from .errors import ConfigurationError, ConflictError, NotFoundError
from .models import ActiveTimer, PendingTimerStart, RecordDraft, ResolvedConfig, utc_now_iso
from .output import contains_secret

_T = TypeVar("_T")


def default_state_root() -> Path:
    return user_state_path("titra-cli", "titra")


class StateStore:
    def __init__(self, root: Path | None = None, *, secrets: Iterable[str] = ()) -> None:
        self.root = (root or default_state_root()).expanduser().absolute()
        self._secrets = {secret for secret in secrets if secret}

    def add_secret(self, secret: str | None) -> None:
        if secret:
            self._secrets.add(secret)

    @staticmethod
    def _validate_private_stat(
        value: os.stat_result,
        path: Path,
        *,
        directory: bool,
    ) -> None:
        kind_ok = stat.S_ISDIR(value.st_mode) if directory else stat.S_ISREG(value.st_mode)
        if not kind_ok:
            label = "directory" if directory else "file"
            raise ConfigurationError(f"Local-state {label} is not a regular {label}: {path}")
        if os.name == "posix":
            if value.st_uid != os.geteuid():
                raise ConfigurationError(
                    f"Local-state path is not owned by the current user: {path}"
                )
            if value.st_mode & 0o077:
                raise ConfigurationError(
                    f"Local-state path must not grant group/other permissions: {path}"
                )

    @staticmethod
    def _reject_symlink_ancestry(path: Path) -> None:
        current = path
        while True:
            try:
                value = current.lstat()
            except FileNotFoundError:
                pass
            else:
                if stat.S_ISLNK(value.st_mode):
                    raise ConfigurationError(
                        f"Refusing symlinked local-state path component: {current}"
                    )
            if current == current.parent:
                return
            current = current.parent

    def _ensure_root(self) -> None:
        self._reject_symlink_ancestry(self.root)
        try:
            value = self.root.lstat()
        except FileNotFoundError:
            missing: list[Path] = []
            current = self.root
            while True:
                try:
                    current.lstat()
                    break
                except FileNotFoundError:
                    missing.append(current)
                    if current == current.parent:
                        raise ConfigurationError(
                            f"Cannot locate an existing parent for local state: {self.root}"
                        ) from None
                    current = current.parent
            for directory in reversed(missing):
                directory.mkdir(mode=0o700, exist_ok=False)
                if os.name == "posix":
                    flags = os.O_RDONLY | os.O_DIRECTORY | getattr(os, "O_NOFOLLOW", 0)
                    descriptor = os.open(directory.parent, flags)
                    try:
                        os.fsync(descriptor)
                    finally:
                        os.close(descriptor)
            value = self.root.lstat()
        if stat.S_ISLNK(value.st_mode):
            raise ConfigurationError(f"Refusing symlinked local-state root: {self.root}")
        self._validate_private_stat(value, self.root, directory=True)

    @contextmanager
    def _private_directory(self, path: Path, *, create: bool) -> Iterator[int | None]:
        """Open a private descendant directory without following replaceable symlinks."""

        try:
            relative = path.relative_to(self.root)
        except ValueError as exc:
            raise ConfigurationError(
                f"Local-state path escapes its configured root: {path}"
            ) from exc
        self._ensure_root()
        if os.name != "posix":
            current = self.root
            for part in relative.parts:
                current = current / part
                try:
                    value = current.lstat()
                except FileNotFoundError:
                    if not create:
                        raise
                    current.mkdir(mode=0o700)
                    value = current.lstat()
                if stat.S_ISLNK(value.st_mode):
                    raise ConfigurationError(f"Refusing symlinked local-state directory: {current}")
                self._validate_private_stat(value, current, directory=True)
            yield None
            return

        flags = os.O_RDONLY | os.O_DIRECTORY | getattr(os, "O_NOFOLLOW", 0)
        try:
            descriptor = os.open(self.root, flags)
        except OSError as exc:
            raise ConfigurationError(
                f"Cannot securely open local-state root {self.root}: {exc}"
            ) from exc
        try:
            self._validate_private_stat(os.fstat(descriptor), self.root, directory=True)
            current_path = self.root
            for part in relative.parts:
                current_path = current_path / part
                try:
                    child = os.open(part, flags, dir_fd=descriptor)
                except FileNotFoundError:
                    if not create:
                        raise
                    os.mkdir(part, 0o700, dir_fd=descriptor)
                    os.fsync(descriptor)
                    child = os.open(part, flags, dir_fd=descriptor)
                except OSError as exc:
                    raise ConfigurationError(
                        f"Cannot securely open local-state directory {current_path}: {exc}"
                    ) from exc
                try:
                    self._validate_private_stat(os.fstat(child), current_path, directory=True)
                except BaseException:
                    os.close(child)
                    raise
                os.close(descriptor)
                descriptor = child
            yield descriptor
        finally:
            os.close(descriptor)

    @staticmethod
    def _scope(config: ResolvedConfig) -> str:
        safe_profile = "".join(
            character if character.isalnum() or character in "-_" else "_"
            for character in config.profile
        )[:32]
        canonical_scope = f"{config.profile}\0{config.server.rstrip('/')}".encode()
        digest = hashlib.sha256(canonical_scope).hexdigest()[:20]
        return f"{safe_profile or 'default'}-{digest}"

    @staticmethod
    def _legacy_scope(config: ResolvedConfig) -> str:
        """Return the pre-v0.2 ambiguous scope only for safe legacy-state detection."""

        safe_profile = "".join(
            character if character.isalnum() or character in "-_" else "_"
            for character in config.profile
        )[:40]
        digest = hashlib.sha256(config.server.encode("utf-8")).hexdigest()[:12]
        return f"{safe_profile or 'default'}-{digest}"

    def _active_path(self, config: ResolvedConfig) -> Path:
        return self.root / f"active-{self._scope(config)}.json"

    def _pending_start_path(self, config: ResolvedConfig) -> Path:
        return self.root / f"pending-start-{self._scope(config)}.json"

    def _legacy_scoped_path(self, config: ResolvedConfig, prefix: str) -> Path:
        return self.root / f"{prefix}-{self._legacy_scope(config)}.json"

    def _read_scoped_model(
        self,
        current_path: Path,
        legacy_path: Path,
        parser: Callable[[dict[str, Any]], _T],
        *,
        label: str,
        allow_legacy_unbound: bool,
    ) -> _T:
        try:
            return self._read_model(current_path, parser)
        except NotFoundError as current_missing:
            if legacy_path == current_path:
                raise
            try:
                # Read through the same no-follow/private-file checks. The content is
                # deliberately not adopted because a truncated legacy profile prefix can
                # refer to more than one modern scope.
                self._read_json(legacy_path)
            except NotFoundError:
                raise current_missing from None
            if allow_legacy_unbound:
                raise current_missing from None
            raise ConflictError(
                f"Legacy {label} state uses an ambiguous pre-v0.2 profile scope and was left "
                "untouched. Inspect the server timer, then use an exact guarded timer adopt; "
                f"retain the legacy file for manual recovery: {legacy_path}"
            ) from None

    @contextmanager
    def _lock(self, name: str, *, timeout: float = 5.0) -> Iterator[None]:
        self._ensure_root()
        lock_path = self.root / f".{name}.lock"
        deadline = time.monotonic() + timeout
        while True:
            try:
                descriptor = os.open(lock_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                os.close(descriptor)
                break
            except FileExistsError:
                try:
                    lock_stat = lock_path.lstat()
                    if stat.S_ISLNK(lock_stat.st_mode):
                        raise ConfigurationError(
                            f"Refusing symlinked local-state lock: {lock_path}"
                        )
                    self._validate_private_stat(lock_stat, lock_path, directory=False)
                    age = time.time() - lock_stat.st_mtime
                    if age > 60:
                        lock_path.unlink()
                        continue
                except FileNotFoundError:
                    continue
                if time.monotonic() >= deadline:
                    raise ConflictError(f"Local state is busy: {lock_path}") from None
                time.sleep(0.05)
        try:
            yield
        finally:
            with suppress(FileNotFoundError):
                lock_path.unlink()

    def _write_json(self, path: Path, value: dict[str, Any]) -> None:
        if any(contains_secret(value, secret) for secret in self._secrets):
            raise ConfigurationError(
                "Refusing to persist local state containing a configured credential."
            )
        temporary_name = f".{path.name}.tmp-{os.getpid()}-{uuid.uuid4().hex}"
        data = json.dumps(value, indent=2, sort_keys=True, ensure_ascii=False).encode("utf-8")
        with self._private_directory(path.parent, create=True) as parent_descriptor:
            try:
                existing_descriptor = os.open(
                    path if parent_descriptor is None else path.name,
                    os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0),
                    **({"dir_fd": parent_descriptor} if parent_descriptor is not None else {}),
                )
            except FileNotFoundError:
                pass
            except OSError as exc:
                raise ConfigurationError(
                    f"Cannot securely inspect existing local-state file {path}: {exc}"
                ) from exc
            else:
                try:
                    self._validate_private_stat(
                        os.fstat(existing_descriptor), path, directory=False
                    )
                finally:
                    os.close(existing_descriptor)
            if parent_descriptor is None:
                temporary = path.with_name(temporary_name)
                descriptor = os.open(
                    temporary,
                    os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0),
                    0o600,
                )
            else:
                descriptor = os.open(
                    temporary_name,
                    os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0),
                    0o600,
                    dir_fd=parent_descriptor,
                )
            try:
                with os.fdopen(descriptor, "wb") as handle:
                    handle.write(data)
                    handle.write(b"\n")
                    handle.flush()
                    os.fsync(handle.fileno())
                if parent_descriptor is None:
                    os.replace(temporary, path)
                else:
                    os.replace(
                        temporary_name,
                        path.name,
                        src_dir_fd=parent_descriptor,
                        dst_dir_fd=parent_descriptor,
                    )
                    os.fsync(parent_descriptor)
            except BaseException:
                try:
                    if parent_descriptor is None:
                        temporary.unlink(missing_ok=True)
                    else:
                        os.unlink(temporary_name, dir_fd=parent_descriptor)
                except FileNotFoundError:
                    pass
                raise

    def _read_json(self, path: Path) -> dict[str, Any]:
        try:
            with self._private_directory(path.parent, create=False) as parent_descriptor:
                flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
                descriptor = os.open(
                    path if parent_descriptor is None else path.name,
                    flags,
                    **({"dir_fd": parent_descriptor} if parent_descriptor is not None else {}),
                )
                try:
                    self._validate_private_stat(os.fstat(descriptor), path, directory=False)
                    with os.fdopen(descriptor, "r", encoding="utf-8") as handle:
                        descriptor = -1
                        value = json.load(handle)
                finally:
                    if descriptor >= 0:
                        os.close(descriptor)
        except FileNotFoundError:
            raise NotFoundError(f"Local state does not exist: {path}") from None
        except (OSError, json.JSONDecodeError) as exc:
            raise ConfigurationError(f"Cannot read local state {path}: {exc}") from exc
        if not isinstance(value, dict):
            raise ConfigurationError(f"Local state must contain a JSON object: {path}")
        return value

    def _read_model(
        self,
        path: Path,
        parser: Callable[[dict[str, Any]], _T],
    ) -> _T:
        try:
            return parser(self._read_json(path))
        except NotFoundError:
            raise
        except (KeyError, TypeError, ValueError) as exc:
            raise ConfigurationError(f"Invalid local state in {path}: {exc}") from exc

    def save_active_timer(self, config: ResolvedConfig, timer: ActiveTimer) -> None:
        self.add_secret(config.api_key)
        path = self._active_path(config)
        with self._lock(f"active-{self._scope(config)}"):
            self._write_json(path, timer.to_dict())

    def load_active_timer(
        self,
        config: ResolvedConfig,
        *,
        allow_legacy_unbound: bool = False,
    ) -> ActiveTimer:
        timer = self._read_scoped_model(
            self._active_path(config),
            self._legacy_scoped_path(config, "active"),
            ActiveTimer.from_dict,
            label="active-timer",
            allow_legacy_unbound=allow_legacy_unbound,
        )
        if timer.profile != config.profile or timer.server.rstrip("/") != config.server.rstrip("/"):
            raise ConflictError("Local timer belongs to a different Titra profile or server.")
        return timer

    def clear_active_timer(self, config: ResolvedConfig) -> None:
        path = self._active_path(config)
        with self._lock(f"active-{self._scope(config)}"):
            self._unlink_file(path, missing_ok=True)

    def _fsync_directory(self, path: Path) -> None:
        if os.name != "posix":
            return
        with self._private_directory(path, create=False) as descriptor:
            assert descriptor is not None
            os.fsync(descriptor)

    def _unlink_file(self, path: Path, *, missing_ok: bool) -> None:
        try:
            with self._private_directory(path.parent, create=False) as parent_descriptor:
                if parent_descriptor is None:
                    path.unlink(missing_ok=missing_ok)
                else:
                    os.unlink(path.name, dir_fd=parent_descriptor)
                    os.fsync(parent_descriptor)
        except (FileNotFoundError, NotFoundError):
            if not missing_ok:
                raise

    def _list_json_paths(self, directory: Path) -> list[Path]:
        try:
            with self._private_directory(directory, create=False) as descriptor:
                names = os.listdir(directory if descriptor is None else descriptor)
        except FileNotFoundError:
            return []
        return [directory / name for name in sorted(names) if name.endswith(".json")]

    def reserve_pending_timer_start(
        self,
        config: ResolvedConfig,
        pending: PendingTimerStart,
    ) -> bool:
        """Create a durable start intent without overwriting another process's intent."""

        self.add_secret(config.api_key)
        if pending.profile != config.profile or pending.server.rstrip("/") != config.server.rstrip(
            "/"
        ):
            raise ConflictError("Pending timer start belongs to a different profile or server.")
        path = self._pending_start_path(config)
        with self._lock(f"pending-start-{self._scope(config)}"):
            try:
                existing = self._read_model(path, PendingTimerStart.from_dict)
            except NotFoundError:
                self._write_json(path, pending.to_dict())
                # The file has already been fsynced. Persist the rename before POST so a
                # machine/process restart cannot orphan a successful late server commit.
                self._fsync_directory(path.parent)
                return True
            if existing.profile != config.profile or existing.server.rstrip(
                "/"
            ) != config.server.rstrip("/"):
                raise ConflictError("Pending timer start belongs to a different profile or server.")
            if existing != pending:
                raise ConflictError(
                    "A different timer start is already pending recovery; local state was not "
                    "replaced."
                )
            return False

    def load_pending_timer_start(
        self,
        config: ResolvedConfig,
        *,
        allow_legacy_unbound: bool = False,
    ) -> PendingTimerStart:
        pending = self._read_scoped_model(
            self._pending_start_path(config),
            self._legacy_scoped_path(config, "pending-start"),
            PendingTimerStart.from_dict,
            label="pending timer-start",
            allow_legacy_unbound=allow_legacy_unbound,
        )
        if pending.profile != config.profile or pending.server.rstrip("/") != config.server.rstrip(
            "/"
        ):
            raise ConflictError("Pending timer start belongs to a different profile or server.")
        return pending

    def clear_pending_timer_start(
        self,
        config: ResolvedConfig,
        *,
        expected_operation_id: str,
    ) -> None:
        path = self._pending_start_path(config)
        with self._lock(f"pending-start-{self._scope(config)}"):
            try:
                pending = self._read_model(path, PendingTimerStart.from_dict)
            except NotFoundError:
                return
            if pending.operation_id != expected_operation_id:
                raise ConflictError(
                    "Pending timer start changed while it was being finalized; it was retained."
                )
            self._unlink_file(path, missing_ok=False)

    def create_draft(
        self,
        config: ResolvedConfig,
        payloads: list[dict[str, Any]],
        *,
        owner_id: str,
        timer: dict[str, Any] | None = None,
        note: str | None = None,
    ) -> RecordDraft:
        self.add_secret(config.api_key)
        if not owner_id:
            raise ConfigurationError("Draft owner ID must not be empty.")
        draft = RecordDraft(
            version=2,
            draft_id=uuid.uuid4().hex,
            profile=config.profile,
            server=config.server,
            created_at=utc_now_iso(),
            status="pending",
            payloads=payloads,
            owner_id=owner_id,
            timer=timer,
            note=note,
            idempotency_keys=[uuid.uuid4().hex for _payload in payloads],
        )
        self.save_draft(draft)
        return draft

    def _draft_path(self, draft_id: str) -> Path:
        if not draft_id or any(
            character not in "0123456789abcdef" for character in draft_id.lower()
        ):
            raise ConfigurationError("Draft ID must be hexadecimal.")
        return self.root / "drafts" / f"{draft_id}.json"

    @contextmanager
    def draft_operation_lock(self, draft_id: str) -> Iterator[None]:
        """Hold a process-lifetime OS lock across one complete draft operation.

        Unlike the short atomic-write lock, this lock has no age-based eviction: a slow API
        request cannot lose exclusivity. The operating system releases it after process death.
        """

        self._draft_path(draft_id)  # Validate before using the ID in a lock-file name.
        with self._operation_lock(
            lock_name=f"draft-operation-{draft_id}",
            label=f"Draft {draft_id}",
        ):
            yield

    @contextmanager
    def _operation_lock(self, *, lock_name: str, label: str) -> Iterator[None]:
        """Take a non-expiring OS lock whose lifetime is the open descriptor."""

        self._ensure_root()
        lock_path = self.root / f".{lock_name}.lock"
        flags = os.O_RDWR | os.O_CREAT
        nofollow = getattr(os, "O_NOFOLLOW", 0)
        descriptor = os.open(lock_path, flags | nofollow, 0o600)
        locked = False
        try:
            self._validate_private_stat(os.fstat(descriptor), lock_path, directory=False)
            if os.name == "nt":
                windows_locks = __import__("msvcrt")
                if os.fstat(descriptor).st_size == 0:
                    os.write(descriptor, b"\0")
                    os.fsync(descriptor)
                os.lseek(descriptor, 0, os.SEEK_SET)
                windows_locks.locking(descriptor, windows_locks.LK_NBLCK, 1)
            else:
                posix_locks = __import__("fcntl")
                posix_locks.flock(descriptor, posix_locks.LOCK_EX | posix_locks.LOCK_NB)
            locked = True
        except OSError as exc:
            os.close(descriptor)
            if exc.errno in {errno.EACCES, errno.EAGAIN, errno.EDEADLK}:
                raise ConflictError(
                    f"{label} is already being changed by another process."
                ) from None
            raise ConfigurationError(f"Cannot lock {label.lower()}: {exc}") from exc
        try:
            yield
        finally:
            try:
                if locked:
                    if os.name == "nt":
                        windows_locks = __import__("msvcrt")
                        os.lseek(descriptor, 0, os.SEEK_SET)
                        windows_locks.locking(descriptor, windows_locks.LK_UNLCK, 1)
                    else:
                        posix_locks = __import__("fcntl")
                        posix_locks.flock(descriptor, posix_locks.LOCK_UN)
            finally:
                os.close(descriptor)

    def save_draft(self, draft: RecordDraft) -> None:
        with self._lock(f"draft-{draft.draft_id}"):
            self._write_json(self._draft_path(draft.draft_id), draft.to_dict())

    def load_draft(self, draft_id: str) -> RecordDraft:
        path = self._draft_path(draft_id)
        draft = self._read_model(path, RecordDraft.from_dict)
        if draft.draft_id != draft_id:
            raise ConfigurationError("Draft ID does not match its local-state path.")
        return draft

    def list_drafts(self, config: ResolvedConfig | None = None) -> list[RecordDraft]:
        drafts_dir = self.root / "drafts"
        drafts: list[RecordDraft] = []
        for path in self._list_json_paths(drafts_dir):
            draft = self._read_model(path, RecordDraft.from_dict)
            if config is None or (
                draft.profile == config.profile
                and draft.server.rstrip("/") == config.server.rstrip("/")
            ):
                drafts.append(draft)
        return sorted(drafts, key=lambda value: value.created_at, reverse=True)

    def save_deletion_receipt(self, config: ResolvedConfig, entry: dict[str, Any]) -> Path:
        self.add_secret(config.api_key)
        if contains_secret(entry, config.api_key):
            raise ConfigurationError(
                "Refusing deletion because its recovery snapshot contains the configured API key."
            )
        entry_id = str(entry.get("_id", "unknown"))
        safe_id = "".join(
            character if character.isalnum() or character in "-_" else "_" for character in entry_id
        )
        stamp = utc_now_iso().replace(":", "").replace("+", "_")
        path = self.root / "deletion-receipts" / f"{stamp}-{safe_id}.json"
        receipt = {
            "version": 1,
            "created_at": utc_now_iso(),
            "profile": config.profile,
            "server": config.server,
            "record": entry,
        }
        with self._lock("deletion-receipts"):
            self._write_json(path, receipt)
        return path

    def creation_receipt_path(self, receipt_id: str) -> Path:
        if not re_full_receipt_id(receipt_id):
            raise ConfigurationError("Creation receipt ID must contain 32 lowercase hex digits.")
        return self.root / "creation-receipts" / f"{receipt_id}.json"

    def create_creation_receipt(
        self,
        config: ResolvedConfig,
        operation: str,
        payload: dict[str, Any],
        *,
        owner_id: str,
    ) -> dict[str, Any]:
        self.add_secret(config.api_key)
        if not owner_id:
            raise ConfigurationError("Creation-receipt owner ID must not be empty.")
        receipt = {
            "schema": "titra-cli/create-receipt/v2",
            "receipt_id": uuid.uuid4().hex,
            "created_at": utc_now_iso(),
            "updated_at": utc_now_iso(),
            "profile": config.profile,
            "server": config.server,
            "owner_id": owner_id,
            "operation": operation,
            "payload": payload,
            "idempotency_key": uuid.uuid4().hex,
            "status": "pending",
            "result_id": None,
        }
        self.save_creation_receipt(receipt)
        return receipt

    def save_creation_receipt(self, receipt: dict[str, Any]) -> Path:
        receipt_id = str(receipt.get("receipt_id", ""))
        path = self.creation_receipt_path(receipt_id)
        receipt["updated_at"] = utc_now_iso()
        with self._lock(f"creation-{receipt_id}"):
            self._write_json(path, receipt)
        return path

    def load_creation_receipt(self, receipt_id: str) -> dict[str, Any]:
        receipt = self._read_json(self.creation_receipt_path(receipt_id))
        if receipt.get("receipt_id") != receipt_id:
            raise ConfigurationError("Creation receipt ID does not match its local-state path.")
        return receipt

    def list_creation_receipts(self, config: ResolvedConfig | None = None) -> list[dict[str, Any]]:
        directory = self.root / "creation-receipts"
        receipts = [self._read_json(path) for path in self._list_json_paths(directory)]
        if config is not None:
            receipts = [
                receipt
                for receipt in receipts
                if receipt.get("profile") == config.profile
                and str(receipt.get("server", "")).rstrip("/") == config.server.rstrip("/")
            ]
        return sorted(receipts, key=lambda value: str(value.get("created_at", "")), reverse=True)

    def webhook_delivery_receipt_path(self, receipt_id: str) -> Path:
        if not re_full_receipt_id(receipt_id):
            raise ConfigurationError(
                "Webhook delivery receipt ID must contain 32 lowercase hex digits."
            )
        return self.root / "webhook-delivery-receipts" / f"{receipt_id}.json"

    @contextmanager
    def webhook_delivery_operation_lock(self, receipt_id: str) -> Iterator[None]:
        self.webhook_delivery_receipt_path(receipt_id)
        with self._operation_lock(
            lock_name=f"webhook-delivery-{receipt_id}",
            label=f"Webhook delivery receipt {receipt_id}",
        ):
            yield

    def save_webhook_delivery_receipt(self, receipt: dict[str, Any]) -> Path:
        receipt_id = str(receipt.get("receipt_id", ""))
        path = self.webhook_delivery_receipt_path(receipt_id)
        with self._lock(f"webhook-delivery-write-{receipt_id}"):
            self._write_json(path, receipt)
        return path

    def load_webhook_delivery_receipt(self, receipt_id: str) -> dict[str, Any]:
        receipt = self._read_json(self.webhook_delivery_receipt_path(receipt_id))
        if receipt.get("receipt_id") != receipt_id:
            raise ConfigurationError(
                "Webhook delivery receipt ID does not match its local-state path."
            )
        return receipt

    def list_webhook_delivery_receipts(
        self, config: ResolvedConfig | None = None
    ) -> list[dict[str, Any]]:
        directory = self.root / "webhook-delivery-receipts"
        receipts: list[dict[str, Any]] = []
        for path in self._list_json_paths(directory):
            receipt = self._read_json(path)
            if receipt.get("receipt_id") != path.stem:
                raise ConfigurationError(
                    "Webhook delivery receipt ID does not match its local-state path."
                )
            receipts.append(receipt)
        if config is not None:
            receipts = [
                receipt
                for receipt in receipts
                if receipt.get("profile") == config.profile
                and str(receipt.get("server", "")).rstrip("/") == config.server.rstrip("/")
            ]
        return sorted(receipts, key=lambda value: str(value.get("created_at", "")), reverse=True)

    def task_edit_receipt_path(self, receipt_id: str) -> Path:
        if not re_full_receipt_id(receipt_id):
            raise ConfigurationError("Task-edit receipt ID must contain 32 lowercase hex digits.")
        return self.root / "task-edit-receipts" / f"{receipt_id}.json"

    def save_task_edit_receipt(self, receipt: dict[str, Any]) -> Path:
        """Persist and fsync before a task PATCH; a failure must abort submission."""
        receipt_id = str(receipt.get("receipt_id", ""))
        path = self.task_edit_receipt_path(receipt_id)
        with self._lock(f"task-edit-{receipt_id}"):
            self._write_json(path, receipt)
        return path

    def load_task_edit_receipt(self, receipt_id: str) -> dict[str, Any]:
        return self._read_json(self.task_edit_receipt_path(receipt_id))


def re_full_receipt_id(value: str) -> bool:
    return len(value) == 32 and all(character in "0123456789abcdef" for character in value)
