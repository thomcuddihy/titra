"""HTTP contract tests for :mod:`titra_cli.api`.

Every test uses ``httpx.MockTransport``.  If one of these tests ever attempts to
use the network, construction of the client without an explicit mock transport
would itself be a test bug.
"""

from __future__ import annotations

import json
from collections.abc import Callable
from copy import deepcopy
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from typing import Any

import httpx
import pytest

from titra_cli.api import TitraClient
from titra_cli.dates import DateRange
from titra_cli.errors import (
    ActionVerificationRequiredError,
    AuthenticationError,
    ConfigurationError,
    ConflictError,
    ExitCode,
    NotFoundError,
    OutcomeUnknownError,
    RateLimitError,
    RemoteApiError,
)
from titra_cli.models import ResolvedConfig
from titra_cli.v2_contract import EXPECTED_V2_CAPABILITIES, EXPECTED_V7_CAPABILITIES

API_KEY = "super-secret-api-token"
SERVER = "https://titra.example.test/base"


def make_config(**overrides: Any) -> ResolvedConfig:
    values: dict[str, Any] = {
        "profile": "work",
        "server": SERVER,
        "api_key": API_KEY,
        "username": "Ada Example",
        "timezone": "Australia/Brisbane",
        "verify_tls": True,
        "timeout": 7.5,
        "source_files": (Path("/private/credentials.toml"),),
    }
    values.update(overrides)
    return ResolvedConfig(**values)


def envelope(
    request: httpx.Request,
    payload: Any = None,
    *,
    status: int = 200,
    message: str = "ok",
    include_payload: bool = True,
    headers: dict[str, str] | None = None,
) -> httpx.Response:
    body: dict[str, Any] = {"statusCode": status, "message": message}
    if include_payload:
        body["payload"] = payload
    return httpx.Response(status, json=body, headers=headers, request=request)


def v2_envelope(
    request: httpx.Request,
    payload: Any,
    *,
    status: int = 200,
    headers: dict[str, str] | None = None,
) -> httpx.Response:
    response_headers = {
        "Content-Type": "application/vnd.titra.v2+json",
        "X-Request-ID": request.headers["X-Request-ID"],
        **(headers or {}),
    }
    return httpx.Response(
        status,
        json={"apiVersion": 2, "payload": payload},
        headers=response_headers,
        request=request,
    )


def v2_problem(
    request: httpx.Request,
    *,
    status: int,
    code: str,
    category: str,
    message: str,
    outcome: str,
    retry_after: int | None = None,
) -> httpx.Response:
    request_id = request.headers["X-Request-ID"]
    retry = {"allowed": retry_after is not None}
    if retry_after is not None:
        retry["afterSeconds"] = retry_after
    return httpx.Response(
        status,
        json={
            "error": {
                "version": 1,
                "code": code,
                "category": category,
                "message": message,
                "requestId": request_id,
                "outcome": outcome,
                "retry": retry,
            }
        },
        headers={
            "Content-Type": "application/problem+json",
            "X-Request-ID": request_id,
        },
        request=request,
    )


def client_with(
    handler: Callable[[httpx.Request], httpx.Response],
    *,
    config: ResolvedConfig | None = None,
    environment: dict[str, str] | None = None,
    sleeper: Callable[[float], None] | None = None,
    clock: Callable[[], float] | None = None,
) -> TitraClient:
    options: dict[str, Any] = {
        "transport": httpx.MockTransport(handler),
        "environment": {} if environment is None else environment,
    }
    if sleeper is not None:
        options["sleeper"] = sleeper
    if clock is not None:
        options["clock"] = clock
    return TitraClient(config or make_config(), **options)


def raw_path(request: httpx.Request) -> str:
    return request.url.raw_path.decode("ascii")


def json_body(request: httpx.Request) -> Any:
    return json.loads(request.content.decode("utf-8"))


def test_auth_headers_and_resolved_config_redaction() -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return envelope(request, [])

    config = make_config()
    with client_with(handler, config=config) as client:
        assert client.list_projects() == []

    assert len(requests) == 1
    request = requests[0]
    assert request.headers["Authorization"] == f"Bearer {API_KEY}"
    assert request.headers["Accept"] == "application/json"
    assert request.headers["User-Agent"].startswith("titra-cli/")
    assert "Ada Example" not in request.headers.values()
    assert API_KEY not in str(request.url)

    redacted = config.redacted()
    serialized = json.dumps(redacted, sort_keys=True)
    assert redacted["api_key"] == "<redacted>"
    assert API_KEY not in serialized
    assert redacted["username"] == "Ada Example"


def test_transport_request_spacing_uses_monotonic_request_start_times() -> None:
    observed_starts: list[float] = []
    sleeps: list[float] = []
    current = [100.0]

    def clock() -> float:
        return current[0]

    def sleeper(delay: float) -> None:
        sleeps.append(delay)
        current[0] += delay

    def handler(request: httpx.Request) -> httpx.Response:
        observed_starts.append(clock())
        return envelope(request, [])

    with client_with(
        handler,
        environment={"TITRA_CLI_MIN_REQUEST_SPACING_SECONDS": "0.25"},
        sleeper=sleeper,
        clock=clock,
    ) as client:
        client.list_projects()
        client.list_projects()
        current[0] += 0.1
        client.list_projects()

    assert observed_starts == pytest.approx([100.0, 100.25, 100.5])
    assert sleeps == pytest.approx([0.25, 0.15])


@pytest.mark.parametrize("environment", [{}, {"TITRA_CLI_MIN_REQUEST_SPACING_SECONDS": "0"}])
def test_transport_request_spacing_is_disabled_by_default_or_zero(
    environment: dict[str, str],
) -> None:
    def unexpected_sleep(_delay: float) -> None:
        raise AssertionError("disabled pacing must not read the clock or sleep")

    def unexpected_clock() -> float:
        raise AssertionError("disabled pacing must not read the clock or sleep")

    with client_with(
        lambda request: envelope(request, []),
        environment=environment,
        sleeper=unexpected_sleep,
        clock=unexpected_clock,
    ) as client:
        assert client.list_projects() == []


@pytest.mark.parametrize("value", ["", "not-a-number", "nan", "inf", "-0.1", "60.1"])
def test_transport_request_spacing_rejects_invalid_environment_values(value: str) -> None:
    with pytest.raises(ConfigurationError, match="TITRA_CLI_MIN_REQUEST_SPACING_SECONDS"):
        client_with(
            lambda request: envelope(request, []),
            environment={"TITRA_CLI_MIN_REQUEST_SPACING_SECONDS": value},
        )


@pytest.mark.parametrize("value", ["0", "60"])
def test_transport_request_spacing_accepts_range_boundaries(value: str) -> None:
    with client_with(
        lambda request: envelope(request, []),
        environment={"TITRA_CLI_MIN_REQUEST_SPACING_SECONDS": value},
        sleeper=lambda _delay: None,
        clock=lambda: 1.0,
    ):
        pass


def test_transport_pacing_does_not_replay_a_rate_limited_mutation() -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return envelope(
            request,
            status=429,
            message="Too many requests.",
            headers={"Retry-After": "1"},
        )

    with (
        client_with(
            handler,
            environment={"TITRA_CLI_MIN_REQUEST_SPACING_SECONDS": "0.25"},
            sleeper=lambda _delay: None,
            clock=lambda: 1.0,
        ) as client,
        pytest.raises(RateLimitError),
    ):
        client.create_project({"name": "single-attempt"})

    assert len(requests) == 1
    assert requests[0].method == "POST"


def test_all_simple_routes_methods_bodies_and_encoded_identifiers() -> None:
    requests: list[httpx.Request] = []
    payloads: list[Any] = [
        [{"_id": "project-1", "name": "Project One"}],
        {"projectId": "project-created"},
        [{"_id": "task-1", "name": "Task One"}],
        {"taskId": "task-created"},
        {"timecardId": "record-created"},
        {"_id": "record/one", "hours": 1.25},
        {"_id": "user-1", "name": "Ada Example"},
        [{"_id": "user-1", "name": "Ada Example"}],
        {"startTime": "2026-08-30T00:00:00.000Z"},
        {"startTime": "2026-08-30T00:00:00.000Z", "duration": 1_000},
        {"startTime": "2026-08-30T00:00:00.000Z", "duration": 2_000},
    ]

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return envelope(request, payloads[len(requests) - 1])

    project_values = {
        "name": "Project One",
        "color": "#123456",
        "customer": "Example Org",
        "rate": 125.5,
    }
    task_values = {
        "projectId": "project/with space",
        "name": "Task One",
        "start": "2026-08-30T00:00:00.000Z",
        "end": "2026-08-31T00:00:00.000Z",
        "estimatedHours": 4.5,
    }
    record_values = {
        "projectId": "project/with space",
        "task": "Task One",
        "date": "2026-08-30",
        "startTime": "09:15",
        "hours": 1.25,
        "customfields": {"ticket": "ABC-123"},
    }

    with client_with(handler) as client:
        assert client.list_projects()[0]["_id"] == "project-1"
        assert client.create_project(project_values) == "project-created"
        assert client.list_tasks("project/with space")[0]["_id"] == "task-1"
        assert client.create_task(task_values) == "task-created"
        assert client.create_time_entry(record_values) == "record-created"
        assert client.get_time_entry("record/one")["hours"] == 1.25
        assert client.current_user()["_id"] == "user-1"
        assert client.project_users("project/with space")[0]["_id"] == "user-1"
        assert client.timer_start()["startTime"].startswith("2026-08-30")
        assert client.timer_get()["duration"] == 1_000
        assert client.timer_stop()["duration"] == 2_000

    observed = [(request.method, raw_path(request)) for request in requests]
    assert observed == [
        ("GET", "/base/project/list/"),
        ("POST", "/base/project/create/"),
        ("GET", "/base/project/tasks/project%2Fwith%20space"),
        ("POST", "/base/project/task/create/"),
        ("POST", "/base/timeentry/create/"),
        ("GET", "/base/timeentry/get/record%2Fone"),
        ("GET", "/base/user/me/"),
        ("GET", "/base/project/users/project%2Fwith%20space"),
        ("POST", "/base/timer/start/"),
        ("GET", "/base/timer/get/"),
        ("POST", "/base/timer/stop/"),
    ]
    assert json_body(requests[1]) == project_values
    assert json_body(requests[3]) == task_values
    assert json_body(requests[4]) == record_values
    assert json_body(requests[8]) == {}
    assert json_body(requests[10]) == {}


