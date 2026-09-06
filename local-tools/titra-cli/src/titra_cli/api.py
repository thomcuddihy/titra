"""Minimal typed client for Titra's token-authenticated HTTP API."""

from __future__ import annotations

import math
import os
import re
import threading
import time
from collections.abc import Callable, Iterator, Mapping
from contextlib import contextmanager
from copy import deepcopy
from datetime import UTC, datetime
from typing import Any
from urllib.parse import quote
from uuid import uuid4

import httpx

from . import __version__
from .dates import DateRange, chunk_date_range
from .errors import (
    ActionVerificationRequiredError,
    AuthenticationError,
    ConfigurationError,
    ConflictError,
    NotFoundError,
    OutcomeUnknownError,
    RateLimitError,
    RemoteApiError,
    WriteRejectedError,
)
from .models import ResolvedConfig
from .output import contains_secret
from .v2_contract import exact_v2_capabilities, exact_v7_capabilities

_REVISION_ETAG = re.compile(r'^"titra-date-revision-(0|[1-9][0-9]*)"$')
_PROJECT_RECOVERY_ETAG = re.compile(r'^"titra-project-recovery-[a-f0-9]{64}"$')
_PROJECT_RECOVERY_ID = re.compile(r"^[A-Za-z0-9._:-]{8,128}$")
_SAFE_REQUEST_ID = re.compile(r"^[A-Za-z0-9_-]{16,80}$")
_SAFE_PROBLEM_CODE = re.compile(r"^[A-Z][A-Z0-9_]{0,79}$")
_SAFE_PROBLEM_CATEGORY = re.compile(r"^[a-z][a-z0-9_]{0,79}$")
_OPAQUE_CURSOR = re.compile(r"^[A-Za-z0-9_-]+$")
_SAFE_RESOURCE_ID = re.compile(r"^[A-Za-z0-9._:-]{1,128}$")
_IDEMPOTENCY_EXPIRY = re.compile(
    r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$"
)
_IDEMPOTENCY_CLOCK_SKEW_SECONDS = 300
_RESOURCE_KINDS = frozenset({"project", "project-task", "task-suggestion", "timer"})
_PROJECT_DETAIL_FIELDS = frozenset(
    {
        "name",
        "description",
        "color",
        "customer",
        "rate",
        "budget",
        "startDate",
        "endDate",
        "public",
        "notbillable",
    }
)
_PROJECT_TASK_FIELDS = frozenset({"name", "start", "end", "estimatedHours", "dependencies"})
_UNSET = object()
MAX_SAFE_REVISION = 2**53 - 1
_MAX_RETRY_AFTER_SECONDS = 24 * 60 * 60
_MIN_REQUEST_SPACING_ENV = "TITRA_CLI_MIN_REQUEST_SPACING_SECONDS"
_MAX_REQUEST_SPACING_SECONDS = 60.0


def _request_spacing_seconds(environment: Mapping[str, str] | None = None) -> float:
    """Read the optional transport pacing interval without guessing invalid values."""

    source = os.environ if environment is None else environment
    raw_value = source.get(_MIN_REQUEST_SPACING_ENV)
    if raw_value is None:
        return 0.0
    try:
        value = float(raw_value)
    except (TypeError, ValueError) as exc:
        raise ConfigurationError(
            f"{_MIN_REQUEST_SPACING_ENV} must be a finite number from 0 through 60."
        ) from exc
    if not math.isfinite(value) or not 0 <= value <= _MAX_REQUEST_SPACING_SECONDS:
        raise ConfigurationError(
            f"{_MIN_REQUEST_SPACING_ENV} must be a finite number from 0 through 60."
        )
    return value


def _same_json_value(left: Any, right: Any) -> bool:
    """Compare decoded JSON without treating booleans as numeric values."""

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


def _changed_fields(expected: dict[str, Any], changes: dict[str, Any], *, label: str) -> list[str]:
    if not expected or set(expected) != set(changes):
        raise ConfigurationError(f"{label} expected and changed fields must match exactly.")
    return sorted(
        field for field in changes if not _same_json_value(expected[field], changes[field])
    )


def _nonnegative_number(value: Any) -> bool:
    return type(value) in {int, float} and math.isfinite(float(value)) and float(value) >= 0


def _finite_number(value: Any) -> bool:
    return type(value) in {int, float} and math.isfinite(float(value))


def revision_from_etag(etag: str | None) -> int | None:
    if etag == '"titra-date-revision-legacy"':
        return None
    match = _REVISION_ETAG.fullmatch(etag) if isinstance(etag, str) else None
    if not match:
        raise ConfigurationError("A valid strong Titra revision ETag is required for task edits.")
    if len(match[1]) > 16:
        raise ConfigurationError("Titra revision exceeds JavaScript's safe integer range.")
    value = int(match[1])
    if value > MAX_SAFE_REVISION:
        raise ConfigurationError("Titra revision exceeds JavaScript's safe integer range.")
    return value


def resource_revision_from_etag(kind: str, etag: str | None) -> int | None:
    """Parse one strong v6 resource ETag without accepting lists or weak validators."""

    if kind not in _RESOURCE_KINDS:
        raise ConfigurationError(f"Unsupported Titra revision resource kind: {kind!r}.")
    if etag == f'"titra-{kind}-revision-legacy"':
        return None
    pattern = re.compile(rf'^"titra-{re.escape(kind)}-revision-(0|[1-9][0-9]*)"$')
    match = pattern.fullmatch(etag) if isinstance(etag, str) else None
    if not match:
        raise ConfigurationError(f"A valid strong Titra {kind} revision ETag is required.")
    if len(match[1]) > 16:
        raise ConfigurationError(f"Titra {kind} revision exceeds JavaScript's safe integer range.")
    value = int(match[1])
    if value > MAX_SAFE_REVISION:
        raise ConfigurationError(f"Titra {kind} revision exceeds JavaScript's safe integer range.")
    return value


def _valid_v2_capabilities(value: Any) -> bool:
    """Authorize v6 behavior only for the exact reviewed contract."""

    return exact_v2_capabilities(value)


def validate_task_edit(task: str, expected_task: str) -> None:
    if not isinstance(task, str) or not task.strip() or len(task) > 1000:
        raise ConfigurationError("Task must be nonblank text of at most 1000 Unicode characters.")
    if not isinstance(expected_task, str):
        raise ConfigurationError("Expected task must be the exact previous string.")
    if any(0xD800 <= ord(character) <= 0xDFFF for character in task + expected_task):
        raise ConfigurationError("Task values cannot contain invalid Unicode surrogate codepoints.")


