"""Crash-aware server timer orchestration and durable record submission."""

from __future__ import annotations

import math
import uuid
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from .api import TitraClient
from .dates import (
    DateRange,
    TimerSegment,
    apply_break_to_segments,
    parse_date,
    parse_timestamp,
    split_timer_by_local_day,
)
from .durations import seconds_to_hours
from .errors import (
    AuthenticationError,
    ConfigurationError,
    ConflictError,
    NotFoundError,
    OutcomeUnknownError,
    TitraCliError,
)
from .models import ActiveTimer, PendingTimerStart, RecordDraft, ResolvedConfig, utc_now_iso
from .output import contains_secret, redact_sensitive
from .state import StateStore

V6_IDEMPOTENCY_RETENTION_SECONDS = 604_800
V6_IDEMPOTENCY_RETRY_SAFETY_SECONDS = 600
V6_IDEMPOTENCY_RETRY_CUTOFF_SECONDS = (
    V6_IDEMPOTENCY_RETENTION_SECONDS - V6_IDEMPOTENCY_RETRY_SAFETY_SECONDS
)
V6_TIMER_START_REPLAY_RETENTION_SECONDS = 604_800
V6_TIMER_START_REPLAY_SAFETY_SECONDS = 600
V6_TIMER_START_REPLAY_CUTOFF_SECONDS = (
    V6_TIMER_START_REPLAY_RETENTION_SECONDS - V6_TIMER_START_REPLAY_SAFETY_SECONDS
)
_TIME_ENTRY_CREATE_REQUIRED_FIELDS = frozenset({"projectId", "task", "date", "hours"})
_TIME_ENTRY_CREATE_OPTIONAL_FIELDS = frozenset({"startTime", "taskRate", "customfields"})
_TIME_ENTRY_STORAGE_FIELDS = frozenset(
    {
        "_id",
        "userId",
        "projectId",
        "date",
        "dateOnly",
        "startTime",
        "dateRevision",
        "hours",
        "task",
        "taskRate",
        "state",
        "lastUsed",
        "name",
        "createdAt",
        "updatedAt",
    }
)


def _same_json_value(left: Any, right: Any) -> bool:
    """Compare JSON values using JavaScript-number rather than Python-bool semantics."""

    if isinstance(left, bool) or isinstance(right, bool):
        return type(left) is bool and type(right) is bool and left is right
    if type(left) in {int, float} and type(right) in {int, float}:
        return math.isfinite(float(left)) and math.isfinite(float(right)) and left == right
    if type(left) is not type(right):
        return False
    if isinstance(left, list):
        return len(left) == len(right) and all(
            _same_json_value(left_item, right_item)
            for left_item, right_item in zip(left, right, strict=True)
        )
    if isinstance(left, dict):
        return set(left) == set(right) and all(
            _same_json_value(left[key], right[key]) for key in left
        )
    return bool(left == right)


def _matches_time_entry_create(
    entry: dict[str, Any],
    payload: dict[str, Any],
    *,
    owner_id: str,
) -> bool:
    """Match every material create field using the server's stored representation."""

    if (
        set(payload) - _TIME_ENTRY_CREATE_OPTIONAL_FIELDS != _TIME_ENTRY_CREATE_REQUIRED_FIELDS
        or not isinstance(entry.get("_id"), str)
        or not entry["_id"]
        or entry.get("userId") != owner_id
        or not isinstance(payload.get("projectId"), str)
        or entry.get("projectId") != payload["projectId"]
        or not isinstance(payload.get("task"), str)
        or entry.get("task") != payload["task"]
    ):
        return False
    requested_hours = payload.get("hours")
    observed_hours = entry.get("hours")
    if (
        type(requested_hours) not in {int, float}
        or type(observed_hours) not in {int, float}
        or not _same_json_value(requested_hours, observed_hours)
    ):
        return False
    requested_day = payload.get("date")
    observed_day = entry.get("dateOnly")
    if not isinstance(observed_day, str):
        observed_date = entry.get("date")
        observed_day = observed_date[:10] if isinstance(observed_date, str) else None
    if not isinstance(requested_day, str) or observed_day != requested_day:
        return False

    requested_has_start = "startTime" in payload
    observed_has_start = "startTime" in entry
    if requested_has_start != observed_has_start or (
        requested_has_start and entry.get("startTime") != payload.get("startTime")
    ):
        return False

    requested_rate = payload.get("taskRate")
    # The server intentionally omits a zero/null rate from stored records.
    if "taskRate" in payload and (
        requested_rate is not None
        and (type(requested_rate) not in {int, float} or not math.isfinite(float(requested_rate)))
    ):
        return False
    requested_has_rate = (
        "taskRate" in payload and requested_rate is not None and requested_rate != 0
    )
    observed_has_rate = "taskRate" in entry
    if requested_has_rate != observed_has_rate or (
        requested_has_rate and not _same_json_value(requested_rate, entry.get("taskRate"))
    ):
        return False

    requested_custom = payload.get("customfields", {})
    if requested_custom is None:
        requested_custom = {}
    if not isinstance(requested_custom, dict):
        return False
    expected_custom = {
        key: value
        for key, value in requested_custom.items()
        if key not in _TIME_ENTRY_STORAGE_FIELDS
    }
    observed_custom = {
        key: value for key, value in entry.items() if key not in _TIME_ENTRY_STORAGE_FIELDS
    }
    return _same_json_value(expected_custom, observed_custom)


def assert_idempotency_retry_within_retention(
    client: TitraClient,
    first_submitted_at: str,
    *,
    now: datetime | None = None,
) -> None:
    """Refuse a replay once the server's advertised duplicate-suppression window may have ended."""

    capabilities = getattr(client, "capabilities", None)
    if not callable(capabilities):
        raise ConfigurationError(
            "Cannot verify the server idempotency retention contract; refusing retry."
        )
    document = capabilities()
    contract = document.get("idempotency") if isinstance(document, dict) else None
    if (
        not isinstance(document, dict)
        or document.get("apiVersion") not in {1, 2}
        or not isinstance(contract, dict)
        or contract.get("version") != 1
        or contract.get("retentionSeconds") != V6_IDEMPOTENCY_RETENTION_SECONDS
    ):
        raise ConfigurationError(
            "The server does not advertise the required 604800-second idempotency retention "
            "contract; refusing retry."
        )
    submitted_at = parse_timestamp(first_submitted_at).astimezone(UTC)
    current = (now or datetime.now(UTC)).astimezone(UTC)
    age_seconds = (current - submitted_at).total_seconds()
    if age_seconds < 0:
        raise ConfigurationError(
            "The saved first-submission timestamp is in the future; refusing retry."
        )
    if age_seconds >= V6_IDEMPOTENCY_RETRY_CUTOFF_SECONDS:
        raise ConflictError(
            "The original request is within the final 600 seconds of the guaranteed "
            "604800-second idempotency retention window. It was left untouched; "
            "reconcile it manually instead of replaying the key."
        )