def test_get_snapshot_captures_strong_etag_and_delete_sends_if_match() -> None:
    requests: list[httpx.Request] = []
    revision = '"titra-date-revision-3"'

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if request.method == "GET":
            return envelope(
                request,
                {"_id": "record/one", "hours": 2.0},
                headers={"ETag": revision},
            )
        return envelope(
            request,
            {"timecardId": "record/one"},
            message="Time entry deleted.",
        )

    with client_with(handler) as client:
        entry, etag = client.get_time_entry_snapshot("record/one")
        assert entry == {"_id": "record/one", "hours": 2.0}
        assert etag == revision
        assert client.delete_time_entry("record/one", etag=etag) == {"timecardId": "record/one"}

    assert [(request.method, raw_path(request)) for request in requests] == [
        ("GET", "/base/timeentry/get/record%2Fone"),
        ("DELETE", "/base/timeentry/delete/record%2Fone"),
    ]
    assert "If-Match" not in requests[0].headers
    assert requests[1].headers["If-Match"] == revision


def test_snapshot_without_etag_returns_none_and_delete_can_omit_precondition() -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if request.method == "GET":
            return envelope(request, {"_id": "record-1"})
        return envelope(request, {"deleted": True})

    with client_with(handler) as client:
        assert client.get_time_entry_snapshot("record-1") == ({"_id": "record-1"}, None)
        assert client.delete_time_entry("record-1") == {"deleted": True}

    assert "If-Match" not in requests[1].headers


@pytest.mark.parametrize(
    ("operation", "payload", "headers"),
    [
        (
            lambda client: client.get_time_entry("record-1"),
            {"_id": "record-2"},
            {},
        ),
        (
            lambda client: client.get_time_entry_snapshot("record-1"),
            {"_id": "record-2"},
            {"ETag": '"titra-date-revision-1"'},
        ),
        (
            lambda client: client.get_project_snapshot("project-1"),
            {"_id": "project-2"},
            {"ETag": '"titra-project-revision-1"'},
        ),
        (
            lambda client: client.get_project_fence_recovery("project-1"),
            {"projectId": "project-2"},
            {"ETag": '"titra-project-recovery-' + "a" * 64 + '"'},
        ),
        (
            lambda client: client.get_project_task_snapshot("task-1"),
            {"_id": "task-2", "projectId": "project-1"},
            {"ETag": '"titra-project-task-revision-1"'},
        ),
        (
            lambda client: client.get_task_suggestion_snapshot("suggestion-1"),
            {"_id": "suggestion-2"},
            {"ETag": '"titra-task-suggestion-revision-1"'},
        ),
    ],
    ids=["record", "record snapshot", "project", "recovery", "task", "suggestion"],
)
def test_resource_snapshots_reject_a_different_path_identity(
    operation: Callable[[TitraClient], Any], payload: dict[str, Any], headers: dict[str, str]
) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return envelope(request, payload, headers=headers)

    with client_with(handler) as client, pytest.raises(RemoteApiError, match="another resource"):
        operation(client)


def test_own_date_ranges_are_inclusive_chunked_and_aggregated_in_order() -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if raw_path(request).endswith(("/capabilities/v2/", "/capabilities/")):
            return envelope(request, status=404, message="Route not found", payload=None)
        return envelope(request, [{"_id": f"chunk-{len(requests)}"}])

    value = DateRange(date(2025, 1, 1), date(2025, 7, 15))
    with client_with(handler) as client:
        records = client.list_own_time_entries(value)

    assert records == [{"_id": "chunk-3"}, {"_id": "chunk-4"}, {"_id": "chunk-5"}]
    assert [raw_path(request) for request in requests] == [
        "/base/capabilities/v2/",
        "/base/capabilities/",
        "/base/timeentry/daterange/2025-01-01/2025-03-31",
        "/base/timeentry/daterange/2025-04-01/2025-06-29",
        "/base/timeentry/daterange/2025-06-30/2025-07-15",
    ]
    assert all(request.method == "GET" for request in requests)


def test_project_date_ranges_encode_project_and_chunk_inclusively() -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if raw_path(request).endswith(("/capabilities/v2/", "/capabilities/")):
            return envelope(request, status=404, message="Route not found", payload=None)
        return envelope(request, [{"_id": f"chunk-{len(requests)}"}])

    value = DateRange(date(2025, 1, 1), date(2025, 7, 15))
    with client_with(handler) as client:
        records = client.list_project_time_entries("project/with space", value)

    assert records == [{"_id": "chunk-3"}, {"_id": "chunk-4"}, {"_id": "chunk-5"}]
    assert [raw_path(request) for request in requests] == [
        "/base/capabilities/v2/",
        "/base/capabilities/",
        "/base/project/timeentriesfordaterange/project%2Fwith%20space/2025-01-01/2025-03-31",
        "/base/project/timeentriesfordaterange/project%2Fwith%20space/2025-04-01/2025-06-29",
        "/base/project/timeentriesfordaterange/project%2Fwith%20space/2025-06-30/2025-07-15",
    ]


def v1_capabilities() -> dict[str, Any]:
    return {
        "apiVersion": 1,
        "features": {
            "timeEntryTaskUpdate": True,
            "idempotentCreate": True,
            "timeEntryPagination": True,
        },
        "taskUpdate": {
            "requiresIfMatch": True,
            "requiresExpectedTask": True,
            "maxTaskLength": 1000,
            "preservesOtherFields": True,
        },
        "idempotency": {
            "version": 1,
            "header": "Idempotency-Key",
            "minKeyLength": 16,
            "maxKeyLength": 128,
            "retentionSeconds": 604800,
            "operations": ["timeentry.create", "project.create", "project-task.create"],
        },
        "timeEntryPagination": {
            "version": 1,
            "defaultLimit": 200,
            "maxLimit": 500,
            "consistency": "live-keyset",
            "ownerPath": "timeentry/daterange-page",
            "projectPath": "project/timeentriesfordaterange-page",
        },
    }


def v6_capabilities(
    *, fence_recovery: bool = True, webhook_receiver: bool = True
) -> dict[str, Any]:
    operations = deepcopy(EXPECTED_V2_CAPABILITIES["mutationPreconditions"]["operations"])
    return {
        "apiVersion": 2,
        "capabilitiesVersion": 2,
        "features": {
            "identity": {"read": 1},
            "projects": {
                "list": 1,
                "create": 1,
                "read": 1,
                "detailsEdit": 1,
                "archive": 1,
                "emptyDelete": 1,
                "fenceRecovery": 1,
                "timeEntries": 1,
                "users": 2,
                "tasks": 2,
                "taskStats": 1,
            },
            "timeEntries": {
                "create": 1,
                "get": 1,
                "delete": 1,
                "listByDay": 1,
                "listByRange": 1,
                "taskEdit": 1,
                "detailsEdit": 1,
            },
            "taskSuggestions": {"list": 1, "read": 1, "delete": 1},
            "timers": {"start": 1, "get": 1, "stop": 1, "atomicTransitions": 2},
            "webhooks": {"actionVerificationReceiver": 3},
            "pagination": {"stableCursor": 1},
            "idempotency": {"create": 1},
        },
        "contracts": {
            "errors": {
                "version": 1,
                "mediaType": "application/problem+json",
                "routes": [
                    {"path": "/capabilities/v2", "methods": ["GET"]},
                    {
                        "path": "/user/action-verification/webhook/:endpointId",
                        "methods": ["POST"],
                    },
                ],
                "otherAdvertisedRoutes": "legacy-v1-envelope",
            },
            "dateOnly": 1,
            "timecardRevisionETag": 1,
            "resourceRevisionETag": 1,
            "projectUserPrivacy": 1,
            "projectFenceRecovery": 1,
            "webhookHmacSha256": 1,
            "webhookRetry": {
                "version": 1,
                "authenticationTimestamp": "fresh",
                "actionTimestamp": "original",
                "configurationBinding": "revision",
                "retentionSeconds": 604800,
                "clientSafetyMarginSeconds": 600,
            },
            "timerStartReplay": {
                "version": 1,
                "scope": "user",
                "activeReplay": "returnExisting",
                "consumedReplay": "conflict",
                "consumedErrorCode": "timer-operation-consumed",
                "retentionSeconds": 604800,
                "clientSafetyMarginSeconds": 600,
            },
            "expectedUserId": {
                "version": 1,
                "header": "X-Titra-Expected-User-Id",
                "appliesTo": "authenticatedRequests",
                "required": False,
                "mismatchStatus": 412,
            },
        },
        "mutationPreconditions": {
            "version": 2,
            "operations": operations,
        },
        "idempotency": {
            "version": 1,
            "header": "Idempotency-Key",
            "minKeyLength": 16,
            "maxKeyLength": 128,
            "retentionSeconds": 604800,
            "operations": ["timeentry.create", "project.create", "project-task.create"],
        },
        "timeEntryPagination": {
            "version": 1,
            "defaultLimit": 200,
            "maxLimit": 500,
            "consistency": "live-keyset",
            "ownerPath": "timeentry/daterange-page",
            "projectPath": "project/timeentriesfordaterange-page",
        },
        "deployment": {
            "projectFenceRecoveryEnabled": fence_recovery,
            "webhookActionVerificationEnabled": webhook_receiver,
        },
        "limits": {
            "taskCodePoints": 1000,
            "taskEditBodyBytes": 65536,
            "webhookBodyBytes": 65536,
            "webhookTimestampSkewSeconds": 300,
            "webhookProcessingLeaseSeconds": 60,
            "webhookReplayRetentionSeconds": 604800,
            "timerStartRetainedOperations": 4096,
            "projectFenceRecoveryMinimumAgeSeconds": 900,
        },
    }


def test_v2_capability_discovery_is_preferred_cached_and_defensively_copied() -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        assert raw_path(request) == "/base/capabilities/v2/"
        return v2_envelope(request, v6_capabilities())

    with client_with(handler) as client:
        first = client.capabilities_v2(required=True)
        assert first is not None
        first["features"]["projects"]["read"] = 0
        assert client.capabilities_v2(required=True)["features"]["projects"]["read"] == 1
        assert client.capabilities()["apiVersion"] == 2
        assert client.capability_source == "/capabilities/v2/"

    assert [raw_path(request) for request in requests] == ["/base/capabilities/v2/"]
    assert all(request.headers.get("X-Request-ID") for request in requests)