class TitraClient:
    def __init__(
        self,
        config: ResolvedConfig,
        *,
        transport: httpx.BaseTransport | None = None,
        environment: Mapping[str, str] | None = None,
        sleeper: Callable[[float], None] = time.sleep,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.config = config
        minimum_request_spacing = _request_spacing_seconds(environment)
        self._client = httpx.Client(
            base_url=f"{config.server.rstrip('/')}/",
            headers={
                "Authorization": f"Bearer {config.api_key}",
                "Accept": "application/json",
                "User-Agent": f"titra-cli/{__version__}",
            },
            timeout=config.timeout,
            verify=config.verify_tls,
            follow_redirects=False,
            transport=transport,
        )
        self._capabilities_v2_loaded = False
        self._capabilities_v2: dict[str, Any] | None = None
        self._capabilities_v1_loaded = False
        self._capabilities_v1: dict[str, Any] | None = None
        self._capability_source: str | None = None
        self._expected_user_id: str | None = None
        self._minimum_request_spacing = minimum_request_spacing
        self._request_sleeper = sleeper
        self._request_clock = clock
        self._last_request_started: float | None = None
        self._request_pacing_lock = threading.Lock()
        self.last_timeentry_fetch: dict[str, Any] = {
            "complete": None,
            "consistency": "not-fetched",
            "duplicates": 0,
            "pages": 0,
        }

    def _pace_request(self) -> None:
        """Space request starts without retrying or changing any request outcome."""

        if self._minimum_request_spacing == 0:
            return
        with self._request_pacing_lock:
            while True:
                now = self._request_clock()
                if self._last_request_started is None:
                    break
                elapsed = max(0.0, now - self._last_request_started)
                remaining = self._minimum_request_spacing - elapsed
                if remaining <= 0:
                    break
                self._request_sleeper(remaining)
            self._last_request_started = now

    @property
    def expected_user_id(self) -> str | None:
        return self._expected_user_id

    def bind_expected_user_id(self, user_id: str) -> None:
        """Pin subsequent mutations to one immutable authenticated user ID."""

        if not isinstance(user_id, str) or _SAFE_RESOURCE_ID.fullmatch(user_id) is None:
            raise ConfigurationError("Expected user ID must contain 1-128 safe ASCII characters.")
        if self._expected_user_id is not None and self._expected_user_id != user_id:
            raise ConflictError("Titra client is already bound to a different API user.")
        self._expected_user_id = user_id

    def close(self) -> None:
        self._client.close()

    def __enter__(self) -> TitraClient:
        return self

    def __exit__(self, *_args: object) -> None:
        self.close()

    @staticmethod
    def _problem_metadata(response: httpx.Response, body: Any) -> dict[str, Any] | None:
        if not isinstance(body, dict) or set(body) != {"error"}:
            return None
        error = body.get("error")
        if not isinstance(error, dict):
            return None
        retry = error.get("retry")
        request_id = error.get("requestId")
        if (
            error.get("version") != 1
            or not isinstance(error.get("code"), str)
            or _SAFE_PROBLEM_CODE.fullmatch(error["code"]) is None
            or not isinstance(error.get("category"), str)
            or _SAFE_PROBLEM_CATEGORY.fullmatch(error["category"]) is None
            or not isinstance(error.get("message"), str)
            or not error["message"]
            or len(error["message"]) > 500
            or not isinstance(request_id, str)
            or _SAFE_REQUEST_ID.fullmatch(request_id) is None
            or error.get("outcome") not in {"rejected", "unknown", "applied"}
            or not isinstance(retry, dict)
            or type(retry.get("allowed")) is not bool
        ):
            return None
        after_seconds = retry.get("afterSeconds")
        if retry["allowed"]:
            if type(after_seconds) is not int or after_seconds <= 0:
                return None
        elif "afterSeconds" in retry:
            return None
        response_request_id = response.headers.get("x-request-id")
        if response_request_id is not None and response_request_id != request_id:
            return None
        return {
            "version": 1,
            "code": error["code"],
            "category": error["category"],
            "message": error["message"],
            "requestId": request_id,
            "outcome": error["outcome"],
            "retry": {
                "allowed": retry["allowed"],
                **({"afterSeconds": after_seconds} if retry["allowed"] else {}),
            },
            "httpStatus": response.status_code,
        }

    @classmethod
    def _message(cls, response: httpx.Response, body: Any) -> str:
        problem = cls._problem_metadata(response, body)
        if problem is not None:
            return str(problem["message"])
        if isinstance(body, dict):
            message = body.get("message")
            if isinstance(message, str):
                return message
        text = response.text.strip()
        return text[:500] if text else f"Titra returned HTTP {response.status_code}."

    def _request(
        self,
        method: str,
        path: str,
        *,
        json_body: dict[str, Any] | None = None,
        headers: dict[str, str] | None = None,
        mutation: bool = False,
        include_response: bool = False,
        guarded_task_write: bool = False,
        guarded_recovery_write: bool = False,
        definite_mutation_messages: frozenset[str] = frozenset(),
    ) -> Any:
        request_headers = {"X-Request-ID": uuid4().hex}
        if headers:
            request_headers.update(headers)
        if self._expected_user_id is not None:
            request_headers["X-Titra-Expected-User-Id"] = self._expected_user_id
        try:
            self._pace_request()
            response = self._client.request(
                method, path.lstrip("/"), json=json_body, headers=request_headers
            )
        except httpx.RequestError as exc:
            if mutation:
                raise OutcomeUnknownError(
                    "The connection failed during a write. Its outcome is unknown; "
                    "do not retry blindly.",
                    {"request": str(exc.request.url), "error": str(exc)},
                ) from exc
            raise RemoteApiError(f"Cannot reach Titra: {exc}") from exc
        try:
            body: Any = response.json()
        except ValueError as exc:
            if response.status_code in {401, 403}:
                raise AuthenticationError(
                    f"Titra rejected authentication (HTTP {response.status_code})."
                ) from exc
            if response.status_code == 404:
                raise NotFoundError(f"Titra endpoint is not available: {path}") from exc
            if mutation:
                raise OutcomeUnknownError(
                    "A write returned non-JSON data; its outcome is unknown. Do not retry "
                    "without reconciliation.",
                    {"httpStatus": response.status_code},
                ) from exc
            raise RemoteApiError(
                f"Titra returned non-JSON data (HTTP {response.status_code})."
            ) from exc
        message = self._message(response, body)
        problem = self._problem_metadata(response, body)
        details: Any = {"problem": problem} if problem is not None else body
        if response.status_code == 429:
            header_delay = response.headers.get("retry-after")
            if header_delay is not None and (
                not header_delay.isascii()
                or not header_delay.isdigit()
                or not 1 <= int(header_delay) <= _MAX_RETRY_AFTER_SECONDS
            ):
                raise RemoteApiError("Titra returned an invalid Retry-After value.", details)
            problem_delay = (
                problem["retry"].get("afterSeconds")
                if problem is not None and problem["retry"]["allowed"]
                else None
            )
            if problem_delay is not None and (
                problem_delay > _MAX_RETRY_AFTER_SECONDS
                or (header_delay is not None and problem_delay != int(header_delay))
            ):
                raise RemoteApiError("Titra returned inconsistent rate-limit metadata.", details)
            retry_after = (
                problem_delay
                if problem_delay is not None
                else (int(header_delay) if header_delay is not None else None)
            )
            raise RateLimitError(message, retry_after, details)
        if response.status_code in {401, 403}:
            if response.status_code == 403 and (
                (problem is not None and problem.get("code") == "ACTION_VERIFICATION_REQUIRED")
                or message == "Required account verification is overdue."
            ):
                raise ActionVerificationRequiredError(message, details)
            raise AuthenticationError(message, details)
        if response.status_code == 404:
            raise NotFoundError(message, details)
        if response.status_code in {409, 412, 423, 428}:
            raise ConflictError(message, details)
        if response.status_code < 200 or response.status_code >= 300:
            if mutation and (
                (problem is not None and problem["outcome"] == "unknown")
                or (
                    problem is None
                    and response.status_code >= 500
                    and message not in definite_mutation_messages
                )
            ):
                raise OutcomeUnknownError(
                    "The server returned an uncertain write result; do not retry blindly. "
                    "Reconcile the resource first.",
                    {
                        "httpStatus": response.status_code,
                        **({"problem": problem} if problem else {}),
                    },
                )
            if guarded_task_write:
                # A proxy/5xx response is not evidence that a write was rejected.
                if response.status_code in {400, 422} and isinstance(body, dict):
                    raise WriteRejectedError("Titra rejected the task edit.")
                raise OutcomeUnknownError(
                    "Task-edit outcome is uncertain; do not retry. Reconcile its receipt."
                )
            if guarded_recovery_write and response.status_code not in {400, 422}:
                raise OutcomeUnknownError(
                    "Project fence recovery outcome is uncertain; inspect current recovery "
                    "state before retrying."
                )
            raise RemoteApiError(f"Titra rejected the request: {message}", details)
        if not isinstance(body, dict):
            if mutation:
                raise OutcomeUnknownError(
                    "A write returned an invalid response envelope; reconcile before retrying."
                )
            raise RemoteApiError("Titra returned an invalid response envelope.", body)
        payload = body.get("payload")
        if mutation and contains_secret(payload, self.config.api_key):
            raise OutcomeUnknownError(
                "A write response reflected the configured credential; its outcome is unknown. "
                "Reconcile without displaying or persisting that response."
            )
        return (payload, response) if include_response else payload

    @staticmethod
    def _list_payload(payload: Any, label: str) -> list[dict[str, Any]]:
        if payload is None:
            return []
        if not isinstance(payload, list) or not all(isinstance(item, dict) for item in payload):
            raise RemoteApiError(f"Titra returned an invalid {label} list.", payload)
        return payload

    def list_projects(self) -> list[dict[str, Any]]:
        payload = self._request("GET", "project/list/")
        return self._list_payload(payload, "project")

    @staticmethod
    def _idempotency_headers(idempotency_key: str | None) -> dict[str, str] | None:
        if idempotency_key is None:
            return None
        if (
            not isinstance(idempotency_key, str)
            or not 16 <= len(idempotency_key) <= 128
            or any(ord(character) < 0x21 or ord(character) > 0x7E for character in idempotency_key)
        ):
            raise ConfigurationError(
                "Idempotency key must contain 16 to 128 visible ASCII characters."
            )
        return {"Idempotency-Key": idempotency_key}

    def _idempotency_create_retention(self, operation: str) -> int:
        """Require the advertised retry window before issuing an idempotent create."""

        if not self.supports_idempotent_create(operation):
            raise ConfigurationError(
                "This server does not advertise durable idempotent creation for this operation."
            )
        document = self._api_capabilities()
        contract = document.get("idempotency") if isinstance(document, dict) else None
        retention = contract.get("retentionSeconds") if isinstance(contract, dict) else None
        if type(retention) is not int or retention <= 0:
            raise ConfigurationError(
                "This server does not advertise a valid idempotency retention window."
            )
        return retention

    @staticmethod
    def _idempotency_expiry(
        response: httpx.Response,
        *,
        retention_seconds: int,
        require_full_window: bool,
    ) -> str:
        """Validate a bounded, future idempotency expiry without reflecting its raw value."""

        expires_at = response.headers.get("idempotency-expires-at")
        safe_expiry = (
            expires_at
            if isinstance(expires_at, str) and _IDEMPOTENCY_EXPIRY.fullmatch(expires_at)
            else None
        )
        try:
            expiry = datetime.fromisoformat(str(safe_expiry).replace("Z", "+00:00"))
        except ValueError as exc:
            raise OutcomeUnknownError(
                "Titra returned no valid idempotency expiry; reconcile before retrying."
            ) from exc
        if expiry.tzinfo is None:
            raise OutcomeUnknownError(
                "Titra returned no valid idempotency expiry; reconcile before retrying."
            )
        remaining = (expiry.astimezone(UTC) - datetime.now(UTC)).total_seconds()
        minimum = (
            max(0, retention_seconds - _IDEMPOTENCY_CLOCK_SKEW_SECONDS)
            if require_full_window
            else 0
        )
        maximum = retention_seconds + _IDEMPOTENCY_CLOCK_SKEW_SECONDS
        if remaining <= minimum or remaining > maximum:
            raise OutcomeUnknownError(
                "Titra returned an idempotency expiry inconsistent with its advertised "
                "retention; reconcile before retrying."
            )
        assert safe_expiry is not None
        return safe_expiry

    def _create_resource(
        self,
        *,
        operation: str,
        path: str,
        result_key: str,
        label: str,
        values: dict[str, Any],
        idempotency_key: str | None,
        legacy_result_keys: tuple[str, ...] = (),
        recovery: bool = False,
    ) -> tuple[str, bool | None, str | None]:
        headers = self._idempotency_headers(idempotency_key)
        retention = (
            self._idempotency_create_retention(operation) if idempotency_key is not None else None
        )
        payload, response = self._request(
            "POST",
            path,
            json_body=values,
            headers=headers,
            mutation=True,
            include_response=True,
        )
        if not isinstance(payload, dict):
            raise OutcomeUnknownError(
                f"Titra did not return the created {label} ID; reconcile before retrying."
            )
        allowed_keys = (
            (result_key,)
            if idempotency_key is not None
            else (
                result_key,
                *legacy_result_keys,
            )
        )
        selected_key = next(
            (key for key in allowed_keys if set(payload) == {key}),
            None,
        )
        if selected_key is None:
            if not any(payload.get(key) for key in allowed_keys):
                raise OutcomeUnknownError(
                    f"Titra did not return the created {label} ID; reconcile before retrying."
                )
            raise OutcomeUnknownError(
                f"Titra returned an inconsistent {label} creation result; reconcile before "
                "retrying."
            )
        result_id = payload.get(selected_key)
        if not isinstance(result_id, str) or _SAFE_RESOURCE_ID.fullmatch(result_id) is None:
            raise OutcomeUnknownError(
                f"Titra returned an invalid created {label} ID; reconcile before retrying."
            )
        replayed_result: bool | None = None
        expiry_result: str | None = None
        if idempotency_key is not None:
            replayed_header = response.headers.get("idempotency-replayed")
            allowed_replay_headers = {"false", "true"} if recovery else {"false"}
            if replayed_header not in allowed_replay_headers:
                message = (
                    "Titra did not confirm an exact idempotent recovery outcome; reconcile "
                    "before retrying."
                    if recovery
                    else "Titra did not confirm a fresh idempotent create; reconcile before "
                    "retrying."
                )
                raise OutcomeUnknownError(message)
            assert retention is not None
            replayed_result = replayed_header == "true"
            expiry_result = self._idempotency_expiry(
                response,
                retention_seconds=retention,
                require_full_window=not replayed_result,
            )
        return result_id, replayed_result, expiry_result

    def create_project(self, values: dict[str, Any], *, idempotency_key: str | None = None) -> str:
        result_id, _replayed, _expiry = self._create_resource(
            operation="project.create",
            path="project/create/",
            result_key="projectId",
            label="project",
            values=values,
            idempotency_key=idempotency_key,
        )
        return result_id

    def list_tasks(self, project_id: str) -> list[dict[str, Any]]:
        payload = self._request("GET", f"project/tasks/{quote(project_id, safe='')}")
        return self._list_payload(payload, "task")

    def project_task_stats(self, project_id: str, task_name: str | None = None) -> dict[str, Any]:
        """Read planned/actual project-task totals, optionally filtered by exact task name."""

        if task_name is not None and (not isinstance(task_name, str) or not task_name):
            raise ConfigurationError("Task-name filter must be a nonempty exact string.")
        payload = self._request("GET", f"project/task/stats/{quote(project_id, safe='')}")
        result = self._require_object(payload, "project task statistics")
        if result.get("projectId") != project_id:
            raise RemoteApiError("Titra returned task statistics for a different project.")
        if not isinstance(result.get("tasks"), list) or not all(
            type(result.get(field)) in {int, float} and math.isfinite(float(result[field]))
            for field in ("totalEstimatedHours", "totalActualHours")
        ):
            raise RemoteApiError("Titra returned invalid project task statistics.")
        tasks = self._list_payload(result["tasks"], "project task statistic")
        for task in tasks:
            if (
                not isinstance(task.get("taskId"), str)
                or not task["taskId"]
                or not isinstance(task.get("taskName"), str)
                or type(task.get("estimatedHours")) not in {int, float}
                or type(task.get("actualHours")) not in {int, float}
                or type(task.get("variance")) not in {int, float}
                or not all(
                    math.isfinite(float(task[field]))
                    for field in ("estimatedHours", "actualHours", "variance")
                )
            ):
                raise RemoteApiError("Titra returned invalid project task statistics.")
        selected = (
            tasks
            if task_name is None
            else [task for task in tasks if task.get("taskName") == task_name]
        )
        if task_name is None:
            return result
        filtered = deepcopy(result)
        filtered["tasks"] = selected
        filtered["totalEstimatedHours"] = sum(float(task["estimatedHours"]) for task in selected)
        filtered["totalActualHours"] = sum(float(task["actualHours"]) for task in selected)
        return filtered

    def create_task(self, values: dict[str, Any], *, idempotency_key: str | None = None) -> str:
        result_id, _replayed, _expiry = self._create_resource(
            operation="project-task.create",
            path="project/task/create/",
            result_key="taskId",
            label="task",
            values=values,
            idempotency_key=idempotency_key,
            legacy_result_keys=("_id",),
        )
        return result_id

    def create_time_entry(
        self, values: dict[str, Any], *, idempotency_key: str | None = None
    ) -> str:
        result_id, _replayed, _expiry = self._create_resource(
            operation="timeentry.create",
            path="timeentry/create/",
            result_key="timecardId",
            label="time-entry",
            values=values,
            idempotency_key=idempotency_key,
        )
        return result_id

    def recover_idempotent_create(
        self,
        operation: str,
        values: dict[str, Any],
        *,
        idempotency_key: str,
    ) -> dict[str, Any]:
        """Resume one uncertain create, accepting only an exact fresh or replayed result."""

        routes = {
            "project.create": ("project/create/", "projectId", "project"),
            "project-task.create": ("project/task/create/", "taskId", "task"),
            "timeentry.create": ("timeentry/create/", "timecardId", "time-entry"),
        }
        if operation not in routes:
            raise ConfigurationError("Unsupported idempotent create recovery operation.")
        if not isinstance(values, dict) or not values:
            raise ConfigurationError("Idempotent create recovery requires its exact JSON object.")
        path, result_key, label = routes[operation]
        result_id, replayed, expires_at = self._create_resource(
            operation=operation,
            path=path,
            result_key=result_key,
            label=label,
            values=values,
            idempotency_key=idempotency_key,
            recovery=True,
        )
        assert replayed is not None and expires_at is not None
        return {
            "operation": operation,
            "result_id": result_id,
            "idempotency_replayed": replayed,
            "idempotency_expires_at": expires_at,
        }

    def replay_idempotent_create(
        self,
        operation: str,
        values: dict[str, Any],
        *,
        idempotency_key: str,
        expected_result_id: str,
    ) -> dict[str, Any]:
        """Replay one completed v6 create and prove the server reused its result."""

        routes = {
            "project.create": ("project/create/", "projectId"),
            "project-task.create": ("project/task/create/", "taskId"),
            "timeentry.create": ("timeentry/create/", "timecardId"),
        }
        if operation not in routes:
            raise ConfigurationError("Unsupported idempotent create operation.")
        if (
            not isinstance(expected_result_id, str)
            or _SAFE_RESOURCE_ID.fullmatch(expected_result_id) is None
        ):
            raise ConfigurationError(
                "Expected create result ID must contain 1-128 safe ASCII characters."
            )
        if not isinstance(values, dict) or not values:
            raise ConfigurationError("Idempotent create replay requires its exact JSON object.")
        headers = self._idempotency_headers(idempotency_key)
        assert headers is not None
        if not self.supports_idempotent_create(operation):
            raise ConfigurationError(
                "This server does not advertise durable idempotent creation replay."
            )
        path, result_key = routes[operation]
        payload, response = self._request(
            "POST",
            path,
            json_body=values,
            headers=headers,
            mutation=True,
            include_response=True,
        )
        result = self._require_exact_mutation_object(
            payload, "idempotent create replay", frozenset({result_key})
        )
        observed_result_id = result.get(result_key)
        if (
            not isinstance(observed_result_id, str)
            or _SAFE_RESOURCE_ID.fullmatch(observed_result_id) is None
        ):
            raise OutcomeUnknownError(
                "Idempotent create replay returned an invalid resource ID; reconcile before "
                "continuing.",
                {
                    "operation": operation,
                    "expected_result_id": expected_result_id,
                    "idempotency_replayed": False,
                },
            )
        replayed = response.headers.get("idempotency-replayed")
        expires_at = response.headers.get("idempotency-expires-at")
        safe_expiry = (
            expires_at
            if isinstance(expires_at, str) and _IDEMPOTENCY_EXPIRY.fullmatch(expires_at)
            else None
        )
        observation = {
            "operation": operation,
            "expected_result_id": expected_result_id,
            "observed_result_id": observed_result_id,
            "idempotency_replayed": replayed == "true",
            "idempotency_expires_at": safe_expiry,
        }
        if observed_result_id != expected_result_id:
            raise OutcomeUnknownError(
                "Idempotent create replay returned another resource ID; reconcile before "
                "continuing.",
                observation,
            )
        try:
            expiry = datetime.fromisoformat(str(safe_expiry).replace("Z", "+00:00"))
        except ValueError as exc:
            raise OutcomeUnknownError(
                "Idempotent create replay returned no valid expiry; reconcile before continuing.",
                observation,
            ) from exc
        if (
            replayed != "true"
            or expiry.tzinfo is None
            or expiry.astimezone(UTC) <= datetime.now(UTC)
        ):
            raise OutcomeUnknownError(
                "Idempotent create replay was not confirmed by exact server headers; reconcile "
                "before continuing.",
                observation,
            )
        return {
            "operation": operation,
            "result_id": expected_result_id,
            "idempotency_replayed": True,
            "idempotency_expires_at": safe_expiry,
        }

    def get_time_entry(self, timecard_id: str) -> dict[str, Any]:
        payload = self._request("GET", f"timeentry/get/{quote(timecard_id, safe='')}")
        if not isinstance(payload, dict):
            raise RemoteApiError("Titra returned an invalid time entry.", payload)
        self._require_snapshot_identifier(payload, "_id", timecard_id, "time entry")
        return payload

    def get_time_entry_snapshot(self, timecard_id: str) -> tuple[dict[str, Any], str | None]:
        result = self._request(
            "GET", f"timeentry/get/{quote(timecard_id, safe='')}", include_response=True
        )
        payload, response = result
        if not isinstance(payload, dict):
            raise RemoteApiError("Titra returned an invalid time entry.", payload)
        self._require_snapshot_identifier(payload, "_id", timecard_id, "time entry")
        etag = response.headers.get("etag")
        if etag is not None:
            try:
                revision_from_etag(etag)
            except ConfigurationError as exc:
                raise RemoteApiError(
                    "Titra returned a time entry with an invalid revision ETag."
                ) from exc
        return payload, etag

    @staticmethod
    def _require_object(payload: Any, label: str) -> dict[str, Any]:
        if not isinstance(payload, dict):
            raise RemoteApiError(f"Titra returned invalid {label} information.", payload)
        return payload

    @staticmethod
    def _require_mutation_object(payload: Any, label: str) -> dict[str, Any]:
        if not isinstance(payload, dict):
            raise OutcomeUnknownError(
                f"Titra returned an invalid {label} write result; reconcile before retrying."
            )
        return payload

    @staticmethod
    def _require_snapshot_identifier(
        payload: dict[str, Any], key: str, expected: str, label: str
    ) -> None:
        if payload.get(key) != expected:
            raise RemoteApiError(f"Titra returned {label} information for another resource.")

    @classmethod
    def _require_exact_mutation_object(
        cls,
        payload: Any,
        label: str,
        keys: frozenset[str],
    ) -> dict[str, Any]:
        result = cls._require_mutation_object(payload, label)
        if set(result) != keys:
            raise OutcomeUnknownError(
                f"Titra returned an inconsistent {label} write result; reconcile before retrying."
            )
        return result

    @staticmethod
    def _expected_timecard_etag(etag: str, *, changed: bool) -> str:
        revision = revision_from_etag(etag)
        if not changed:
            return etag
        if revision == MAX_SAFE_REVISION:
            raise ConfigurationError("Time-entry revision cannot safely advance.")
        return f'"titra-date-revision-{(revision or 0) + 1}"'

    @staticmethod
    def _expected_resource_etag(kind: str, etag: str, *, changed: bool) -> str:
        revision = resource_revision_from_etag(kind, etag)
        if not changed:
            return etag
        if revision == MAX_SAFE_REVISION:
            raise ConfigurationError(f"Titra {kind} revision cannot safely advance.")
        return f'"titra-{kind}-revision-{(revision or 0) + 1}"'

    @staticmethod
    def _require_exact_mutation_etag(response: httpx.Response, expected: str, label: str) -> str:
        actual = response.headers.get("etag")
        if actual != expected:
            raise OutcomeUnknownError(
                f"Titra returned {label} with an inconsistent revision ETag; "
                "reconcile before retrying."
            )
        return expected

    @classmethod
    def _require_timer_payload(
        cls,
        payload: Any,
        *,
        label: str,
        expected_timer_id: object = _UNSET,
        includes_changed: bool,
        stopped: bool = False,
    ) -> dict[str, Any]:
        keys = {"timerId", "startTime", "duration", "revision", "legacy"}
        if includes_changed:
            keys.add("changed")
        if stopped:
            keys.add("stoppedAt")
        if includes_changed:
            result = cls._require_exact_mutation_object(payload, label, frozenset(keys))
        else:
            result = cls._require_object(payload, label)
            if set(result) != keys:
                raise RemoteApiError(f"Titra returned inconsistent {label} information.")
        timer_id = result.get("timerId")
        revision = result.get("revision")
        valid_timer_id = timer_id is None or (
            isinstance(timer_id, str)
            and 8 <= len(timer_id) <= 128
            and re.fullmatch(r"[A-Za-z0-9._:-]+", timer_id) is not None
        )
        if (
            not valid_timer_id
            or (expected_timer_id is not _UNSET and timer_id != expected_timer_id)
            or not isinstance(result.get("startTime"), str)
            or not result["startTime"]
            or len(result["startTime"]) > 64
            or not _nonnegative_number(result.get("duration"))
            or (
                revision is not None
                and (type(revision) is not int or revision < 0 or revision > MAX_SAFE_REVISION)
            )
            or type(result.get("legacy")) is not bool
            or result["legacy"] is not (timer_id is None or revision is None)
            or (includes_changed and type(result.get("changed")) is not bool)
            or (
                stopped
                and (
                    not isinstance(result.get("stoppedAt"), str)
                    or not result["stoppedAt"]
                    or len(result["stoppedAt"]) > 64
                )
            )
        ):
            error_type = OutcomeUnknownError if includes_changed else RemoteApiError
            raise error_type(f"Titra returned inconsistent {label} information.")
        return result

    @staticmethod
    def _resource_etag(response: httpx.Response, kind: str, label: str) -> str:
        etag = response.headers.get("etag")
        try:
            resource_revision_from_etag(kind, etag)
        except ConfigurationError as exc:
            raise RemoteApiError(f"Titra returned {label} without a valid revision ETag.") from exc
        assert isinstance(etag, str)
        return etag

    @staticmethod
    def _mutation_resource_etag(response: httpx.Response, kind: str, label: str) -> str:
        etag = response.headers.get("etag")
        try:
            resource_revision_from_etag(kind, etag)
        except ConfigurationError as exc:
            raise OutcomeUnknownError(
                f"Titra returned {label} without a valid revision ETag; reconcile before retrying."
            ) from exc
        assert isinstance(etag, str)
        return etag

    def edit_time_entry_details(
        self,
        timecard_id: str,
        *,
        expected: dict[str, Any],
        changes: dict[str, Any],
        etag: str,
        accept_legacy_conversion: bool = False,
    ) -> tuple[dict[str, Any], str]:
        changed_fields = _changed_fields(expected, changes, label="Time-entry details")
        expected_etag = self._expected_timecard_etag(etag, changed=bool(changed_fields))
        body: dict[str, Any] = {"expected": expected, "changes": changes}
        if accept_legacy_conversion:
            body["acceptLegacyConversion"] = True
        payload, response = self._request(
            "PATCH",
            f"timeentry/details/{quote(timecard_id, safe='')}",
            json_body=body,
            headers={"If-Match": etag},
            mutation=True,
            include_response=True,
        )
        result = self._require_exact_mutation_object(
            payload,
            "time-entry details update",
            frozenset({"timecardId", "changed", "changedFields", "previous", "current"}),
        )
        expected_result = {
            "timecardId": timecard_id,
            "changed": bool(changed_fields),
            "changedFields": changed_fields,
            "previous": expected,
            "current": changes,
        }
        if not _same_json_value(result, expected_result):
            raise OutcomeUnknownError(
                "Titra returned an inconsistent time-entry details update; reconcile before "
                "retrying."
            )
        next_etag = self._require_exact_mutation_etag(
            response, expected_etag, "a time-entry details update"
        )
        return result, next_etag

    def delete_time_entry(self, timecard_id: str, *, etag: str | None = None) -> dict[str, Any]:
        if etag is not None:
            revision_from_etag(etag)
        headers = {"If-Match": etag} if etag else None
        payload = self._request(
            "DELETE",
            f"timeentry/delete/{quote(timecard_id, safe='')}",
            headers=headers,
            mutation=True,
        )
        if etag is not None:
            result = self._require_exact_mutation_object(
                payload, "time-entry deletion", frozenset({"timecardId"})
            )
            if result.get("timecardId") != timecard_id:
                raise OutcomeUnknownError(
                    "Titra returned a deletion result for another time entry; inspect before "
                    "retrying."
                )
            return result
        if payload is None:
            return {}
        if not isinstance(payload, dict):
            raise OutcomeUnknownError(
                "Titra returned an invalid deletion result; inspect the record before retrying."
            )
        return payload

    def edit_time_entry_task(
        self, timecard_id: str, *, task: str, expected_task: str, etag: str
    ) -> tuple[dict[str, Any], str]:
        """Send one guarded PATCH only; never retry or serialize unrelated record fields."""
        if not isinstance(timecard_id, str) or not timecard_id or len(timecard_id) > 128:
            raise ConfigurationError("Record ID must contain 1 to 128 characters.")
        validate_task_edit(task, expected_task)
        old_revision = revision_from_etag(etag)
        changed = task != expected_task
        if changed and old_revision == MAX_SAFE_REVISION:
            raise ConfigurationError("Task edit cannot safely increment the maximum revision.")
        payload, response = self._request(
            "PATCH",
            f"timeentry/task/{quote(timecard_id, safe='')}",
            json_body={"task": task, "expectedTask": expected_task},
            headers={"If-Match": etag},
            mutation=True,
            include_response=True,
            guarded_task_write=True,
        )
        expected_etag = f'"titra-date-revision-{(old_revision or 0) + 1}"' if changed else etag
        expected = {
            "timecardId": timecard_id,
            "task": task,
            "previousTask": expected_task,
            "changed": changed,
        }
        new_etag = response.headers.get("etag")
        if (
            not isinstance(payload, dict)
            or set(payload) != set(expected)
            or any(payload.get(key) != value for key, value in expected.items())
            or type(payload.get("changed")) is not bool
            or new_etag != expected_etag
        ):
            raise OutcomeUnknownError(
                "Task edit returned an inconsistent result or ETag; reconcile its receipt."
            )
        return expected, expected_etag

    def list_own_time_entries(
        self, value: DateRange, *, page_size: int = 200
    ) -> list[dict[str, Any]]:
        if type(page_size) is not int or not 1 <= page_size <= 500:
            raise ConfigurationError("Time-entry page size must be between 1 and 500.")
        if self.supports_timeentry_pagination():
            return self._list_paginated_time_entries(
                value,
                lambda chunk: (
                    f"timeentry/daterange-page/{chunk.start.isoformat()}/{chunk.end.isoformat()}"
                ),
                "time-entry",
                page_size=page_size,
            )
        records: list[dict[str, Any]] = []
        for chunk in chunk_date_range(value):
            payload = self._request(
                "GET", f"timeentry/daterange/{chunk.start.isoformat()}/{chunk.end.isoformat()}"
            )
            records.extend(self._list_payload(payload, "time-entry"))
        self.last_timeentry_fetch = {
            "complete": None,
            "consistency": "legacy-array-unverified",
            "duplicates": 0,
            "pages": len(chunk_date_range(value)),
        }
        return records

    def list_project_time_entries(
        self, project_id: str, value: DateRange, *, page_size: int = 200
    ) -> list[dict[str, Any]]:
        if type(page_size) is not int or not 1 <= page_size <= 500:
            raise ConfigurationError("Time-entry page size must be between 1 and 500.")
        if self.supports_timeentry_pagination():
            encoded = quote(project_id, safe="")
            return self._list_paginated_time_entries(
                value,
                lambda chunk: (
                    "project/timeentriesfordaterange-page/"
                    f"{encoded}/{chunk.start.isoformat()}/{chunk.end.isoformat()}"
                ),
                "project time-entry",
                page_size=page_size,
            )
        records: list[dict[str, Any]] = []
        encoded = quote(project_id, safe="")
        for chunk in chunk_date_range(value):
            payload = self._request(
                "GET",
                "project/timeentriesfordaterange/"
                f"{encoded}/{chunk.start.isoformat()}/{chunk.end.isoformat()}",
            )
            records.extend(self._list_payload(payload, "project time-entry"))
        self.last_timeentry_fetch = {
            "complete": None,
            "consistency": "legacy-array-unverified",
            "duplicates": 0,
            "pages": len(chunk_date_range(value)),
        }
        return records

    def _list_paginated_time_entries(
        self,
        value: DateRange,
        path_for_chunk: Callable[[DateRange], str],
        label: str,
        *,
        page_size: int,
    ) -> list[dict[str, Any]]:
        records: list[dict[str, Any]] = []
        seen_record_ids: set[str] = set()
        duplicate_count = 0
        page_count = 0
        for chunk in chunk_date_range(value):
            cursor: str | None = None
            seen_cursors: set[str] = set()
            while True:
                path = path_for_chunk(chunk)
                if cursor is not None:
                    path = f"{path}?limit={page_size}&cursor={quote(cursor, safe='')}"
                else:
                    path = f"{path}?limit={page_size}"
                payload = self._request("GET", path)
                if not isinstance(payload, dict) or set(payload) != {"items", "page"}:
                    raise RemoteApiError(f"Titra returned an invalid paginated {label} result.")
                items = self._list_payload(payload.get("items"), label)
                page = payload.get("page")
                if not isinstance(page, dict):
                    raise RemoteApiError(f"Titra returned invalid {label} page metadata.")
                required = {"version", "limit", "returned", "complete", "nextCursor", "consistency"}
                if (
                    not required.issubset(page)
                    or page.get("version") != 1
                    or type(page.get("limit")) is not int
                    or page["limit"] != page_size
                    or type(page.get("returned")) is not int
                    or page["returned"] != len(items)
                    or type(page.get("complete")) is not bool
                    or page.get("consistency") != "live-keyset"
                ):
                    raise RemoteApiError(f"Titra returned inconsistent {label} page metadata.")
                next_cursor = page.get("nextCursor")
                if page["complete"]:
                    if next_cursor is not None:
                        raise RemoteApiError(
                            f"Titra returned a cursor for a complete {label} page."
                        )
                elif (
                    not items
                    or not isinstance(next_cursor, str)
                    or not next_cursor
                    or len(next_cursor) > 2048
                    or _OPAQUE_CURSOR.fullmatch(next_cursor) is None
                    or next_cursor in seen_cursors
                ):
                    raise RemoteApiError(
                        "Titra returned a missing or repeated cursor for an incomplete "
                        f"{label} page."
                    )
                for item in items:
                    record_id = item.get("_id")
                    if not isinstance(record_id, str) or not record_id:
                        raise RemoteApiError(f"Titra returned a {label} without an ID.")
                    if record_id in seen_record_ids:
                        duplicate_count += 1
                        continue
                    seen_record_ids.add(record_id)
                    records.append(item)
                page_count += 1
                if page["complete"]:
                    break
                assert isinstance(next_cursor, str)
                seen_cursors.add(next_cursor)
                cursor = next_cursor
        self.last_timeentry_fetch = {
            "complete": True,
            "consistency": "live-keyset",
            "duplicates": duplicate_count,
            "pages": page_count,
        }
        return records

    def current_user(self) -> dict[str, Any]:
        payload = self._request("GET", "user/me/")
        if not isinstance(payload, dict):
            raise RemoteApiError("Titra returned invalid current-user information.", payload)
        return payload

    def project_users(self, project_id: str) -> list[dict[str, Any]]:
        payload = self._request("GET", f"project/users/{quote(project_id, safe='')}")
        return self._list_payload(payload, "project-user")

    def get_project_snapshot(self, project_id: str) -> tuple[dict[str, Any], str]:
        payload, response = self._request(
            "GET", f"project/get/{quote(project_id, safe='')}", include_response=True
        )
        result = self._require_object(payload, "project")
        self._require_snapshot_identifier(result, "_id", project_id, "project")
        etag = self._resource_etag(response, "project", "a project")
        return result, etag

    def edit_project_details(
        self,
        project_id: str,
        *,
        expected: dict[str, Any],
        changes: dict[str, Any],
        etag: str,
    ) -> tuple[dict[str, Any], str]:
        changed_fields = _changed_fields(expected, changes, label="Project details")
        expected_etag = self._expected_resource_etag("project", etag, changed=bool(changed_fields))
        payload, response = self._request(
            "PATCH",
            f"project/details/{quote(project_id, safe='')}",
            json_body={"expected": expected, "changes": changes},
            headers={"If-Match": etag},
            mutation=True,
            include_response=True,
        )
        result = self._require_exact_mutation_object(
            payload,
            "project update",
            frozenset({"projectId", "changed", "changedFields", "current"}),
        )
        current = result.get("current")
        if (
            result.get("projectId") != project_id
            or type(result.get("changed")) is not bool
            or result["changed"] is not bool(changed_fields)
            or result.get("changedFields") != changed_fields
            or not isinstance(current, dict)
            or set(current) != _PROJECT_DETAIL_FIELDS
            or any(not _same_json_value(current.get(field), changes[field]) for field in changes)
        ):
            raise OutcomeUnknownError(
                "Titra returned an inconsistent project update; reconcile before retrying."
            )
        next_etag = self._require_exact_mutation_etag(response, expected_etag, "a project update")
        return result, next_etag

    def set_project_archived(
        self,
        project_id: str,
        *,
        archived: bool,
        expected_archived: bool,
        etag: str,
    ) -> tuple[dict[str, Any], str]:
        if type(archived) is not bool or type(expected_archived) is not bool:
            raise ConfigurationError("Archived values must be booleans.")
        changed = archived is not expected_archived
        expected_etag = self._expected_resource_etag("project", etag, changed=changed)
        payload, response = self._request(
            "PATCH",
            f"project/archive/{quote(project_id, safe='')}",
            json_body={"archived": archived, "expectedArchived": expected_archived},
            headers={"If-Match": etag},
            mutation=True,
            include_response=True,
        )
        result = self._require_exact_mutation_object(
            payload,
            "project archive update",
            frozenset({"projectId", "archived", "changed"}),
        )
        expected_result = {"projectId": project_id, "archived": archived, "changed": changed}
        if not _same_json_value(result, expected_result):
            raise OutcomeUnknownError(
                "Titra returned an inconsistent project archive update; reconcile before retrying."
            )
        next_etag = self._require_exact_mutation_etag(
            response, expected_etag, "a project archive update"
        )
        return result, next_etag

    def delete_empty_project(
        self, project_id: str, *, expected_name: str, etag: str
    ) -> dict[str, Any]:
        resource_revision_from_etag("project", etag)
        payload = self._request(
            "DELETE",
            f"project/delete/{quote(project_id, safe='')}",
            json_body={"expectedName": expected_name},
            headers={"If-Match": etag},
            mutation=True,
        )
        result = self._require_exact_mutation_object(
            payload,
            "project deletion",
            frozenset({"projectId", "deleted", "counts"}),
        )
        if not _same_json_value(
            result,
            {
                "projectId": project_id,
                "deleted": True,
                "counts": {"timecards": 0, "projectTasks": 0},
            },
        ):
            raise OutcomeUnknownError(
                "Titra returned an inconsistent project deletion result; reconcile before retrying."
            )
        return result

    def get_project_fence_recovery(self, project_id: str) -> tuple[dict[str, Any], str]:
        payload, response = self._request(
            "GET", f"project/recovery/{quote(project_id, safe='')}", include_response=True
        )
        result = self._require_object(payload, "project fence recovery")
        self._require_snapshot_identifier(result, "projectId", project_id, "project fence recovery")
        etag = response.headers.get("etag")
        if not isinstance(etag, str) or _PROJECT_RECOVERY_ETAG.fullmatch(etag) is None:
            raise RemoteApiError("Titra returned project recovery state without a valid ETag.")
        return result, etag

    def recover_project_fence(
        self,
        project_id: str,
        *,
        recovery_type: str,
        recovery_id: str,
        etag: str,
    ) -> tuple[dict[str, Any], str]:
        if recovery_type not in {"writer", "task-delete"}:
            raise ConfigurationError("Recovery type must be writer or task-delete.")
        if not isinstance(recovery_id, str) or _PROJECT_RECOVERY_ID.fullmatch(recovery_id) is None:
            raise ConfigurationError("Recovery ID must be 8-128 safe ASCII characters.")
        if not isinstance(etag, str) or _PROJECT_RECOVERY_ETAG.fullmatch(etag) is None:
            raise ConfigurationError("A valid project recovery ETag is required.")
        payload, response = self._request(
            "POST",
            f"project/recovery/{quote(project_id, safe='')}",
            json_body={
                "type": recovery_type,
                "recoveryId": recovery_id,
                "acknowledgeStaleFence": True,
            },
            headers={"If-Match": etag},
            mutation=True,
            include_response=True,
            guarded_recovery_write=True,
        )
        result = self._require_exact_mutation_object(
            payload,
            "project fence recovery",
            frozenset({"cleared", "current"}),
        )
        current = result.get("current")
        if (
            result.get("cleared") != {"type": recovery_type, "recoveryId": recovery_id}
            or not isinstance(current, dict)
            or current.get("projectId") != project_id
        ):
            raise OutcomeUnknownError(
                "Project fence recovery returned an inconsistent result; inspect before retrying."
            )
        next_etag = response.headers.get("etag")
        if (
            not isinstance(next_etag, str)
            or _PROJECT_RECOVERY_ETAG.fullmatch(next_etag) is None
            or next_etag == etag
        ):
            raise OutcomeUnknownError(
                "Project fence recovery returned no distinct valid current ETag; inspect before "
                "retrying."
            )
        return result, next_etag

    def get_project_task_snapshot(self, task_id: str) -> tuple[dict[str, Any], str]:
        payload, response = self._request(
            "GET", f"project/task/get/{quote(task_id, safe='')}", include_response=True
        )
        result = self._require_object(payload, "project task")
        self._require_snapshot_identifier(result, "_id", task_id, "project task")
        if not isinstance(result.get("projectId"), str) or not result["projectId"]:
            raise RemoteApiError("Titra returned a project task without its project scope.")
        etag = self._resource_etag(response, "project-task", "a project task")
        return result, etag

    def edit_project_task(
        self,
        task_id: str,
        *,
        expected: dict[str, Any],
        changes: dict[str, Any],
        etag: str,
    ) -> tuple[dict[str, Any], str]:
        changed_fields = _changed_fields(expected, changes, label="Project-task details")
        expected_etag = self._expected_resource_etag(
            "project-task", etag, changed=bool(changed_fields)
        )
        payload, response = self._request(
            "PATCH",
            f"project/task/details/{quote(task_id, safe='')}",
            json_body={"expected": expected, "changes": changes},
            headers={"If-Match": etag},
            mutation=True,
            include_response=True,
        )
        result = self._require_exact_mutation_object(
            payload,
            "project-task update",
            frozenset({"taskId", "changed", "changedFields", "current"}),
        )
        current = result.get("current")
        if (
            result.get("taskId") != task_id
            or type(result.get("changed")) is not bool
            or result["changed"] is not bool(changed_fields)
            or result.get("changedFields") != changed_fields
            or not isinstance(current, dict)
            or set(current) != _PROJECT_TASK_FIELDS
            or any(not _same_json_value(current.get(field), changes[field]) for field in changes)
        ):
            raise OutcomeUnknownError(
                "Titra returned an inconsistent project-task update; reconcile before retrying."
            )
        next_etag = self._require_exact_mutation_etag(
            response, expected_etag, "a project-task update"
        )
        return result, next_etag

    def delete_project_task(
        self,
        task_id: str,
        *,
        expected_name: str,
        acknowledge_recorded_entries: bool,
        etag: str,
    ) -> dict[str, Any]:
        resource_revision_from_etag("project-task", etag)
        payload = self._request(
            "DELETE",
            f"project/task/delete/{quote(task_id, safe='')}",
            json_body={
                "expectedName": expected_name,
                "acknowledgeRecordedEntries": acknowledge_recorded_entries,
            },
            headers={"If-Match": etag},
            mutation=True,
        )
        result = self._require_exact_mutation_object(
            payload,
            "project-task deletion",
            frozenset({"taskId", "deleted", "references"}),
        )
        references = result.get("references")
        if (
            result.get("taskId") != task_id
            or result.get("deleted") is not True
            or not isinstance(references, dict)
            or set(references) != {"conflict", "isDefault", "dependentTaskCount", "recordCount"}
            or references.get("conflict") is not False
            or references.get("isDefault") is not False
            or type(references.get("dependentTaskCount")) is not int
            or references["dependentTaskCount"] != 0
            or type(references.get("recordCount")) is not int
            or references["recordCount"] < 0
        ):
            raise OutcomeUnknownError(
                "Titra returned an inconsistent project-task deletion result; reconcile before "
                "retrying."
            )
        return result

    def list_task_suggestions(self, *, limit: int = 100) -> list[dict[str, Any]]:
        if type(limit) is not int or not 1 <= limit <= 500:
            raise ConfigurationError("Task suggestion limit must be between 1 and 500.")
        items: list[dict[str, Any]] = []
        seen_item_ids: set[str] = set()
        seen_cursors: set[str] = set()
        previous_id: str | None = None
        cursor: str | None = None
        while True:
            suffix = f"?limit={limit}"
            if cursor is not None:
                suffix += f"&cursor={quote(cursor, safe='')}"
            payload = self._request("GET", f"task-suggestions/{suffix}")
            page_result = self._require_object(payload, "task suggestions")
            if set(page_result) != {"items", "page"}:
                raise RemoteApiError("Titra returned an invalid task-suggestion page.")
            page_items = self._list_payload(page_result.get("items"), "task-suggestion")
            page = page_result.get("page")
            if (
                not isinstance(page, dict)
                or set(page) != {"version", "limit", "returned", "complete", "nextCursor"}
                or page.get("version") != 1
                or page.get("limit") != limit
                or type(page.get("returned")) is not int
                or page["returned"] != len(page_items)
                or type(page.get("complete")) is not bool
            ):
                raise RemoteApiError("Titra returned invalid task-suggestion page metadata.")
            for item in page_items:
                item_id = item.get("_id")
                if (
                    not isinstance(item_id, str)
                    or not item_id
                    or len(item_id) > 128
                    or item_id in seen_item_ids
                    or (previous_id is not None and item_id <= previous_id)
                ):
                    raise RemoteApiError("Titra returned task suggestions outside stable ID order.")
                seen_item_ids.add(item_id)
                previous_id = item_id
                items.append(item)
            next_cursor = page.get("nextCursor")
            if page["complete"]:
                if next_cursor is not None:
                    raise RemoteApiError(
                        "Titra returned a cursor for a complete task-suggestion page."
                    )
                return items
            if (
                not page_items
                or not isinstance(next_cursor, str)
                or not next_cursor
                or len(next_cursor) > 512
                or _OPAQUE_CURSOR.fullmatch(next_cursor) is None
                or next_cursor in seen_cursors
            ):
                raise RemoteApiError("Titra returned an invalid task-suggestion cursor.")
            seen_cursors.add(next_cursor)
            cursor = next_cursor

    def get_task_suggestion_snapshot(self, suggestion_id: str) -> tuple[dict[str, Any], str]:
        payload, response = self._request(
            "GET",
            f"task-suggestions/get/{quote(suggestion_id, safe='')}",
            include_response=True,
        )
        result = self._require_object(payload, "task suggestion")
        self._require_snapshot_identifier(result, "_id", suggestion_id, "task suggestion")
        etag = self._resource_etag(response, "task-suggestion", "a task suggestion")
        return result, etag

    def delete_task_suggestion(
        self,
        suggestion_id: str,
        *,
        expected_name: str,
        acknowledge_referenced_records: bool,
        etag: str,
    ) -> dict[str, Any]:
        resource_revision_from_etag("task-suggestion", etag)
        payload = self._request(
            "DELETE",
            f"task-suggestions/delete/{quote(suggestion_id, safe='')}",
            json_body={
                "expectedName": expected_name,
                "acknowledgeReferencedRecords": acknowledge_referenced_records,
            },
            headers={"If-Match": etag},
            mutation=True,
        )
        result = self._require_exact_mutation_object(
            payload,
            "task-suggestion deletion",
            frozenset({"suggestionId", "deleted", "usage"}),
        )
        usage = result.get("usage")
        if (
            result.get("suggestionId") != suggestion_id
            or result.get("deleted") is not True
            or not isinstance(usage, dict)
            or set(usage) != {"recordCount", "totalHours", "lastRecordedAt", "projectCount"}
            or type(usage.get("recordCount")) is not int
            or usage["recordCount"] < 0
            or not _finite_number(usage.get("totalHours"))
            or (
                usage.get("lastRecordedAt") is not None
                and not isinstance(usage["lastRecordedAt"], str)
            )
            or type(usage.get("projectCount")) is not int
            or usage["projectCount"] < 0
        ):
            raise OutcomeUnknownError(
                "Titra returned an inconsistent task-suggestion deletion result; reconcile before "
                "retrying."
            )
        return result

    def timer_start(self, *, operation_id: str | None = None) -> dict[str, Any]:
        if operation_id is not None and (
            not 8 <= len(operation_id) <= 128
            or re.fullmatch(r"[A-Za-z0-9._:-]+", operation_id) is None
        ):
            raise ConfigurationError("Timer operation ID must be 8-128 safe ASCII characters.")
        try:
            response_result = self._request(
                "POST",
                "timer/start/",
                json_body={"operationId": operation_id} if operation_id is not None else {},
                mutation=True,
                include_response=operation_id is not None,
                definite_mutation_messages=frozenset({"There is already another running timer."}),
            )
        except RemoteApiError as exc:
            if "already another running timer" in str(exc):
                raise ConflictError("There is already a running Titra timer.") from exc
            raise
        if operation_id is not None:
            payload, response = response_result
            result = self._require_timer_payload(
                payload,
                label="timer-start",
                expected_timer_id=operation_id,
                includes_changed=True,
            )
            revision = result["revision"]
            if type(revision) is not int or result.get("legacy") is not False:
                raise OutcomeUnknownError(
                    "Titra returned an inconsistent atomic timer-start result; inspect before "
                    "retrying."
                )
            self._require_exact_mutation_etag(
                response,
                f'"titra-timer-revision-{revision}"',
                "a timer start",
            )
            return result
        payload = response_result
        if payload is None:
            return {}
        if not isinstance(payload, dict):
            raise OutcomeUnknownError(
                "Titra returned invalid timer-start information; inspect the timer before retrying."
            )
        return payload

    def timer_get(self) -> dict[str, Any]:
        payload, _etag = self.timer_get_snapshot()
        return payload

    def timer_get_snapshot(self) -> tuple[dict[str, Any], str | None]:
        try:
            payload, response = self._request("GET", "timer/get/", include_response=True)
        except RemoteApiError as exc:
            if "No running timer" in str(exc):
                raise NotFoundError("No running timer found.") from exc
            raise
        if not isinstance(payload, dict):
            raise RemoteApiError("Titra returned invalid timer information.", payload)
        etag = response.headers.get("etag")
        if etag is not None:
            try:
                revision = resource_revision_from_etag("timer", etag)
            except ConfigurationError as exc:
                raise RemoteApiError("Titra returned an invalid timer revision ETag.") from exc
            payload = self._require_timer_payload(payload, label="timer", includes_changed=False)
            if payload.get("revision") != revision:
                raise RemoteApiError("Titra returned timer state with an inconsistent revision.")
        return payload, etag

    def timer_stop(self, *, timer_id: str | None = None, etag: str | None = None) -> dict[str, Any]:
        if (timer_id is None) != (etag is None):
            # A legacy v6 timer legitimately has a null timerId but still has
            # an ETag. Callers use timer_stop_snapshot for that rare case.
            raise ConfigurationError("Timer ID and revision ETag must be supplied together.")
        if timer_id is not None and (
            not 8 <= len(timer_id) <= 128 or re.fullmatch(r"[A-Za-z0-9._:-]+", timer_id) is None
        ):
            raise ConfigurationError("Timer ID must be 8-128 safe ASCII characters.")
        expected_revision = resource_revision_from_etag("timer", etag) if etag is not None else None
        if etag is not None and expected_revision == MAX_SAFE_REVISION:
            raise ConfigurationError("Titra timer revision cannot safely advance.")
        try:
            response_result = self._request(
                "POST",
                "timer/stop/",
                json_body={"timerId": timer_id} if etag is not None else {},
                headers={"If-Match": etag} if etag is not None else None,
                mutation=True,
                include_response=etag is not None,
                definite_mutation_messages=frozenset({"No running timer found."}),
            )
        except RemoteApiError as exc:
            if "No running timer" in str(exc):
                raise NotFoundError("No running timer found.") from exc
            raise
        if etag is not None:
            payload, response = response_result
            result = self._require_timer_payload(
                payload,
                label="stopped-timer",
                expected_timer_id=timer_id,
                includes_changed=True,
                stopped=True,
            )
            if result.get("revision") != expected_revision:
                raise OutcomeUnknownError(
                    "Titra returned an inconsistent stopped-timer revision; reconcile before "
                    "retrying."
                )
            self._require_exact_mutation_etag(
                response,
                f'"titra-timer-revision-{(expected_revision or 0) + 1}"',
                "a timer stop",
            )
            return result
        payload = response_result
        if not isinstance(payload, dict):
            raise OutcomeUnknownError(
                "Titra returned invalid stopped-timer information; reconcile before retrying."
            )
        return payload

    def timer_stop_snapshot(self, snapshot: dict[str, Any], etag: str | None) -> dict[str, Any]:
        if etag is None:
            return self.timer_stop()
        expected_revision = resource_revision_from_etag("timer", etag)
        if expected_revision == MAX_SAFE_REVISION:
            raise ConfigurationError("Titra timer revision cannot safely advance.")
        if "timerId" not in snapshot or (
            snapshot["timerId"] is not None and not isinstance(snapshot["timerId"], str)
        ):
            raise ConfigurationError("Titra returned an invalid atomic timer snapshot.")
        if snapshot["timerId"] is not None and (
            not 8 <= len(snapshot["timerId"]) <= 128
            or re.fullmatch(r"[A-Za-z0-9._:-]+", snapshot["timerId"]) is None
        ):
            raise ConfigurationError("Titra returned an invalid atomic timer snapshot.")
        try:
            payload, response = self._request(
                "POST",
                "timer/stop/",
                json_body={"timerId": snapshot["timerId"]},
                headers={"If-Match": etag},
                mutation=True,
                include_response=True,
                definite_mutation_messages=frozenset({"No running timer found."}),
            )
        except RemoteApiError as exc:
            if "No running timer" in str(exc):
                raise NotFoundError("No running timer found.") from exc
            raise
        result = self._require_timer_payload(
            payload,
            label="stopped-timer",
            expected_timer_id=snapshot["timerId"],
            includes_changed=True,
            stopped=True,
        )
        if result.get("revision") != expected_revision or result.get("startTime") != snapshot.get(
            "startTime"
        ):
            raise OutcomeUnknownError(
                "Titra returned an inconsistent stopped-timer result; reconcile before retrying."
            )
        self._require_exact_mutation_etag(
            response,
            f'"titra-timer-revision-{(expected_revision or 0) + 1}"',
            "a timer stop",
        )
        return result

    def capability_report(self) -> dict[str, Any]:
        report: dict[str, Any] = {"projects": False, "identity": False, "record_delete": False}
        self.list_projects()
        report["projects"] = True
        try:
            self.current_user()
        except NotFoundError:
            report["identity"] = False
        else:
            report["identity"] = True
            report["record_delete"] = True
        capabilities = self.capabilities()
        api_version = capabilities.get("apiVersion") if isinstance(capabilities, dict) else None
        capabilities_version = (
            capabilities.get("capabilitiesVersion") if isinstance(capabilities, dict) else None
        )
        deployment = capabilities.get("deployment") if isinstance(capabilities, dict) else None
        report["api_version"] = api_version if type(api_version) is int else None
        report["capabilities_version"] = (
            capabilities_version if type(capabilities_version) is int else None
        )
        report["capability_source"] = self.capability_source
        report["v6_ready"] = bool(
            report["api_version"] == 2
            and isinstance(report["capabilities_version"], int)
            and report["capabilities_version"] >= 2
            and self.capability_source == "/capabilities/v2/"
        )
        report["v7_ready"] = bool(
            report["api_version"] == 2
            and report["capabilities_version"] == 3
            and exact_v7_capabilities(capabilities)
            and self.capability_source == "/capabilities/v2/"
        )
        if report["v7_ready"] and isinstance(capabilities, dict):
            contracts = capabilities.get("contracts")
            security_contract = contracts.get("security") if isinstance(contracts, dict) else None
            security_deployment = (
                deployment.get("security") if isinstance(deployment, dict) else None
            )
            report["security_policy"] = {
                "contract": deepcopy(security_contract),
                "deployment": deepcopy(security_deployment),
            }
        report["project_lifecycle"] = all(
            self.supports_v2_feature("projects", feature)
            for feature in (
                "list",
                "create",
                "read",
                "detailsEdit",
                "archive",
                "emptyDelete",
            )
        )
        report["project_task_lifecycle"] = self.supports_v2_feature("projects", "tasks", minimum=2)
        report["task_stats"] = self.supports_v2_feature("projects", "taskStats")
        report["record_details_edit"] = self.supports_v2_feature("timeEntries", "detailsEdit")
        report["task_suggestions"] = all(
            self.supports_v2_feature("taskSuggestions", feature)
            for feature in ("list", "read", "delete")
        )
        report["atomic_timers"] = self.supports_atomic_timers()
        report["webhook_receiver"] = bool(
            self.supports_v2_feature("webhooks", "actionVerificationReceiver", minimum=3)
            and isinstance(deployment, dict)
            and deployment.get("webhookActionVerificationEnabled") is True
        )
        report["record_task_edit"] = self.supports_task_edit()
        report["idempotent_create"] = self.supports_idempotent_create()
        report["timeentry_pagination"] = self.supports_timeentry_pagination()
        report["project_fence_recovery"] = self.supports_project_fence_recovery()
        return report

    def api_security_headers_report(self, *, require_hsts: bool = False) -> dict[str, Any]:
        """Inspect the authenticated v7 API response headers without exposing credentials."""

        self.capabilities_v2(required=True)
        _payload, response = self._request("GET", "capabilities/v2/", include_response=True)
        required = {
            "cache-control": "no-store",
            "pragma": "no-cache",
            "cross-origin-opener-policy": "same-origin-allow-popups",
            "permissions-policy": ("camera=(), geolocation=(), microphone=(), payment=(), usb=()"),
            "referrer-policy": "no-referrer",
            "x-content-type-options": "nosniff",
            "x-dns-prefetch-control": "off",
        }
        observed = {name: response.headers.get(name) for name in required}
        missing_or_mismatched = [
            name for name, expected in required.items() if observed[name] != expected
        ]
        hsts = response.headers.get("strict-transport-security")
        if require_hsts and hsts != "max-age=31536000":
            missing_or_mismatched.append("strict-transport-security")
        return {
            "ok": not missing_or_mismatched,
            "profile": "v7-http-security/v1",
            "headers": {
                **observed,
                "strict-transport-security": hsts,
            },
            "hsts_required": require_hsts,
            "missing_or_mismatched": missing_or_mismatched,
        }

    @staticmethod
    def _legacy_html_fallback(error: RemoteApiError) -> bool:
        # Older Meteor deployments route unknown paths to their HTML shell with
        # HTTP 200. This exact response shape is the only non-404 condition that
        # proves the capability endpoint itself is unavailable.
        return "non-JSON data (HTTP 200)" in str(error)

    def capabilities_v2(self, *, required: bool = False) -> dict[str, Any] | None:
        """Return the authenticated v2 capability document, never a guessed downgrade."""

        if self._capabilities_v2_loaded:
            if required and self._capabilities_v2 is None:
                raise ConfigurationError("This Titra server does not provide /capabilities/v2/.")
            return deepcopy(self._capabilities_v2)
        try:
            payload, response = self._request("GET", "capabilities/v2/", include_response=True)
        except NotFoundError:
            payload = None
        except RemoteApiError as exc:
            if not self._legacy_html_fallback(exc):
                raise
            payload = None
        else:
            body = response.json()
            media_type = response.headers.get("content-type", "").split(";", 1)[0].strip()
            if (
                media_type != "application/vnd.titra.v2+json"
                or not isinstance(body, dict)
                or set(body) != {"apiVersion", "payload"}
                or body.get("apiVersion") != 2
            ):
                raise RemoteApiError("Titra returned an invalid capabilities-v2 envelope.")
        if payload is not None and not _valid_v2_capabilities(payload):
            raise RemoteApiError("Titra returned an invalid capabilities-v2 document.")
        self._capabilities_v2 = deepcopy(payload)
        self._capabilities_v2_loaded = True
        if payload is not None:
            self._capability_source = "/capabilities/v2/"
        elif required:
            raise ConfigurationError("This Titra server does not provide /capabilities/v2/.")
        return deepcopy(self._capabilities_v2)

    def capabilities_v1(self) -> dict[str, Any] | None:
        """Return the frozen v1 compatibility document when that route exists."""

        if self._capabilities_v1_loaded:
            return deepcopy(self._capabilities_v1)
        try:
            payload = self._request("GET", "capabilities/")
        except NotFoundError:
            payload = None
        except RemoteApiError as exc:
            if not self._legacy_html_fallback(exc):
                raise
            payload = None
        if payload is not None and (
            not isinstance(payload, dict) or payload.get("apiVersion") != 1
        ):
            raise RemoteApiError("Titra returned an invalid capabilities-v1 document.")
        self._capabilities_v1 = deepcopy(payload)
        self._capabilities_v1_loaded = True
        if payload is not None:
            self._capability_source = "/capabilities/"
        return deepcopy(self._capabilities_v1)

    def capabilities(self) -> dict[str, Any] | None:
        """Negotiate v2 first and fall back only when that endpoint is definitely absent."""

        payload = self.capabilities_v2()
        if payload is not None:
            self._capability_source = "/capabilities/v2/"
            return payload
        payload = self.capabilities_v1()
        self._capability_source = "/capabilities/" if payload is not None else None
        return payload

    @property
    def capability_source(self) -> str | None:
        return self._capability_source

    def _api_capabilities(self) -> dict[str, Any] | None:
        return self.capabilities()

    def supports_task_edit(self) -> bool:
        """Accept only explicit, read-only discovery of the guarded task-edit contract."""
        payload = self._api_capabilities()
        if not isinstance(payload, dict) or type(payload.get("apiVersion")) is not int:
            return False
        if payload["apiVersion"] == 2:
            return self.supports_v2_feature("timeEntries", "taskEdit")
        features, limits = payload.get("features"), payload.get("taskUpdate")
        return (
            payload["apiVersion"] == 1
            and isinstance(features, dict)
            and features.get("timeEntryTaskUpdate") is True
            and isinstance(limits, dict)
            and limits.get("requiresIfMatch") is True
            and limits.get("requiresExpectedTask") is True
            and type(limits.get("maxTaskLength")) is int
            and limits.get("maxTaskLength") == 1000
            and limits.get("preservesOtherFields") is True
        )

    def supports_idempotent_create(self, operation: str | None = None) -> bool:
        payload = self._api_capabilities()
        if not isinstance(payload, dict) or payload.get("apiVersion") not in {1, 2}:
            return False
        features = payload.get("features")
        contract = payload.get("idempotency")
        if not isinstance(features, dict):
            return False
        if payload["apiVersion"] == 1:
            feature_enabled = features.get("idempotentCreate") is True
        else:
            idempotency_features = features.get("idempotency")
            feature_enabled = (
                isinstance(idempotency_features, dict)
                and idempotency_features.get("create", 0) >= 1
            )
        if not (
            isinstance(features, dict)
            and feature_enabled
            and isinstance(contract, dict)
            and contract.get("version") == 1
            and contract.get("header") == "Idempotency-Key"
            and contract.get("minKeyLength") == 16
            and contract.get("maxKeyLength") == 128
            and type(contract.get("retentionSeconds")) is int
            and contract["retentionSeconds"] > 0
            and isinstance(contract.get("operations"), list)
            and all(isinstance(value, str) for value in contract["operations"])
        ):
            return False
        return operation is None or operation in contract["operations"]

    def supports_timeentry_pagination(self) -> bool:
        payload = self._api_capabilities()
        if not isinstance(payload, dict) or payload.get("apiVersion") not in {1, 2}:
            return False
        features = payload.get("features")
        contract = payload.get("timeEntryPagination")
        if not isinstance(features, dict):
            return False
        if payload["apiVersion"] == 1:
            feature_enabled = features.get("timeEntryPagination") is True
        else:
            pagination_features = features.get("pagination")
            feature_enabled = (
                isinstance(pagination_features, dict)
                and pagination_features.get("stableCursor", 0) >= 1
            )
        return bool(
            isinstance(features, dict)
            and feature_enabled
            and isinstance(contract, dict)
            and contract.get("version") == 1
            and contract.get("defaultLimit") == 200
            and contract.get("maxLimit") == 500
            and contract.get("consistency") == "live-keyset"
            and contract.get("ownerPath") == "timeentry/daterange-page"
            and contract.get("projectPath") == "project/timeentriesfordaterange-page"
        )

    def supports_v2_feature(self, group: str, feature: str, *, minimum: int = 1) -> bool:
        payload = self._api_capabilities()
        if not isinstance(payload, dict) or payload.get("apiVersion") != 2:
            return False
        groups = payload.get("features")
        values = groups.get(group) if isinstance(groups, dict) else None
        value = values.get(feature) if isinstance(values, dict) else None
        return type(value) is int and value >= minimum

    def supports_v2_contract(self, contract: str, *, minimum: int = 1) -> bool:
        payload = self._api_capabilities()
        if not isinstance(payload, dict) or payload.get("apiVersion") != 2:
            return False
        contracts = payload.get("contracts")
        value = contracts.get(contract) if isinstance(contracts, dict) else None
        return type(value) is int and value >= minimum

    def supports_atomic_timers(self) -> bool:
        return self.supports_v2_feature("timers", "atomicTransitions", minimum=2)

    def supports_project_fence_recovery(self) -> bool:
        payload = self._api_capabilities()
        deployment = payload.get("deployment") if isinstance(payload, dict) else None
        return (
            self.supports_v2_feature("projects", "fenceRecovery")
            and self.supports_v2_contract("projectFenceRecovery")
            and isinstance(deployment, dict)
            and deployment.get("projectFenceRecoveryEnabled") is True
        )


@contextmanager
def client_for(config: ResolvedConfig) -> Iterator[TitraClient]:
    client = TitraClient(config)
    try:
        yield client
    finally:
        client.close()