def assert_timer_start_retry_within_retention(
    client: TitraClient,
    created_at: str,
    *,
    now: datetime | None = None,
) -> None:
    """Require the exact consumed-ID contract and a safe remaining replay window."""

    capabilities = getattr(client, "capabilities", None)
    if not callable(capabilities):
        raise ConfigurationError(
            "Cannot verify the timer-start replay contract; refusing recovery."
        )
    document = capabilities()
    features = document.get("features") if isinstance(document, dict) else None
    timers = features.get("timers") if isinstance(features, dict) else None
    contracts = document.get("contracts") if isinstance(document, dict) else None
    contract = contracts.get("timerStartReplay") if isinstance(contracts, dict) else None
    expected_contract = {
        "version": 1,
        "scope": "user",
        "activeReplay": "returnExisting",
        "consumedReplay": "conflict",
        "consumedErrorCode": "timer-operation-consumed",
        "retentionSeconds": V6_TIMER_START_REPLAY_RETENTION_SECONDS,
        "clientSafetyMarginSeconds": V6_TIMER_START_REPLAY_SAFETY_SECONDS,
    }
    if (
        not isinstance(document, dict)
        or document.get("apiVersion") != 2
        or not isinstance(timers, dict)
        or timers.get("atomicTransitions") != 2
        or contract != expected_contract
    ):
        raise ConfigurationError(
            "The server does not advertise the required consumed timer-start replay contract; "
            "refusing recovery."
        )
    reserved_at = parse_timestamp(created_at).astimezone(UTC)
    current = (now or datetime.now(UTC)).astimezone(UTC)
    age_seconds = (current - reserved_at).total_seconds()
    if age_seconds < 0:
        raise ConfigurationError(
            "The pending timer-start timestamp is in the future; refusing recovery."
        )
    if age_seconds >= V6_TIMER_START_REPLAY_CUTOFF_SECONDS:
        raise ConflictError(
            "The pending timer start is within the final 600 seconds of the guaranteed "
            "604800-second replay window. It was left untouched; inspect the server rather "
            "than replaying its operation ID."
        )


def assert_expected_identity(client: TitraClient, config: ResolvedConfig) -> dict[str, Any]:
    user = client.current_user()
    expected = config.username
    if expected and str(user.get("name") or "").casefold() != expected.casefold():
        raise AuthenticationError(
            f"API key belongs to {user.get('name')!r}, not configured username {expected!r}."
        )
    if not isinstance(user.get("_id"), str) or not user["_id"]:
        raise AuthenticationError(
            "Titra did not return the immutable current-user ID required for safe writes."
        )
    expected_user_id = getattr(client, "expected_user_id", None)
    if expected_user_id is not None and user["_id"] != expected_user_id:
        raise ConflictError(
            "API key now belongs to a different API user than the immutable expected user ID."
        )
    bind = getattr(client, "bind_expected_user_id", None)
    if callable(bind):
        bind(user["_id"])
    return user