def test_capability_discovery_falls_back_only_after_definite_v2_absence() -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if raw_path(request).endswith("/capabilities/v2/"):
            return v2_problem(
                request,
                status=404,
                code="NOT_FOUND",
                category="not_found",
                message="The resource was not found.",
                outcome="rejected",
            )
        return envelope(request, v1_capabilities())

    with client_with(handler) as client:
        assert client.capabilities()["apiVersion"] == 1
        assert client.capability_source == "/capabilities/"
        assert client.capabilities_v2() is None
        with pytest.raises(ConfigurationError, match="does not provide"):
            client.capabilities_v2(required=True)

    assert [raw_path(request) for request in requests] == [
        "/base/capabilities/v2/",
        "/base/capabilities/",
    ]


@pytest.mark.parametrize("failure", ["unavailable", "wrong-envelope", "malformed"])
def test_v2_capability_failure_never_silently_falls_back(failure: str) -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        assert raw_path(request).endswith("/capabilities/v2/")
        if failure == "unavailable":
            return v2_problem(
                request,
                status=503,
                code="MIGRATION_LOCKED",
                category="availability",
                message="Writes are temporarily locked.",
                outcome="rejected",
            )
        if failure == "wrong-envelope":
            return envelope(request, v6_capabilities())
        malformed = v6_capabilities()
        malformed["mutationPreconditions"]["operations"].pop()
        return v2_envelope(request, malformed)

    with client_with(handler) as client, pytest.raises(RemoteApiError):
        client.capabilities()

    assert [raw_path(request) for request in requests] == ["/base/capabilities/v2/"]


@pytest.mark.parametrize("change", ["method", "path", "headers", "extra-field"])
def test_v2_capability_contract_changes_never_authorize_hard_coded_writes(change: str) -> None:
    malformed = v6_capabilities()
    operation = malformed["mutationPreconditions"]["operations"][0]
    if change == "method":
        operation["method"] = "DELETE"
    elif change == "path":
        operation["path"] = "/different/create"
    elif change == "headers":
        operation["headers"] = ["If-Match"]
    else:
        operation["unreviewed"] = True

    def handler(request: httpx.Request) -> httpx.Response:
        return v2_envelope(request, malformed)

    with (
        client_with(handler) as client,
        pytest.raises(RemoteApiError, match="invalid capabilities-v2"),
    ):
        client.capabilities_v2(required=True)


@pytest.mark.parametrize(
    ("change", "value"),
    [
        ("missing", None),
        ("header", "X-Wrong-Expected-User"),
        ("scope", "allRequests"),
        ("required", True),
        ("status", 409),
        ("preconditions-version", 1),
    ],
)
def test_v2_identity_precondition_contract_must_match_exactly(change: str, value: Any) -> None:
    malformed = v6_capabilities()
    if change == "missing":
        del malformed["contracts"]["expectedUserId"]
    elif change == "preconditions-version":
        malformed["mutationPreconditions"]["version"] = value
    else:
        field = {
            "header": "header",
            "scope": "appliesTo",
            "required": "required",
            "status": "mismatchStatus",
        }[change]
        malformed["contracts"]["expectedUserId"][field] = value

    def handler(request: httpx.Request) -> httpx.Response:
        return v2_envelope(request, malformed)

    with (
        client_with(handler) as client,
        pytest.raises(RemoteApiError, match="invalid capabilities-v2"),
    ):
        client.capabilities_v2(required=True)


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("authenticationTimestamp", "original"),
        ("actionTimestamp", "fresh"),
        ("configurationBinding", "none"),
        ("retentionSeconds", 604799),
        ("clientSafetyMarginSeconds", 0),
    ],
)
def test_v2_webhook_retry_contract_must_match_exactly(field: str, value: Any) -> None:
    malformed = v6_capabilities()
    malformed["contracts"]["webhookRetry"][field] = value

    def handler(request: httpx.Request) -> httpx.Response:
        return v2_envelope(request, malformed)

    with (
        client_with(handler) as client,
        pytest.raises(RemoteApiError, match="invalid capabilities-v2"),
    ):
        client.capabilities_v2(required=True)


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("scope", "global"),
        ("activeReplay", "restart"),
        ("consumedReplay", "allow"),
        ("consumedErrorCode", "timer-write-conflict"),
        ("retentionSeconds", 604799),
        ("clientSafetyMarginSeconds", 0),
    ],
)
def test_v2_timer_start_replay_contract_must_match_exactly(field: str, value: Any) -> None:
    malformed = v6_capabilities()
    malformed["contracts"]["timerStartReplay"][field] = value

    def handler(request: httpx.Request) -> httpx.Response:
        return v2_envelope(request, malformed)

    with (
        client_with(handler) as client,
        pytest.raises(RemoteApiError, match="invalid capabilities-v2"),
    ):
        client.capabilities_v2(required=True)


@pytest.mark.parametrize(
    ("status", "outcome", "expected_error"),
    [
        (500, "unknown", OutcomeUnknownError),
        (422, "rejected", RemoteApiError),
        (503, "rejected", RemoteApiError),
    ],
)
def test_v2_problem_outcomes_map_safely_for_mutations(
    status: int, outcome: str, expected_error: type[Exception]
) -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        response = v2_problem(
            request,
            status=status,
            code="WRITE_OUTCOME_UNKNOWN" if outcome == "unknown" else "RULE_REJECTED",
            category="internal" if outcome == "unknown" else "rule",
            message="Safe public message.",
            outcome=outcome,
        )
        response_body = response.json()
        response_body["error"]["privateDebug"] = API_KEY
        return httpx.Response(
            status,
            json=response_body,
            headers=response.headers,
            request=request,
        )

    with client_with(handler) as client, pytest.raises(expected_error) as raised:
        client.create_project({"name": "Project"})

    assert len(requests) == 1
    assert requests[0].headers["X-Request-ID"]
    assert raised.value.details["problem"]["message"] == "Safe public message."
    assert raised.value.details["problem"]["outcome"] == outcome
    assert API_KEY not in json.dumps(raised.value.details, sort_keys=True)


def test_generic_definite_4xx_mutation_remains_rejected() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return envelope(request, status=400, message="Invalid project", payload=None)

    with client_with(handler) as client, pytest.raises(RemoteApiError) as raised:
        client.create_project({"name": "Project"})
    assert not isinstance(raised.value, OutcomeUnknownError)


def test_v6_paginated_listing_drains_pages_deduplicates_ids_and_records_completeness() -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        path = raw_path(request)
        if path.endswith("/capabilities/v2/"):
            return v2_envelope(request, v6_capabilities())
        if "cursor=next-one" in path:
            return envelope(
                request,
                {
                    "items": [{"_id": "r2"}, {"_id": "r3"}],
                    "page": {
                        "version": 1,
                        "limit": 200,
                        "returned": 2,
                        "complete": True,
                        "nextCursor": None,
                        "consistency": "live-keyset",
                    },
                },
            )
        return envelope(
            request,
            {
                "items": [{"_id": "r1"}, {"_id": "r2"}],
                "page": {
                    "version": 1,
                    "limit": 200,
                    "returned": 2,
                    "complete": False,
                    "nextCursor": "next-one",
                    "consistency": "live-keyset",
                },
            },
        )

    with client_with(handler) as client:
        records = client.list_own_time_entries(DateRange(date(2026, 8, 1), date(2026, 8, 2)))
        assert [record["_id"] for record in records] == ["r1", "r2", "r3"]
        assert client.last_timeentry_fetch == {
            "complete": True,
            "consistency": "live-keyset",
            "duplicates": 1,
            "pages": 2,
        }
    assert [raw_path(request) for request in requests] == [
        "/base/capabilities/v2/",
        "/base/timeentry/daterange-page/2026-08-01/2026-08-02?limit=200",
        "/base/timeentry/daterange-page/2026-08-01/2026-08-02?limit=200&cursor=next-one",
    ]


def test_v6_pagination_rejects_cursor_loops_and_inconsistent_metadata() -> None:
    calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        if raw_path(request).endswith("/capabilities/v2/"):
            return v2_envelope(request, v6_capabilities())
        calls += 1
        return envelope(
            request,
            {
                "items": [{"_id": f"r{calls}"}],
                "page": {
                    "version": 1,
                    "limit": 200,
                    "returned": 1,
                    "complete": False,
                    "nextCursor": "same-cursor",
                    "consistency": "live-keyset",
                },
            },
        )

    with client_with(handler) as client, pytest.raises(RemoteApiError, match="repeated cursor"):
        client.list_own_time_entries(DateRange(date(2026, 8, 1), date(2026, 8, 1)))


def test_v6_paginated_listing_honours_configurable_page_size() -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if raw_path(request).endswith("/capabilities/v2/"):
            return v2_envelope(request, v6_capabilities())
        return envelope(
            request,
            {
                "items": [],
                "page": {
                    "version": 1,
                    "limit": 37,
                    "returned": 0,
                    "complete": True,
                    "nextCursor": None,
                    "consistency": "live-keyset",
                },
            },
        )

    with client_with(handler) as client:
        assert (
            client.list_project_time_entries(
                "project/one",
                DateRange(date(2026, 8, 1), date(2026, 8, 1)),
                page_size=37,
            )
            == []
        )
        with pytest.raises(ConfigurationError, match="between 1 and 500"):
            client.list_own_time_entries(
                DateRange(date(2026, 8, 1), date(2026, 8, 1)), page_size=501
            )

    assert raw_path(requests[1]).endswith(
        "/project/timeentriesfordaterange-page/project%2Fone/2026-08-01/2026-08-01?limit=37"
    )


def test_project_task_stats_validates_contract_and_exact_name_filter() -> None:
    requests: list[httpx.Request] = []
    stats = {
        "projectId": "project/one",
        "totalEstimatedHours": 15.0,
        "totalActualHours": 12.75,
        "tasks": [
            {
                "taskId": "task-1",
                "taskName": "Client meeting",
                "estimatedHours": 5.0,
                "actualHours": 5.0,
                "variance": 0.0,
                "start": "2026-08-01T00:00:00.000Z",
                "end": "2026-08-31T00:00:00.000Z",
            },
            {
                "taskId": "task-2",
                "taskName": "Analysis",
                "estimatedHours": 10.0,
                "actualHours": 7.75,
                "variance": -2.25,
                "start": None,
                "end": None,
            },
        ],
    }

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return envelope(request, stats)

    with client_with(handler) as client:
        complete = client.project_task_stats("project/one")
        filtered = client.project_task_stats("project/one", "Analysis")

    assert complete == stats
    assert [task["taskId"] for task in filtered["tasks"]] == ["task-2"]
    assert filtered["totalEstimatedHours"] == 10.0
    assert filtered["totalActualHours"] == 7.75
    assert all(
        raw_path(request) == "/base/project/task/stats/project%2Fone" for request in requests
    )


