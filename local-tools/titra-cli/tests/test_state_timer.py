from __future__ import annotations

import json
import os
import threading
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import pytest

import titra_cli.state as state_module
from titra_cli.errors import (
    AuthenticationError,
    ConfigurationError,
    ConflictError,
    NotFoundError,
    OutcomeUnknownError,
    RemoteApiError,
)
from titra_cli.models import ActiveTimer, PendingTimerStart, ResolvedConfig
from titra_cli.state import StateStore
from titra_cli.timer import TimerManager


def test_atomic_json_write_fsyncs_rename_and_new_directory_entries(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    store = StateStore(tmp_path / "new-state")
    destination = store.root / "drafts" / "receipt.json"
    events: list[str] = []
    original_replace = state_module.os.replace
    original_fsync = state_module.os.fsync

    def recording_replace(source: str | Path, target: str | Path, **kwargs: Any) -> None:
        original_replace(source, target, **kwargs)
        events.append("replace")

    def recording_fsync(descriptor: int) -> None:
        original_fsync(descriptor)
        events.append("fsync")

    monkeypatch.setattr(state_module.os, "replace", recording_replace)
    monkeypatch.setattr(state_module.os, "fsync", recording_fsync)

    store._write_json(destination, {"status": "pending"})

    assert events.count("replace") == 1
    assert events.count("fsync") >= 4
    assert events[-1] == "fsync"
    assert destination.read_text(encoding="utf-8") == '{\n  "status": "pending"\n}\n'


def test_draft_operation_lock_never_expires_while_held(tmp_path: Path) -> None:
    store = StateStore(tmp_path)
    draft = store.create_draft(config(), [], owner_id="u1")
    lock_path = tmp_path / f".draft-operation-{draft.draft_id}.lock"

    with store.draft_operation_lock(draft.draft_id):
        os.utime(lock_path, (0, 0))
        with (
            pytest.raises(ConflictError, match="another process"),
            StateStore(tmp_path).draft_operation_lock(draft.draft_id),
        ):
            pytest.fail("a second draft operation acquired the held lock")


def config(*, username: str | None = "Alice") -> ResolvedConfig:
    return ResolvedConfig(
        profile="test",
        server="https://titra.example",
        api_key="never-write-this-token",
        username=username,
        timezone="Australia/Brisbane",
    )


class FakeTimerClient:
    def __init__(self) -> None:
        self.running = False
        self.started_at = "2026-08-30T13:30:00.000Z"
        self.duration_ms = 7_200_000
        self.created: list[dict[str, Any]] = []
        self.start_calls = 0
        self.stop_error: BaseException | None = None
        self.create_error: BaseException | None = None
        self.entries: list[dict[str, Any]] = []
        self.user = {"_id": "u1", "name": "Alice"}
        self.idempotent = False
        self.create_keys: list[str | None] = []
        self.recovery_calls: list[tuple[str, dict[str, Any], str]] = []

    def current_user(self) -> dict[str, Any]:
        return self.user

    def timer_start(self) -> dict[str, Any]:
        self.start_calls += 1
        if self.running:
            raise ConflictError("already running")
        self.running = True
        return {}

    def timer_get(self) -> dict[str, Any]:
        if not self.running:
            raise NotFoundError("No running timer")
        return {"startTime": self.started_at, "duration": self.duration_ms}

    def timer_stop(self) -> dict[str, Any]:
        if self.stop_error:
            raise self.stop_error
        if not self.running:
            raise NotFoundError("No running timer")
        self.running = False
        return {"startTime": self.started_at, "duration": self.duration_ms}

    def supports_idempotent_create(self, _operation: str | None = None) -> bool:
        return self.idempotent

    def capabilities(self) -> dict[str, Any]:
        return {
            "apiVersion": 2,
            "features": {"timers": {"atomicTransitions": 2}},
            "contracts": {
                "timerStartReplay": {
                    "version": 1,
                    "scope": "user",
                    "activeReplay": "returnExisting",
                    "consumedReplay": "conflict",
                    "consumedErrorCode": "timer-operation-consumed",
                    "retentionSeconds": 604800,
                    "clientSafetyMarginSeconds": 600,
                }
            },
            "idempotency": {
                "version": 1,
                "retentionSeconds": 604800,
            },
        }

    def create_time_entry(
        self, payload: dict[str, Any], *, idempotency_key: str | None = None
    ) -> str:
        self.create_keys.append(idempotency_key)
        if self.create_error:
            raise self.create_error
        self.created.append(payload)
        return f"r{len(self.created)}"

    def recover_idempotent_create(
        self,
        operation: str,
        payload: dict[str, Any],
        *,
        idempotency_key: str,
    ) -> dict[str, Any]:
        self.recovery_calls.append((operation, payload, idempotency_key))
        result_id = self.create_time_entry(payload, idempotency_key=idempotency_key)
        return {
            "operation": operation,
            "result_id": result_id,
            "idempotency_replayed": False,
            "idempotency_expires_at": "2099-01-01T00:00:00.000Z",
        }

    def list_own_time_entries(self, _value: Any, *, page_size: int = 200) -> list[dict[str, Any]]:
        assert 1 <= page_size <= 500
        return self.entries


class RecoverableTimerClient(FakeTimerClient):
    def __init__(self) -> None:
        super().__init__()
        self.running = True
        self.stop_attempts: list[tuple[dict[str, Any], str | None]] = []
        self.lose_next_stop_response = True

    def timer_get(self) -> dict[str, Any]:
        value = super().timer_get()
        return {**value, "timerId": "client-stop-0001", "revision": 7}

    def timer_get_snapshot(self) -> tuple[dict[str, Any], str | None]:
        if not self.running:
            raise NotFoundError("No running timer")
        return {
            "timerId": "client-stop-0001",
            "startTime": self.started_at,
            "duration": self.duration_ms,
        }, '"titra-timer-revision-7"'

    def timer_stop_snapshot(self, snapshot: dict[str, Any], etag: str | None) -> dict[str, Any]:
        self.stop_attempts.append((snapshot.copy(), etag))
        changed = self.running
        self.running = False
        if self.lose_next_stop_response:
            self.lose_next_stop_response = False
            raise OutcomeUnknownError("lost after commit")
        return {
            "timerId": snapshot["timerId"],
            "startTime": self.started_at,
            "stoppedAt": "2026-08-30T15:30:00.000Z",
            "duration": self.duration_ms,
            "changed": changed,
        }


class AtomicStartTimerClient(FakeTimerClient):
    def __init__(self) -> None:
        super().__init__()
        self.operation_ids: list[str] = []

    def supports_atomic_timers(self) -> bool:
        return True

    def timer_start(self, *, operation_id: str | None = None) -> dict[str, Any]:
        assert operation_id is not None
        self.operation_ids.append(operation_id)
        self.running = True
        return {"timerId": operation_id, "changed": True}

    def timer_get(self) -> dict[str, Any]:
        value = super().timer_get()
        return {**value, "timerId": self.operation_ids[-1], "revision": 1}


class LateCommitStartTimerClient(AtomicStartTimerClient):
    def __init__(self, store: StateStore) -> None:
        super().__init__()
        self.store = store
        self.lose_first_response = True
        self.delayed_operation_id: str | None = None

    def timer_start(self, *, operation_id: str | None = None) -> dict[str, Any]:
        assert operation_id is not None
        # The request must never be sent until its exact identity is durable.
        assert self.store.load_pending_timer_start(config()).operation_id == operation_id
        self.operation_ids.append(operation_id)
        if self.lose_first_response:
            self.lose_first_response = False
            self.delayed_operation_id = operation_id
            raise OutcomeUnknownError("start response timed out")
        self.running = True
        return {"timerId": operation_id, "changed": True}

    def commit_delayed_start(self) -> None:
        assert self.delayed_operation_id is not None
        self.running = True


def test_active_timer_round_trip_and_scope_check(tmp_path: Path) -> None:
    store = StateStore(tmp_path)
    timer = ActiveTimer(1, "test", "https://titra.example", "2026-01-01T00:00:00Z")
    store.save_active_timer(config(), timer)
    assert store.load_active_timer(config()).started_at == timer.started_at
    other = ResolvedConfig("other", "https://other", "x", None, "UTC")
    with pytest.raises(NotFoundError):
        store.load_active_timer(other)
    store.clear_active_timer(config())
    with pytest.raises(NotFoundError):
        store.load_active_timer(config())


def test_long_profile_names_have_distinct_timer_and_pending_state_scopes(tmp_path: Path) -> None:
    shared_prefix = "shared-profile-prefix-that-is-longer-than-forty-characters-"
    first = ResolvedConfig(
        profile=f"{shared_prefix}alpha",
        server="https://titra.example",
        api_key="token-a",
        username="Alice",
        timezone="UTC",
    )
    second = ResolvedConfig(
        profile=f"{shared_prefix}bravo",
        server="https://titra.example",
        api_key="token-b",
        username="Alice",
        timezone="UTC",
    )
    store = StateStore(tmp_path)
    first_timer = ActiveTimer(1, first.profile, first.server, "2026-09-03T00:00:00Z")
    second_timer = ActiveTimer(1, second.profile, second.server, "2026-09-03T01:00:00Z")
    first_pending = PendingTimerStart(
        1,
        first.profile,
        first.server,
        "first-operation-id",
        "2026-09-03T00:00:00Z",
        "u1",
    )
    second_pending = PendingTimerStart(
        1,
        second.profile,
        second.server,
        "second-operation-id",
        "2026-09-03T01:00:00Z",
        "u1",
    )

    store.save_active_timer(first, first_timer)
    store.save_active_timer(second, second_timer)
    assert store.reserve_pending_timer_start(first, first_pending) is True
    assert store.reserve_pending_timer_start(second, second_pending) is True

    assert store._active_path(first) != store._active_path(second)
    assert store._pending_start_path(first) != store._pending_start_path(second)
    assert store.load_active_timer(first) == first_timer
    assert store.load_active_timer(second) == second_timer
    assert store.load_pending_timer_start(first) == first_pending
    assert store.load_pending_timer_start(second) == second_pending


def test_ambiguous_legacy_scope_fails_closed_but_exact_adopt_can_rebind(
    tmp_path: Path,
) -> None:
    selected = config()
    store = StateStore(tmp_path)
    legacy_path = store._legacy_scoped_path(selected, "active")
    legacy = ActiveTimer(
        1,
        selected.profile,
        selected.server,
        "2026-08-30T12:00:00.000Z",
        owner_id="u1",
    )
    store._write_json(legacy_path, legacy.to_dict())

    with pytest.raises(ConflictError, match=r"ambiguous pre-v0\.2 profile scope"):
        store.load_active_timer(selected)

    client = FakeTimerClient()
    client.running = True
    rebound = TimerManager(selected, client, store).adopt(  # type: ignore[arg-type]
        expected_start_time=client.started_at
    )

    assert rebound.started_at == client.started_at
    assert store.load_active_timer(selected).started_at == client.started_at
    assert legacy_path.exists()


def test_state_files_are_private_and_never_contain_token(tmp_path: Path) -> None:
    store = StateStore(tmp_path)
    draft = store.create_draft(config(), [{"task": "secret work"}], owner_id="u1")
    receipt = store.save_deletion_receipt(config(), {"_id": "r1", "task": "secret work"})
    content = (tmp_path / "drafts" / f"{draft.draft_id}.json").read_text()
    assert "never-write-this-token" not in content
    assert "never-write-this-token" not in receipt.read_text()
    if os.name == "posix":
        assert (receipt.stat().st_mode & 0o077) == 0
        assert (tmp_path.stat().st_mode & 0o077) == 0


@pytest.mark.skipif(os.name != "posix", reason="POSIX ownership and mode contract")
def test_existing_unsafe_state_root_and_child_permissions_are_rejected_not_repaired(
    tmp_path: Path,
) -> None:
    unsafe_root = tmp_path / "unsafe-state"
    unsafe_root.mkdir(mode=0o700)
    unsafe_root.chmod(0o770)
    store = StateStore(unsafe_root)
    with pytest.raises(ConfigurationError, match="group/other permissions"):
        store.create_draft(config(), [{"task": "blocked"}], owner_id="u1")
    assert unsafe_root.stat().st_mode & 0o077 == 0o070

    private_root = tmp_path / "private-state"
    private_root.mkdir(mode=0o700)
    drafts = private_root / "drafts"
    drafts.mkdir(mode=0o700)
    drafts.chmod(0o755)
    with pytest.raises(ConfigurationError, match="group/other permissions"):
        StateStore(private_root).list_drafts()
    assert drafts.stat().st_mode & 0o077 == 0o055


@pytest.mark.skipif(os.name != "posix", reason="O_NOFOLLOW descriptor contract")
def test_symlinked_state_directory_and_file_are_rejected(tmp_path: Path) -> None:
    root = tmp_path / "state"
    root.mkdir(mode=0o700)
    outside = tmp_path / "outside"
    outside.mkdir(mode=0o700)
    (root / "drafts").symlink_to(outside, target_is_directory=True)
    with pytest.raises(ConfigurationError, match="securely open local-state directory"):
        StateStore(root).create_draft(config(), [{"task": "blocked"}], owner_id="u1")
    assert list(outside.iterdir()) == []

    (root / "drafts").unlink()
    store = StateStore(root)
    draft = store.create_draft(config(), [{"task": "original"}], owner_id="u1")
    path = root / "drafts" / f"{draft.draft_id}.json"
    path.chmod(0o644)
    with pytest.raises(ConfigurationError, match="group/other permissions"):
        store.load_draft(draft.draft_id)
    draft.status = "discarded"
    with pytest.raises(ConfigurationError, match="group/other permissions"):
        store.save_draft(draft)
    assert path.stat().st_mode & 0o077 == 0o044
    path.chmod(0o600)
    target = outside / "replacement.json"
    target.write_text(path.read_text(encoding="utf-8"), encoding="utf-8")
    target.chmod(0o600)
    path.unlink()
    path.symlink_to(target)
    with pytest.raises(ConfigurationError, match="Cannot read local state"):
        store.load_draft(draft.draft_id)


@pytest.mark.skipif(os.name != "posix", reason="openat directory binding contract")
def test_read_uses_open_parent_descriptor_if_directory_path_is_swapped(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root = tmp_path / "state"
    store = StateStore(root)
    draft = store.create_draft(config(), [{"task": "original"}], owner_id="u1")
    drafts = root / "drafts"
    original_dir = root / "drafts-original"
    attacker_dir = root / "drafts-attacker"
    attacker_dir.mkdir(mode=0o700)
    attacker_path = attacker_dir / f"{draft.draft_id}.json"
    attacker = draft.to_dict()
    attacker["payloads"] = [{"task": "swapped"}]
    attacker_path.write_text(json.dumps(attacker), encoding="utf-8")
    attacker_path.chmod(0o600)
    original_open = state_module.os.open
    swapped = False

    def swapping_open(path: Any, flags: int, *args: Any, **kwargs: Any) -> int:
        nonlocal swapped
        if path == f"{draft.draft_id}.json" and kwargs.get("dir_fd") is not None and not swapped:
            drafts.rename(original_dir)
            drafts.symlink_to(attacker_dir, target_is_directory=True)
            swapped = True
        return original_open(path, flags, *args, **kwargs)

    monkeypatch.setattr(state_module.os, "open", swapping_open)
    loaded = store.load_draft(draft.draft_id)
    assert loaded.payloads == [{"task": "original"}]
    assert swapped is True
    drafts.unlink()
    original_dir.rename(drafts)


def test_deletion_receipt_refuses_server_snapshot_containing_api_key(tmp_path: Path) -> None:
    store = StateStore(tmp_path)

    with pytest.raises(ConfigurationError, match="recovery snapshot contains"):
        store.save_deletion_receipt(
            config(),
            {"_id": "r1", "nested": {"peerEcho": "xnever-write-this-tokeny"}},
        )

    assert list(tmp_path.rglob("*deletion-receipts*")) == []


def test_draft_lifecycle_and_filtering(tmp_path: Path) -> None:
    store = StateStore(tmp_path)
    first = store.create_draft(config(), [{"task": "one"}], owner_id="u1")
    other_config = ResolvedConfig(
        "other", "https://other", "another-never-write-token", None, "UTC"
    )
    store.create_draft(other_config, [{"task": "two"}], owner_id="u2")
    assert [draft.draft_id for draft in store.list_drafts(config())] == [first.draft_id]
    loaded = store.load_draft(first.draft_id)
    loaded.status = "discarded"
    store.save_draft(loaded)
    assert store.load_draft(first.draft_id).status == "discarded"
    with pytest.raises(ConfigurationError):
        store.load_draft("../escape")


def test_local_state_rejects_inner_identity_that_differs_from_requested_path(
    tmp_path: Path,
) -> None:
    store = StateStore(tmp_path)
    draft = store.create_draft(config(), [{"task": "one"}], owner_id="u1")
    draft_path = tmp_path / "drafts" / f"{draft.draft_id}.json"
    value = json.loads(draft_path.read_text(encoding="utf-8"))
    value["draft_id"] = "b" * 32
    draft_path.write_text(json.dumps(value), encoding="utf-8")
    with pytest.raises(ConfigurationError, match="does not match"):
        store.load_draft(draft.draft_id)

    receipt = store.create_creation_receipt(
        config(), "project.create", {"name": "one"}, owner_id="u1"
    )
    receipt_path = store.creation_receipt_path(receipt["receipt_id"])
    value = json.loads(receipt_path.read_text(encoding="utf-8"))
    value["receipt_id"] = "c" * 32
    receipt_path.write_text(json.dumps(value), encoding="utf-8")
    with pytest.raises(ConfigurationError, match="does not match"):
        store.load_creation_receipt(receipt["receipt_id"])


def test_timer_start_gets_authoritative_server_timestamp(tmp_path: Path) -> None:
    client = FakeTimerClient()
    manager = TimerManager(config(), client, StateStore(tmp_path))  # type: ignore[arg-type]
    timer = manager.start(project_id="p1", task="Work")
    assert client.start_calls == 1
    assert timer.started_at == client.started_at
    assert manager.status()["elapsed_seconds"] == 7200


def test_status_reports_unbound_server_timer_without_adopting_or_enabling_stop(
    tmp_path: Path,
) -> None:
    client = FakeTimerClient()
    client.running = True
    store = StateStore(tmp_path)
    manager = TimerManager(config(), client, store)  # type: ignore[arg-type]

    status = manager.status()
    assert status["running"] is True
    assert status["bound"] is False
    assert status["phase"] == "unbound"
    with pytest.raises(NotFoundError):
        store.load_active_timer(config())
    with pytest.raises(ConflictError, match="No locally bound timer"):
        manager.capture_stop()
    assert client.running is True


def test_server_timer_secret_echo_is_never_persisted(tmp_path: Path) -> None:
    class ReflectingTimerClient(FakeTimerClient):
        def timer_get(self) -> dict[str, Any]:
            return {
                **super().timer_get(),
                "peerEcho": f"prefix-{config().api_key}-suffix",
            }

    client = ReflectingTimerClient()
    store = StateStore(tmp_path)

    with pytest.raises(OutcomeUnknownError, match="configured credential"):
        TimerManager(config(), client, store).start()  # type: ignore[arg-type]

    assert client.running is True
    assert not any(config().api_key in path.read_text() for path in tmp_path.rglob("*.json"))
    with pytest.raises(NotFoundError):
        store.load_active_timer(config())


def test_v6_timer_start_uses_caller_known_operation_id_and_status_exposes_it(
    tmp_path: Path,
) -> None:
    client = AtomicStartTimerClient()
    manager = TimerManager(config(), client, StateStore(tmp_path))  # type: ignore[arg-type]
    operation_id = "selftest:known-operation-0001"
    manager.start(project_id="p1", task="Work", operation_id=operation_id)
    assert client.operation_ids == [operation_id]
    assert manager.status()["timerId"] == operation_id


def test_v6_unknown_start_is_journaled_then_late_commit_is_recovered_by_status(
    tmp_path: Path,
) -> None:
    store = StateStore(tmp_path)
    client = LateCommitStartTimerClient(store)
    manager = TimerManager(config(), client, store)  # type: ignore[arg-type]

    with pytest.raises(OutcomeUnknownError) as caught:
        manager.start(project_id="p1", task="Crash-safe work")

    pending = store.load_pending_timer_start(config())
    assert pending.operation_id == client.operation_ids[0]
    assert pending.project_id == "p1"
    assert pending.task == "Crash-safe work"
    assert caught.value.details == {
        "pending_start": True,
        "operation_id": pending.operation_id,
        "project_id": "p1",
        "task": "Crash-safe work",
    }
    with pytest.raises(NotFoundError):
        store.load_active_timer(config())

    client.commit_delayed_start()
    restarted = TimerManager(config(), client, store)  # type: ignore[arg-type]
    status = restarted.status()
    assert status["timerId"] == pending.operation_id
    assert status["projectId"] == "p1"
    assert status["task"] == "Crash-safe work"
    assert store.load_active_timer(config()).timer_id == pending.operation_id
    with pytest.raises(NotFoundError):
        store.load_pending_timer_start(config())


def test_v6_unknown_start_recovery_replays_the_exact_persisted_operation(
    tmp_path: Path,
) -> None:
    store = StateStore(tmp_path)
    client = LateCommitStartTimerClient(store)
    with pytest.raises(OutcomeUnknownError):
        TimerManager(config(), client, store).start(project_id="p1", task="Replay-safe work")  # type: ignore[arg-type]
    operation_id = store.load_pending_timer_start(config()).operation_id

    recovered = TimerManager(config(), client, store).recover_start()  # type: ignore[arg-type]

    assert client.operation_ids == [operation_id, operation_id]
    assert recovered.timer_id == operation_id
    assert recovered.project_id == "p1"
    assert recovered.task == "Replay-safe work"
    with pytest.raises(NotFoundError):
        store.load_pending_timer_start(config())


def test_timer_start_recovery_refuses_safe_retention_cutoff_before_post(
    tmp_path: Path,
) -> None:
    first_attempt = datetime(2026, 8, 30, 12, 0, tzinfo=UTC)
    pending = PendingTimerStart(
        version=1,
        profile="test",
        server="https://titra.example",
        operation_id="expired-start-operation-0001",
        created_at=first_attempt.isoformat(timespec="seconds"),
        owner_id="u1",
        project_id="p1",
        task="Old work",
    )
    store = StateStore(tmp_path)
    store.reserve_pending_timer_start(config(), pending)
    client = AtomicStartTimerClient()

    with pytest.raises(ConflictError, match=r"final 600 seconds.*604800-second"):
        TimerManager(
            config(),
            client,
            store,
            now=lambda: first_attempt + timedelta(seconds=604_200),
        ).recover_start()  # type: ignore[arg-type]

    assert client.operation_ids == []
    assert store.load_pending_timer_start(config()) == pending


def test_ordinary_timer_start_cannot_replay_stale_pending_intent(
    tmp_path: Path,
) -> None:
    first_attempt = datetime(2026, 8, 30, 12, 0, tzinfo=UTC)
    pending = PendingTimerStart(
        version=1,
        profile="test",
        server="https://titra.example",
        operation_id="expired-start-operation-0002",
        created_at=first_attempt.isoformat(timespec="seconds"),
        owner_id="u1",
        project_id="p1",
        task="Old work",
    )
    store = StateStore(tmp_path)
    store.reserve_pending_timer_start(config(), pending)
    client = AtomicStartTimerClient()

    with pytest.raises(ConflictError, match=r"final 600 seconds.*604800-second"):
        TimerManager(
            config(),
            client,
            store,
            now=lambda: first_attempt + timedelta(seconds=604_200),
        ).start(project_id="p1", task="Old work")  # type: ignore[arg-type]

    assert client.operation_ids == []
    assert store.load_pending_timer_start(config()) == pending


def test_timer_start_recovery_is_allowed_one_second_before_safe_cutoff(
    tmp_path: Path,
) -> None:
    first_attempt = datetime(2026, 8, 30, 12, 0, tzinfo=UTC)
    pending = PendingTimerStart(
        version=1,
        profile="test",
        server="https://titra.example",
        operation_id="recoverable-start-operation-0001",
        created_at=first_attempt.isoformat(timespec="seconds"),
        owner_id="u1",
        project_id="p1",
        task="Recoverable work",
    )
    store = StateStore(tmp_path)
    store.reserve_pending_timer_start(config(), pending)
    client = AtomicStartTimerClient()

    recovered = TimerManager(
        config(),
        client,
        store,
        now=lambda: first_attempt + timedelta(seconds=604_199),
    ).recover_start()  # type: ignore[arg-type]

    assert client.operation_ids == [pending.operation_id]
    assert recovered.timer_id == pending.operation_id
    with pytest.raises(NotFoundError):
        store.load_pending_timer_start(config())


def test_timer_start_recovery_requires_exact_consumed_id_contract_before_post(
    tmp_path: Path,
) -> None:
    pending = PendingTimerStart(
        version=1,
        profile="test",
        server="https://titra.example",
        operation_id="uncontracted-start-operation-0001",
        created_at=datetime.now(UTC).isoformat(timespec="seconds"),
        owner_id="u1",
    )
    store = StateStore(tmp_path)
    store.reserve_pending_timer_start(config(), pending)
    client = AtomicStartTimerClient()
    client.capabilities = lambda: {  # type: ignore[method-assign]
        "apiVersion": 2,
        "features": {"timers": {"atomicTransitions": 2}},
        "contracts": {},
    }

    with pytest.raises(ConfigurationError, match="consumed timer-start replay contract"):
        TimerManager(config(), client, store).recover_start()  # type: ignore[arg-type]

    assert client.operation_ids == []
    assert store.load_pending_timer_start(config()) == pending


def test_consumed_timer_start_response_resolves_and_clears_inherited_intent(
    tmp_path: Path,
) -> None:
    class ConsumedStartClient(AtomicStartTimerClient):
        def timer_start(self, *, operation_id: str | None = None) -> dict[str, Any]:
            assert operation_id is not None
            self.operation_ids.append(operation_id)
            raise ConflictError(
                "This timer-start operation was already consumed.",
                {
                    "statusCode": 409,
                    "message": "This timer start operation was already used.",
                    "payload": {"code": "timer-operation-consumed"},
                },
            )

    pending = PendingTimerStart(
        version=1,
        profile="test",
        server="https://titra.example",
        operation_id="consumed-start-operation-0001",
        created_at=datetime.now(UTC).isoformat(timespec="seconds"),
        owner_id="u1",
    )
    store = StateStore(tmp_path)
    store.reserve_pending_timer_start(config(), pending)
    client = ConsumedStartClient()

    with pytest.raises(ConflictError, match="already consumed"):
        TimerManager(config(), client, store).recover_start()  # type: ignore[arg-type]

    assert client.operation_ids == [pending.operation_id]
    with pytest.raises(NotFoundError):
        store.load_pending_timer_start(config())
    assert client.running is False


def test_unrecognized_timer_start_conflict_keeps_inherited_intent(
    tmp_path: Path,
) -> None:
    class AmbiguousConflictClient(AtomicStartTimerClient):
        def timer_start(self, *, operation_id: str | None = None) -> dict[str, Any]:
            assert operation_id is not None
            self.operation_ids.append(operation_id)
            raise ConflictError("A different conflict.", {"code": "other-conflict"})

    pending = PendingTimerStart(
        version=1,
        profile="test",
        server="https://titra.example",
        operation_id="uncertain-start-operation-0001",
        created_at=datetime.now(UTC).isoformat(timespec="seconds"),
        owner_id="u1",
    )
    store = StateStore(tmp_path)
    store.reserve_pending_timer_start(config(), pending)
    client = AmbiguousConflictClient()

    with pytest.raises(ConflictError, match="different conflict"):
        TimerManager(config(), client, store).recover_start()  # type: ignore[arg-type]

    assert client.operation_ids == [pending.operation_id]
    assert store.load_pending_timer_start(config()) == pending


def test_rotated_token_cannot_replay_another_users_pending_start(tmp_path: Path) -> None:
    store = StateStore(tmp_path)
    client = LateCommitStartTimerClient(store)
    with pytest.raises(OutcomeUnknownError):
        TimerManager(config(), client, store).start(project_id="p1", task="Owner one")  # type: ignore[arg-type]
    pending = store.load_pending_timer_start(config())
    assert pending.owner_id == "u1"
    attempts = list(client.operation_ids)

    client.user = {"_id": "u2", "name": "Alice"}
    with pytest.raises(ConflictError, match="different API user"):
        TimerManager(config(), client, store).recover_start()  # type: ignore[arg-type]
    assert client.operation_ids == attempts
    assert store.load_pending_timer_start(config()).operation_id == pending.operation_id


def test_explicit_timer_operation_id_requires_atomic_server(tmp_path: Path) -> None:
    client = FakeTimerClient()
    manager = TimerManager(config(), client, StateStore(tmp_path))  # type: ignore[arg-type]
    with pytest.raises(ConfigurationError, match="requires the v6 atomic-timer"):
        manager.start(operation_id="selftest:known-operation-0001")
    assert client.start_calls == 0


def test_expected_username_is_checked_before_start_mutation(tmp_path: Path) -> None:
    client = FakeTimerClient()
    client.user["name"] = "Mallory"
    manager = TimerManager(config(), client, StateStore(tmp_path))  # type: ignore[arg-type]
    with pytest.raises(AuthenticationError):
        manager.start()
    assert client.start_calls == 0


@pytest.mark.parametrize("user_id", [None, "", 123])
def test_malformed_or_missing_user_id_is_rejected_before_timer_mutation(
    tmp_path: Path, user_id: object
) -> None:
    client = FakeTimerClient()
    client.user = {"name": "Alice"}
    if user_id is not None:
        client.user["_id"] = user_id
    manager = TimerManager(config(), client, StateStore(tmp_path))  # type: ignore[arg-type]
    with pytest.raises(AuthenticationError, match="immutable current-user ID"):
        manager.start()
    assert client.start_calls == 0


def test_malformed_private_timer_identity_fields_fail_closed(tmp_path: Path) -> None:
    store = StateStore(tmp_path)
    malformed_owner = ActiveTimer(
        1,
        "test",
        "https://titra.example",
        "2026-01-01T00:00:00Z",
        owner_id=123,  # type: ignore[arg-type]
    )
    store.save_active_timer(config(), malformed_owner)
    with pytest.raises(ConfigurationError, match="owner_id must be a nonempty string"):
        store.load_active_timer(config())

    malformed_timer_id = ActiveTimer(
        1,
        "test",
        "https://titra.example",
        "2026-01-01T00:00:00Z",
        owner_id="u1",
        timer_id={"unexpected": True},  # type: ignore[arg-type]
    )
    store.save_active_timer(config(), malformed_timer_id)
    with pytest.raises(ConfigurationError, match="timer_id must be a nonempty string"):
        store.load_active_timer(config())


def test_rotated_token_cannot_reuse_legacy_null_id_timer_metadata(tmp_path: Path) -> None:
    client = FakeTimerClient()
    store = StateStore(tmp_path)
    manager = TimerManager(config(), client, store)  # type: ignore[arg-type]
    original = manager.start(project_id="old-project", task="Old user's task")
    assert original.timer_id is None
    assert original.owner_id == "u1"

    # A different account can have the same display name and another legacy timer whose
    # timerId is also null. The immutable user ID, not name/null timer ID, is the boundary.
    client.user = {"_id": "u2", "name": "Alice"}
    client.started_at = "2026-08-30T14:00:00.000Z"
    with pytest.raises(ConflictError, match="different API user"):
        manager.capture_stop()
    assert client.running is True
    assert store.load_active_timer(config()).phase == "running"
    assert store.list_drafts(config()) == []

    rebound = manager.adopt(
        project_id="new-project",
        task="New user's task",
        expected_start_time=client.started_at,
    )
    assert rebound.owner_id == "u2"
    assert rebound.timer_id is None
    assert rebound.project_id == "new-project"
    assert rebound.task == "New user's task"


def test_ownerless_legacy_timer_state_fails_closed_until_guarded_adopt(tmp_path: Path) -> None:
    client = FakeTimerClient()
    client.running = True
    store = StateStore(tmp_path)
    store.save_active_timer(
        config(),
        ActiveTimer(
            1,
            "test",
            "https://titra.example",
            client.started_at,
            project_id="untrusted-project",
            task="Untrusted task",
            timer_id=None,
        ),
    )
    manager = TimerManager(config(), client, store)  # type: ignore[arg-type]

    with pytest.raises(ConflictError, match="predates immutable user binding"):
        manager.status()
    with pytest.raises(ConflictError, match="predates immutable user binding"):
        manager.capture_stop()
    assert client.running is True

    rebound = manager.adopt(expected_start_time=client.started_at)
    assert rebound.owner_id == "u1"
    assert rebound.timer_id is None


def test_guarded_legacy_adopt_does_not_erase_a_different_pending_start(tmp_path: Path) -> None:
    client = FakeTimerClient()
    client.running = True
    store = StateStore(tmp_path)
    pending = PendingTimerStart(
        version=1,
        profile="test",
        server="https://titra.example",
        operation_id="pending-start-owner1",
        created_at="2026-08-30T13:00:00+00:00",
        owner_id="u1",
        project_id="p1",
        task="Pending work",
    )
    store.reserve_pending_timer_start(config(), pending)

    adopted = TimerManager(config(), client, store).adopt(  # type: ignore[arg-type]
        expected_start_time=client.started_at
    )

    assert adopted.timer_id is None
    assert adopted.owner_id == "u1"
    assert store.load_pending_timer_start(config()) == pending


def test_pause_resume_and_stop_create_durable_split_draft(tmp_path: Path) -> None:
    client = FakeTimerClient()
    now_values = iter(
        [
            datetime(2026, 8, 30, 14, 0, tzinfo=UTC),
            datetime(2026, 8, 30, 14, 15, tzinfo=UTC),
        ]
    )
    store = StateStore(tmp_path)
    manager = TimerManager(
        config(),
        client,
        store,
        now=lambda: next(now_values),  # type: ignore[arg-type]
    )
    manager.start(project_id="p1", task="Work")
    manager.pause()
    manager.resume()
    draft = manager.capture_stop()
    assert draft.status == "pending"
    assert draft.payloads == []
    with pytest.raises(NotFoundError):
        store.load_active_timer(config())
    prepared = manager.prepare_timer_draft(
        draft,
        project_id="p1",
        task="Work",
        break_seconds=900,
        split_midnight=True,
    )
    assert [payload["date"] for payload in prepared.payloads] == ["2026-08-30", "2026-08-31"]
    assert sum(payload["hours"] for payload in prepared.payloads) == pytest.approx(1.5)


def test_exact_duration_replaces_elapsed_and_cannot_combine_with_break(tmp_path: Path) -> None:
    client = FakeTimerClient()
    store = StateStore(tmp_path)
    manager = TimerManager(config(), client, store)  # type: ignore[arg-type]
    manager.start()
    draft = manager.capture_stop()
    prepared = manager.prepare_timer_draft(draft, project_id="p1", task="Work", exact_seconds=1800)
    assert prepared.payloads[0]["hours"] == 0.5
    with pytest.raises(ConfigurationError, match="either an exact duration"):
        manager.prepare_timer_draft(
            prepared, project_id="p1", task="Work", exact_seconds=1800, break_seconds=60
        )


def test_lost_stop_response_retains_active_state_and_unknown_draft(tmp_path: Path) -> None:
    client = FakeTimerClient()
    store = StateStore(tmp_path)
    manager = TimerManager(config(), client, store)  # type: ignore[arg-type]
    manager.start()
    client.stop_error = OutcomeUnknownError("lost")
    with pytest.raises(OutcomeUnknownError) as caught:
        manager.capture_stop()
    assert caught.value.details["draft_id"]
    assert store.load_active_timer(config()).phase == "pending_stop"
    drafts = store.list_drafts(config())
    assert drafts[0].status == "outcome_unknown"


def test_v6_lost_stop_response_is_recovered_from_exact_durable_receipt(tmp_path: Path) -> None:
    client = RecoverableTimerClient()
    store = StateStore(tmp_path)
    active = ActiveTimer(
        1,
        "test",
        "https://titra.example",
        client.started_at,
        owner_id="u1",
        project_id="p1",
        task="Work",
        timer_id="client-stop-0001",
    )
    store.save_active_timer(config(), active)
    manager = TimerManager(config(), client, store)  # type: ignore[arg-type]

    with pytest.raises(OutcomeUnknownError) as caught:
        manager.capture_stop()
    unknown = store.load_draft(caught.value.details["draft_id"])
    assert unknown.status == "outcome_unknown"
    assert unknown.timer is not None
    assert unknown.timer["stop_request"] == {
        "timerId": "client-stop-0001",
        "etag": '"titra-timer-revision-7"',
    }
    assert store.load_active_timer(config()).phase == "pending_stop"

    recovered = manager.recover_stop(unknown)
    assert recovered.status == "pending"
    assert recovered.timer is not None
    assert recovered.timer["server_duration_ms"] == client.duration_ms
    assert recovered.timer["stop_request"] == unknown.timer["stop_request"]
    assert client.stop_attempts == [
        (
            {
                "timerId": "client-stop-0001",
                "startTime": client.started_at,
                "duration": client.duration_ms,
            },
            '"titra-timer-revision-7"',
        ),
        ({"timerId": "client-stop-0001"}, '"titra-timer-revision-7"'),
    ]
    with pytest.raises(NotFoundError):
        store.load_active_timer(config())


def test_timer_cancel_intent_is_atomic_and_survives_lost_stop_recovery(tmp_path: Path) -> None:
    client = RecoverableTimerClient()
    store = StateStore(tmp_path)
    store.save_active_timer(
        config(),
        ActiveTimer(
            1,
            "test",
            "https://titra.example",
            client.started_at,
            owner_id="u1",
            timer_id="client-stop-0001",
        ),
    )
    manager = TimerManager(config(), client, store)  # type: ignore[arg-type]

    with pytest.raises(OutcomeUnknownError) as caught:
        manager.capture_stop(discard=True)
    unknown = store.load_draft(caught.value.details["draft_id"])
    assert unknown.status == "outcome_unknown"
    assert unknown.timer is not None
    assert unknown.timer["discard_after_stop"] is True

    recovered = manager.recover_stop(unknown)

    assert recovered.status == "discarded"
    assert recovered.payloads == []
    assert recovered.timer is not None
    assert recovered.timer["discard_after_stop"] is True
    assert store.load_draft(recovered.draft_id).status == "discarded"
    with pytest.raises(NotFoundError):
        store.load_active_timer(config())


def test_successful_timer_cancel_never_persists_a_submittable_draft(tmp_path: Path) -> None:
    client = RecoverableTimerClient()
    client.lose_next_stop_response = False
    store = StateStore(tmp_path)
    store.save_active_timer(
        config(),
        ActiveTimer(
            1,
            "test",
            "https://titra.example",
            client.started_at,
            owner_id="u1",
            timer_id="client-stop-0001",
        ),
    )

    cancelled = TimerManager(config(), client, store).capture_stop(discard=True)  # type: ignore[arg-type]

    assert cancelled.status == "discarded"
    assert cancelled.payloads == []
    assert store.load_draft(cancelled.draft_id).status == "discarded"


def test_v6_stop_survives_interrupt_after_dispatch_and_recovers_exact_receipt(
    tmp_path: Path,
) -> None:
    class InterruptedStopClient(RecoverableTimerClient):
        def timer_stop_snapshot(self, snapshot: dict[str, Any], etag: str | None) -> dict[str, Any]:
            self.stop_attempts.append((snapshot.copy(), etag))
            changed = self.running
            self.running = False
            if changed:
                raise KeyboardInterrupt
            return {
                "timerId": snapshot["timerId"],
                "startTime": self.started_at,
                "stoppedAt": "2026-08-30T15:30:00.000Z",
                "duration": self.duration_ms,
                "changed": False,
            }

    client = InterruptedStopClient()
    store = StateStore(tmp_path)
    store.save_active_timer(
        config(),
        ActiveTimer(
            1,
            "test",
            "https://titra.example",
            client.started_at,
            owner_id="u1",
            timer_id="client-stop-0001",
        ),
    )
    manager = TimerManager(config(), client, store)  # type: ignore[arg-type]

    with pytest.raises(KeyboardInterrupt):
        manager.capture_stop()
    [interrupted] = store.list_drafts(config())
    assert interrupted.status == "pending_stop"
    assert interrupted.timer is not None
    assert interrupted.timer["phase"] == "stopping"
    assert interrupted.timer["stop_request"]["timerId"] == "client-stop-0001"

    recovered = manager.recover_stop(interrupted)
    assert recovered.status == "pending"
    assert recovered.timer is not None
    assert recovered.timer["server_duration_ms"] == client.duration_ms
    assert len(client.stop_attempts) == 2
    with pytest.raises(NotFoundError):
        store.load_active_timer(config())


@pytest.mark.parametrize("changed", [None, 0, 1, "true"])
def test_guarded_stop_requires_a_real_boolean_changed_flag(
    tmp_path: Path,
    changed: object,
) -> None:
    class InvalidChangedClient(RecoverableTimerClient):
        def timer_stop_snapshot(self, snapshot: dict[str, Any], etag: str | None) -> dict[str, Any]:
            self.stop_attempts.append((snapshot.copy(), etag))
            self.running = False
            return {
                "timerId": snapshot["timerId"],
                "startTime": self.started_at,
                "stoppedAt": "2026-08-30T15:30:00.000Z",
                "duration": self.duration_ms,
                "changed": changed,
            }

    client = InvalidChangedClient()
    store = StateStore(tmp_path)
    store.save_active_timer(
        config(),
        ActiveTimer(
            1,
            "test",
            "https://titra.example",
            client.started_at,
            owner_id="u1",
            timer_id="client-stop-0001",
        ),
    )

    with pytest.raises(OutcomeUnknownError, match="invalid changed flag"):
        TimerManager(config(), client, store).capture_stop()  # type: ignore[arg-type]
    [draft] = store.list_drafts(config())
    assert draft.status == "outcome_unknown"


def test_rotated_token_cannot_replay_another_users_timer_stop(tmp_path: Path) -> None:
    client = RecoverableTimerClient()
    store = StateStore(tmp_path)
    store.save_active_timer(
        config(),
        ActiveTimer(
            1,
            "test",
            "https://titra.example",
            client.started_at,
            owner_id="u1",
            timer_id="client-stop-0001",
        ),
    )
    manager = TimerManager(config(), client, store)  # type: ignore[arg-type]
    with pytest.raises(OutcomeUnknownError) as caught:
        manager.capture_stop()
    draft = store.load_draft(caught.value.details["draft_id"])
    assert draft.owner_id == "u1"
    first_attempts = list(client.stop_attempts)

    client.user = {"_id": "u2", "name": "Alice"}
    with pytest.raises(ConflictError, match="different API user"):
        manager.recover_stop(draft)
    assert client.stop_attempts == first_attempts


def test_guarded_timer_stop_refuses_a_different_active_timer_without_journaling(
    tmp_path: Path,
) -> None:
    client = RecoverableTimerClient()
    store = StateStore(tmp_path)
    store.save_active_timer(
        config(),
        ActiveTimer(
            1,
            "test",
            "https://titra.example",
            client.started_at,
            phase="running",
            owner_id="u1",
            timer_id="client-stop-0001",
        ),
    )
    manager = TimerManager(config(), client, store)  # type: ignore[arg-type]
    with pytest.raises(ConflictError, match="no stop was attempted"):
        manager.capture_stop(expected_timer_id="different-operation-0001")
    assert client.stop_attempts == []
    assert store.load_active_timer(config()).phase == "running"
    assert store.list_drafts(config()) == []


def test_guarded_legacy_timer_stop_refuses_changed_start_before_journaling(
    tmp_path: Path,
) -> None:
    client = FakeTimerClient()
    client.running = True
    reviewed_start = "2026-08-30T13:00:00.000Z"
    client.started_at = "2026-08-30T14:00:00.000Z"
    store = StateStore(tmp_path)
    store.save_active_timer(
        config(),
        ActiveTimer(
            1,
            "test",
            "https://titra.example",
            reviewed_start,
            phase="running",
            owner_id="u1",
            timer_id=None,
        ),
    )

    with pytest.raises(ConflictError, match="start time does not match"):
        TimerManager(config(), client, store).capture_stop(  # type: ignore[arg-type]
            expected_start_time=reviewed_start
        )

    assert client.running is True
    assert store.load_active_timer(config()).phase == "running"
    assert store.list_drafts(config()) == []


def test_cross_device_replacement_is_never_stopped_or_given_stale_local_labels(
    tmp_path: Path,
) -> None:
    client = RecoverableTimerClient()
    store = StateStore(tmp_path)
    store.save_active_timer(
        config(),
        ActiveTimer(
            1,
            "test",
            "https://titra.example",
            client.started_at,
            owner_id="u1",
            project_id="old-project",
            task="old task",
            timer_id="replaced-timer-0001",
        ),
    )
    manager = TimerManager(config(), client, store)  # type: ignore[arg-type]
    with pytest.raises(ConflictError, match="differs from the locally tracked timer"):
        manager.capture_stop()
    assert client.stop_attempts == []
    assert store.list_drafts(config()) == []


def test_guarded_timer_stop_uses_matching_id_and_revision(tmp_path: Path) -> None:
    client = RecoverableTimerClient()
    client.lose_next_stop_response = False
    store = StateStore(tmp_path)
    store.save_active_timer(
        config(),
        ActiveTimer(
            1,
            "test",
            "https://titra.example",
            client.started_at,
            phase="running",
            owner_id="u1",
            timer_id="client-stop-0001",
        ),
    )
    draft = TimerManager(config(), client, store).capture_stop(  # type: ignore[arg-type]
        expected_timer_id="client-stop-0001"
    )
    assert draft.status == "pending"
    assert client.stop_attempts == [
        (
            {
                "timerId": "client-stop-0001",
                "startTime": client.started_at,
                "duration": client.duration_ms,
            },
            '"titra-timer-revision-7"',
        )
    ]


def test_fresh_state_stop_requires_an_exact_timer_guard(tmp_path: Path) -> None:
    client = RecoverableTimerClient()
    client.lose_next_stop_response = False
    store = StateStore(tmp_path)
    manager = TimerManager(config(), client, store)  # type: ignore[arg-type]

    with pytest.raises(ConflictError, match="No locally bound timer"):
        manager.capture_stop()
    assert client.stop_attempts == []
    assert store.list_drafts(config()) == []

    draft = manager.capture_stop(expected_timer_id="client-stop-0001")
    assert draft.status == "pending"
    assert len(client.stop_attempts) == 1


def test_new_stop_rejects_a_replayed_receipt_without_creating_a_record_draft(
    tmp_path: Path,
) -> None:
    class ReplayedReceiptClient(RecoverableTimerClient):
        def timer_stop_snapshot(self, snapshot: dict[str, Any], etag: str | None) -> dict[str, Any]:
            self.stop_attempts.append((snapshot.copy(), etag))
            self.running = False
            return {
                "timerId": snapshot["timerId"],
                "startTime": self.started_at,
                "stoppedAt": "2026-08-30T15:30:00.000Z",
                "duration": self.duration_ms,
                "changed": False,
            }

    client = ReplayedReceiptClient()
    store = StateStore(tmp_path)
    store.save_active_timer(
        config(),
        ActiveTimer(
            1,
            "test",
            "https://titra.example",
            client.started_at,
            owner_id="u1",
            timer_id="client-stop-0001",
        ),
    )

    with pytest.raises(ConflictError, match="already-used timer-stop receipt"):
        TimerManager(config(), client, store).capture_stop()  # type: ignore[arg-type]

    [audit] = store.list_drafts(config())
    assert audit.status == "discarded"
    assert audit.payloads == []
    assert audit.timer is not None
    assert audit.timer["phase"] == "replayed_stop_receipt"
    with pytest.raises(NotFoundError):
        store.load_active_timer(config())


def test_stop_recovery_rejects_untracked_or_wrong_scope_drafts(tmp_path: Path) -> None:
    client = RecoverableTimerClient()
    store = StateStore(tmp_path)
    manager = TimerManager(config(), client, store)  # type: ignore[arg-type]
    untracked = store.create_draft(config(), [], owner_id="u1", timer={"phase": "pending_stop"})
    untracked.status = "outcome_unknown"
    store.save_draft(untracked)
    with pytest.raises(ConflictError, match="predates recoverable"):
        manager.recover_stop(untracked)
    wrong = store.create_draft(config(), [], owner_id="u1", timer={})
    wrong.status = "outcome_unknown"
    wrong.server = "https://other.example"
    store.save_draft(wrong)
    with pytest.raises(ConflictError, match="different Titra profile"):
        manager.recover_stop(wrong)
    assert client.stop_attempts == []


def test_submit_marks_unknown_and_never_blindly_retries(tmp_path: Path) -> None:
    client = FakeTimerClient()
    store = StateStore(tmp_path)
    draft = store.create_draft(
        config(),
        [{"projectId": "p1", "task": "Work", "date": "2026-08-30", "hours": 1}],
        owner_id="u1",
    )
    client.create_error = OutcomeUnknownError("lost")
    manager = TimerManager(config(), client, store)  # type: ignore[arg-type]
    with pytest.raises(OutcomeUnknownError):
        manager.submit_draft(draft)
    unknown = store.load_draft(draft.draft_id)
    assert unknown.status == "outcome_unknown"
    client.create_error = None
    with pytest.raises(OutcomeUnknownError):
        manager.submit_draft(unknown)
    assert client.created == []


def test_rotated_token_cannot_submit_another_users_draft(tmp_path: Path) -> None:
    client = FakeTimerClient()
    store = StateStore(tmp_path)
    draft = store.create_draft(
        config(),
        [{"projectId": "p1", "task": "Owner one", "date": "2026-08-30", "hours": 1}],
        owner_id="u1",
    )
    client.user = {"_id": "u2", "name": "Alice"}

    with pytest.raises(ConflictError, match="different API user"):
        TimerManager(config(), client, store).submit_draft(draft)  # type: ignore[arg-type]
    assert client.created == []
    assert store.load_draft(draft.draft_id).status == "pending"


@pytest.mark.parametrize("action", ["prepare", "reconcile", "retry"])
def test_all_draft_mutations_reject_wrong_profile_before_use(
    tmp_path: Path,
    action: str,
) -> None:
    client = FakeTimerClient()
    store = StateStore(tmp_path)
    draft = store.create_draft(
        config(),
        [{"projectId": "p1", "task": "Work", "date": "2026-08-30", "hours": 1}],
        owner_id="u1",
        timer={
            "started_at": "2026-08-30T13:30:00.000Z",
            "stopped_at": "2026-08-30T14:30:00.000Z",
            "pauses": [],
        },
    )
    draft.profile = "other"
    draft.status = "outcome_unknown" if action != "prepare" else "pending"
    store.save_draft(draft)
    manager = TimerManager(config(), client, store)  # type: ignore[arg-type]

    with pytest.raises(ConflictError, match="different Titra profile"):
        if action == "prepare":
            manager.prepare_timer_draft(draft, project_id="p1", task="Work")
        elif action == "reconcile":
            manager.reconcile_draft(draft)
        else:
            manager.mark_retryable_after_reconciliation(draft)
    assert client.created == []
    assert client.entries == []


def test_ownerless_old_draft_is_readable_but_cannot_be_submitted(tmp_path: Path) -> None:
    client = FakeTimerClient()
    store = StateStore(tmp_path)
    draft = store.create_draft(
        config(),
        [{"projectId": "p1", "task": "Old draft", "date": "2026-08-30", "hours": 1}],
        owner_id="u1",
    )
    draft.owner_id = None
    store.save_draft(draft)
    loaded = store.load_draft(draft.draft_id)
    assert loaded.owner_id is None

    with pytest.raises(ConflictError, match="predates immutable user binding"):
        TimerManager(config(), client, store).submit_draft(loaded)  # type: ignore[arg-type]
    assert client.created == []


def test_v6_unknown_draft_reuses_the_persisted_key_and_cannot_duplicate(tmp_path: Path) -> None:
    client = FakeTimerClient()
    client.idempotent = True
    store = StateStore(tmp_path)
    draft = store.create_draft(
        config(),
        [{"projectId": "p1", "task": "Work", "date": "2026-08-30", "hours": 1}],
        owner_id="u1",
    )
    key = draft.idempotency_keys[0]
    client.create_error = OutcomeUnknownError("lost response")
    manager = TimerManager(config(), client, store)  # type: ignore[arg-type]
    with pytest.raises(OutcomeUnknownError):
        manager.submit_draft(draft)
    unknown = store.load_draft(draft.draft_id)
    assert unknown.status == "outcome_unknown"
    assert unknown.idempotency_keys == [key]
    client.create_error = None
    submitted = manager.submit_draft(unknown)
    assert submitted.status == "submitted"
    assert client.create_keys == [key, key]
    assert submitted.result_ids == ["r1"]


def test_resumed_multi_record_draft_recovers_only_uncertain_record_then_creates_fresh(
    tmp_path: Path,
) -> None:
    client = FakeTimerClient()
    client.idempotent = True
    store = StateStore(tmp_path)
    payloads = [
        {"projectId": "p1", "task": "Prior", "date": "2026-08-29", "hours": 1},
        {"projectId": "p1", "task": "Uncertain", "date": "2026-08-30", "hours": 2},
        {"projectId": "p1", "task": "Fresh", "date": "2026-08-31", "hours": 3},
    ]
    draft = store.create_draft(config(), payloads, owner_id="u1")
    draft.result_ids = ["r-prior"]
    draft.first_submitted_at = "2026-08-30T12:00:00+00:00"
    draft.status = "outcome_unknown"
    store.save_draft(draft)

    def recover(
        operation: str,
        payload: dict[str, Any],
        *,
        idempotency_key: str,
    ) -> dict[str, Any]:
        client.recovery_calls.append((operation, payload, idempotency_key))
        assert payload == payloads[1]
        return {
            "operation": operation,
            "result_id": "r-recovered",
            "idempotency_replayed": True,
            "idempotency_expires_at": "2026-09-06T12:00:00.000Z",
        }

    def create_fresh(payload: dict[str, Any], *, idempotency_key: str | None = None) -> str:
        # The recovered ID must be durable before the next POST is attempted.
        assert store.load_draft(draft.draft_id).result_ids == ["r-prior", "r-recovered"]
        client.created.append(payload)
        client.create_keys.append(idempotency_key)
        return "r-fresh"

    client.recover_idempotent_create = recover  # type: ignore[method-assign]
    client.create_time_entry = create_fresh  # type: ignore[method-assign]
    submitted = TimerManager(
        config(),
        client,
        store,
        now=lambda: datetime(2026, 8, 30, 12, 1, tzinfo=UTC),
    ).submit_draft(store.load_draft(draft.draft_id))  # type: ignore[arg-type]

    assert submitted.status == "submitted"
    assert submitted.result_ids == ["r-prior", "r-recovered", "r-fresh"]
    assert client.recovery_calls == [("timeentry.create", payloads[1], draft.idempotency_keys[1])]
    assert client.created == [payloads[2]]
    assert client.create_keys == [draft.idempotency_keys[2]]


def test_v6_draft_retry_is_refused_at_safe_retention_cutoff_without_mutation(
    tmp_path: Path,
) -> None:
    client = FakeTimerClient()
    client.idempotent = True
    store = StateStore(tmp_path)
    draft = store.create_draft(
        config(),
        [{"projectId": "p1", "task": "Work", "date": "2026-08-30", "hours": 1}],
        owner_id="u1",
    )
    first_attempt = datetime(2026, 8, 30, 12, 0, tzinfo=UTC)
    manager = TimerManager(
        config(),
        client,
        store,
        now=lambda: first_attempt,  # type: ignore[arg-type]
    )
    client.create_error = OutcomeUnknownError("lost response")
    with pytest.raises(OutcomeUnknownError):
        manager.submit_draft(draft)
    unknown = store.load_draft(draft.draft_id)
    assert unknown.first_submitted_at == first_attempt.isoformat(timespec="seconds")
    assert len(client.create_keys) == 1

    client.create_error = None
    expired = TimerManager(
        config(),
        client,
        store,
        now=lambda: first_attempt + timedelta(seconds=604200),
    )  # type: ignore[arg-type]
    with pytest.raises(ConflictError, match=r"final 600 seconds.*604800-second"):
        expired.submit_draft(unknown)
    saved = store.load_draft(draft.draft_id)
    assert saved.status == "outcome_unknown"
    assert len(client.create_keys) == 1


def test_v6_draft_retry_is_allowed_one_second_before_safe_retention_cutoff(
    tmp_path: Path,
) -> None:
    client = FakeTimerClient()
    client.idempotent = True
    store = StateStore(tmp_path)
    draft = store.create_draft(
        config(),
        [{"projectId": "p1", "task": "Work", "date": "2026-08-30", "hours": 1}],
        owner_id="u1",
    )
    first_attempt = datetime(2026, 8, 30, 12, 0, tzinfo=UTC)
    initial = TimerManager(
        config(),
        client,
        store,
        now=lambda: first_attempt,  # type: ignore[arg-type]
    )
    client.create_error = OutcomeUnknownError("lost response")
    with pytest.raises(OutcomeUnknownError):
        initial.submit_draft(draft)

    client.create_error = None
    retried = TimerManager(
        config(),
        client,
        store,
        now=lambda: first_attempt + timedelta(seconds=604199),
    ).submit_draft(store.load_draft(draft.draft_id))  # type: ignore[arg-type]

    assert retried.status == "submitted"
    assert client.create_keys == [draft.idempotency_keys[0], draft.idempotency_keys[0]]


def test_v6_legacy_attempted_draft_uses_creation_time_for_retention_gate(
    tmp_path: Path,
) -> None:
    client = FakeTimerClient()
    client.idempotent = True
    store = StateStore(tmp_path)
    draft = store.create_draft(
        config(),
        [{"projectId": "p1", "task": "Old", "date": "2026-08-30", "hours": 1}],
        owner_id="u1",
    )
    draft.created_at = "2026-08-01T00:00:00+00:00"
    draft.status = "outcome_unknown"
    store.save_draft(draft)

    manager = TimerManager(
        config(),
        client,
        store,
        now=lambda: datetime(2026, 8, 20, tzinfo=UTC),  # type: ignore[arg-type]
    )
    with pytest.raises(ConflictError, match=r"final 600 seconds.*604800-second"):
        manager.mark_retryable_after_reconciliation(draft)
    saved = store.load_draft(draft.draft_id)
    assert saved.status == "outcome_unknown"
    assert saved.first_submitted_at is None


@pytest.mark.parametrize("idempotent", [False, True])
def test_two_concurrent_submitters_can_post_a_draft_only_once(
    tmp_path: Path,
    idempotent: bool,
) -> None:
    first_client = FakeTimerClient()
    first_client.idempotent = idempotent
    second_client = FakeTimerClient()
    second_client.idempotent = idempotent
    store = StateStore(tmp_path)
    draft = store.create_draft(
        config(),
        [{"projectId": "p1", "task": "Once", "date": "2026-08-30", "hours": 1}],
        owner_id="u1",
    )
    request_started = threading.Event()
    release_request = threading.Event()
    results: list[str] = []
    failures: list[BaseException] = []

    def slow_create(payload: dict[str, Any], *, idempotency_key: str | None = None) -> str:
        request_started.set()
        if not release_request.wait(timeout=5):
            raise RuntimeError("test did not release blocked request")
        first_client.created.append(payload)
        first_client.create_keys.append(idempotency_key)
        return "r1"

    first_client.create_time_entry = slow_create  # type: ignore[method-assign]

    def first_submit() -> None:
        try:
            submitted = TimerManager(config(), first_client, store).submit_draft(  # type: ignore[arg-type]
                draft
            )
            results.extend(submitted.result_ids)
        except BaseException as exc:
            failures.append(exc)

    worker = threading.Thread(target=first_submit)
    worker.start()
    assert request_started.wait(timeout=5)
    try:
        with pytest.raises(ConflictError, match="another process"):
            TimerManager(config(), second_client, StateStore(tmp_path)).submit_draft(  # type: ignore[arg-type]
                draft
            )
        assert second_client.created == []
    finally:
        release_request.set()
        worker.join(timeout=5)

    assert not worker.is_alive()
    assert failures == []
    assert results == ["r1"]
    assert first_client.created == [draft.payloads[0]]
    assert store.load_draft(draft.draft_id).status == "submitted"


def test_interrupted_legacy_submit_is_never_returned_to_blindly_retryable_state(
    tmp_path: Path,
) -> None:
    client = FakeTimerClient()
    store = StateStore(tmp_path)
    draft = store.create_draft(
        config(),
        [{"projectId": "p1", "task": "Once", "date": "2026-08-30", "hours": 1}],
        owner_id="u1",
    )

    def committed_then_interrupted(payload: dict[str, Any]) -> str:
        client.created.append(payload)
        raise KeyboardInterrupt

    client.create_time_entry = committed_then_interrupted  # type: ignore[method-assign]
    manager = TimerManager(config(), client, store)  # type: ignore[arg-type]
    with pytest.raises(KeyboardInterrupt):
        manager.submit_draft(draft)
    unknown = store.load_draft(draft.draft_id)
    assert unknown.status == "outcome_unknown"
    assert len(client.created) == 1

    def forbidden_retry(_payload: dict[str, Any]) -> str:
        pytest.fail("legacy outcome-unknown draft was posted without reconciliation")

    client.create_time_entry = forbidden_retry  # type: ignore[method-assign]
    with pytest.raises(OutcomeUnknownError, match="Run draft reconcile"):
        manager.submit_draft(unknown)
    assert len(client.created) == 1


def test_finalize_cannot_overwrite_a_concurrently_submitting_draft(tmp_path: Path) -> None:
    submit_client = FakeTimerClient()
    finalize_client = FakeTimerClient()
    store = StateStore(tmp_path)
    original_payload = {
        "projectId": "p1",
        "task": "Original",
        "date": "2026-08-30",
        "hours": 1,
    }
    draft = store.create_draft(
        config(),
        [original_payload],
        owner_id="u1",
        timer={
            "started_at": "2026-08-30T13:30:00.000Z",
            "stopped_at": "2026-08-30T14:30:00.000Z",
            "pauses": [],
        },
    )
    request_started = threading.Event()
    release_request = threading.Event()
    failures: list[BaseException] = []

    def slow_create(payload: dict[str, Any]) -> str:
        request_started.set()
        if not release_request.wait(timeout=5):
            raise RuntimeError("test did not release blocked request")
        submit_client.created.append(payload)
        return "r1"

    submit_client.create_time_entry = slow_create  # type: ignore[method-assign]

    def submit() -> None:
        try:
            TimerManager(config(), submit_client, store).submit_draft(draft)  # type: ignore[arg-type]
        except BaseException as exc:
            failures.append(exc)

    worker = threading.Thread(target=submit)
    worker.start()
    assert request_started.wait(timeout=5)
    try:
        with pytest.raises(ConflictError, match="another process"):
            TimerManager(config(), finalize_client, StateStore(tmp_path)).prepare_timer_draft(  # type: ignore[arg-type]
                draft,
                project_id="p1",
                task="Replacement",
            )
        during_submit = store.load_draft(draft.draft_id)
        assert during_submit.status == "submitting"
        assert during_submit.payloads == [original_payload]
    finally:
        release_request.set()
        worker.join(timeout=5)

    assert not worker.is_alive()
    assert failures == []
    saved = store.load_draft(draft.draft_id)
    assert saved.status == "submitted"
    assert saved.payloads == [original_payload]

    with pytest.raises(ConflictError, match="changed after it was loaded"):
        TimerManager(config(), finalize_client, store).prepare_timer_draft(  # type: ignore[arg-type]
            draft,
            project_id="p1",
            task="Replacement",
        )


def test_stale_submit_cannot_post_payload_changed_by_a_completed_finalize(
    tmp_path: Path,
) -> None:
    client = FakeTimerClient()
    store = StateStore(tmp_path)
    stale = store.create_draft(
        config(),
        [{"projectId": "p1", "task": "Old", "date": "2026-08-30", "hours": 1}],
        owner_id="u1",
        timer={
            "started_at": "2026-08-30T13:30:00.000Z",
            "stopped_at": "2026-08-30T14:30:00.000Z",
            "pauses": [],
        },
    )
    competing_view = store.load_draft(stale.draft_id)
    finalized = TimerManager(config(), client, store).prepare_timer_draft(  # type: ignore[arg-type]
        competing_view,
        project_id="p1",
        task="New",
    )
    assert finalized.payloads[0]["task"] == "New"

    with pytest.raises(ConflictError, match="changed after it was loaded"):
        TimerManager(config(), client, store).submit_draft(stale)  # type: ignore[arg-type]
    assert client.created == []
    saved = store.load_draft(stale.draft_id)
    assert saved.payloads[0]["task"] == "New"
    assert saved.status == "pending"


def test_conclusive_second_payload_failure_keeps_first_id_and_pending_remainder(
    tmp_path: Path,
) -> None:
    client = FakeTimerClient()
    calls = 0

    def create(payload: dict[str, Any]) -> str:
        nonlocal calls
        calls += 1
        if calls == 2:
            raise RemoteApiError("rejected")
        client.created.append(payload)
        return "r1"

    client.create_time_entry = create  # type: ignore[method-assign]
    store = StateStore(tmp_path)
    draft = store.create_draft(
        config(),
        [
            {"projectId": "p1", "task": "A", "date": "2026-08-30", "hours": 1},
            {"projectId": "p1", "task": "B", "date": "2026-08-31", "hours": 1},
        ],
        owner_id="u1",
    )
    with pytest.raises(RemoteApiError):
        TimerManager(config(), client, store).submit_draft(draft)  # type: ignore[arg-type]
    saved = store.load_draft(draft.draft_id)
    assert saved.status == "pending"
    assert saved.result_ids == ["r1"]


def test_reconcile_resolves_one_exact_candidate(tmp_path: Path) -> None:
    client = FakeTimerClient()
    store = StateStore(tmp_path)
    payload = {
        "projectId": "p1",
        "task": "Work",
        "date": "2026-08-30",
        "startTime": "09:00",
        "hours": 1,
        "taskRate": 125.75,
        "customfields": {"ticket": "ABC-123", "billable": True},
    }
    draft = store.create_draft(config(), [payload], owner_id="u1")
    draft.status = "outcome_unknown"
    store.save_draft(draft)
    client.entries = [
        {
            "_id": "r1",
            "userId": "u1",
            "projectId": "p1",
            "task": "Work",
            "date": "2026-08-30T00:00:00.000Z",
            "dateOnly": "2026-08-30",
            "startTime": "09:00",
            "hours": 1,
            "taskRate": 125.75,
            "ticket": "ABC-123",
            "billable": True,
        }
    ]
    result = TimerManager(config(), client, store).reconcile_draft(draft)  # type: ignore[arg-type]
    assert result["resolved"] is True
    assert store.load_draft(draft.draft_id).result_ids == ["r1"]


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("taskRate", 125.76),
        ("taskRate", None),
        ("ticket", "DIFFERENT"),
        ("ticket", None),
        ("unexpectedCustomField", "not-posted"),
        ("userId", "different-user"),
        ("startTime", "09:01"),
    ],
)
def test_reconcile_does_not_adopt_record_with_different_material_create_data(
    tmp_path: Path,
    field: str,
    value: Any,
) -> None:
    client = FakeTimerClient()
    store = StateStore(tmp_path)
    payload = {
        "projectId": "p1",
        "task": "Work",
        "date": "2026-08-30",
        "startTime": "09:00",
        "hours": 1.25,
        "taskRate": 125.75,
        "customfields": {"ticket": "ABC-123"},
    }
    draft = store.create_draft(config(), [payload], owner_id="u1")
    draft.status = "outcome_unknown"
    store.save_draft(draft)
    candidate: dict[str, Any] = {
        "_id": "r1",
        "userId": "u1",
        "projectId": "p1",
        "task": "Work",
        "date": "2026-08-30T00:00:00.000Z",
        "dateOnly": "2026-08-30",
        "startTime": "09:00",
        "hours": 1.25,
        "taskRate": 125.75,
        "ticket": "ABC-123",
    }
    if value is None:
        candidate.pop(field)
    else:
        candidate[field] = value
    client.entries = [candidate]

    result = TimerManager(config(), client, store).reconcile_draft(draft)  # type: ignore[arg-type]

    assert result["resolved"] is False
    assert result["matches"] == [{"payload": payload, "candidates": []}]
    saved = store.load_draft(draft.draft_id)
    assert saved.status == "outcome_unknown"
    assert saved.result_ids == []


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("startTime", "09:00"),
        ("taskRate", 80.0),
        ("unrequestedCustomField", "value"),
    ],
)
def test_reconcile_requires_exact_absence_of_unposted_optional_data(
    tmp_path: Path,
    field: str,
    value: Any,
) -> None:
    client = FakeTimerClient()
    store = StateStore(tmp_path)
    payload = {
        "projectId": "p1",
        "task": "Work",
        "date": "2026-08-30",
        "hours": 1.25,
    }
    draft = store.create_draft(config(), [payload], owner_id="u1")
    draft.status = "outcome_unknown"
    store.save_draft(draft)
    client.entries = [
        {
            "_id": "r1",
            "userId": "u1",
            "projectId": "p1",
            "task": "Work",
            "date": "2026-08-30T00:00:00.000Z",
            "dateOnly": "2026-08-30",
            "hours": 1.25,
            field: value,
        }
    ]

    result = TimerManager(config(), client, store).reconcile_draft(draft)  # type: ignore[arg-type]

    assert result["resolved"] is False
    assert store.load_draft(draft.draft_id).status == "outcome_unknown"