class TimerManager:
    def __init__(
        self,
        config: ResolvedConfig,
        client: TitraClient,
        store: StateStore,
        *,
        now: Callable[[], datetime] | None = None,
    ) -> None:
        self.config = config
        self.client = client
        self.store = store
        self.store.add_secret(config.api_key)
        self.now = now or (lambda: datetime.now(UTC))

    def _authenticated_owner_id(self) -> str:
        user = assert_expected_identity(self.client, self.config)
        return str(user["_id"])

    @staticmethod
    def _assert_state_owner(
        saved_owner_id: str | None,
        current_owner_id: str,
        *,
        state_name: str,
    ) -> None:
        if saved_owner_id is None:
            raise ConflictError(
                f"{state_name} predates immutable user binding and cannot be used safely. "
                "Inspect it explicitly; it will not be rebound automatically."
            )
        if saved_owner_id != current_owner_id:
            raise ConflictError(
                f"{state_name} belongs to a different API user and was left untouched. "
                "Use a separate profile/state directory or explicitly inspect recovery state."
            )

    def _load_active_timer(self, *, allow_legacy_unbound: bool = False) -> ActiveTimer | None:
        try:
            return self.store.load_active_timer(
                self.config,
                allow_legacy_unbound=allow_legacy_unbound,
            )
        except NotFoundError:
            return None

    def validate_draft_access(self, draft: RecordDraft) -> str:
        """Bind every draft operation to its original profile, server, and immutable user."""

        if draft.profile != self.config.profile or draft.server.rstrip(
            "/"
        ) != self.config.server.rstrip("/"):
            raise ConflictError("Draft belongs to a different Titra profile or server.")
        owner_id = self._authenticated_owner_id()
        self._assert_state_owner(
            draft.owner_id,
            owner_id,
            state_name="Record draft",
        )
        return owner_id

    def _reload_unchanged_draft(self, expected: RecordDraft) -> RecordDraft:
        current = self.store.load_draft(expected.draft_id)
        if current.to_dict() != expected.to_dict():
            raise ConflictError(
                f"Draft {expected.draft_id} changed after it was loaded; inspect it again "
                "before retrying the operation."
            )
        return current

    def start(
        self,
        *,
        project_id: str | None = None,
        task: str | None = None,
        operation_id: str | None = None,
    ) -> ActiveTimer:
        owner_id = self._authenticated_owner_id()
        active = self._load_active_timer()
        if active is not None:
            self._assert_state_owner(
                active.owner_id,
                owner_id,
                state_name="Local active-timer state",
            )
        atomic_check = getattr(self.client, "supports_atomic_timers", None)
        atomic = bool(atomic_check and atomic_check())
        if not atomic:
            if operation_id is not None:
                raise ConfigurationError(
                    "An explicit timer operation ID requires the v6 atomic-timer contract."
                )
            self.client.timer_start()
            # Current legacy Titra versions return an empty start payload; GET is authoritative.
            return self._save_server_timer(
                self.client.timer_get(),
                owner_id=owner_id,
                project_id=project_id,
                task=task,
            )

        existing = self._load_pending_start()
        if existing is not None:
            self._assert_state_owner(
                existing.owner_id,
                owner_id,
                state_name="Pending timer-start state",
            )
            newly_reserved = False
            if operation_id is not None and existing.operation_id != operation_id:
                raise ConflictError(
                    "A different v6 timer start is pending recovery; retry its exact operation "
                    "ID or inspect timer status."
                )
            if existing.project_id != project_id or existing.task != task:
                raise ConflictError(
                    "A v6 timer start with different project/task metadata is pending recovery; "
                    "local state was not replaced."
                )
            pending = existing
        else:
            pending = PendingTimerStart(
                version=1,
                profile=self.config.profile,
                server=self.config.server,
                operation_id=operation_id or uuid.uuid4().hex,
                created_at=utc_now_iso(),
                owner_id=owner_id,
                project_id=project_id,
                task=task,
            )
            # This compare-and-create is the last local step before POST. If it fails,
            # no server mutation is attempted; another process's intent is never replaced.
            newly_reserved = self.store.reserve_pending_timer_start(self.config, pending)

        return self._attempt_pending_start(
            pending,
            owner_id=owner_id,
            newly_reserved=newly_reserved,
        )

    def _load_pending_start(
        self, *, allow_legacy_unbound: bool = False
    ) -> PendingTimerStart | None:
        try:
            return self.store.load_pending_timer_start(
                self.config,
                allow_legacy_unbound=allow_legacy_unbound,
            )
        except NotFoundError:
            return None

    @staticmethod
    def _pending_unknown(
        pending: PendingTimerStart,
        original: OutcomeUnknownError | TitraCliError,
    ) -> OutcomeUnknownError:
        details = dict(original.details) if isinstance(original.details, dict) else {}
        details.update(
            {
                "pending_start": True,
                "operation_id": pending.operation_id,
                "project_id": pending.project_id,
                "task": pending.task,
            }
        )
        return OutcomeUnknownError(
            f"The v6 timer-start outcome is still unknown. Operation ID "
            f"{pending.operation_id!r} and its project/task metadata are saved locally; inspect "
            "timer status or retry the same start to reconcile it safely.",
            details,
        )

    def _attempt_pending_start(
        self,
        pending: PendingTimerStart,
        *,
        owner_id: str,
        newly_reserved: bool,
    ) -> ActiveTimer:
        self._assert_state_owner(
            pending.owner_id,
            owner_id,
            state_name="Pending timer-start state",
        )
        if not newly_reserved:
            assert_timer_start_retry_within_retention(
                self.client,
                pending.created_at,
                now=self.now(),
            )
        try:
            self.client.timer_start(operation_id=pending.operation_id)
        except OutcomeUnknownError as unknown:
            try:
                server_timer = self.client.timer_get()
            except TitraCliError as observation_error:
                raise self._pending_unknown(pending, unknown) from observation_error
        except TitraCliError as error:
            # A definite rejection of the first attempt cannot later commit. An intent
            # inherited after a crash remains journaled because an older request may still
            # be in flight. The exact consumed-operation code is the one inherited
            # rejection that proves the server's durable ledger has resolved that intent.
            consumed_operation = isinstance(error, ConflictError) and error.details == {
                "statusCode": 409,
                "message": "This timer start operation was already used.",
                "payload": {"code": "timer-operation-consumed"},
            }
            if newly_reserved or consumed_operation:
                self.store.clear_pending_timer_start(
                    self.config, expected_operation_id=pending.operation_id
                )
            raise
        else:
            try:
                # GET remains authoritative if the start response is empty or changed shape.
                server_timer = self.client.timer_get()
            except TitraCliError as observation_error:
                raise self._pending_unknown(pending, observation_error) from observation_error
        return self._promote_pending_start(pending, server_timer, owner_id=owner_id)

    def recover_start(self) -> ActiveTimer:
        """Reconcile or replay the exact durable v6 start operation after interruption."""

        owner_id = self._authenticated_owner_id()
        pending = self.store.load_pending_timer_start(self.config)
        self._assert_state_owner(
            pending.owner_id,
            owner_id,
            state_name="Pending timer-start state",
        )
        atomic_check = getattr(self.client, "supports_atomic_timers", None)
        if not bool(atomic_check and atomic_check()):
            raise ConfigurationError(
                "Pending timer-start recovery requires the v6 atomic-timer contract."
            )
        try:
            server_timer = self.client.timer_get()
        except NotFoundError:
            return self._attempt_pending_start(
                pending,
                owner_id=owner_id,
                newly_reserved=False,
            )
        return self._promote_pending_start(pending, server_timer, owner_id=owner_id)

    def _save_server_timer(
        self,
        server_timer: dict[str, Any],
        *,
        owner_id: str,
        project_id: str | None,
        task: str | None,
        expected_timer_id: str | None = None,
    ) -> ActiveTimer:
        if contains_secret(server_timer, self.config.api_key):
            raise OutcomeUnknownError(
                "Titra returned timer state containing the configured credential; local state "
                "was not changed. Inspect the server timer before continuing."
            )
        observed_id = server_timer.get("timerId")
        if observed_id is not None and not isinstance(observed_id, str):
            raise ConfigurationError("Titra returned an invalid timer ID.")
        if expected_timer_id is not None and observed_id != expected_timer_id:
            raise ConflictError(
                "A different timer is active after the start request; local state was not changed."
            )
        started_at = server_timer.get("startTime")
        if not isinstance(started_at, str):
            raise ConfigurationError("Titra timer did not return a valid start timestamp.")
        timer = ActiveTimer(
            version=1,
            profile=self.config.profile,
            server=self.config.server,
            started_at=started_at,
            owner_id=owner_id,
            project_id=project_id,
            task=task,
            timer_id=observed_id if isinstance(observed_id, str) else None,
        )
        self.store.save_active_timer(self.config, timer)
        return timer

    def _promote_pending_start(
        self,
        pending: PendingTimerStart,
        server_timer: dict[str, Any],
        *,
        owner_id: str,
    ) -> ActiveTimer:
        self._assert_state_owner(
            pending.owner_id,
            owner_id,
            state_name="Pending timer-start state",
        )
        observed_id = server_timer.get("timerId")
        if observed_id != pending.operation_id:
            raise ConflictError(
                "A different timer is active while a v6 timer start remains pending; neither "
                "local state nor the pending intent was changed."
            )
        local = self._load_active_timer()
        if local is not None:
            self._assert_state_owner(
                local.owner_id,
                owner_id,
                state_name="Local active-timer state",
            )
        timer = self._save_server_timer(
            server_timer,
            owner_id=owner_id,
            project_id=pending.project_id,
            task=pending.task,
            expected_timer_id=pending.operation_id,
        )
        # Saving active state precedes deletion. A crash between these operations leaves
        # redundant, fully identifiable state that a later status call can finalize again.
        self.store.clear_pending_timer_start(
            self.config, expected_operation_id=pending.operation_id
        )
        return timer

    def adopt(
        self,
        *,
        project_id: str | None = None,
        task: str | None = None,
        expected_timer_id: str | None = None,
        expected_start_time: str | None = None,
    ) -> ActiveTimer:
        owner_id = self._authenticated_owner_id()
        guarded_adoption = expected_timer_id is not None or expected_start_time is not None
        pending = self._load_pending_start(allow_legacy_unbound=guarded_adoption)
        if pending is not None:
            self._assert_state_owner(
                pending.owner_id,
                owner_id,
                state_name="Pending timer-start state",
            )
        local = self._load_active_timer(allow_legacy_unbound=guarded_adoption)
        if local is not None:
            try:
                self._assert_state_owner(
                    local.owner_id,
                    owner_id,
                    state_name="Local active-timer state",
                )
            except ConflictError:
                # An exact server snapshot is the explicit migration path for state
                # created before owner binding or left behind after credential rotation.
                if expected_timer_id is None and expected_start_time is None:
                    raise
        server_timer = self.client.timer_get()
        server_timer_id = server_timer.get("timerId")
        if (expected_timer_id is not None and server_timer_id != expected_timer_id) or (
            expected_start_time is not None and server_timer.get("startTime") != expected_start_time
        ):
            raise ConflictError(
                "The server timer changed before it could be adopted; local state was not changed."
            )
        if pending is not None and server_timer_id == pending.operation_id:
            if (project_id is not None and project_id != pending.project_id) or (
                task is not None and task != pending.task
            ):
                raise ConflictError(
                    "This is the recovered pending timer; its saved project/task metadata was "
                    "not replaced."
                )
            return self._promote_pending_start(pending, server_timer, owner_id=owner_id)
        if pending is not None and expected_timer_id is None and expected_start_time is None:
            raise ConflictError(
                "A different timer-start operation is pending. Supply the exact current timer "
                "ID or start time to adopt without discarding the pending intent."
            )
        return self._save_server_timer(
            server_timer,
            owner_id=owner_id,
            project_id=project_id,
            task=task,
        )

    def _local_or_adopt(
        self,
        *,
        owner_id: str,
        expected_timer_id: str | None = None,
        expected_start_time: str | None = None,
    ) -> ActiveTimer:
        guarded_adoption = expected_timer_id is not None or expected_start_time is not None
        pending = self._load_pending_start(allow_legacy_unbound=guarded_adoption)
        if pending is not None:
            self._assert_state_owner(
                pending.owner_id,
                owner_id,
                state_name="Pending timer-start state",
            )
        local = self._load_active_timer(allow_legacy_unbound=guarded_adoption)
        if local is None:
            if expected_timer_id is None and expected_start_time is None:
                raise ConflictError(
                    "No locally bound timer exists. Inspect the server timer, then use timer "
                    "adopt or supply its exact timer ID/start time before changing it."
                )
            return self.adopt(
                expected_timer_id=expected_timer_id,
                expected_start_time=expected_start_time,
            )
        self._assert_state_owner(
            local.owner_id,
            owner_id,
            state_name="Local active-timer state",
        )
        return local

    @staticmethod
    def _assert_same_timer(timer: ActiveTimer, server: dict[str, Any]) -> None:
        server_timer_id = server.get("timerId")
        if server_timer_id is not None and not isinstance(server_timer_id, str):
            raise ConfigurationError("Titra returned an invalid timer ID.")
        if timer.timer_id != server_timer_id:
            raise ConflictError(
                "The server timer differs from the locally tracked timer. It was left untouched; "
                "explicitly adopt the current timer before changing or stopping it."
            )

    def status(self) -> dict[str, Any]:
        owner_id = self._authenticated_owner_id()
        pending = self._load_pending_start()
        if pending is not None:
            self._assert_state_owner(
                pending.owner_id,
                owner_id,
                state_name="Pending timer-start state",
            )
        local = self._load_active_timer()
        if local is not None:
            self._assert_state_owner(
                local.owner_id,
                owner_id,
                state_name="Local active-timer state",
            )
        try:
            server = self.client.timer_get()
        except NotFoundError as not_found:
            if pending is not None:
                raise self._pending_unknown(pending, not_found) from not_found
            raise
        if pending is not None and server.get("timerId") == pending.operation_id:
            local = self._promote_pending_start(pending, server, owner_id=owner_id)
        elif local is None:
            if pending is not None:
                raise ConflictError(
                    "A different server timer is active while a v6 start is pending; use a "
                    "guarded adopt before changing either state."
                )
            duration_ms = int(server.get("duration") or 0)
            return {
                "running": True,
                "bound": False,
                "timerId": server.get("timerId"),
                "revision": server.get("revision"),
                "startTime": server.get("startTime"),
                "elapsed_seconds": max(0, duration_ms // 1000),
                "paused": False,
                "projectId": None,
                "task": None,
                "phase": "unbound",
            }
        self._assert_same_timer(local, server)
        duration_ms = int(server.get("duration") or 0)
        paused_seconds = self._paused_seconds(local, stop=self.now())
        return {
            "running": True,
            "bound": True,
            "timerId": server.get("timerId"),
            "revision": server.get("revision"),
            "startTime": server.get("startTime"),
            "elapsed_seconds": max(0, duration_ms // 1000 - paused_seconds),
            "paused": local.paused_at is not None,
            "projectId": local.project_id,
            "task": local.task,
            "phase": local.phase,
        }

    def pause(self) -> ActiveTimer:
        owner_id = self._authenticated_owner_id()
        timer = self._local_or_adopt(owner_id=owner_id)
        self._assert_same_timer(timer, self.client.timer_get())
        if timer.paused_at:
            raise ConflictError("Timer is already paused locally.")
        timer.paused_at = self.now().isoformat()
        self.store.save_active_timer(self.config, timer)
        return timer

    def resume(self) -> ActiveTimer:
        owner_id = self._authenticated_owner_id()
        timer = self._local_or_adopt(owner_id=owner_id)
        self._assert_same_timer(timer, self.client.timer_get())
        if not timer.paused_at:
            raise ConflictError("Timer is not paused.")
        timer.pauses.append({"start": timer.paused_at, "end": self.now().isoformat()})
        timer.paused_at = None
        self.store.save_active_timer(self.config, timer)
        return timer

    @staticmethod
    def _pause_intervals(timer: ActiveTimer, *, stop: datetime) -> list[tuple[datetime, datetime]]:
        intervals: list[tuple[datetime, datetime]] = []
        for pause in timer.pauses:
            intervals.append((parse_timestamp(pause["start"]), parse_timestamp(pause["end"])))
        if timer.paused_at:
            intervals.append((parse_timestamp(timer.paused_at), stop))
        return intervals

    def _paused_seconds(self, timer: ActiveTimer, *, stop: datetime) -> int:
        total = 0
        for start, end in self._pause_intervals(timer, stop=stop):
            if end > start:
                total += round((end.astimezone(UTC) - start.astimezone(UTC)).total_seconds())
        return total

    def capture_stop(
        self,
        *,
        expected_timer_id: str | None = None,
        expected_start_time: str | None = None,
        discard: bool = False,
    ) -> RecordDraft:
        if type(discard) is not bool:
            raise ConfigurationError("Timer-stop discard intent must be a boolean.")
        owner_id = self._authenticated_owner_id()
        timer = self._local_or_adopt(
            owner_id=owner_id,
            expected_timer_id=expected_timer_id,
            expected_start_time=expected_start_time,
        )
        get_snapshot = getattr(self.client, "timer_get_snapshot", None)
        stop_snapshot = getattr(self.client, "timer_stop_snapshot", None)
        guarded_snapshot: dict[str, Any] | None = None
        guarded_etag: str | None = None
        if callable(get_snapshot) and callable(stop_snapshot):
            guarded_snapshot, guarded_etag = get_snapshot()
            self._assert_same_timer(timer, guarded_snapshot)
        elif expected_start_time is not None:
            guarded_snapshot = self.client.timer_get()
            self._assert_same_timer(timer, guarded_snapshot)
        if expected_timer_id is not None:
            if guarded_snapshot is None:
                raise ConfigurationError(
                    "An expected timer ID requires the v6 atomic-timer contract."
                )
            if guarded_snapshot.get("timerId") != expected_timer_id or not isinstance(
                guarded_etag, str
            ):
                raise ConflictError(
                    "The active timer ID/revision does not match the guarded stop; "
                    "no stop was attempted."
                )
        if expected_start_time is not None and (
            guarded_snapshot is None or guarded_snapshot.get("startTime") != expected_start_time
        ):
            raise ConflictError(
                "The active timer start time does not match the reviewed stop; "
                "no stop was attempted."
            )
        timer.phase = "pending_stop"
        self.store.save_active_timer(self.config, timer)
        draft = self.store.create_draft(
            self.config,
            [],
            owner_id=owner_id,
            timer={
                "active": timer.to_dict(),
                "phase": "pending_stop",
                "discard_after_stop": discard,
            },
            note="Timer stop was journaled before contacting Titra.",
        )
        draft.status = "pending_stop"
        self.store.save_draft(draft)
        with self.store.draft_operation_lock(draft.draft_id):
            draft = self.store.load_draft(draft.draft_id)
            if (
                draft.status != "pending_stop"
                or not isinstance(draft.timer, dict)
                or draft.timer.get("phase") != "pending_stop"
            ):
                raise ConflictError(
                    "The timer-stop draft changed before dispatch; no stop was attempted."
                )
            try:
                if callable(get_snapshot) and callable(stop_snapshot):
                    if guarded_snapshot is None:
                        raise ConfigurationError("Titra did not return a guarded timer snapshot.")
                    server_snapshot, server_etag = guarded_snapshot, guarded_etag
                    if isinstance(server_etag, str) and "timerId" in server_snapshot:
                        # Persist the exact CAS request before POST. A v6 server keeps
                        # a bounded receipt for this tuple, so a lost response can be
                        # retried without guessing which timer was stopped.
                        draft.timer = {
                            "active": timer.to_dict(),
                            "phase": "stopping",
                            "discard_after_stop": discard,
                            "stop_request": {
                                "timerId": server_snapshot["timerId"],
                                "etag": server_etag,
                            },
                        }
                        self.store.save_draft(draft)
                    stopped = stop_snapshot(server_snapshot, server_etag)
                else:
                    stopped = self.client.timer_stop()
            except OutcomeUnknownError as exc:
                draft.status = "outcome_unknown"
                draft.note = (
                    "The timer stop response was lost. Check server timer status before "
                    "deciding how to recover."
                )
                self.store.save_draft(draft)
                raise OutcomeUnknownError(str(exc), {"draft_id": draft.draft_id}) from exc

            return self._finalize_stopped_timer(draft, timer, stopped)

    def _finalize_stopped_timer(
        self,
        draft: RecordDraft,
        timer: ActiveTimer,
        stopped: dict[str, Any],
        *,
        allow_replayed_receipt: bool = False,
    ) -> RecordDraft:
        self._assert_state_owner(
            draft.owner_id,
            str(timer.owner_id or ""),
            state_name="Timer draft",
        )
        if contains_secret(stopped, self.config.api_key):
            draft.status = "outcome_unknown"
            draft.note = (
                "Titra returned a timer-stop receipt containing the configured credential; "
                "the receipt was not persisted."
            )
            self.store.save_draft(draft)
            raise OutcomeUnknownError(draft.note, {"draft_id": draft.draft_id})
        stop_request = draft.timer.get("stop_request") if isinstance(draft.timer, dict) else None
        discard_after_stop = (
            draft.timer.get("discard_after_stop", False) if isinstance(draft.timer, dict) else False
        )
        if type(discard_after_stop) is not bool:
            draft.status = "outcome_unknown"
            draft.note = (
                "The saved timer-stop intent has an invalid discard marker; inspect it before "
                "continuing."
            )
            self.store.save_draft(draft)
            raise OutcomeUnknownError(draft.note, {"draft_id": draft.draft_id})

        started_at = stopped.get("startTime")
        duration_ms = stopped.get("duration")
        stopped_timer_id = stopped.get("timerId")
        if timer.timer_id is not None and stopped_timer_id != timer.timer_id:
            draft.status = "outcome_unknown"
            draft.note = (
                "Titra returned a stop receipt for a different timer; inspect server state."
            )
            self.store.save_draft(draft)
            raise OutcomeUnknownError(draft.note, {"draft_id": draft.draft_id})
        changed = stopped.get("changed")
        if isinstance(stop_request, dict) and type(changed) is not bool:
            draft.status = "outcome_unknown"
            draft.note = (
                "Titra returned an invalid changed flag for a guarded timer stop; inspect or "
                "recover the exact saved request."
            )
            self.store.save_draft(draft)
            raise OutcomeUnknownError(draft.note, {"draft_id": draft.draft_id})
        if not isinstance(started_at, str) or not isinstance(duration_ms, (int, float)):
            draft.status = "outcome_unknown"
            draft.note = "Titra stopped the timer but returned invalid timing information."
            self.store.save_draft(draft)
            raise OutcomeUnknownError(draft.note, {"draft_id": draft.draft_id})
        if changed is False and not allow_replayed_receipt:
            draft.status = "discarded"
            draft.timer = {
                "phase": "replayed_stop_receipt",
                "active": timer.to_dict(),
                "stop_request": stop_request,
                "receipt": stopped,
            }
            draft.note = (
                "Titra returned an already-used timer-stop receipt to a newly captured stop. "
                "No record draft was created; only draft recover-stop may consume a replayed "
                "receipt after a lost response."
            )
            self.store.save_draft(draft)
            self.store.clear_active_timer(self.config)
            raise ConflictError(draft.note)
        started = parse_timestamp(started_at)
        stopped_at_value = stopped.get("stoppedAt")
        stopped_at = (
            parse_timestamp(stopped_at_value)
            if isinstance(stopped_at_value, str)
            else started.astimezone(UTC) + timedelta(milliseconds=float(duration_ms))
        )
        timer_data = {
            "started_at": started.isoformat(),
            "stopped_at": stopped_at.isoformat(),
            "server_duration_ms": float(duration_ms),
            "project_id": timer.project_id,
            "task": timer.task,
            "discard_after_stop": discard_after_stop,
            "pauses": [
                {"start": start.isoformat(), "end": end.isoformat()}
                for start, end in self._pause_intervals(timer, stop=stopped_at)
            ],
        }
        if isinstance(stop_request, dict):
            timer_data["stop_request"] = stop_request
        draft.timer = timer_data
        if discard_after_stop:
            draft.status = "discarded"
            draft.note = "Timer cancelled by operator; timing data retained in this local receipt."
        else:
            draft.status = "pending"
            draft.note = "Stopped timer captured; record details have not yet been submitted."
        self.store.save_draft(draft)
        self.store.clear_active_timer(self.config)
        return draft

    def recover_stop(self, draft: RecordDraft) -> RecordDraft:
        with self.store.draft_operation_lock(draft.draft_id):
            current = self._reload_unchanged_draft(draft)
            return self._recover_stop_locked(current)

    def _recover_stop_locked(self, draft: RecordDraft) -> RecordDraft:
        owner_id = self.validate_draft_access(draft)
        if draft.status not in {"outcome_unknown", "pending_stop"} or not isinstance(
            draft.timer, dict
        ):
            raise ConflictError(
                "Only an interrupted or outcome-unknown v6 timer stop can be recovered."
            )
        active_value = draft.timer.get("active")
        stop_request = draft.timer.get("stop_request")
        if not isinstance(active_value, dict) or not isinstance(stop_request, dict):
            raise ConflictError(
                "This timer draft predates recoverable v6 stop receipts; "
                "inspect the server manually."
            )
        if "timerId" not in stop_request or not isinstance(stop_request.get("etag"), str):
            raise ConflictError("The timer draft does not contain an exact v6 stop request.")
        discard_after_stop = draft.timer.get("discard_after_stop", False)
        if type(discard_after_stop) is not bool:
            raise ConflictError("The timer draft contains an invalid discard-after-stop intent.")
        if draft.status == "pending_stop" and draft.timer.get("phase") != "stopping":
            raise ConflictError(
                "The pending timer draft was not interrupted after a complete v6 stop request "
                "was journaled; it cannot be replayed safely."
            )
        timer = ActiveTimer.from_dict(active_value)
        if timer.profile != self.config.profile or timer.server.rstrip(
            "/"
        ) != self.config.server.rstrip("/"):
            raise ConflictError("Saved timer state belongs to a different profile or server.")
        self._assert_state_owner(
            timer.owner_id,
            owner_id,
            state_name="Saved timer-stop state",
        )
        stop_snapshot = getattr(self.client, "timer_stop_snapshot", None)
        if not callable(stop_snapshot):
            raise ConflictError("This client cannot recover a v6 timer stop.")
        try:
            stopped = stop_snapshot({"timerId": stop_request["timerId"]}, stop_request["etag"])
        except OutcomeUnknownError as exc:
            draft.note = (
                "The exact v6 timer-stop retry also lost its response; retry this recovery."
            )
            self.store.save_draft(draft)
            raise OutcomeUnknownError(str(exc), {"draft_id": draft.draft_id}) from exc
        return self._finalize_stopped_timer(
            draft,
            timer,
            stopped,
            allow_replayed_receipt=True,
        )

    def prepare_timer_draft(
        self,
        draft: RecordDraft,
        *,
        project_id: str,
        task: str,
        break_seconds: int = 0,
        exact_seconds: int | None = None,
        split_midnight: bool = False,
    ) -> RecordDraft:
        with self.store.draft_operation_lock(draft.draft_id):
            current = self._reload_unchanged_draft(draft)
            return self._prepare_timer_draft_locked(
                current,
                project_id=project_id,
                task=task,
                break_seconds=break_seconds,
                exact_seconds=exact_seconds,
                split_midnight=split_midnight,
            )

    def _prepare_timer_draft_locked(
        self,
        draft: RecordDraft,
        *,
        project_id: str,
        task: str,
        break_seconds: int,
        exact_seconds: int | None,
        split_midnight: bool,
    ) -> RecordDraft:
        self.validate_draft_access(draft)
        if draft.status not in {"pending", "pending_stop"}:
            raise ConflictError(f"Draft {draft.draft_id} cannot be edited in state {draft.status}.")
        if draft.first_submitted_at is not None or draft.result_ids:
            raise ConflictError(
                "Draft submission has already started; its payload and idempotency keys cannot "
                "be changed. Reconcile or submit only the unchanged remainder."
            )
        if not draft.timer:
            raise ConfigurationError("Draft is not associated with a stopped timer.")
        started = parse_timestamp(str(draft.timer["started_at"]))
        stopped = parse_timestamp(str(draft.timer["stopped_at"]))
        pauses = [
            (parse_timestamp(value["start"]), parse_timestamp(value["end"]))
            for value in draft.timer.get("pauses", [])
        ]
        segments = split_timer_by_local_day(
            started_at=started,
            stopped_at=stopped,
            timezone_name=self.config.timezone,
            pauses=pauses,
        )
        if exact_seconds is not None:
            if exact_seconds <= 0:
                raise ConfigurationError("Exact duration must be greater than zero.")
            if break_seconds:
                raise ConfigurationError(
                    "Use either an exact duration or a break subtraction, not both."
                )
            if segments:
                first = segments[0]
            else:
                local_start = started.astimezone(ZoneInfo(self.config.timezone))
                first = TimerSegment(
                    local_start.date(), local_start.time().replace(tzinfo=None), exact_seconds
                )
            segments = [TimerSegment(first.calendar_date, first.start_time, exact_seconds)]
        else:
            segments = apply_break_to_segments(segments, break_seconds)
            if not split_midnight and len(segments) > 1:
                first = segments[0]
                segments = [
                    type(first)(
                        first.calendar_date,
                        first.start_time,
                        sum(item.seconds for item in segments),
                    )
                ]
        draft.payloads = [
            {
                "projectId": project_id,
                "task": task,
                "date": segment.calendar_date.isoformat(),
                "startTime": segment.start_time.strftime("%H:%M"),
                "hours": seconds_to_hours(segment.seconds),
            }
            for segment in segments
        ]
        if not draft.payloads:
            raise ConfigurationError("The adjusted timer has no positive duration to submit.")
        while len(draft.idempotency_keys) < len(draft.payloads):
            draft.idempotency_keys.append(uuid.uuid4().hex)
        draft.idempotency_keys = draft.idempotency_keys[: len(draft.payloads)]
        draft.status = "pending"
        draft.note = "Timer draft finalized and ready for one-time submission."
        self.store.save_draft(draft)
        return draft

    def submit_draft(self, draft: RecordDraft) -> RecordDraft:
        with self.store.draft_operation_lock(draft.draft_id):
            current = self._reload_unchanged_draft(draft)
            return self._submit_draft_locked(current)

    def verify_submitted_draft_replay(
        self,
        draft: RecordDraft,
        *,
        expected_result_ids: list[str],
    ) -> dict[str, Any]:
        """Replay completed v6 creates without changing their original draft evidence."""

        with self.store.draft_operation_lock(draft.draft_id):
            current = self._reload_unchanged_draft(draft)
            self.validate_draft_access(current)
            if current.status != "submitted":
                raise ConflictError("Only a fully submitted draft can be replay-verified.")
            if (
                not current.payloads
                or len(current.payloads) != len(current.result_ids)
                or len(current.payloads) != len(current.idempotency_keys)
                or any(not isinstance(item, str) or not item for item in current.result_ids)
            ):
                raise ConfigurationError(
                    "Submitted draft lacks a complete payload, result-ID, and idempotency-key set."
                )
            if expected_result_ids != current.result_ids:
                raise ConflictError(
                    "--expect-result-id values do not match the draft's stored result IDs."
                )
            first_submitted_at = current.first_submitted_at
            if not isinstance(first_submitted_at, str) or not first_submitted_at:
                raise ConfigurationError(
                    "Submitted draft lacks its immutable first-submission time; refusing replay."
                )
            assert_idempotency_retry_within_retention(
                self.client,
                first_submitted_at,
                now=self.now(),
            )
            marker: dict[str, Any] = {
                "status": "replay_verifying",
                "started_at": self.now().astimezone(UTC).isoformat(timespec="seconds"),
                "expected_result_ids": list(expected_result_ids),
                "verified": [],
            }
            current.replay_verification = marker
            self.store.save_draft(current)
            try:
                for payload, key, result_id in zip(
                    current.payloads,
                    current.idempotency_keys,
                    current.result_ids,
                    strict=True,
                ):
                    observed = self.client.replay_idempotent_create(
                        "timeentry.create",
                        payload,
                        idempotency_key=key,
                        expected_result_id=result_id,
                    )
                    marker["verified"].append(
                        redact_sensitive(observed, secrets=(self.config.api_key,))
                    )
                    current.replay_verification = marker
                    self.store.save_draft(current)
            except BaseException as exc:
                marker["status"] = "replay_outcome_unknown"
                marker["checked_at"] = self.now().astimezone(UTC).isoformat(timespec="seconds")
                marker["error_type"] = type(exc).__name__
                details = getattr(exc, "details", None)
                if isinstance(details, dict):
                    marker["observation"] = redact_sensitive(
                        details,
                        secrets=(self.config.api_key,),
                    )
                current.replay_verification = marker
                self.store.save_draft(current)
                raise
            marker["status"] = "verified"
            marker["checked_at"] = self.now().astimezone(UTC).isoformat(timespec="seconds")
            current.replay_verification = marker
            self.store.save_draft(current)
            return {
                "draft_id": current.draft_id,
                "status": current.status,
                "replay_status": "verified",
                "result_ids": list(current.result_ids),
                "replays": list(marker["verified"]),
            }

    def _submit_draft_locked(self, draft: RecordDraft) -> RecordDraft:
        self.validate_draft_access(draft)
        support_check = getattr(self.client, "supports_idempotent_create", None)
        idempotent = bool(support_check and support_check("timeentry.create"))
        attempted_before = bool(
            draft.first_submitted_at
            or draft.result_ids
            or draft.status in {"submitting", "outcome_unknown"}
        )
        recovery_index = (
            len(draft.result_ids)
            if idempotent and attempted_before and len(draft.result_ids) < len(draft.payloads)
            else None
        )
        if idempotent and attempted_before:
            first_submitted_at = draft.first_submitted_at or draft.created_at
            assert_idempotency_retry_within_retention(
                self.client,
                first_submitted_at,
                now=self.now(),
            )
            if draft.first_submitted_at is None:
                draft.first_submitted_at = first_submitted_at
        if idempotent and draft.status == "pending":
            while len(draft.idempotency_keys) < len(draft.payloads):
                draft.idempotency_keys.append(uuid.uuid4().hex)
            draft.idempotency_keys = draft.idempotency_keys[: len(draft.payloads)]
            if draft.first_submitted_at is None:
                draft.first_submitted_at = self.now().astimezone(UTC).isoformat(timespec="seconds")
            self.store.save_draft(draft)
        if draft.status in {"submitting", "outcome_unknown"}:
            if idempotent and len(draft.idempotency_keys) == len(draft.payloads):
                draft.status = "pending"
                draft.note = (
                    "Resuming with the same server idempotency keys; duplicate creation is "
                    "prevented during the server retention window."
                )
                self.store.save_draft(draft)
            else:
                draft.status = "outcome_unknown"
                draft.note = "A previous submission was interrupted; reconcile before retrying."
                self.store.save_draft(draft)
                raise OutcomeUnknownError(
                    "Draft outcome is unknown. Run draft reconcile; it will never be retried "
                    "automatically on this server.",
                    {"draft_id": draft.draft_id},
                )
        if draft.status != "pending" or not draft.payloads:
            raise ConflictError(f"Draft {draft.draft_id} is not ready for submission.")
        draft.status = "submitting"
        self.store.save_draft(draft)
        try:
            for index, payload in enumerate(
                draft.payloads[len(draft.result_ids) :], start=len(draft.result_ids)
            ):
                if idempotent:
                    if index == recovery_index:
                        recovered = self.client.recover_idempotent_create(
                            "timeentry.create",
                            payload,
                            idempotency_key=draft.idempotency_keys[index],
                        )
                        record_id = recovered.get("result_id")
                        if (
                            set(recovered)
                            != {
                                "operation",
                                "result_id",
                                "idempotency_replayed",
                                "idempotency_expires_at",
                            }
                            or recovered.get("operation") != "timeentry.create"
                            or not isinstance(record_id, str)
                            or not record_id
                            or type(recovered.get("idempotency_replayed")) is not bool
                            or not isinstance(recovered.get("idempotency_expires_at"), str)
                            or not recovered["idempotency_expires_at"]
                        ):
                            raise OutcomeUnknownError(
                                "Idempotent time-entry recovery returned an inconsistent result; "
                                "reconcile before retrying."
                            )
                    else:
                        record_id = self.client.create_time_entry(
                            payload, idempotency_key=draft.idempotency_keys[index]
                        )
                else:
                    record_id = self.client.create_time_entry(payload)
                draft.result_ids.append(record_id)
                self.store.save_draft(draft)
        except OutcomeUnknownError as exc:
            draft.status = "outcome_unknown"
            draft.note = "A create response was lost; reconcile before any retry."
            self.store.save_draft(draft)
            raise OutcomeUnknownError(str(exc), {"draft_id": draft.draft_id}) from exc
        except TitraCliError:
            # A received non-success response is conclusive. Already returned IDs are
            # journaled, so only the remaining payloads are eligible for a later submit.
            draft.status = "pending"
            self.store.save_draft(draft)
            raise
        except BaseException:
            # KeyboardInterrupt, SystemExit, malformed client responses, and unexpected
            # failures may occur after the server committed the POST. Preserve a state that
            # requires idempotent recovery or explicit reconciliation, never a blind v5 retry.
            draft.status = "outcome_unknown"
            draft.note = "Submission was interrupted with an unknown server outcome."
            self.store.save_draft(draft)
            raise
        draft.status = "submitted"
        draft.note = "All payloads were accepted by Titra."
        self.store.save_draft(draft)
        return draft

    def reconcile_draft(self, draft: RecordDraft) -> dict[str, Any]:
        with self.store.draft_operation_lock(draft.draft_id):
            current = self._reload_unchanged_draft(draft)
            return self._reconcile_draft_locked(current)

    def _reconcile_draft_locked(self, draft: RecordDraft) -> dict[str, Any]:
        owner_id = self.validate_draft_access(draft)
        if draft.status not in {"outcome_unknown", "submitting"}:
            raise ConflictError(
                "Only an interrupted or outcome-unknown draft needs reconciliation."
            )
        matches: list[dict[str, Any]] = []
        resolved_ids = list(draft.result_ids)
        matched_ids = set(resolved_ids)
        all_unique = True
        for payload in draft.payloads[len(draft.result_ids) :]:
            if not isinstance(payload, dict) or not isinstance(payload.get("date"), str):
                raise ConfigurationError(
                    "Draft contains a malformed time-entry create payload; refusing reconciliation."
                )
            day = payload["date"]
            candidates = self.client.list_own_time_entries(
                DateRange(parse_date(day), parse_date(day))
            )
            likely = [
                entry
                for entry in candidates
                if _matches_time_entry_create(entry, payload, owner_id=owner_id)
            ]
            matches.append({"payload": payload, "candidates": likely})
            if len(likely) != 1 or str(likely[0].get("_id")) in matched_ids:
                all_unique = False
            elif likely:
                matched_id = str(likely[0].get("_id"))
                matched_ids.add(matched_id)
                resolved_ids.append(matched_id)
        if all_unique:
            draft.result_ids = resolved_ids
            draft.status = "submitted"
            draft.note = "Submission reconciled against matching server records."
            self.store.save_draft(draft)
        return {"draft_id": draft.draft_id, "resolved": all_unique, "matches": matches}

    def mark_retryable_after_reconciliation(self, draft: RecordDraft) -> RecordDraft:
        with self.store.draft_operation_lock(draft.draft_id):
            current = self._reload_unchanged_draft(draft)
            return self._mark_retryable_after_reconciliation_locked(current)

    def _mark_retryable_after_reconciliation_locked(self, draft: RecordDraft) -> RecordDraft:
        self.validate_draft_access(draft)
        if draft.status not in {"outcome_unknown", "submitting"}:
            raise ConflictError("Draft is not outcome-unknown.")
        support_check = getattr(self.client, "supports_idempotent_create", None)
        if bool(support_check and support_check("timeentry.create")):
            first_submitted_at = draft.first_submitted_at or draft.created_at
            assert_idempotency_retry_within_retention(
                self.client,
                first_submitted_at,
                now=self.now(),
            )
            if draft.first_submitted_at is None:
                draft.first_submitted_at = first_submitted_at
        draft.status = "pending"
        draft.note = (
            f"Operator explicitly marked retryable after reconciliation at {utc_now_iso()}."
        )
        self.store.save_draft(draft)
        return draft

    def discard_draft(self, draft: RecordDraft) -> RecordDraft:
        with self.store.draft_operation_lock(draft.draft_id):
            current = self._reload_unchanged_draft(draft)
            self.validate_draft_access(current)
            current.status = "discarded"
            current.note = f"Discarded by operator at {utc_now_iso()}."
            self.store.save_draft(current)
            return current