@pytest.mark.parametrize(
    "mutation",
    [
        lambda value: value.update(projectId="different"),
        lambda value: value.pop("totalActualHours"),
        lambda value: value.update(tasks=None),
        lambda value: value["tasks"][0].update(actualHours="not-a-number"),
    ],
)
def test_project_task_stats_rejects_malformed_payloads(
    mutation: Callable[[dict[str, Any]], Any],
) -> None:
    stats: dict[str, Any] = {
        "projectId": "project-1",
        "totalEstimatedHours": 1.0,
        "totalActualHours": 1.0,
        "tasks": [
            {
                "taskId": "task-1",
                "taskName": "Task",
                "estimatedHours": 1.0,
                "actualHours": 1.0,
                "variance": 0.0,
            }
        ],
    }
    mutation(stats)

    def handler(request: httpx.Request) -> httpx.Response:
        return envelope(request, stats)

    with client_with(handler) as client, pytest.raises(RemoteApiError):
        client.project_task_stats("project-1")


def test_task_suggestion_pager_drains_pages_in_stable_order() -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        second = "cursor=cursor-two" in raw_path(request)
        items = (
            [{"_id": "suggestion-3", "name": "C"}]
            if second
            else [
                {"_id": "suggestion-1", "name": "A"},
                {"_id": "suggestion-2", "name": "B"},
            ]
        )
        return envelope(
            request,
            {
                "items": items,
                "page": {
                    "version": 1,
                    "limit": 2,
                    "returned": len(items),
                    "complete": second,
                    "nextCursor": None if second else "cursor-two",
                },
            },
        )

    with client_with(handler) as client:
        assert [item["_id"] for item in client.list_task_suggestions(limit=2)] == [
            "suggestion-1",
            "suggestion-2",
            "suggestion-3",
        ]
    assert [raw_path(request) for request in requests] == [
        "/base/task-suggestions/?limit=2",
        "/base/task-suggestions/?limit=2&cursor=cursor-two",
    ]


def test_task_suggestion_pager_rejects_non_adjacent_cursor_cycles() -> None:
    cursors = ["cursor-a", "cursor-b", "cursor-a"]
    calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        cursor = cursors[calls]
        calls += 1
        return envelope(
            request,
            {
                "items": [{"_id": f"suggestion-{calls}"}],
                "page": {
                    "version": 1,
                    "limit": 1,
                    "returned": 1,
                    "complete": False,
                    "nextCursor": cursor,
                },
            },
        )

    with client_with(handler) as client, pytest.raises(RemoteApiError, match="cursor"):
        client.list_task_suggestions(limit=1)
    assert calls == 3


@pytest.mark.parametrize(
    "change",
    [
        {"limit": 99},
        {"returned": 2},
        {"complete": True, "nextCursor": "unexpected"},
        {"complete": False, "nextCursor": "not+a+base64url+cursor"},
    ],
)
def test_task_suggestion_pager_rejects_inconsistent_metadata(
    change: dict[str, Any],
) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        page = {
            "version": 1,
            "limit": 1,
            "returned": 1,
            "complete": True,
            "nextCursor": None,
        }
        page.update(change)
        return envelope(
            request,
            {"items": [{"_id": "suggestion-1"}], "page": page},
        )

    with client_with(handler) as client, pytest.raises(RemoteApiError):
        client.list_task_suggestions(limit=1)


def test_v6_create_sends_exact_optional_idempotency_header_and_validates_it() -> None:
    requests: list[httpx.Request] = []
    expiry = (datetime.now(UTC) + timedelta(days=7)).isoformat().replace("+00:00", "Z")

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if raw_path(request).endswith("/capabilities/v2/"):
            return v2_envelope(request, v6_capabilities())
        return envelope(
            request,
            {"projectId": "p1"},
            headers={
                "Idempotency-Replayed": "false",
                "Idempotency-Expires-At": expiry,
            },
        )

    with client_with(handler) as client:
        assert client.create_project({"name": "Safe"}, idempotency_key="a" * 32) == "p1"
        with pytest.raises(ConfigurationError, match="16 to 128"):
            client.create_project({"name": "Unsafe"}, idempotency_key="short")
    assert len(requests) == 2
    assert requests[-1].headers["Idempotency-Key"] == "a" * 32


@pytest.mark.parametrize(
    ("case", "payload", "replayed", "expiry_delta"),
    [
        ("extra-payload", {"projectId": "p1", "extra": True}, "false", timedelta(days=7)),
        ("wrong-result-key", {"_id": "p1"}, "false", timedelta(days=7)),
        ("control-id", {"projectId": "p1\nforged"}, "false", timedelta(days=7)),
        ("replayed", {"projectId": "p1"}, "true", timedelta(days=7)),
        ("wrong-replay-case", {"projectId": "p1"}, "False", timedelta(days=7)),
        ("missing-replay", {"projectId": "p1"}, None, timedelta(days=7)),
        ("missing-expiry", {"projectId": "p1"}, "false", None),
        ("expired", {"projectId": "p1"}, "false", timedelta(days=-1)),
        ("short-expiry", {"projectId": "p1"}, "false", timedelta(days=1)),
        ("long-expiry", {"projectId": "p1"}, "false", timedelta(days=8)),
    ],
)
def test_idempotent_create_rejects_unconfirmed_initial_success(
    case: str,
    payload: dict[str, Any],
    replayed: str | None,
    expiry_delta: timedelta | None,
) -> None:
    _ = case

    def handler(request: httpx.Request) -> httpx.Response:
        if raw_path(request).endswith("/capabilities/v2/"):
            return v2_envelope(request, v6_capabilities())
        headers: dict[str, str] = {}
        if replayed is not None:
            headers["Idempotency-Replayed"] = replayed
        if expiry_delta is not None:
            headers["Idempotency-Expires-At"] = (
                (datetime.now(UTC) + expiry_delta).isoformat().replace("+00:00", "Z")
            )
        return envelope(request, payload, headers=headers)

    with client_with(handler) as client, pytest.raises(OutcomeUnknownError):
        client.create_project({"name": "Exact"}, idempotency_key="a" * 32)


def test_idempotent_create_rejects_malformed_expiry_header() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if raw_path(request).endswith("/capabilities/v2/"):
            return v2_envelope(request, v6_capabilities())
        return envelope(
            request,
            {"projectId": "p1"},
            headers={
                "Idempotency-Replayed": "false",
                "Idempotency-Expires-At": "not-a-canonical-timestamp",
            },
        )

    with client_with(handler) as client, pytest.raises(OutcomeUnknownError):
        client.create_project({"name": "Exact"}, idempotency_key="a" * 32)


def test_keyless_create_keeps_exact_known_legacy_task_id_shape() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return envelope(request, {"_id": "legacy-task-id"})

    with client_with(handler) as client:
        assert client.create_task({"projectId": "p1", "name": "Legacy"}) == "legacy-task-id"


@pytest.mark.parametrize(
    "payload",
    [
        {"projectId": "p1", "unexpected": True},
        {"projectId": "p1\rforged"},
        {"projectId": 123},
    ],
)
def test_keyless_create_rejects_extra_or_unsafe_result(payload: dict[str, Any]) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return envelope(request, payload)

    with client_with(handler) as client, pytest.raises(OutcomeUnknownError):
        client.create_project({"name": "Exact"})


def test_expected_user_binding_is_sent_on_all_requests_and_cannot_be_rebound() -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if request.method == "GET":
            return envelope(request, [])
        return envelope(request, {"projectId": "p1"})

    with client_with(handler) as client:
        client.bind_expected_user_id("immutable-user-1")
        assert client.list_projects() == []
        assert client.create_project({"name": "Pinned"}) == "p1"
        with pytest.raises(ConflictError, match="different API user"):
            client.bind_expected_user_id("immutable-user-2")
        with pytest.raises(ConfigurationError, match="safe ASCII"):
            client.bind_expected_user_id("unsafe user\nheader")

    assert requests[0].headers["X-Titra-Expected-User-Id"] == "immutable-user-1"
    assert requests[1].headers["X-Titra-Expected-User-Id"] == "immutable-user-1"


def test_expected_user_mismatch_is_a_definite_precondition_conflict() -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return v2_problem(
            request,
            status=412,
            code="PRECONDITION_FAILED",
            category="precondition",
            message="A write precondition failed.",
            outcome="rejected",
        )

    with client_with(handler) as client:
        client.bind_expected_user_id("expected-user")
        with pytest.raises(ConflictError) as raised:
            client.create_project({"name": "Must not be written"})

    assert requests[0].headers["X-Titra-Expected-User-Id"] == "expected-user"
    assert raised.value.details["problem"] == {
        "version": 1,
        "code": "PRECONDITION_FAILED",
        "category": "precondition",
        "message": "A write precondition failed.",
        "requestId": requests[0].headers["X-Request-ID"],
        "outcome": "rejected",
        "retry": {"allowed": False},
        "httpStatus": 412,
    }


@pytest.mark.parametrize(
    ("operation", "path", "result_key"),
    [
        ("project.create", "/base/project/create/", "projectId"),
        ("project-task.create", "/base/project/task/create/", "taskId"),
        ("timeentry.create", "/base/timeentry/create/", "timecardId"),
    ],
)
def test_idempotent_create_replay_requires_same_id_and_exact_replay_headers(
    operation: str, path: str, result_key: str
) -> None:
    requests: list[httpx.Request] = []
    key = "replay-key-for-tests-1234567890"
    payload = {"marker": "exact-original-payload"}
    expiry = (datetime.now(UTC) + timedelta(days=1)).isoformat().replace("+00:00", "Z")

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if raw_path(request).endswith("/capabilities/v2/"):
            return v2_envelope(request, v6_capabilities())
        return envelope(
            request,
            {result_key: "expected-result-id"},
            headers={
                "Idempotency-Replayed": "true",
                "Idempotency-Expires-At": expiry,
            },
        )

    with client_with(handler) as client:
        result = client.replay_idempotent_create(
            operation,
            payload,
            idempotency_key=key,
            expected_result_id="expected-result-id",
        )

    assert result == {
        "operation": operation,
        "result_id": "expected-result-id",
        "idempotency_replayed": True,
        "idempotency_expires_at": expiry,
    }
    assert raw_path(requests[-1]) == path
    assert requests[-1].headers["Idempotency-Key"] == key
    assert json_body(requests[-1]) == payload


@pytest.mark.parametrize(
    ("result_id", "replayed", "expires_at"),
    [
        ("different-result", "true", "2099-01-01T00:00:00.000Z"),
        ("expected-result-id", "false", "2099-01-01T00:00:00.000Z"),
        ("expected-result-id", "true", None),
        ("expected-result-id", "true", "2000-01-01T00:00:00.000Z"),
    ],
)
def test_idempotent_create_replay_rejects_unconfirmed_success(
    result_id: str, replayed: str, expires_at: str | None
) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if raw_path(request).endswith("/capabilities/v2/"):
            return v2_envelope(request, v6_capabilities())
        headers = {"Idempotency-Replayed": replayed}
        if expires_at is not None:
            headers["Idempotency-Expires-At"] = expires_at
        return envelope(request, {"projectId": result_id}, headers=headers)

    with client_with(handler) as client, pytest.raises(OutcomeUnknownError):
        client.replay_idempotent_create(
            "project.create",
            {"name": "Exact"},
            idempotency_key="replay-key-for-tests-1234567890",
            expected_result_id="expected-result-id",
        )


@pytest.mark.parametrize(
    ("operation", "path", "result_key"),
    [
        ("project.create", "/base/project/create/", "projectId"),
        ("project-task.create", "/base/project/task/create/", "taskId"),
        ("timeentry.create", "/base/timeentry/create/", "timecardId"),
    ],
)
@pytest.mark.parametrize("replayed", [False, True])
def test_idempotent_create_recovery_accepts_exact_fresh_or_committed_result(
    operation: str,
    path: str,
    result_key: str,
    replayed: bool,
) -> None:
    requests: list[httpx.Request] = []
    payload = {"marker": "exact-original-payload"}
    expiry_delta = timedelta(days=1) if replayed else timedelta(seconds=604_800)
    expiry = (datetime.now(UTC) + expiry_delta).isoformat().replace("+00:00", "Z")

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if raw_path(request).endswith("/capabilities/v2/"):
            return v2_envelope(request, v6_capabilities())
        return envelope(
            request,
            {result_key: "recovered-result-id"},
            headers={
                "Idempotency-Replayed": str(replayed).lower(),
                "Idempotency-Expires-At": expiry,
            },
        )

    with client_with(handler) as client:
        result = client.recover_idempotent_create(
            operation,
            payload,
            idempotency_key="recovery-key-for-tests-123456789",
        )

    assert result == {
        "operation": operation,
        "result_id": "recovered-result-id",
        "idempotency_replayed": replayed,
        "idempotency_expires_at": expiry,
    }
    assert raw_path(requests[-1]) == path
    assert json_body(requests[-1]) == payload


@pytest.mark.parametrize(
    ("replayed", "expires_at"),
    [
        (None, "2099-01-01T00:00:00.000Z"),
        ("TRUE", "2099-01-01T00:00:00.000Z"),
        ("false ", "2099-01-01T00:00:00.000Z"),
        ("true", None),
        ("true", "not-a-timestamp"),
        ("true", "2000-01-01T00:00:00.000Z"),
    ],
)
def test_idempotent_create_recovery_rejects_hostile_or_incomplete_headers(
    replayed: str | None,
    expires_at: str | None,
) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if raw_path(request).endswith("/capabilities/v2/"):
            return v2_envelope(request, v6_capabilities())
        headers: dict[str, str] = {}
        if replayed is not None:
            headers["Idempotency-Replayed"] = replayed
        if expires_at is not None:
            headers["Idempotency-Expires-At"] = expires_at
        return envelope(request, {"projectId": "recovered-result-id"}, headers=headers)

    with client_with(handler) as client, pytest.raises(OutcomeUnknownError):
        client.recover_idempotent_create(
            "project.create",
            {"name": "Exact"},
            idempotency_key="recovery-key-for-tests-123456789",
        )


def test_idempotent_create_recovery_rejects_extra_response_fields() -> None:
    expiry = (datetime.now(UTC) + timedelta(days=1)).isoformat().replace("+00:00", "Z")

    def handler(request: httpx.Request) -> httpx.Response:
        if raw_path(request).endswith("/capabilities/v2/"):
            return v2_envelope(request, v6_capabilities())
        return envelope(
            request,
            {"projectId": "recovered-result-id", "extra": True},
            headers={
                "Idempotency-Replayed": "true",
                "Idempotency-Expires-At": expiry,
            },
        )

    with client_with(handler) as client, pytest.raises(OutcomeUnknownError):
        client.recover_idempotent_create(
            "project.create",
            {"name": "Exact"},
            idempotency_key="recovery-key-for-tests-123456789",
        )


@pytest.mark.parametrize(
    ("replayed", "expiry_delta"),
    [("false", timedelta(days=1)), ("true", timedelta(days=8))],
)
def test_idempotent_create_recovery_rejects_expiry_outside_valid_bounds(
    replayed: str,
    expiry_delta: timedelta,
) -> None:
    expiry = (datetime.now(UTC) + expiry_delta).isoformat().replace("+00:00", "Z")

    def handler(request: httpx.Request) -> httpx.Response:
        if raw_path(request).endswith("/capabilities/v2/"):
            return v2_envelope(request, v6_capabilities())
        return envelope(
            request,
            {"projectId": "recovered-result-id"},
            headers={
                "Idempotency-Replayed": replayed,
                "Idempotency-Expires-At": expiry,
            },
        )

    with client_with(handler) as client, pytest.raises(OutcomeUnknownError):
        client.recover_idempotent_create(
            "project.create",
            {"name": "Exact"},
            idempotency_key="recovery-key-for-tests-123456789",
        )


def test_missing_payload_is_a_valid_empty_list_envelope_for_project_listing() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return envelope(request, include_payload=False)

    with client_with(handler) as client:
        assert client.list_projects() == []


@pytest.mark.parametrize("body", [[], "not-an-envelope", 17, None])
def test_success_response_requires_an_object_envelope(body: Any) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            content=json.dumps(body).encode(),
            headers={"Content-Type": "application/json"},
            request=request,
        )

    with (
        client_with(handler) as client,
        pytest.raises(RemoteApiError, match="invalid response envelope"),
    ):
        client.list_projects()


@pytest.mark.parametrize(
    ("operation", "bad_payload"),
    [
        (lambda client: client.list_projects(), {"not": "a list"}),
        (lambda client: client.list_tasks("project-1"), {"not": "a list"}),
        (lambda client: client.project_users("project-1"), {"not": "a list"}),
        (
            lambda client: client.list_own_time_entries(
                DateRange(date(2026, 8, 1), date(2026, 8, 1))
            ),
            {"not": "a list"},
        ),
        (
            lambda client: client.list_project_time_entries(
                "project-1", DateRange(date(2026, 8, 1), date(2026, 8, 1))
            ),
            {"not": "a list"},
        ),
    ],
)
def test_collection_operations_reject_non_list_payloads(
    operation: Callable[[TitraClient], Any], bad_payload: Any
) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return envelope(request, bad_payload)

    with (
        client_with(handler) as client,
        pytest.raises(RemoteApiError, match=r"invalid|list|entries"),
    ):
        operation(client)


@pytest.mark.parametrize(
    ("operation", "bad_payload", "expected_error", "expected_message"),
    [
        (
            lambda client: client.create_project({"name": "Project"}),
            {},
            OutcomeUnknownError,
            "created project ID",
        ),
        (
            lambda client: client.create_task({"projectId": "p", "name": "Task"}),
            {},
            OutcomeUnknownError,
            "created task ID",
        ),
        (
            lambda client: client.create_time_entry(
                {"projectId": "p", "task": "Task", "date": "2026-08-30", "hours": 1.0}
            ),
            {},
            OutcomeUnknownError,
            "created time-entry ID",
        ),
        (
            lambda client: client.get_time_entry("record-1"),
            [],
            RemoteApiError,
            "invalid time entry",
        ),
        (
            lambda client: client.current_user(),
            [],
            RemoteApiError,
            "invalid current-user information",
        ),
        (
            lambda client: client.delete_time_entry("record-1"),
            "deleted",
            OutcomeUnknownError,
            "invalid",
        ),
    ],
)
def test_object_and_creation_operations_reject_invalid_payloads(
    operation: Callable[[TitraClient], Any],
    bad_payload: Any,
    expected_error: type[Exception],
    expected_message: str,
) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return envelope(request, bad_payload)

    with client_with(handler) as client, pytest.raises(expected_error, match=expected_message):
        operation(client)


@pytest.mark.parametrize("status", [401, 403])
def test_authentication_statuses_map_to_authentication_error(status: int) -> None:
    body = {"statusCode": status, "message": "API token rejected", "payload": {"why": "bad"}}

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(status, json=body, request=request)

    with client_with(handler) as client, pytest.raises(AuthenticationError) as raised:
        client.list_projects()

    assert str(raised.value) == "API token rejected"
    assert raised.value.details == body
    assert raised.value.exit_code == ExitCode.AUTH


@pytest.mark.parametrize("v2", [False, True])
def test_v7_overdue_action_verification_has_a_distinct_auth_error(v2: bool) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if v2:
            return v2_problem(
                request,
                status=403,
                code="ACTION_VERIFICATION_REQUIRED",
                category="authorization",
                message="Required account verification is overdue.",
                outcome="rejected",
            )
        return envelope(
            request,
            status=403,
            message="Required account verification is overdue.",
            payload=None,
        )

    with client_with(handler) as client, pytest.raises(ActionVerificationRequiredError) as raised:
        client.list_projects()
    assert raised.value.exit_code == ExitCode.AUTH


@pytest.mark.parametrize("v2", [False, True])
def test_v7_rate_limit_has_a_validated_retry_delay(v2: bool) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if v2:
            problem = v2_problem(
                request,
                status=429,
                code="RATE_LIMITED",
                category="rate_limit",
                message="Too many requests were received.",
                outcome="rejected",
                retry_after=17,
            )
            problem.headers["Retry-After"] = "17"
            return problem
        return envelope(
            request,
            status=429,
            message="Too many requests. Retry after the indicated delay.",
            payload=None,
            headers={"Retry-After": "17"},
        )

    with client_with(handler) as client, pytest.raises(RateLimitError) as raised:
        client.list_projects()
    assert raised.value.retry_after_seconds == 17
    assert raised.value.exit_code == ExitCode.REMOTE


@pytest.mark.parametrize(
    ("header", "problem_delay"),
    [("0", None), ("tomorrow", None), ("17", 18), ("86401", None)],
)
def test_v7_rate_limit_rejects_invalid_or_inconsistent_retry_metadata(
    header: str, problem_delay: int | None
) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        response = v2_problem(
            request,
            status=429,
            code="RATE_LIMITED",
            category="rate_limit",
            message="Too many requests were received.",
            outcome="rejected",
            retry_after=problem_delay,
        )
        response.headers["Retry-After"] = header
        return response

    with client_with(handler) as client, pytest.raises(RemoteApiError) as raised:
        client.list_projects()
    assert not isinstance(raised.value, RateLimitError)


def test_v7_api_security_header_profile_is_explicit_and_hsts_is_optional() -> None:
    headers = {
        "Cache-Control": "no-store",
        "Pragma": "no-cache",
        "Cross-Origin-Opener-Policy": "same-origin-allow-popups",
        "Permissions-Policy": "camera=(), geolocation=(), microphone=(), payment=(), usb=()",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
        "X-DNS-Prefetch-Control": "off",
    }

    def handler(request: httpx.Request) -> httpx.Response:
        return v2_envelope(request, v6_capabilities(), headers=headers)

    with client_with(handler) as client:
        report = client.api_security_headers_report()
        strict = client.api_security_headers_report(require_hsts=True)
    assert report["ok"] is True
    assert report["profile"] == "v7-http-security/v1"
    assert strict["ok"] is False
    assert strict["missing_or_mismatched"] == ["strict-transport-security"]


def test_404_maps_to_not_found_and_preserves_server_message() -> None:
    body = {"statusCode": 404, "message": "No such record", "payload": {"id": "missing"}}

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(404, json=body, request=request)

    with client_with(handler) as client, pytest.raises(NotFoundError) as raised:
        client.get_time_entry("missing")

    assert str(raised.value) == "No such record"
    assert raised.value.details == body
    assert raised.value.exit_code == ExitCode.NOT_FOUND_OR_CONFLICT


@pytest.mark.parametrize("status", [409, 412, 423, 428])
def test_conflict_and_precondition_statuses_map_to_conflict(status: int) -> None:
    body = {"statusCode": status, "message": "Record changed", "payload": {"etag": '"new"'}}

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(status, json=body, request=request)

    with client_with(handler) as client, pytest.raises(ConflictError) as raised:
        client.delete_time_entry("record-1", etag='"titra-date-revision-1"')

    assert str(raised.value) == "Record changed"
    assert raised.value.details == body
    assert raised.value.exit_code == ExitCode.NOT_FOUND_OR_CONFLICT


@pytest.mark.parametrize("status", [400, 422, 500, 503])
def test_other_http_failures_map_to_remote_api_error(status: int) -> None:
    body = {"statusCode": status, "message": "Server refused request", "payload": {"retry": False}}

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(status, json=body, request=request)

    with client_with(handler) as client, pytest.raises(RemoteApiError) as raised:
        client.list_projects()

    assert str(raised.value) == "Titra rejected the request: Server refused request"
    assert raised.value.details == body
    assert raised.value.exit_code == ExitCode.REMOTE


@pytest.mark.parametrize("status", [200, 500])
def test_html_or_other_non_json_responses_are_remote_errors(status: int) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            status,
            text="<html><body>reverse proxy error</body></html>",
            headers={"Content-Type": "text/html"},
            request=request,
        )

    with (
        client_with(handler) as client,
        pytest.raises(RemoteApiError, match=rf"non-JSON data \(HTTP {status}\)"),
    ):
        client.list_projects()


def test_html_404_is_treated_as_an_unavailable_endpoint() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            404,
            text="<html><body>not found</body></html>",
            headers={"Content-Type": "text/html"},
            request=request,
        )

    with (
        client_with(handler) as client,
        pytest.raises(NotFoundError, match="endpoint is not available: user/me/"),
    ):
        client.current_user()


def test_plain_text_http_error_uses_bounded_response_text() -> None:
    response_text = "x" * 800

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            500,
            content=json.dumps(response_text).encode(),
            headers={"Content-Type": "application/json"},
            request=request,
        )

    with client_with(handler) as client, pytest.raises(RemoteApiError) as raised:
        client.list_projects()

    assert str(raised.value) == f"Titra rejected the request: {json.dumps(response_text)[:500]}"
    assert API_KEY not in str(raised.value)


def test_redirects_are_not_followed() -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(
            302,
            json={"statusCode": 302, "message": "Moved"},
            headers={"Location": "https://other.example.test/project/list/"},
            request=request,
        )

    with (
        client_with(handler) as client,
        pytest.raises(RemoteApiError, match="Titra rejected the request: Moved"),
    ):
        client.list_projects()

    assert len(requests) == 1
    assert requests[0].url.host == "titra.example.test"


@pytest.mark.parametrize("html_404", [False, True])
def test_old_server_capability_report_treats_missing_identity_as_unsupported(
    html_404: bool,
) -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if raw_path(request).endswith("/project/list/"):
            return envelope(request, [])
        if html_404:
            return httpx.Response(404, text="Not Found", request=request)
        return envelope(request, status=404, message="Route not found", payload=None)

    with client_with(handler) as client:
        assert client.capability_report() == {
            "projects": True,
            "identity": False,
            "record_delete": False,
            "record_task_edit": False,
            "idempotent_create": False,
            "timeentry_pagination": False,
            "project_fence_recovery": False,
            "api_version": None,
            "capabilities_version": None,
            "capability_source": None,
            "v6_ready": False,
            "v7_ready": False,
            "project_lifecycle": False,
            "project_task_lifecycle": False,
            "task_stats": False,
            "record_details_edit": False,
            "task_suggestions": False,
            "atomic_timers": False,
            "webhook_receiver": False,
        }

    assert [raw_path(request) for request in requests] == [
        "/base/project/list/",
        "/base/user/me/",
        "/base/capabilities/v2/",
        "/base/capabilities/",
    ]


def test_capability_discovery_failure_does_not_silently_downgrade_safe_writes() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert raw_path(request) == "/base/capabilities/v2/"
        return envelope(
            request,
            status=503,
            message="Capability discovery temporarily unavailable",
            payload=None,
        )

    with (
        client_with(handler) as client,
        pytest.raises(RemoteApiError, match="Capability discovery temporarily unavailable"),
    ):
        client.supports_idempotent_create("project.create")


def test_modern_server_capability_report_enables_identity_and_safe_delete() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if raw_path(request).endswith("/project/list/"):
            return envelope(request, [])
        if raw_path(request).endswith("/user/me/"):
            return envelope(request, {"_id": "user-1", "name": "Ada Example"})
        return envelope(request, status=404, message="Route not found", payload=None)

    with client_with(handler) as client:
        assert client.capability_report() == {
            "projects": True,
            "identity": True,
            "record_delete": True,
            "record_task_edit": False,
            "idempotent_create": False,
            "timeentry_pagination": False,
            "project_fence_recovery": False,
            "api_version": None,
            "capabilities_version": None,
            "capability_source": None,
            "v6_ready": False,
            "v7_ready": False,
            "project_lifecycle": False,
            "project_task_lifecycle": False,
            "task_stats": False,
            "record_details_edit": False,
            "task_suggestions": False,
            "atomic_timers": False,
            "webhook_receiver": False,
        }


def test_capability_report_does_not_hide_missing_baseline_project_api() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return envelope(request, status=404, message="Route not found", payload=None)

    with client_with(handler) as client, pytest.raises(NotFoundError, match="Route not found"):
        client.capability_report()


def test_explicit_task_edit_discovery_is_independent_of_identity_and_delete() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if raw_path(request).endswith("/project/list/"):
            return envelope(request, [])
        if raw_path(request).endswith("/user/me/"):
            return envelope(request, {"_id": "user-1"})
        if raw_path(request).endswith("/capabilities/v2/"):
            return envelope(request, status=404, message="Route not found", payload=None)
        assert raw_path(request) == "/base/capabilities/"
        return envelope(
            request,
            {
                "apiVersion": 1,
                "features": {"timeEntryTaskUpdate": True},
                "taskUpdate": {
                    "requiresIfMatch": True,
                    "requiresExpectedTask": True,
                    "maxTaskLength": 1000,
                    "preservesOtherFields": True,
                },
            },
        )

    with client_with(handler) as client:
        assert client.capability_report() == {
            "projects": True,
            "identity": True,
            "record_delete": True,
            "record_task_edit": True,
            "idempotent_create": False,
            "timeentry_pagination": False,
            "project_fence_recovery": False,
            "api_version": 1,
            "capabilities_version": None,
            "capability_source": "/capabilities/",
            "v6_ready": False,
            "v7_ready": False,
            "project_lifecycle": False,
            "project_task_lifecycle": False,
            "task_stats": False,
            "record_details_edit": False,
            "task_suggestions": False,
            "atomic_timers": False,
            "webhook_receiver": False,
        }


def test_task_patch_uses_only_exact_task_fields_and_encoded_id() -> None:
    requests: list[httpx.Request] = []
    task = "  literal :smile: 🧬  "
    record_id = "record/with space"

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        assert request.method == "PATCH"
        assert raw_path(request) == "/base/timeentry/task/record%2Fwith%20space"
        assert request.headers["If-Match"] == '"titra-date-revision-4"'
        assert json_body(request) == {"task": task, "expectedTask": ""}
        return envelope(
            request,
            {
                "timecardId": record_id,
                "task": task,
                "previousTask": "",
                "changed": True,
            },
            headers={"ETag": '"titra-date-revision-5"'},
        )

    with client_with(handler) as client:
        payload, etag = client.edit_time_entry_task(
            record_id, task=task, expected_task="", etag='"titra-date-revision-4"'
        )
    assert len(requests) == 1 and payload["task"] == task
    assert etag == '"titra-date-revision-5"'


def project_details_payload(**changes: Any) -> dict[str, Any]:
    value: dict[str, Any] = {
        "name": "Project",
        "description": None,
        "color": None,
        "customer": None,
        "rate": None,
        "budget": None,
        "startDate": None,
        "endDate": None,
        "public": False,
        "notbillable": False,
    }
    value.update(changes)
    return value


def project_task_details_payload(**changes: Any) -> dict[str, Any]:
    value: dict[str, Any] = {
        "name": "Task",
        "start": None,
        "end": None,
        "estimatedHours": None,
        "dependencies": [],
    }
    value.update(changes)
    return value


def test_v6_lifecycle_mutations_accept_only_the_exact_success_contracts() -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        path = raw_path(request)
        if "/timeentry/details/" in path:
            return envelope(
                request,
                {
                    "timecardId": "record-1",
                    "changed": True,
                    "changedFields": ["hours"],
                    "previous": {"hours": 1},
                    "current": {"hours": 1.5},
                },
                headers={"ETag": '"titra-date-revision-4"'},
            )
        if "/project/details/" in path:
            return envelope(
                request,
                {
                    "projectId": "project-1",
                    "changed": True,
                    "changedFields": ["description"],
                    "current": project_details_payload(description="Edited"),
                },
                headers={"ETag": '"titra-project-revision-3"'},
            )
        if "/project/archive/" in path:
            return envelope(
                request,
                {"projectId": "project-1", "archived": True, "changed": True},
                headers={"ETag": '"titra-project-revision-4"'},
            )
        if "/project/delete/" in path:
            return envelope(
                request,
                {
                    "projectId": "project-1",
                    "deleted": True,
                    "counts": {"timecards": 0, "projectTasks": 0},
                },
            )
        if "/project/task/details/" in path:
            return envelope(
                request,
                {
                    "taskId": "task-1",
                    "changed": True,
                    "changedFields": ["estimatedHours"],
                    "current": project_task_details_payload(estimatedHours=2.5),
                },
                headers={"ETag": '"titra-project-task-revision-6"'},
            )
        if "/project/task/delete/" in path:
            return envelope(
                request,
                {
                    "taskId": "task-1",
                    "deleted": True,
                    "references": {
                        "conflict": False,
                        "isDefault": False,
                        "dependentTaskCount": 0,
                        "recordCount": 2,
                    },
                },
            )
        if "/task-suggestions/delete/" in path:
            return envelope(
                request,
                {
                    "suggestionId": "suggestion-1",
                    "deleted": True,
                    "usage": {
                        "recordCount": 2,
                        "totalHours": 3.5,
                        "lastRecordedAt": "2026-08-30T00:00:00.000Z",
                        "projectCount": 1,
                    },
                },
            )
        raise AssertionError(f"Unexpected request path: {path}")

    with client_with(handler) as client:
        details, details_etag = client.edit_time_entry_details(
            "record-1",
            expected={"hours": 1},
            changes={"hours": 1.5},
            etag='"titra-date-revision-3"',
        )
        project, project_etag = client.edit_project_details(
            "project-1",
            expected={"description": None},
            changes={"description": "Edited"},
            etag='"titra-project-revision-2"',
        )
        archived, archived_etag = client.set_project_archived(
            "project-1",
            archived=True,
            expected_archived=False,
            etag=project_etag,
        )
        deleted_project = client.delete_empty_project(
            "project-1", expected_name="Project", etag=archived_etag
        )
        task, task_etag = client.edit_project_task(
            "task-1",
            expected={"estimatedHours": None},
            changes={"estimatedHours": 2.5},
            etag='"titra-project-task-revision-5"',
        )
        deleted_task = client.delete_project_task(
            "task-1",
            expected_name="Task",
            acknowledge_recorded_entries=True,
            etag=task_etag,
        )
        deleted_suggestion = client.delete_task_suggestion(
            "suggestion-1",
            expected_name="Suggestion",
            acknowledge_referenced_records=True,
            etag='"titra-task-suggestion-revision-1"',
        )

    assert details["timecardId"] == "record-1" and details_etag.endswith('-4"')
    assert project["projectId"] == "project-1" and project_etag.endswith('-3"')
    assert archived["archived"] is True and archived_etag.endswith('-4"')
    assert deleted_project["deleted"] is True
    assert task["taskId"] == "task-1" and task_etag.endswith('-6"')
    assert deleted_task["references"]["recordCount"] == 2
    assert deleted_suggestion["usage"]["totalHours"] == 3.5
    assert len(requests) == 7


@pytest.mark.parametrize(
    ("operation", "payload", "headers"),
    [
        (
            lambda client: client.delete_time_entry("record-1", etag='"titra-date-revision-1"'),
            {"timecardId": "record-2"},
            {},
        ),
        (
            lambda client: client.edit_project_details(
                "project-1",
                expected={"name": "Old"},
                changes={"name": "New"},
                etag='"titra-project-revision-1"',
            ),
            {
                "projectId": "project-2",
                "changed": True,
                "changedFields": ["name"],
                "current": project_details_payload(name="New"),
            },
            {"ETag": '"titra-project-revision-2"'},
        ),
        (
            lambda client: client.delete_project_task(
                "task-1",
                expected_name="Task",
                acknowledge_recorded_entries=False,
                etag='"titra-project-task-revision-1"',
            ),
            {
                "taskId": "task-2",
                "deleted": True,
                "references": {
                    "conflict": False,
                    "isDefault": False,
                    "dependentTaskCount": 0,
                    "recordCount": 0,
                },
            },
            {},
        ),
        (
            lambda client: client.delete_task_suggestion(
                "suggestion-1",
                expected_name="Suggestion",
                acknowledge_referenced_records=False,
                etag='"titra-task-suggestion-revision-1"',
            ),
            {
                "suggestionId": "suggestion-2",
                "deleted": True,
                "usage": {
                    "recordCount": 0,
                    "totalHours": 0,
                    "lastRecordedAt": None,
                    "projectCount": 0,
                },
            },
            {},
        ),
    ],
    ids=["record delete", "project update", "task delete", "suggestion delete"],
)
def test_guarded_mutations_reject_success_for_another_resource(
    operation: Callable[[TitraClient], Any], payload: dict[str, Any], headers: dict[str, str]
) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return envelope(request, payload, headers=headers)

    with (
        client_with(handler) as client,
        pytest.raises(OutcomeUnknownError, match=r"inconsistent|another"),
    ):
        operation(client)


@pytest.mark.parametrize("field", ["task", "expected_task"])
@pytest.mark.parametrize("surrogate", ["\ud800", "\udfff", "\ud83e\uddec"])
def test_task_patch_rejects_invalid_python_surrogates_before_transport(
    field: str, surrogate: str
) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise AssertionError("Invalid Unicode must not reach the transport")

    values = {"task": "new", "expected_task": "old", "etag": '"titra-date-revision-0"'}
    values[field] = surrogate
    with client_with(handler) as client, pytest.raises(ConfigurationError, match="surrogate"):
        client.edit_time_entry_task("r1", **values)


def test_timer_start_tolerates_legacy_empty_payload() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return envelope(request, include_payload=False, message="New timer started.")

    with client_with(handler) as client:
        assert client.timer_start() == {}


def test_atomic_timer_transitions_require_exact_ids_payloads_and_revisions() -> None:
    operation_id = "timer:test-operation"
    start_time = "2026-08-30T00:00:00.000Z"
    stopped_at = "2026-08-30T00:01:00.000Z"
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        path = raw_path(request)
        if path.endswith("/timer/start/"):
            return envelope(
                request,
                {
                    "timerId": operation_id,
                    "startTime": start_time,
                    "duration": 0,
                    "revision": 1,
                    "legacy": False,
                    "changed": True,
                },
                headers={"ETag": '"titra-timer-revision-1"'},
            )
        if path.endswith("/timer/get/"):
            return envelope(
                request,
                {
                    "timerId": operation_id,
                    "startTime": start_time,
                    "duration": 30_000,
                    "revision": 1,
                    "legacy": False,
                },
                headers={"ETag": '"titra-timer-revision-1"'},
            )
        if path.endswith("/timer/stop/"):
            return envelope(
                request,
                {
                    "timerId": operation_id,
                    "startTime": start_time,
                    "duration": 60_000,
                    "revision": 1,
                    "legacy": False,
                    "stoppedAt": stopped_at,
                    "changed": True,
                },
                headers={"ETag": '"titra-timer-revision-2"'},
            )
        raise AssertionError(f"Unexpected timer request: {path}")

    with client_with(handler) as client:
        started = client.timer_start(operation_id=operation_id)
        snapshot, etag = client.timer_get_snapshot()
        stopped = client.timer_stop_snapshot(snapshot, etag)

    assert started["timerId"] == operation_id
    assert snapshot["revision"] == 1
    assert stopped["stoppedAt"] == stopped_at
    assert json_body(requests[0]) == {"operationId": operation_id}
    assert json_body(requests[2]) == {"timerId": operation_id}
    assert requests[2].headers["If-Match"] == '"titra-timer-revision-1"'


@pytest.mark.parametrize(
    ("payload_change", "etag"),
    [
        ({"timerId": "timer:different"}, '"titra-timer-revision-1"'),
        ({}, '"titra-timer-revision-2"'),
        ({"unexpected": "field"}, '"titra-timer-revision-1"'),
    ],
)
def test_atomic_timer_start_rejects_inconsistent_success(
    payload_change: dict[str, Any], etag: str
) -> None:
    operation_id = "timer:test-operation"

    def handler(request: httpx.Request) -> httpx.Response:
        payload = {
            "timerId": operation_id,
            "startTime": "2026-08-30T00:00:00.000Z",
            "duration": 0,
            "revision": 1,
            "legacy": False,
            "changed": True,
        }
        payload.update(payload_change)
        return envelope(request, payload, headers={"ETag": etag})

    with client_with(handler) as client, pytest.raises(OutcomeUnknownError):
        client.timer_start(operation_id=operation_id)


def test_consumed_atomic_timer_start_preserves_only_the_exact_legacy_envelope() -> None:
    expected = {
        "statusCode": 409,
        "message": "This timer start operation was already used.",
        "payload": {"code": "timer-operation-consumed"},
    }

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(409, json=expected, request=request)

    with client_with(handler) as client, pytest.raises(ConflictError) as caught:
        client.timer_start(operation_id="timer:consumed-operation")

    assert caught.value.details == expected


def test_timer_start_maps_legacy_already_running_error_to_conflict() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return envelope(
            request,
            status=500,
            message="There is already another running timer.",
            payload=None,
        )

    with (
        client_with(handler) as client,
        pytest.raises(ConflictError, match="already a running Titra timer"),
    ):
        client.timer_start()


@pytest.mark.parametrize("operation", [TitraClient.timer_get, TitraClient.timer_stop])
def test_timer_get_and_stop_map_legacy_no_timer_error_to_not_found(
    operation: Callable[[TitraClient], Any],
) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return envelope(request, status=500, message="No running timer found.", payload=None)

    with (
        client_with(handler) as client,
        pytest.raises(NotFoundError, match="No running timer found"),
    ):
        operation(client)


@pytest.mark.parametrize(
    ("operation", "expected_error"),
    [
        (TitraClient.timer_get, RemoteApiError),
        (TitraClient.timer_stop, OutcomeUnknownError),
    ],
)
def test_timer_get_and_stop_require_object_payloads(
    operation: Callable[[TitraClient], Any],
    expected_error: type[Exception],
) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return envelope(request, ["invalid"])

    with (
        client_with(handler) as client,
        pytest.raises(expected_error, match=r"invalid (stopped-)?timer information"),
    ):
        operation(client)


MUTATIONS: list[tuple[str, Callable[[TitraClient], Any]]] = [
    ("create project", lambda client: client.create_project({"name": "Project"})),
    (
        "create task",
        lambda client: client.create_task({"projectId": "project-1", "name": "Task"}),
    ),
    (
        "create time entry",
        lambda client: client.create_time_entry(
            {
                "projectId": "project-1",
                "task": "Task",
                "date": "2026-08-30",
                "hours": 1.0,
            }
        ),
    ),
    (
        "delete time entry",
        lambda client: client.delete_time_entry("record-1", etag='"titra-date-revision-1"'),
    ),
    ("start timer", lambda client: client.timer_start()),
    ("stop timer", lambda client: client.timer_stop()),
]


@pytest.mark.parametrize(("_name", "operation"), MUTATIONS, ids=[item[0] for item in MUTATIONS])
def test_mutation_transport_failures_are_outcome_unknown_and_never_retried(
    _name: str, operation: Callable[[TitraClient], Any]
) -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        raise httpx.ReadTimeout("connection lost after request was sent", request=request)

    with client_with(handler) as client, pytest.raises(OutcomeUnknownError) as raised:
        operation(client)

    assert len(requests) == 1
    assert raised.value.exit_code == ExitCode.OUTCOME_UNKNOWN
    assert "outcome is unknown" in str(raised.value)
    assert "do not retry blindly" in str(raised.value)
    serialized_details = json.dumps(raised.value.details, sort_keys=True)
    assert API_KEY not in serialized_details
    assert str(requests[0].url) in serialized_details


def test_read_transport_failure_is_remote_not_outcome_unknown_and_is_not_retried() -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        raise httpx.ConnectError("connection refused", request=request)

    with client_with(handler) as client, pytest.raises(RemoteApiError) as raised:
        client.list_projects()

    assert not isinstance(raised.value, OutcomeUnknownError)
    assert len(requests) == 1
    assert "Cannot reach Titra" in str(raised.value)
    assert API_KEY not in str(raised.value)


def test_generic_server_failure_after_mutation_is_outcome_unknown() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return envelope(request, status=503, message="Migration lock is active", payload=None)

    with client_with(handler) as client, pytest.raises(OutcomeUnknownError) as raised:
        client.create_time_entry(
            {
                "projectId": "project-1",
                "task": "Task",
                "date": "2026-08-30",
                "hours": 1.0,
            }
        )

    assert raised.value.exit_code == ExitCode.OUTCOME_UNKNOWN
    assert "reconcile" in str(raised.value).lower()


def test_successful_mutation_response_reflecting_api_key_is_never_returned() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return envelope(request, {"projectId": f"prefix:{API_KEY}:suffix"})

    with client_with(handler) as client, pytest.raises(OutcomeUnknownError) as raised:
        client.create_project({"name": "Safe"})

    rendered = f"{raised.value} {raised.value.details}"
    assert API_KEY not in rendered
    assert "reflected the configured credential" in rendered


def project_recovery_etag(character: str = "a") -> str:
    return f'"titra-project-recovery-{character * 64}"'


def test_project_fence_recovery_get_and_post_use_exact_guarded_contract() -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if request.method == "GET":
            return envelope(
                request,
                {"projectId": "project/with space", "writerRecoveries": {}},
                headers={"ETag": project_recovery_etag("a")},
            )
        assert request.method == "POST"
        assert request.headers["If-Match"] == project_recovery_etag("a")
        assert json_body(request) == {
            "type": "writer",
            "recoveryId": "writer:stale-resource",
            "acknowledgeStaleFence": True,
        }
        return envelope(
            request,
            {
                "cleared": {"type": "writer", "recoveryId": "writer:stale-resource"},
                "current": {"projectId": "project/with space"},
            },
            headers={"ETag": project_recovery_etag("b")},
        )

    with client_with(handler) as client:
        preview, etag = client.get_project_fence_recovery("project/with space")
        assert preview["projectId"] == "project/with space"
        result, next_etag = client.recover_project_fence(
            "project/with space",
            recovery_type="writer",
            recovery_id="writer:stale-resource",
            etag=etag,
        )
    assert result["cleared"]["recoveryId"] == "writer:stale-resource"
    assert next_etag == project_recovery_etag("b")
    assert [raw_path(request) for request in requests] == [
        "/base/project/recovery/project%2Fwith%20space",
        "/base/project/recovery/project%2Fwith%20space",
    ]


def test_project_fence_recovery_validates_target_and_strong_etags_before_writing() -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return envelope(request, {})

    with client_with(handler) as client:
        for recovery_type, recovery_id, etag in [
            ("other", "writer:stale-resource", project_recovery_etag()),
            ("writer", "short", project_recovery_etag()),
            ("writer", "writer:stale-resource", 'W/"weak"'),
        ]:
            with pytest.raises(ConfigurationError):
                client.recover_project_fence(
                    "project-1",
                    recovery_type=recovery_type,
                    recovery_id=recovery_id,
                    etag=etag,
                )
    assert requests == []


@pytest.mark.parametrize("failure", ["server", "non-json", "missing-etag", "bad-payload"])
def test_project_fence_recovery_uncertain_responses_require_fresh_inspection(
    failure: str,
) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if failure == "server":
            return envelope(request, status=500, message="private failure")
        if failure == "non-json":
            return httpx.Response(200, text="not json", request=request)
        payload: Any = [] if failure == "bad-payload" else {"cleared": {}}
        headers = {} if failure == "missing-etag" else {"ETag": project_recovery_etag("b")}
        return envelope(request, payload, headers=headers)

    with (
        client_with(handler) as client,
        pytest.raises(OutcomeUnknownError, match=r"[Rr]econcil|inspect|invalid|ETag"),
    ):
        client.recover_project_fence(
            "project-1",
            recovery_type="task-delete",
            recovery_id="task-delete:task-1:stale",
            etag=project_recovery_etag(),
        )


def test_project_fence_recovery_capability_requires_feature_and_contract() -> None:
    payload = v6_capabilities()

    def handler(request: httpx.Request) -> httpx.Response:
        return v2_envelope(request, payload)

    with client_with(handler) as client:
        assert client.supports_project_fence_recovery() is True

    for missing in ["feature", "contract"]:
        changed = json.loads(json.dumps(payload))
        if missing == "feature":
            changed["features"]["projects"]["fenceRecovery"] = 0
        else:
            changed["contracts"]["projectFenceRecovery"] = 0

        def missing_handler(
            request: httpx.Request,
            value: dict[str, Any] = changed,
        ) -> httpx.Response:
            return v2_envelope(request, value)

        with (
            client_with(missing_handler) as client,
            pytest.raises(RemoteApiError, match="invalid capabilities-v2"),
        ):
            client.supports_project_fence_recovery()

    disabled = v6_capabilities(fence_recovery=False)

    def disabled_handler(request: httpx.Request) -> httpx.Response:
        return v2_envelope(request, disabled)

    with client_with(disabled_handler) as client:
        assert client.supports_project_fence_recovery() is False


def test_capability_report_includes_verified_project_fence_recovery_support() -> None:
    capabilities = v6_capabilities()

    def handler(request: httpx.Request) -> httpx.Response:
        path = raw_path(request)
        if path.endswith("/project/list/"):
            return envelope(request, [])
        if path.endswith("/user/me/"):
            return envelope(request, {"_id": "user-1", "name": "Ada"})
        assert path.endswith("/capabilities/v2/")
        return v2_envelope(request, capabilities)

    with client_with(handler) as client:
        report = client.capability_report()
    assert report["project_fence_recovery"] is True
    assert report | {} == {
        "projects": True,
        "identity": True,
        "record_delete": True,
        "api_version": 2,
        "capabilities_version": 2,
        "capability_source": "/capabilities/v2/",
        "v6_ready": True,
        "v7_ready": False,
        "project_lifecycle": True,
        "project_task_lifecycle": True,
        "task_stats": True,
        "record_details_edit": True,
        "task_suggestions": True,
        "atomic_timers": True,
        "webhook_receiver": True,
        "record_task_edit": True,
        "idempotent_create": True,
        "timeentry_pagination": True,
        "project_fence_recovery": True,
    }


def test_capability_report_recognizes_exact_v7_security_profile() -> None:
    capabilities = deepcopy(EXPECTED_V7_CAPABILITIES)
    capabilities["deployment"]["security"]["oauthEncryptionConfigured"] = True

    def handler(request: httpx.Request) -> httpx.Response:
        path = raw_path(request)
        if path.endswith("/project/list/"):
            return envelope(request, [])
        if path.endswith("/user/me/"):
            return envelope(request, {"_id": "user-1", "name": "Ada"})
        return v2_envelope(request, capabilities)

    with client_with(handler) as client:
        report = client.capability_report()
    assert report["v6_ready"] is True
    assert report["v7_ready"] is True
    assert report["capabilities_version"] == 3
    assert report["security_policy"]["deployment"]["oauthEncryptionConfigured"] is True
    assert report["security_policy"]["contract"]["releaseProfile"] == "security-v7"
