from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
from typing import Any, ClassVar

import click
import pytest
from click.testing import CliRunner

import titra_cli.cli as cli_module
from titra_cli.cli import ReportedClickError, cli
from titra_cli.errors import AuthenticationError, NotFoundError, OutcomeUnknownError, RateLimitError
from titra_cli.models import ActiveTimer, PendingTimerStart, ResolvedConfig
from titra_cli.state import StateStore
from titra_cli.v2_contract import EXPECTED_V7_CAPABILITIES


class FakeClient:
    instances: ClassVar[list[FakeClient]] = []
    etag: str | None = '"titra-date-revision-0"'
    fail_auth = False
    idempotent = False
    recovery_supported = True
    v2_supported = False

    def __init__(self, config: Any) -> None:
        self.config = config
        self.expected_user_id: str | None = None
        self.created_projects: list[dict[str, Any]] = []
        self.created_records: list[dict[str, Any]] = []
        self.deleted: list[tuple[str, str | None]] = []
        self.created_tasks: list[dict[str, Any]] = []
        self.create_keys: list[str | None] = []
        self.replay_calls: list[dict[str, Any]] = []
        self.recovery_calls: list[dict[str, Any]] = []
        self.recovered_fences: list[dict[str, str]] = []
        self.deleted_projects: list[dict[str, Any]] = []
        self.deleted_tasks: list[dict[str, Any]] = []
        self.deleted_suggestions: list[dict[str, Any]] = []
        self.last_timeentry_fetch = {
            "complete": True,
            "consistency": "live-keyset",
            "duplicates": 0,
            "pages": 1,
        }
        FakeClient.instances.append(self)

    def __enter__(self) -> FakeClient:
        return self

    def __exit__(self, *_args: object) -> None:
        pass

    def current_user(self) -> dict[str, Any]:
        if self.fail_auth:
            raise AuthenticationError("bad key")
        return {"_id": "u1", "name": "Alice"}

    def bind_expected_user_id(self, user_id: str) -> None:
        self.expected_user_id = user_id

    def capability_report(self) -> dict[str, bool]:
        return {"projects": True, "identity": True, "record_delete": True}

    def api_security_headers_report(self, *, require_hsts: bool = False) -> dict[str, Any]:
        return {
            "ok": not require_hsts,
            "profile": "v7-http-security/v1",
            "headers": {
                "cache-control": "no-store",
                "strict-transport-security": None,
            },
            "hsts_required": require_hsts,
            "missing_or_mismatched": (["strict-transport-security"] if require_hsts else []),
        }

    @property
    def capability_source(self) -> str:
        return "/capabilities/v2/" if self.v2_supported else "/capabilities/"

    def capabilities_v1(self) -> dict[str, Any]:
        return {"apiVersion": 1, "features": {"timeEntryTaskUpdate": True}}

    def capabilities_v2(self, *, required: bool = False) -> dict[str, Any] | None:
        _ = required
        return complete_v2_capabilities() if self.v2_supported else None

    def capabilities(self) -> dict[str, Any]:
        return self.capabilities_v2() or self.capabilities_v1()

    def supports_v2_feature(self, group: str, feature: str, *, minimum: int = 1) -> bool:
        document = self.capabilities_v2()
        groups = document.get("features") if isinstance(document, dict) else None
        values = groups.get(group) if isinstance(groups, dict) else None
        value = values.get(feature) if isinstance(values, dict) else None
        return type(value) is int and value >= minimum

    def list_projects(self) -> list[dict[str, Any]]:
        return [
            {"_id": "p1", "name": "Alpha", "customer": "ACME", "rate": 100},
            {"_id": "p2", "name": "Old", "archived": True},
        ]

    def supports_idempotent_create(self, _operation: str | None = None) -> bool:
        return self.idempotent

    def supports_project_fence_recovery(self) -> bool:
        return self.recovery_supported

    def get_project_fence_recovery(self, project_id: str) -> tuple[dict[str, Any], str]:
        return {
            "projectId": project_id,
            "minimumAgeSeconds": 900,
            "writerRecoveries": {
                "status": "inspected",
                "writerCount": 1,
                "metadataCount": 1,
                "reservations": [
                    {
                        "status": "recoverable",
                        "reservation": {
                            "reservationId": "writer:stale-resource",
                            "kind": "timecard-create",
                            "resourceId": "timecard-stale",
                            "acquiredAt": "2026-09-01T00:00:00.000Z",
                            "ageMs": 3600000,
                        },
                        "resourceStatus": "absent",
                    }
                ],
            },
            "taskGraphRecovery": {"status": "not-found"},
        }, f'"titra-project-recovery-{"a" * 64}"'

    def recover_project_fence(
        self,
        project_id: str,
        *,
        recovery_type: str,
        recovery_id: str,
        etag: str,
    ) -> tuple[dict[str, Any], str]:
        self.recovered_fences.append(
            {
                "projectId": project_id,
                "type": recovery_type,
                "recoveryId": recovery_id,
                "etag": etag,
            }
        )
        return {
            "cleared": {"type": recovery_type, "recoveryId": recovery_id},
            "current": {"projectId": project_id},
        }, f'"titra-project-recovery-{"b" * 64}"'

    def create_project(self, payload: dict[str, Any], *, idempotency_key: str | None = None) -> str:
        self.created_projects.append(payload)
        self.create_keys.append(idempotency_key)
        return "p-new"

    def list_tasks(self, _project_id: str) -> list[dict[str, Any]]:
        return [{"_id": "t1", "name": "Task", "estimatedHours": 2}]

    def create_task(self, payload: dict[str, Any], *, idempotency_key: str | None = None) -> str:
        self.created_tasks.append(payload)
        self.create_keys.append(idempotency_key)
        return "t-new"

    def list_own_time_entries(self, _value: Any, *, page_size: int = 200) -> list[dict[str, Any]]:
        assert 1 <= page_size <= 500
        return [
            {
                "_id": "r1",
                "userId": "u1",
                "projectId": "p1",
                "date": "2026-08-30T00:00:00Z",
                "dateOnly": "2026-08-30",
                "startTime": "09:00",
                "hours": 1.5,
                "task": "Build",
            }
        ]

    def list_project_time_entries(
        self, _project: str, value: Any, *, page_size: int = 200
    ) -> list[dict[str, Any]]:
        return self.list_own_time_entries(value, page_size=page_size)

    def project_users(self, _project_id: str) -> list[dict[str, Any]]:
        return [{"_id": "u1", "name": "Alice"}, {"_id": "u2", "name": None}]

    def get_project_snapshot(self, project_id: str) -> tuple[dict[str, Any], str]:
        return {
            "_id": project_id,
            "name": "Alpha",
            "role": "owner",
            "archived": False,
        }, '"titra-project-revision-4"'

    def delete_empty_project(
        self, project_id: str, *, expected_name: str, etag: str
    ) -> dict[str, Any]:
        call = {"projectId": project_id, "expectedName": expected_name, "etag": etag}
        self.deleted_projects.append(call)
        return {"projectId": project_id}

    def get_project_task_snapshot(self, task_id: str) -> tuple[dict[str, Any], str]:
        return {
            "_id": task_id,
            "projectId": "p1",
            "name": "Task",
            "projectTaskRevision": 2,
            "recordReferences": 0,
        }, '"titra-project-task-revision-2"'

    def delete_project_task(
        self,
        task_id: str,
        *,
        expected_name: str,
        acknowledge_recorded_entries: bool,
        etag: str,
    ) -> dict[str, Any]:
        call = {
            "taskId": task_id,
            "expectedName": expected_name,
            "acknowledgeRecordedEntries": acknowledge_recorded_entries,
            "etag": etag,
        }
        self.deleted_tasks.append(call)
        return {"taskId": task_id}

    def get_task_suggestion_snapshot(self, suggestion_id: str) -> tuple[dict[str, Any], str]:
        return {
            "_id": suggestion_id,
            "name": "Suggested task",
            "usage": 0,
        }, '"titra-task-suggestion-revision-1"'

    def delete_task_suggestion(
        self,
        suggestion_id: str,
        *,
        expected_name: str,
        acknowledge_referenced_records: bool,
        etag: str,
    ) -> dict[str, Any]:
        call = {
            "suggestionId": suggestion_id,
            "expectedName": expected_name,
            "acknowledgeReferencedRecords": acknowledge_referenced_records,
            "etag": etag,
        }
        self.deleted_suggestions.append(call)
        return {"suggestionId": suggestion_id}

    def project_task_stats(self, project_id: str, task_name: str | None = None) -> dict[str, Any]:
        rows = [
            {
                "taskId": "t1",
                "taskName": "Build",
                "estimatedHours": 2.0,
                "actualHours": 2.5,
                "variance": 0.5,
                "start": "2026-08-01T00:00:00.000Z",
                "end": "2026-08-31T23:59:59.999Z",
            }
        ]
        if task_name is not None:
            rows = [row for row in rows if row["taskName"] == task_name]
        return {
            "projectId": project_id,
            "totalEstimatedHours": sum(row["estimatedHours"] for row in rows),
            "totalActualHours": sum(row["actualHours"] for row in rows),
            "tasks": rows,
        }

    def get_time_entry(self, record_id: str) -> dict[str, Any]:
        if record_id == "missing":
            raise NotFoundError("Time record not found: missing")
        return {**self.list_own_time_entries(None)[0], "_id": record_id, "dateRevision": 0}

    def get_time_entry_snapshot(self, record_id: str) -> tuple[dict[str, Any], str | None]:
        return self.get_time_entry(record_id), self.etag

    def create_time_entry(
        self, payload: dict[str, Any], *, idempotency_key: str | None = None
    ) -> str:
        self.created_records.append(payload)
        self.create_keys.append(idempotency_key)
        return "r-new"

    def replay_idempotent_create(
        self,
        operation: str,
        payload: dict[str, Any],
        *,
        idempotency_key: str,
        expected_result_id: str,
    ) -> dict[str, Any]:
        self.replay_calls.append(
            {
                "operation": operation,
                "payload": payload,
                "idempotency_key": idempotency_key,
                "expected_result_id": expected_result_id,
            }
        )
        return {
            "operation": operation,
            "result_id": expected_result_id,
            "idempotency_replayed": True,
            "idempotency_expires_at": "2099-01-01T00:00:00.000Z",
        }

    def recover_idempotent_create(
        self,
        operation: str,
        payload: dict[str, Any],
        *,
        idempotency_key: str,
    ) -> dict[str, Any]:
        result_ids = {
            "project.create": "p-recovered",
            "project-task.create": "t-recovered",
            "timeentry.create": "r-recovered",
        }
        call = {
            "operation": operation,
            "payload": payload,
            "idempotency_key": idempotency_key,
        }
        self.recovery_calls.append(call)
        self.create_keys.append(idempotency_key)
        return {
            "operation": operation,
            "result_id": result_ids[operation],
            "idempotency_replayed": True,
            "idempotency_expires_at": "2099-01-01T00:00:00.000Z",
        }

    def delete_time_entry(self, record_id: str, *, etag: str | None = None) -> dict[str, Any]:
        self.deleted.append((record_id, etag))
        return {"timecardId": record_id}


def complete_v2_capabilities() -> dict[str, Any]:
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
            "errors": {"version": 1},
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
        "mutationPreconditions": {"version": 2, "operations": []},
        "idempotency": {
            "version": 1,
            "header": "Idempotency-Key",
            "minKeyLength": 16,
            "maxKeyLength": 128,
            "retentionSeconds": 604800,
            "operations": ["timeentry.create", "project.create", "project-task.create"],
        },
        "timeEntryPagination": {"version": 1},
        "deployment": {
            "projectFenceRecoveryEnabled": False,
            "webhookActionVerificationEnabled": False,
        },
        "limits": {"timerStartRetainedOperations": 4096},
    }


def test_rate_limit_click_error_displays_only_validated_retry_delay() -> None:
    error = ReportedClickError(RateLimitError("Too many requests.", 17))
    assert error.format_message() == "Too many requests. Retry after 17 seconds."
    assert error.exit_code == 5


@pytest.fixture(autouse=True)
def fake_client(monkeypatch: pytest.MonkeyPatch) -> None:
    FakeClient.instances = []
    FakeClient.etag = '"titra-date-revision-0"'
    FakeClient.fail_auth = False
    FakeClient.idempotent = False
    FakeClient.recovery_supported = True
    FakeClient.v2_supported = False
    monkeypatch.setattr("titra_cli.cli.TitraClient", FakeClient)


def base_args(tmp_path: Path, output: str = "json") -> list[str]:
    return [
        "--server",
        "https://titra.example",
        "--api-key",
        "top-secret-token",
        "--username",
        "Alice",
        "--state-dir",
        str(tmp_path / "state"),
        "--output",
        output,
    ]


def resolved_cli_config() -> ResolvedConfig:
    return ResolvedConfig(
        profile="default",
        server="https://titra.example",
        api_key="unused-in-state",
        username="Alice",
        timezone="UTC",
    )


def test_help_lists_interactive_and_scriptable_commands() -> None:
    result = CliRunner().invoke(cli, ["--help"])
    assert result.exit_code == 0
    for command in ("interactive", "track", "record", "project", "report", "draft"):
        assert command in result.output


def test_config_show_fully_redacts_token(tmp_path: Path) -> None:
    result = CliRunner().invoke(cli, [*base_args(tmp_path), "config", "show"])
    assert result.exit_code == 0, result.output
    assert "top-secret-token" not in result.output
    assert "top-" not in result.output
    body = json.loads(result.stdout)
    assert body["data"]["api_key"] == "<redacted>"


def test_auth_error_uses_stable_exit_code_three(tmp_path: Path) -> None:
    FakeClient.fail_auth = True
    result = CliRunner().invoke(cli, [*base_args(tmp_path), "auth", "check"])
    assert result.exit_code == 3
    assert "bad key" in result.stderr


def test_global_expected_user_id_blocks_mutation_after_token_owner_change(
    tmp_path: Path,
) -> None:
    result = CliRunner().invoke(
        cli,
        [
            *base_args(tmp_path),
            "--expect-user-id",
            "different-user",
            "project",
            "create",
            "Blocked",
            "--yes",
        ],
    )
    assert result.exit_code == 4, result.output
    assert FakeClient.instances[-1].created_projects == []


def test_global_expected_user_id_also_pins_webhook_owner_resolution(tmp_path: Path) -> None:
    result = CliRunner().invoke(
        cli,
        [
            *base_args(tmp_path),
            "--expect-user-id",
            "different-owner",
            "webhook",
            "list",
        ],
    )

    assert result.exit_code == 4, result.output
    assert "different API user" in result.stderr
    assert FakeClient.instances[-1].expected_user_id == "different-owner"


def test_mutation_workflows_bind_identity_before_any_resource_request(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[tuple[str, str | None]] = []
    original_current_user = FakeClient.current_user

    def current_user(client: FakeClient) -> dict[str, Any]:
        calls.append(("current_user", client.expected_user_id))
        return original_current_user(client)

    monkeypatch.setattr(FakeClient, "current_user", current_user)

    def guard_method(name: str) -> None:
        original = getattr(FakeClient, name)

        def guarded(client: FakeClient, *args: Any, **kwargs: Any) -> Any:
            calls.append((name, client.expected_user_id))
            if client.expected_user_id != "u1":
                raise AssertionError(f"{name} ran before immutable user binding")
            return original(client, *args, **kwargs)

        monkeypatch.setattr(FakeClient, name, guarded)

    for method in (
        "supports_v2_feature",
        "supports_idempotent_create",
        "supports_project_fence_recovery",
        "list_projects",
        "get_project_snapshot",
        "get_project_fence_recovery",
        "get_project_task_snapshot",
        "get_time_entry_snapshot",
        "get_task_suggestion_snapshot",
        "create_project",
        "create_task",
        "create_time_entry",
        "delete_empty_project",
        "recover_project_fence",
        "delete_project_task",
        "delete_time_entry",
        "delete_task_suggestion",
    ):
        guard_method(method)

    def require_bound(client: FakeClient, name: str) -> None:
        calls.append((name, client.expected_user_id))
        if client.expected_user_id != "u1":
            raise AssertionError(f"{name} ran before immutable user binding")

    def supports_atomic_timers(client: FakeClient) -> bool:
        require_bound(client, "supports_atomic_timers")
        return False

    def timer_start(client: FakeClient) -> dict[str, Any]:
        require_bound(client, "timer_start")
        return {}

    def timer_get(client: FakeClient) -> dict[str, Any]:
        require_bound(client, "timer_get")
        return {"startTime": "2026-09-03T00:00:00.000Z", "duration": 0}

    monkeypatch.setattr(FakeClient, "supports_atomic_timers", supports_atomic_timers, raising=False)
    monkeypatch.setattr(FakeClient, "timer_start", timer_start, raising=False)
    monkeypatch.setattr(FakeClient, "timer_get", timer_get, raising=False)

    FakeClient.v2_supported = True
    commands = [
        ["project", "create", "Bound project", "--yes"],
        [
            "project",
            "delete",
            "Alpha",
            "--expect-name",
            "Alpha",
            "--yes",
        ],
        [
            "project",
            "recovery",
            "recover",
            "Alpha",
            "--type",
            "writer",
            "--recovery-id",
            "writer:stale-resource",
            "--yes",
        ],
        [
            "task",
            "create",
            "Alpha",
            "Bound task",
            "--start",
            "2026-09-01",
            "--end",
            "2026-09-02",
            "--yes",
        ],
        [
            "task",
            "delete",
            "t1",
            "--expect-project-id",
            "p1",
            "--expect-name",
            "Task",
            "--yes",
        ],
        [
            "record",
            "create",
            "--project",
            "Alpha",
            "--task",
            "Bound work",
            "--duration",
            "1m",
            "--yes",
        ],
        [
            "record",
            "delete",
            "r1",
            "--expect-project-id",
            "p1",
            "--expect-task",
            "Build",
            "--yes",
        ],
        [
            "suggestion",
            "delete",
            "s1",
            "--expect-name",
            "Suggested task",
            "--yes",
        ],
        ["timer", "start", "--project", "Alpha", "--task", "Bound timer"],
    ]

    for index, arguments in enumerate(commands):
        calls.clear()
        result = CliRunner().invoke(
            cli,
            [*base_args(tmp_path / f"case-{index}"), *arguments],
        )
        assert result.exit_code == 0, result.output
        assert calls[0] == ("current_user", None)
        assert all(owner == "u1" for name, owner in calls if name != "current_user")


def test_project_list_json_and_silent_modes(tmp_path: Path) -> None:
    runner = CliRunner()
    result = runner.invoke(cli, [*base_args(tmp_path), "project", "list"])
    assert result.exit_code == 0, result.output
    data = json.loads(result.stdout)["data"]
    assert [row["name"] for row in data] == ["Alpha"]
    silent = runner.invoke(
        cli, [*base_args(tmp_path, "silent"), "project", "list", "--include-archived"]
    )
    assert silent.exit_code == 0
    assert silent.stdout == ""


@pytest.mark.parametrize("output", ["json", "human"])
def test_successful_server_payload_cannot_reflect_bearer_token_to_output(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, output: str
) -> None:
    token = "top-secret-token"
    monkeypatch.setattr(
        FakeClient,
        "list_projects",
        lambda self: [
            {
                "_id": "p1",
                "name": f"nested-{token}-echo",
                "custom": {"token": token, "safe": "visible"},
            }
        ],
    )
    result = CliRunner().invoke(cli, [*base_args(tmp_path, output), "project", "list"])
    assert result.exit_code == 0, result.output
    assert token not in result.output
    assert "<redacted>" in result.output


def test_project_create_dry_run_resolves_secrets_but_needs_no_connection(tmp_path: Path) -> None:
    result = CliRunner().invoke(
        cli,
        [
            *base_args(tmp_path),
            "project",
            "create",
            "New",
            "--description",
            "Description",
            "--dry-run",
        ],
    )
    assert result.exit_code == 0, result.output
    assert FakeClient.instances == []
    assert json.loads(result.stdout)["data"]["name"] == "New"


def test_credential_file_token_is_redacted_from_dry_run_and_local_state_show(
    tmp_path: Path,
) -> None:
    token = "credential-file-token-never-render"
    credentials = tmp_path / "credentials.toml"
    credentials.write_text(
        'default_profile = "default"\n'
        "[profiles.default]\n"
        'server = "https://titra.example"\n'
        f'api_key = "{token}"\n'
        'username = "Alice"\n'
        'timezone = "UTC"\n',
        encoding="utf-8",
    )
    if os.name == "posix":
        credentials.chmod(0o600)
    state = tmp_path / "state"
    common = [
        "--credentials",
        str(credentials),
        "--state-dir",
        str(state),
        "--output",
        "json",
    ]
    dry_run = CliRunner().invoke(
        cli,
        [*common, "project", "create", f"prefix-{token}-suffix", "--dry-run"],
    )
    assert dry_run.exit_code == 0, dry_run.output
    assert token not in dry_run.output
    assert json.loads(dry_run.stdout)["data"]["name"] == "prefix-<redacted>-suffix"
    assert FakeClient.instances == []

    receipt_id = "a" * 32
    receipt_dir = state / "creation-receipts"
    receipt_dir.mkdir(parents=True)
    if os.name == "posix":
        state.chmod(0o700)
        receipt_dir.chmod(0o700)
    receipt_path = receipt_dir / f"{receipt_id}.json"
    receipt_path.write_text(
        json.dumps(
            {
                "receipt_id": receipt_id,
                "payload": {"name": f"legacy-{token}-echo"},
                "idempotency_key": "stored-private-key",
            }
        ),
        encoding="utf-8",
    )
    if os.name == "posix":
        receipt_path.chmod(0o600)
    shown = CliRunner().invoke(cli, [*common, "creation", "show", receipt_id])
    assert shown.exit_code == 0, shown.output
    assert token not in shown.output

    draft_id = "b" * 32
    draft_dir = state / "drafts"
    draft_dir.mkdir(parents=True, exist_ok=True)
    if os.name == "posix":
        draft_dir.chmod(0o700)
    draft_path = draft_dir / f"{draft_id}.json"
    draft_path.write_text(
        json.dumps(
            {
                "version": 2,
                "draft_id": draft_id,
                "profile": "default",
                "server": "https://titra.example",
                "created_at": "2026-09-03T00:00:00+00:00",
                "status": "submitted",
                "payloads": [{"task": f"legacy-{token}-echo"}],
                "owner_id": "u1",
                "result_ids": ["r1"],
                "idempotency_keys": ["private-key"],
                "first_submitted_at": "2026-09-03T00:00:00+00:00",
            }
        ),
        encoding="utf-8",
    )
    if os.name == "posix":
        draft_path.chmod(0o600)
    draft = CliRunner().invoke(cli, [*common, "draft", "show", draft_id])
    assert draft.exit_code == 0, draft.output
    assert token not in draft.output


def test_noninteractive_mutation_requires_yes(tmp_path: Path) -> None:
    result = CliRunner().invoke(cli, [*base_args(tmp_path), "project", "create", "New"])
    assert result.exit_code == 2
    assert "--yes" in result.stderr


def test_project_and_task_create_payloads(tmp_path: Path) -> None:
    runner = CliRunner()
    project_result = runner.invoke(
        cli,
        [
            *base_args(tmp_path),
            "project",
            "create",
            "New",
            "--rate",
            "75",
            "--yes",
        ],
    )
    assert project_result.exit_code == 0, project_result.output
    assert FakeClient.instances[-1].created_projects == [{"name": "New", "rate": 75.0}]
    task_result = runner.invoke(
        cli,
        [
            *base_args(tmp_path),
            "task",
            "create",
            "Alpha",
            "Milestone",
            "--start",
            "2026-08-01",
            "--end",
            "2026-08-03",
            "--yes",
        ],
    )
    assert task_result.exit_code == 0, task_result.output
    assert FakeClient.instances[-1].created_tasks[0]["projectId"] == "p1"


def test_v6_project_create_persists_private_idempotency_receipt_before_write(
    tmp_path: Path,
) -> None:
    FakeClient.idempotent = True
    result = CliRunner().invoke(
        cli,
        [*base_args(tmp_path), "project", "create", "Safe", "--yes"],
    )
    assert result.exit_code == 0, result.output
    body = json.loads(result.stdout)["data"]
    receipt_path = Path(body["receipt"])
    receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
    assert receipt["status"] == "completed"
    assert receipt["schema"] == "titra-cli/create-receipt/v2"
    assert receipt["owner_id"] == "u1"
    assert receipt["operation"] == "project.create"
    assert receipt["payload"] == {"name": "Safe"}
    assert len(receipt["idempotency_key"]) == 32
    assert FakeClient.instances[-1].create_keys == [receipt["idempotency_key"]]
    assert receipt["idempotency_key"] not in result.output

    shown = CliRunner().invoke(
        cli,
        [*base_args(tmp_path), "creation", "show", receipt["receipt_id"]],
    )
    assert shown.exit_code == 0, shown.output
    assert json.loads(shown.stdout)["data"]["idempotency_key"] == "<redacted>"


@pytest.mark.parametrize(
    ("schema", "owner_id", "expected_code"),
    [
        ("titra-cli/create-receipt/v1", None, 2),
        ("titra-cli/create-receipt/v2", None, 2),
        ("titra-cli/create-receipt/v2", "another-user", 4),
    ],
)
def test_creation_retry_refuses_legacy_missing_or_different_owner_before_post(
    tmp_path: Path,
    schema: str,
    owner_id: str | None,
    expected_code: int,
) -> None:
    FakeClient.idempotent = True
    runner = CliRunner()
    created = runner.invoke(
        cli,
        [*base_args(tmp_path), "project", "create", "Owner-bound", "--yes"],
    )
    assert created.exit_code == 0, created.output
    receipt_path = Path(json.loads(created.stdout)["data"]["receipt"])
    receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
    receipt["schema"] = schema
    receipt["status"] = "outcome_unknown"
    if owner_id is None:
        receipt.pop("owner_id", None)
    else:
        receipt["owner_id"] = owner_id
    receipt_path.write_text(json.dumps(receipt), encoding="utf-8")

    retried = runner.invoke(
        cli,
        [*base_args(tmp_path), "creation", "retry", receipt["receipt_id"], "--yes"],
    )
    assert retried.exit_code == expected_code, retried.output
    assert FakeClient.instances[-1].created_projects == []
    assert FakeClient.instances[-1].create_keys == []
    persisted = json.loads(receipt_path.read_text(encoding="utf-8"))
    assert persisted["status"] == "outcome_unknown"


def test_creation_retry_refuses_expired_v6_receipt_without_changing_it(
    tmp_path: Path,
) -> None:
    FakeClient.idempotent = True
    FakeClient.v2_supported = True
    runner = CliRunner()
    created = runner.invoke(
        cli,
        [*base_args(tmp_path), "project", "create", "Old request", "--yes"],
    )
    assert created.exit_code == 0, created.output
    receipt_path = Path(json.loads(created.stdout)["data"]["receipt"])
    receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
    receipt["created_at"] = "2000-01-01T00:00:00+00:00"
    receipt["status"] = "outcome_unknown"
    receipt_path.write_text(json.dumps(receipt), encoding="utf-8")

    retried = runner.invoke(
        cli,
        [*base_args(tmp_path), "creation", "retry", receipt["receipt_id"], "--yes"],
    )
    assert retried.exit_code == 4, retried.output
    assert "final 600 seconds" in retried.stderr
    assert "604800-second" in retried.stderr
    assert FakeClient.instances[-1].created_projects == []
    persisted = json.loads(receipt_path.read_text(encoding="utf-8"))
    assert persisted["status"] == "outcome_unknown"


@pytest.mark.parametrize(
    ("operation", "payload", "expected_result_id"),
    [
        ("project.create", {"name": "Recovered project"}, "p-recovered"),
        (
            "project-task.create",
            {"projectId": "p1", "name": "Recovered task"},
            "t-recovered",
        ),
        (
            "timeentry.create",
            {
                "projectId": "p1",
                "task": "Recovered record",
                "date": "2026-09-03",
                "hours": 1,
            },
            "r-recovered",
        ),
    ],
)
def test_creation_retry_converges_when_lost_create_was_committed(
    tmp_path: Path,
    operation: str,
    payload: dict[str, Any],
    expected_result_id: str,
) -> None:
    FakeClient.idempotent = True
    FakeClient.v2_supported = True
    store = StateStore(tmp_path / "state")
    receipt = store.create_creation_receipt(
        resolved_cli_config(),
        operation,
        payload,
        owner_id="u1",
    )
    receipt["status"] = "outcome_unknown"
    path = store.save_creation_receipt(receipt)

    recovered = CliRunner().invoke(
        cli,
        [*base_args(tmp_path), "creation", "retry", receipt["receipt_id"], "--yes"],
    )

    assert recovered.exit_code == 0, recovered.output
    data = json.loads(recovered.stdout)["data"]
    assert data["result_id"] == expected_result_id
    assert data["idempotency_replayed"] is True
    client = FakeClient.instances[-1]
    assert client.recovery_calls == [
        {
            "operation": operation,
            "payload": payload,
            "idempotency_key": receipt["idempotency_key"],
        }
    ]
    persisted = json.loads(path.read_text(encoding="utf-8"))
    assert persisted["status"] == "completed"
    assert persisted["result_id"] == expected_result_id
    assert persisted["recovery"]["idempotency_replayed"] is True


def test_creation_verify_replay_uses_original_request_and_preserves_receipt(
    tmp_path: Path,
) -> None:
    FakeClient.idempotent = True
    FakeClient.v2_supported = True
    runner = CliRunner()
    created = runner.invoke(
        cli,
        [*base_args(tmp_path), "project", "create", "Replay me", "--yes"],
    )
    assert created.exit_code == 0, created.output
    created_data = json.loads(created.stdout)["data"]
    receipt_path = Path(created_data["receipt"])
    before = json.loads(receipt_path.read_text(encoding="utf-8"))

    verified = runner.invoke(
        cli,
        [
            *base_args(tmp_path),
            "creation",
            "verify-replay",
            before["receipt_id"],
            "--expect-result-id",
            "p-new",
            "--yes",
        ],
    )
    assert verified.exit_code == 0, verified.output
    output = json.loads(verified.stdout)["data"]
    assert output["result_id"] == "p-new"
    assert output["idempotency_replayed"] is True
    call = FakeClient.instances[-1].replay_calls
    assert call == [
        {
            "operation": "project.create",
            "payload": {"name": "Replay me"},
            "idempotency_key": before["idempotency_key"],
            "expected_result_id": "p-new",
        }
    ]
    after = json.loads(receipt_path.read_text(encoding="utf-8"))
    for field in ("status", "result_id", "payload", "idempotency_key", "owner_id"):
        assert after[field] == before[field]
    assert after["replay_verification"]["status"] == "verified"


def test_creation_verify_replay_expected_id_mismatch_never_posts_or_changes_receipt(
    tmp_path: Path,
) -> None:
    FakeClient.idempotent = True
    FakeClient.v2_supported = True
    runner = CliRunner()
    created = runner.invoke(
        cli,
        [*base_args(tmp_path), "project", "create", "Do not replay", "--yes"],
    )
    receipt_path = Path(json.loads(created.stdout)["data"]["receipt"])
    before_text = receipt_path.read_text(encoding="utf-8")
    receipt_id = json.loads(before_text)["receipt_id"]

    refused = runner.invoke(
        cli,
        [
            *base_args(tmp_path),
            "creation",
            "verify-replay",
            receipt_id,
            "--expect-result-id",
            "another-result",
            "--yes",
        ],
    )
    assert refused.exit_code == 4, refused.output
    assert FakeClient.instances[-1].replay_calls == []
    assert receipt_path.read_text(encoding="utf-8") == before_text


def test_draft_verify_replay_preserves_submitted_evidence_and_journals_failure(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    FakeClient.idempotent = True
    FakeClient.v2_supported = True
    runner = CliRunner()
    created = runner.invoke(
        cli,
        [
            *base_args(tmp_path),
            "record",
            "create",
            "--project",
            "Alpha",
            "--task",
            "Replay record",
            "--hours",
            "1",
            "--yes",
        ],
    )
    assert created.exit_code == 0, created.output
    draft_id = json.loads(created.stdout)["data"]["draft_id"]
    path = tmp_path / "state" / "drafts" / f"{draft_id}.json"
    before = json.loads(path.read_text(encoding="utf-8"))

    def unknown_replay(*_args: Any, **_kwargs: Any) -> dict[str, Any]:
        raise OutcomeUnknownError(
            "fixed failure",
            {"observed_result_id": "r-new", "remote": "top-secret-token inside"},
        )

    monkeypatch.setattr(FakeClient, "replay_idempotent_create", unknown_replay)
    failed = runner.invoke(
        cli,
        [
            *base_args(tmp_path),
            "draft",
            "verify-replay",
            draft_id,
            "--expect-result-id",
            "r-new",
            "--yes",
        ],
    )
    assert failed.exit_code == 6, failed.output
    after_text = path.read_text(encoding="utf-8")
    assert "top-secret-token" not in after_text
    after = json.loads(after_text)
    for field in ("status", "result_ids", "payloads", "idempotency_keys", "owner_id"):
        assert after[field] == before[field]
    assert after["replay_verification"]["status"] == "replay_outcome_unknown"
    assert after["replay_verification"]["observation"]["remote"] == ("<redacted> inside")


def test_project_recovery_inspect_and_dry_run_are_read_only(tmp_path: Path) -> None:
    runner = CliRunner()
    inspected = runner.invoke(
        cli,
        [*base_args(tmp_path), "project", "recovery", "inspect", "Alpha"],
    )
    assert inspected.exit_code == 0, inspected.output
    inspected_data = json.loads(inspected.stdout)["data"]
    assert inspected_data["projectId"] == "p1"
    assert inspected_data["writerRecoveries"]["reservations"][0]["status"] == "recoverable"
    assert inspected_data["etag"].startswith('"titra-project-recovery-')
    assert FakeClient.instances[-1].recovered_fences == []

    dry_run = runner.invoke(
        cli,
        [
            *base_args(tmp_path),
            "project",
            "recovery",
            "recover",
            "p1",
            "--type",
            "writer",
            "--recovery-id",
            "writer:stale-resource",
            "--dry-run",
        ],
    )
    assert dry_run.exit_code == 0, dry_run.output
    dry_data = json.loads(dry_run.stdout)["data"]
    assert dry_data["candidate"]["resourceStatus"] == "absent"
    assert FakeClient.instances[-1].recovered_fences == []


def test_project_recovery_requires_fresh_candidate_confirmation_and_capability(
    tmp_path: Path,
) -> None:
    runner = CliRunner()
    recovered = runner.invoke(
        cli,
        [
            *base_args(tmp_path),
            "project",
            "recovery",
            "recover",
            "p1",
            "--type",
            "writer",
            "--recovery-id",
            "writer:stale-resource",
            "--yes",
        ],
    )
    assert recovered.exit_code == 0, recovered.output
    call = FakeClient.instances[-1].recovered_fences[0]
    assert call["projectId"] == "p1"
    assert call["type"] == "writer"
    assert call["recoveryId"] == "writer:stale-resource"
    assert call["etag"].startswith('"titra-project-recovery-')

    unsafe = runner.invoke(
        cli,
        [
            *base_args(tmp_path),
            "project",
            "recovery",
            "recover",
            "p1",
            "--type",
            "writer",
            "--recovery-id",
            "writer:another-resource",
            "--yes",
        ],
    )
    assert unsafe.exit_code == 2
    assert "not present and safely recoverable" in unsafe.output
    assert FakeClient.instances[-1].recovered_fences == []

    FakeClient.recovery_supported = False
    unsupported = runner.invoke(
        cli,
        [*base_args(tmp_path), "project", "recovery", "inspect", "p1"],
    )
    assert unsupported.exit_code == 2
    assert "requires the v6 project fence recovery API" in unsupported.output


def test_record_list_and_report_summary(tmp_path: Path) -> None:
    runner = CliRunner()
    records = runner.invoke(
        cli,
        [
            *base_args(tmp_path),
            "record",
            "list",
            "--from",
            "2026-08-01",
            "--to",
            "2026-08-31",
        ],
    )
    assert records.exit_code == 0, records.output
    assert json.loads(records.stdout)["data"][0]["id"] == "r1"
    summary = runner.invoke(
        cli,
        [
            *base_args(tmp_path),
            "report",
            "summary",
            "--calendar-month",
            "2026-08",
            "--group-by",
            "project,task",
        ],
    )
    assert summary.exit_code == 0, summary.output
    row = json.loads(summary.stdout)["data"][0]
    assert row["project"] == "Alpha"
    assert row["task"] == "Build"
    assert row["hours"] == 1.5


def test_record_create_journals_and_submits_once(tmp_path: Path) -> None:
    result = CliRunner().invoke(
        cli,
        [
            *base_args(tmp_path),
            "record",
            "create",
            "--project",
            "Alpha",
            "--task",
            "Build",
            "--date",
            "2026-08-30",
            "--start",
            "09:15",
            "--duration",
            "1h30m",
            "--yes",
        ],
    )
    assert result.exit_code == 0, result.output
    assert FakeClient.instances[-1].created_records == [
        {
            "projectId": "p1",
            "task": "Build",
            "date": "2026-08-30",
            "hours": 1.5,
            "startTime": "09:15",
        }
    ]
    drafts = list((tmp_path / "state" / "drafts").glob("*.json"))
    assert len(drafts) == 1
    assert json.loads(drafts[0].read_text())["status"] == "submitted"
    assert "top-secret-token" not in drafts[0].read_text()


def test_timer_recover_start_is_guarded_and_available_in_both_modes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    state = StateStore(tmp_path / "state")
    config = resolved_cli_config()
    operation_id = "cli-recover-start-0001"

    def journal() -> None:
        state.reserve_pending_timer_start(
            config,
            PendingTimerStart(
                version=1,
                profile=config.profile,
                server=config.server,
                operation_id=operation_id,
                created_at="2026-09-03T01:00:00+00:00",
                owner_id="u1",
                project_id="p1",
                task="Recovered work",
            ),
        )

    recovered: list[str] = []

    def fake_recover(manager: Any) -> ActiveTimer:
        pending = manager.store.load_pending_timer_start(manager.config)
        recovered.append(pending.operation_id)
        timer = ActiveTimer(
            version=1,
            profile=manager.config.profile,
            server=manager.config.server,
            started_at="2026-09-03T01:00:00.000Z",
            owner_id=pending.owner_id,
            project_id=pending.project_id,
            task=pending.task,
            timer_id=pending.operation_id,
        )
        manager.store.save_active_timer(manager.config, timer)
        manager.store.clear_pending_timer_start(
            manager.config, expected_operation_id=pending.operation_id
        )
        return timer

    monkeypatch.setattr("titra_cli.cli.TimerManager.recover_start", fake_recover)
    journal()
    runner = CliRunner()
    refused = runner.invoke(cli, [*base_args(tmp_path), "timer", "recover-start"])
    assert refused.exit_code == 2
    assert "--yes" in refused.stderr
    assert recovered == []

    accepted = runner.invoke(cli, [*base_args(tmp_path), "timer", "recover-start", "--yes"])
    assert accepted.exit_code == 0, accepted.output
    assert json.loads(accepted.stdout)["data"]["timer_id"] == operation_id
    assert recovered == [operation_id]

    journal()
    monkeypatch.setattr("titra_cli.cli._terminal_is_interactive", lambda: True)
    interactive = runner.invoke(
        cli,
        [*base_args(tmp_path, "human"), "interactive"],
        input="2\n3\ny\n0\n0\n",
    )
    assert interactive.exit_code == 0, interactive.output
    assert "Recover an interrupted v6 start" in interactive.stderr
    assert recovered == [operation_id, operation_id]


def test_noninteractive_timer_adopt_can_guard_a_legacy_null_id_by_start_time(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    start_time = "2026-09-03T01:23:45.678Z"
    monkeypatch.setattr(
        FakeClient,
        "timer_get",
        lambda self: {"timerId": None, "startTime": start_time, "duration": 1000},
        raising=False,
    )
    runner = CliRunner()
    unguarded = runner.invoke(
        cli,
        [*base_args(tmp_path), "timer", "adopt", "--yes"],
    )
    assert unguarded.exit_code == 2
    assert "--expect-start-time" in unguarded.stderr

    adopted = runner.invoke(
        cli,
        [
            *base_args(tmp_path),
            "timer",
            "adopt",
            "--expect-timer-id",
            "null",
            "--expect-start-time",
            start_time,
            "--yes",
        ],
    )
    assert adopted.exit_code == 0, adopted.output
    data = json.loads(adopted.stdout)["data"]
    assert data["timer_id"] is None
    assert data["owner_id"] == "u1"
    assert StateStore(tmp_path / "state").load_active_timer(resolved_cli_config()).owner_id == "u1"


def test_timer_cancel_yes_requires_and_checks_exact_timer_id(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    stop_calls: list[tuple[dict[str, Any], str | None]] = []
    snapshot = {
        "timerId": "cancel-operation-0001",
        "startTime": "2026-09-03T01:23:45.678Z",
        "stoppedAt": "2026-09-03T01:24:45.678Z",
        "duration": 60_000,
        "revision": 3,
    }
    monkeypatch.setattr(FakeClient, "timer_get", lambda self: snapshot, raising=False)
    monkeypatch.setattr(
        FakeClient,
        "timer_get_snapshot",
        lambda self: (snapshot, '"titra-timer-revision-3"'),
        raising=False,
    )

    def stop_timer(_self: FakeClient, current: dict[str, Any], etag: str | None) -> dict[str, Any]:
        stop_calls.append((current.copy(), etag))
        return {**snapshot, "changed": True}

    monkeypatch.setattr(FakeClient, "timer_stop_snapshot", stop_timer, raising=False)
    runner = CliRunner()
    unguarded = runner.invoke(cli, [*base_args(tmp_path), "timer", "cancel", "--yes"])
    assert unguarded.exit_code == 2
    assert "--expect-timer-id" in unguarded.stderr
    assert stop_calls == []

    wrong = runner.invoke(
        cli,
        [
            *base_args(tmp_path),
            "timer",
            "cancel",
            "--expect-timer-id",
            "different-operation-0001",
            "--yes",
        ],
    )
    assert wrong.exit_code == 4, wrong.output
    assert stop_calls == []

    cancelled = runner.invoke(
        cli,
        [
            *base_args(tmp_path),
            "timer",
            "cancel",
            "--expect-timer-id",
            "cancel-operation-0001",
            "--yes",
        ],
    )
    assert cancelled.exit_code == 0, cancelled.output
    assert len(stop_calls) == 1
    assert json.loads(cancelled.stdout)["data"]["status"] == "discarded"
    [receipt] = StateStore(tmp_path / "state").list_drafts(resolved_cli_config())
    assert receipt.status == "discarded"
    assert receipt.payloads == []
    assert receipt.timer is not None
    assert receipt.timer["discard_after_stop"] is True


def test_timer_cancel_refuses_same_id_with_changed_start_after_preview(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    stop_calls: list[Any] = []
    timer_id = "cancel-operation-0001"
    snapshots = iter(
        [
            {
                "timerId": timer_id,
                "startTime": "2026-09-03T01:00:00.000Z",
                "duration": 60_000,
            },
            {
                "timerId": timer_id,
                "startTime": "2026-09-03T02:00:00.000Z",
                "duration": 1_000,
            },
        ]
    )
    monkeypatch.setattr(FakeClient, "timer_get", lambda _self: next(snapshots), raising=False)
    monkeypatch.setattr(
        FakeClient,
        "timer_stop_snapshot",
        lambda *_args, **_kwargs: stop_calls.append(True),
        raising=False,
    )

    result = CliRunner().invoke(
        cli,
        [
            *base_args(tmp_path),
            "timer",
            "cancel",
            "--expect-timer-id",
            timer_id,
            "--yes",
        ],
    )

    assert result.exit_code == 4, result.output
    assert "changed before it could be adopted" in result.stderr
    assert stop_calls == []


def test_timer_stop_confirms_and_pins_before_stop_or_record_submission(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    events: list[Any] = []

    class Draft:
        draft_id = "draft-1"
        payloads: ClassVar[list[dict[str, Any]]] = [
            {
                "projectId": "p1",
                "task": "Investigation",
                "date": "2026-09-03",
                "hours": 1,
            }
        ]

        def to_dict(self) -> dict[str, Any]:
            return {"draft_id": self.draft_id, "payloads": self.payloads, "status": "pending"}

    class OrderedManager:
        def __init__(self, _config: Any, _client: Any, _store: Any) -> None:
            events.append("manager")

        def status(self) -> dict[str, Any]:
            events.append("status")
            return {
                "timerId": "timer-operation-0001",
                "startTime": "2026-09-03T01:00:00.000Z",
                "elapsed_seconds": 3600,
                "projectId": None,
                "task": None,
            }

        def capture_stop(
            self,
            *,
            expected_timer_id: str | None,
            expected_start_time: str | None,
        ) -> Draft:
            events.append(("stop", expected_timer_id, expected_start_time))
            return Draft()

        def prepare_timer_draft(self, draft: Draft, **values: Any) -> Draft:
            events.append(("prepare", values["project_id"], values["task"]))
            return draft

        def submit_draft(self, draft: Draft) -> Draft:
            events.append("submit")
            return draft

    monkeypatch.setattr(cli_module, "TimerManager", OrderedManager)
    runner = CliRunner()

    missing_yes = runner.invoke(
        cli,
        [
            *base_args(tmp_path),
            "timer",
            "stop",
            "--project",
            "Alpha",
            "--task",
            "Investigation",
        ],
    )
    assert missing_yes.exit_code == 2
    assert "--yes" in missing_yes.stderr
    assert events == []

    malformed_duration = runner.invoke(
        cli,
        [
            *base_args(tmp_path),
            "timer",
            "stop",
            "--project",
            "Alpha",
            "--task",
            "Investigation",
            "--break",
            "not-a-duration",
            "--yes",
        ],
    )
    assert malformed_duration.exit_code == 2
    assert events == []

    invalid_task = runner.invoke(
        cli,
        [
            *base_args(tmp_path),
            "timer",
            "stop",
            "--project",
            "Alpha",
            "--task",
            "   ",
            "--yes",
        ],
    )
    assert invalid_task.exit_code == 2
    assert events == []

    conflicting_adjustments = runner.invoke(
        cli,
        [
            *base_args(tmp_path),
            "timer",
            "stop",
            "--project",
            "Alpha",
            "--task",
            "Investigation",
            "--break",
            "0m",
            "--duration",
            "1h",
            "--yes",
        ],
    )
    assert conflicting_adjustments.exit_code == 2
    assert events == []

    unresolved = runner.invoke(
        cli,
        [
            *base_args(tmp_path),
            "timer",
            "stop",
            "--project",
            "missing-project",
            "--task",
            "Investigation",
            "--yes",
        ],
    )
    assert unresolved.exit_code != 0
    assert events == []

    monkeypatch.setattr(cli_module, "_terminal_is_interactive", lambda: True)
    declined = runner.invoke(
        cli,
        [
            *base_args(tmp_path, "human"),
            "timer",
            "stop",
            "--project",
            "Alpha",
            "--task",
            "Investigation",
        ],
        input="n\n",
    )
    assert declined.exit_code == 0, declined.output
    assert events == ["manager", "status"]
    assert "Timer stop preview" in declined.stderr

    events.clear()
    stopped_only = runner.invoke(
        cli,
        [
            *base_args(tmp_path, "human"),
            "timer",
            "stop",
            "--project",
            "Alpha",
            "--task",
            "Investigation",
        ],
        input="y\nn\n",
    )
    assert stopped_only.exit_code == 0, stopped_only.output
    assert events == [
        "manager",
        "status",
        ("stop", "timer-operation-0001", "2026-09-03T01:00:00.000Z"),
        ("prepare", "p1", "Investigation"),
    ]
    assert "Stopped timer record preview" in stopped_only.stderr


def test_draft_finalize_and_discard_validate_owner_before_local_mutation_or_lookup(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    store = StateStore(tmp_path / "state")
    draft = store.create_draft(
        resolved_cli_config(),
        [],
        owner_id="different-user",
        timer={
            "started_at": "2026-09-03T01:00:00+00:00",
            "stopped_at": "2026-09-03T02:00:00+00:00",
            "pauses": [],
        },
    )

    def forbidden_project_lookup(_self: FakeClient) -> list[dict[str, Any]]:
        raise AssertionError("project lookup happened before draft identity validation")

    monkeypatch.setattr(FakeClient, "list_projects", forbidden_project_lookup)
    runner = CliRunner()
    finalized = runner.invoke(
        cli,
        [
            *base_args(tmp_path),
            "draft",
            "finalize",
            draft.draft_id,
            "--project",
            "Alpha",
            "--task",
            "Work",
        ],
    )
    assert finalized.exit_code == 4, finalized.output

    discarded = runner.invoke(
        cli,
        [*base_args(tmp_path), "draft", "discard", draft.draft_id, "--yes"],
    )
    assert discarded.exit_code == 4, discarded.output
    saved = store.load_draft(draft.draft_id)
    assert saved.status == "pending"
    assert saved.note is None


def test_record_delete_passes_fresh_etag_and_writes_receipt_first(tmp_path: Path) -> None:
    result = CliRunner().invoke(
        cli,
        [
            *base_args(tmp_path),
            "record",
            "delete",
            "r1",
            "--expect-project-id",
            "p1",
            "--expect-task",
            "Build",
            "--if-match",
            '"titra-date-revision-0"',
            "--yes",
        ],
    )
    assert result.exit_code == 0, result.output
    assert FakeClient.instances[-1].deleted == [("r1", '"titra-date-revision-0"')]
    receipts = list((tmp_path / "state" / "deletion-receipts").glob("*.json"))
    assert len(receipts) == 1
    assert json.loads(receipts[0].read_text())["record"]["_id"] == "r1"
    assert "top-secret-token" not in receipts[0].read_text()


def test_record_delete_refuses_old_server_without_etag(tmp_path: Path) -> None:
    FakeClient.etag = None
    result = CliRunner().invoke(
        cli,
        [
            *base_args(tmp_path),
            "record",
            "delete",
            "r1",
            "--expect-project-id",
            "p1",
            "--expect-task",
            "Build",
            "--yes",
        ],
    )
    assert result.exit_code == 2
    assert "ETag" in result.stderr
    assert not (tmp_path / "state" / "deletion-receipts").exists()


@pytest.mark.parametrize(
    "pin_args",
    [
        ["--expect-project-id", "different", "--expect-task", "Build"],
        ["--expect-project-id", "p1", "--expect-task", "Different"],
        [
            "--expect-project-id",
            "p1",
            "--expect-task",
            "Build",
            "--if-match",
            '"titra-date-revision-99"',
        ],
    ],
)
def test_record_delete_identity_pins_fail_before_receipt_or_delete(
    tmp_path: Path, pin_args: list[str]
) -> None:
    result = CliRunner().invoke(
        cli,
        [*base_args(tmp_path), "record", "delete", "r1", *pin_args, "--yes"],
    )
    assert result.exit_code == 4, result.output
    assert FakeClient.instances[-1].deleted == []
    assert not (tmp_path / "state" / "deletion-receipts").exists()


def test_project_task_and_suggestion_delete_check_fresh_identity_pins(
    tmp_path: Path,
) -> None:
    FakeClient.v2_supported = True
    runner = CliRunner()
    project = runner.invoke(
        cli,
        [
            *base_args(tmp_path),
            "project",
            "delete",
            "p1",
            "--expect-name",
            "Alpha",
            "--if-match",
            '"titra-project-revision-99"',
            "--yes",
        ],
    )
    assert project.exit_code == 4, project.output
    assert FakeClient.instances[-1].deleted_projects == []

    task = runner.invoke(
        cli,
        [
            *base_args(tmp_path),
            "task",
            "delete",
            "t1",
            "--expect-project-id",
            "p1",
            "--expect-name",
            "Wrong",
            "--yes",
        ],
    )
    assert task.exit_code == 4, task.output
    assert FakeClient.instances[-1].deleted_tasks == []

    suggestion = runner.invoke(
        cli,
        [
            *base_args(tmp_path),
            "suggestion",
            "delete",
            "s1",
            "--expect-name",
            "Suggested task",
            "--if-match",
            '"titra-task-suggestion-revision-99"',
            "--yes",
        ],
    )
    assert suggestion.exit_code == 4, suggestion.output
    assert FakeClient.instances[-1].deleted_suggestions == []


def test_time_alias_is_functional(tmp_path: Path) -> None:
    result = CliRunner().invoke(
        cli,
        [
            *base_args(tmp_path),
            "time",
            "list",
            "--today",
        ],
    )
    assert result.exit_code == 0, result.output
    assert json.loads(result.stdout)["data"][0]["id"] == "r1"


def test_v6_capabilities_show_and_require_check(tmp_path: Path) -> None:
    FakeClient.v2_supported = True
    runner = CliRunner()
    shown = runner.invoke(
        cli,
        [*base_args(tmp_path), "capabilities", "show", "--version", "2"],
    )
    assert shown.exit_code == 0, shown.output
    shown_data = json.loads(shown.stdout)["data"]
    assert shown_data["source"] == "/capabilities/v2/"
    assert shown_data["document"]["apiVersion"] == 2

    checked = runner.invoke(
        cli,
        [*base_args(tmp_path), "capabilities", "check", "--require-v6"],
    )
    assert checked.exit_code == 0, checked.output
    checked_data = json.loads(checked.stdout)["data"]
    assert checked_data == {
        "ok": True,
        "requirement": "v6",
        "source": "/capabilities/v2/",
        "apiVersion": 2,
        "capabilitiesVersion": 2,
        "missing": [],
    }


def test_v7_capability_and_security_commands_are_scriptable(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    FakeClient.v2_supported = True
    monkeypatch.setattr(
        FakeClient,
        "capabilities_v2",
        lambda self, required=False: json.loads(json.dumps(EXPECTED_V7_CAPABILITIES)),
    )
    runner = CliRunner()
    checked = runner.invoke(
        cli,
        [*base_args(tmp_path), "capabilities", "check", "--require-v7"],
    )
    assert checked.exit_code == 0, checked.output
    data = json.loads(checked.stdout)["data"]
    assert data["requirement"] == "v7"
    assert data["capabilitiesVersion"] == 3
    assert data["security"]["contract"]["releaseProfile"] == "security-v7"
    assert data["security"]["deployment"]["oauthEncryptionConfigured"] is False
    assert data["security"]["http"]["ok"] is True

    security = runner.invoke(cli, [*base_args(tmp_path), "security", "check"])
    assert security.exit_code == 0, security.output
    assert json.loads(security.stdout)["data"]["profile"] == "v7-http-security/v1"

    hsts = runner.invoke(cli, [*base_args(tmp_path), "security", "check", "--require-hsts"])
    assert hsts.exit_code == 2
    assert "strict-transport-security" in hsts.stderr


def test_capability_check_rejects_both_release_requirements(tmp_path: Path) -> None:
    result = CliRunner().invoke(
        cli,
        [
            *base_args(tmp_path),
            "capabilities",
            "check",
            "--require-v6",
            "--require-v7",
        ],
    )
    assert result.exit_code == 2
    assert "only one" in result.stderr


def test_v6_capabilities_check_fails_closed_on_incomplete_document(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    FakeClient.v2_supported = True
    incomplete = complete_v2_capabilities()
    incomplete["features"]["timers"]["atomicTransitions"] = 1
    monkeypatch.setattr(FakeClient, "capabilities_v2", lambda self, required=False: incomplete)
    result = CliRunner().invoke(
        cli,
        [*base_args(tmp_path), "capabilities", "check", "--require-v6"],
    )
    assert result.exit_code == 2
    assert "features.timers.atomicTransitions>=2" in result.stderr


def test_v6_capabilities_check_requires_consumed_timer_start_replay_semantics(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    FakeClient.v2_supported = True
    incomplete = complete_v2_capabilities()
    incomplete["contracts"]["timerStartReplay"]["consumedReplay"] = "allow"
    monkeypatch.setattr(FakeClient, "capabilities_v2", lambda self, required=False: incomplete)
    result = CliRunner().invoke(
        cli,
        [*base_args(tmp_path), "capabilities", "check", "--require-v6"],
    )
    assert result.exit_code == 2
    assert "contracts.timerStartReplay exact v1 contract" in result.stderr


def test_v6_capabilities_check_requires_bounded_timer_start_history(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    FakeClient.v2_supported = True
    incomplete = complete_v2_capabilities()
    incomplete["limits"]["timerStartRetainedOperations"] = 4097
    monkeypatch.setattr(FakeClient, "capabilities_v2", lambda self, required=False: incomplete)
    result = CliRunner().invoke(
        cli,
        [*base_args(tmp_path), "capabilities", "check", "--require-v6"],
    )
    assert result.exit_code == 2
    assert "limits.timerStartRetainedOperations=4096" in result.stderr


def test_v6_capabilities_check_requires_fresh_webhook_retry_semantics(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    FakeClient.v2_supported = True
    incomplete = complete_v2_capabilities()
    incomplete["contracts"]["webhookRetry"]["actionTimestamp"] = "fresh"
    monkeypatch.setattr(FakeClient, "capabilities_v2", lambda self, required=False: incomplete)
    result = CliRunner().invoke(
        cli,
        [*base_args(tmp_path), "capabilities", "check", "--require-v6"],
    )
    assert result.exit_code == 2
    assert "contracts.webhookRetry exact v1 contract" in result.stderr


def test_v6_project_and_record_show_include_revision_snapshots(tmp_path: Path) -> None:
    FakeClient.v2_supported = True
    runner = CliRunner()
    project = runner.invoke(cli, [*base_args(tmp_path), "project", "show", "Alpha"])
    assert project.exit_code == 0, project.output
    assert json.loads(project.stdout)["data"] == {
        "_id": "p1",
        "name": "Alpha",
        "role": "owner",
        "archived": False,
        "etag": '"titra-project-revision-4"',
    }

    record = runner.invoke(cli, [*base_args(tmp_path), "record", "show", "r1"])
    assert record.exit_code == 0, record.output
    record_data = json.loads(record.stdout)["data"]
    assert record_data["_id"] == "r1"
    assert record_data["etag"] == '"titra-date-revision-0"'


def test_project_users_preserve_private_names_and_task_stats_structure(tmp_path: Path) -> None:
    FakeClient.v2_supported = True
    runner = CliRunner()
    users = runner.invoke(cli, [*base_args(tmp_path), "project", "users", "p1"])
    assert users.exit_code == 0, users.output
    user_rows = json.loads(users.stdout)["data"]
    assert user_rows == [
        {"id": "u1", "name": "Alice", "name_private": False},
        {"id": "u2", "name": "", "name_private": True},
    ]

    stats = runner.invoke(
        cli,
        [*base_args(tmp_path), "task", "stats", "Alpha", "--task", "Build"],
    )
    assert stats.exit_code == 0, stats.output
    stats_data = json.loads(stats.stdout)["data"]
    assert stats_data["projectId"] == "p1"
    assert stats_data["totalEstimatedHours"] == 2.0
    assert stats_data["totalActualHours"] == 2.5
    assert stats_data["tasks"][0]["taskName"] == "Build"


def test_interactive_project_create_prints_exact_preview_before_confirmation(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr("titra_cli.cli._terminal_is_interactive", lambda: True)
    result = CliRunner().invoke(
        cli,
        [*base_args(tmp_path, "human"), "project", "create", "Previewed", "--rate", "75"],
        input="n\n",
    )
    assert result.exit_code == 0, result.output
    assert "Project create preview" in result.stderr
    assert '"name": "Previewed"' in result.stderr
    assert '"rate": 75.0' in result.stderr
    assert FakeClient.instances == []


def test_nested_interactive_menu_recovers_from_one_action_error(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr("titra_cli.cli._terminal_is_interactive", lambda: True)
    result = CliRunner().invoke(
        cli,
        [*base_args(tmp_path, "human"), "interactive"],
        input="3\n2\nmissing\n0\n0\n",
    )
    assert result.exit_code == 0, result.output
    assert "Time record not found: missing" in result.stderr
    assert result.stderr.count("Time records") >= 2
    assert result.stderr.count("Titra CLI") >= 2


def test_interactive_time_record_menu_exposes_task_edit_reconciliation(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr("titra_cli.cli._terminal_is_interactive", lambda: True)
    result = CliRunner().invoke(
        cli,
        [*base_args(tmp_path, "human"), "interactive"],
        input="3\n0\n0\n",
    )
    assert result.exit_code == 0, result.output
    assert "Reconcile an uncertain Task edit" in result.stderr


def test_interactive_entry_primes_prompt_enabled_config_resolution(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    calls: list[bool] = []
    original = cli_module.AppContext.resolve

    def traced(app: Any, *, interactive: bool = False) -> ResolvedConfig:
        calls.append(interactive)
        return original(app, interactive=interactive)

    monkeypatch.setattr(cli_module.AppContext, "resolve", traced)
    monkeypatch.setattr(cli_module, "_terminal_is_interactive", lambda: True)
    result = CliRunner().invoke(
        cli,
        [*base_args(tmp_path, "human"), "interactive"],
        input="0\n",
    )
    assert result.exit_code == 0, result.output
    assert calls and calls[0] is True
    assert FakeClient.instances == []


def test_interactive_receipt_menu_exposes_both_replay_verification_workflows(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(cli_module, "_terminal_is_interactive", lambda: True)
    result = CliRunner().invoke(
        cli,
        [*base_args(tmp_path, "human"), "interactive"],
        input="8\n0\n0\n",
    )
    assert result.exit_code == 0, result.output
    assert "Verify submitted draft idempotency replay" in result.stderr
    assert "Verify completed creation idempotency replay" in result.stderr


def test_interactive_connection_menu_exposes_webhook_receipt_workflow(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(cli_module, "_terminal_is_interactive", lambda: True)
    result = CliRunner().invoke(
        cli,
        [*base_args(tmp_path, "human"), "interactive"],
        input="9\n0\n0\n",
    )
    assert result.exit_code == 0, result.output
    for label in (
        "List webhook receipts",
        "Show webhook receipt",
        "Retry journaled webhook",
    ):
        assert label in result.stderr


def test_interactive_connection_menu_exposes_v7_security_header_checks(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: list[tuple[str, Any]] = []

    def capture_menu(_app: Any, title: str, actions: list[tuple[str, Any]]) -> None:
        assert title == "Connection and API"
        captured.extend(actions)

    monkeypatch.setattr(cli_module, "_interactive_menu", capture_menu)
    cli_module._interactive_connection_menu(object(), object())  # type: ignore[arg-type]
    labels = [label for label, _action in captured]
    assert "Check v7 security headers" in labels
    assert "Check v7 security headers + HSTS" in labels


def test_interactive_summary_splits_comma_separated_group_fields(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, Any] = {}

    class Context:
        def invoke(self, command: Any, **kwargs: Any) -> None:
            captured["command"] = command
            captured["kwargs"] = kwargs

    values = iter([None, "project, task , user"])
    monkeypatch.setattr(cli_module, "_prompt_date_options", lambda: {"today": True})
    monkeypatch.setattr(cli_module, "_prompt_optional", lambda _label: next(values))
    cli_module._interactive_report(Context(), cli_module.report_summary)  # type: ignore[arg-type]
    assert captured["kwargs"]["group_by"] == ("project", "task", "user")


def test_interactive_create_exposes_record_and_task_custom_fields(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[tuple[Any, dict[str, Any]]] = []

    class Context:
        def invoke(self, command: Any, **kwargs: Any) -> None:
            calls.append((command, kwargs))

    record_prompts = iter(["Alpha", "Record task", "1h"])
    record_optional = iter(["2026-09-03", "09:00", '{"ticket":"R-1"}'])
    monkeypatch.setattr(click, "prompt", lambda *_args, **_kwargs: next(record_prompts))
    monkeypatch.setattr(cli_module, "_prompt_optional", lambda _label: next(record_optional))
    monkeypatch.setattr(cli_module, "_prompt_optional_number", lambda _label: 123.456)
    cli_module._interactive_record_create(Context())  # type: ignore[arg-type]
    assert calls[-1][1]["task_rate"] == 123.456
    assert calls[-1][1]["custom_fields"] == '{"ticket":"R-1"}'

    task_prompts = iter(["Alpha", "Milestone", "2026-09-03", "2026-09-04"])
    task_optional = iter(["dep-1, dep-2", '{"stream":"API"}'])
    monkeypatch.setattr(click, "prompt", lambda *_args, **_kwargs: next(task_prompts))
    monkeypatch.setattr(cli_module, "_prompt_optional", lambda _label: next(task_optional))
    monkeypatch.setattr(cli_module, "_prompt_optional_number", lambda _label: 8.25)
    cli_module._interactive_task_create(Context())  # type: ignore[arg-type]
    assert calls[-1][1]["dependencies"] == ("dep-1", "dep-2")
    assert calls[-1][1]["custom_fields"] == '{"stream":"API"}'


def test_webhook_prepare_and_send_never_expose_secret_or_signature(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    payload = tmp_path / "event.json"
    payload.write_text('{"email":"synthetic@example.invalid","state":"active"}', encoding="utf-8")
    secret = "A" * 43
    delivered: list[Any] = []

    def fake_delivery(server: str, signed: Any, **options: Any) -> dict[str, Any]:
        delivered.append((server, signed, options))
        assert "Authorization" not in signed.headers
        return {
            "accepted": True,
            "status": 202,
            "request_id": signed.request_id,
            "event_id": signed.event_id,
            "body_sha256": hashlib.sha256(signed.body).hexdigest(),
        }

    monkeypatch.setattr("titra_cli.cli.deliver_webhook", fake_delivery)
    runner = CliRunner()
    common = [
        *base_args(tmp_path),
        "--output",
        "json",
        "webhook",
    ]
    options = [
        "--endpoint-id",
        "a" * 32,
        "--event-id",
        "event-1",
        "--file",
        str(payload),
        "--secret-env",
        "TEST_WEBHOOK_SECRET",
        "--timestamp",
        "1770000000",
        "--request-id",
        "titra-cli-request-1",
    ]
    prepared = runner.invoke(
        cli,
        [*common, "prepare", *options],
        env={"TEST_WEBHOOK_SECRET": secret},
    )
    assert prepared.exit_code == 0, prepared.output
    assert secret not in prepared.output
    assert "v1=" not in prepared.output
    assert json.loads(prepared.stdout)["data"]["headers"]["X-Titra-Webhook-Signature"] == (
        "<redacted>"
    )

    sent = runner.invoke(
        cli,
        [*common, "send", *options, "--yes"],
        env={"TEST_WEBHOOK_SECRET": secret},
    )
    assert sent.exit_code == 0, sent.output
    assert secret not in sent.output
    assert len(delivered) == 1
    assert delivered[0][0] == "https://titra.example"
    receipt_id = json.loads(sent.stdout)["data"]["receipt_id"]
    receipt_path = tmp_path / "state" / "webhook-delivery-receipts" / f"{receipt_id}.json"
    persisted = json.loads(receipt_path.read_text(encoding="utf-8"))
    raw_receipt = receipt_path.read_text(encoding="utf-8")
    assert persisted["owner_id"] == "u1"
    assert persisted["status"] == "accepted"
    assert secret not in raw_receipt
    assert "top-secret-token" not in raw_receipt
    assert "signature" not in raw_receipt.casefold()

    listed = runner.invoke(cli, [*base_args(tmp_path), "webhook", "list"])
    assert listed.exit_code == 0, listed.output
    listed_data = json.loads(listed.stdout)["data"]
    assert listed_data[0]["receipt_id"] == receipt_id
    assert listed_data[0]["body_sha256"] == hashlib.sha256(delivered[0][1].body).hexdigest()
    assert "body_base64" not in listed.output
    assert secret not in listed.output

    shown = runner.invoke(cli, [*base_args(tmp_path), "webhook", "show", receipt_id])
    assert shown.exit_code == 0, shown.output
    shown_data = json.loads(shown.stdout)["data"]
    assert shown_data["receipt_id"] == receipt_id
    assert shown_data["attempts"][0]["request_id"] == "titra-cli-request-1"
    assert "body_base64" not in shown.output
    assert secret not in shown.output


def test_webhook_unknown_outcome_has_durable_guarded_retry(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    payload = tmp_path / "event.json"
    payload.write_text('{"kind":"synthetic"}', encoding="utf-8")
    secret = "A" * 43
    delivered: list[Any] = []

    def fail_then_accept(server: str, signed: Any, **options: Any) -> dict[str, Any]:
        delivered.append((server, signed, options))
        if len(delivered) == 1:
            raise OutcomeUnknownError("synthetic delivery uncertainty")
        return {
            "accepted": True,
            "status": 202,
            "request_id": signed.request_id,
            "event_id": signed.event_id,
            "body_sha256": hashlib.sha256(signed.body).hexdigest(),
        }

    monkeypatch.setattr("titra_cli.cli.deliver_webhook", fail_then_accept)
    runner = CliRunner()
    common = [*base_args(tmp_path), "webhook"]
    send = runner.invoke(
        cli,
        [
            *common,
            "send",
            "--endpoint-id",
            "a" * 32,
            "--event-id",
            "stable-provider-event",
            "--file",
            str(payload),
            "--secret-env",
            "TEST_WEBHOOK_SECRET",
            "--yes",
        ],
        env={"TEST_WEBHOOK_SECRET": secret},
    )
    assert send.exit_code == 6, send.output
    [receipt_path] = list((tmp_path / "state" / "webhook-delivery-receipts").glob("*.json"))
    receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
    receipt_id = receipt["receipt_id"]
    assert receipt_id in send.output
    assert receipt["status"] == "outcome_unknown"

    retry = runner.invoke(
        cli,
        [
            *common,
            "retry",
            receipt_id,
            "--secret-env",
            "TEST_WEBHOOK_SECRET",
            "--yes",
        ],
        env={"TEST_WEBHOOK_SECRET": secret},
    )
    assert retry.exit_code == 0, retry.output
    assert len(delivered) == 2
    assert delivered[1][1].event_id == delivered[0][1].event_id
    assert delivered[1][1].body == delivered[0][1].body
    assert delivered[1][1].request_id != delivered[0][1].request_id
    final = json.loads(receipt_path.read_text(encoding="utf-8"))
    assert final["status"] == "accepted"
    assert [attempt["status"] for attempt in final["attempts"]] == [
        "outcome_unknown",
        "accepted",
    ]


def test_webhook_refuses_api_key_as_hmac_secret(tmp_path: Path) -> None:
    payload = tmp_path / "event.json"
    payload.write_text("{}", encoding="utf-8")
    secret = "A" * 43
    arguments = base_args(tmp_path)
    arguments[arguments.index("top-secret-token")] = secret
    result = CliRunner().invoke(
        cli,
        [
            *arguments,
            "webhook",
            "prepare",
            "--endpoint-id",
            "a" * 32,
            "--file",
            str(payload),
            "--secret-env",
            "TEST_WEBHOOK_SECRET",
        ],
        env={"TEST_WEBHOOK_SECRET": secret},
    )
    assert result.exit_code == 2
    assert "must not be the Titra API key" in result.stderr
    assert secret not in result.output


def test_webhook_prepare_needs_only_server_and_separate_hmac_secret(tmp_path: Path) -> None:
    payload = tmp_path / "event.json"
    payload.write_text("{}", encoding="utf-8")
    secret = "A" * 43
    result = CliRunner().invoke(
        cli,
        [
            "--server",
            "https://titra.example",
            "--output",
            "json",
            "webhook",
            "prepare",
            "--endpoint-id",
            "a" * 32,
            "--file",
            str(payload),
            "--secret-env",
            "TEST_WEBHOOK_SECRET",
        ],
        env={"TEST_WEBHOOK_SECRET": secret},
    )
    assert result.exit_code == 0, result.output
    assert secret not in result.output
    assert json.loads(result.stdout)["data"]["server"] == "https://titra.example"


@pytest.mark.parametrize("ambient_api_key", ["", "ambient-production-api-token"])
def test_webhook_explicit_server_stays_server_only_with_or_without_ambient_api_key(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    ambient_api_key: str,
) -> None:
    payload = tmp_path / "event.json"
    payload.write_text("{}", encoding="utf-8")
    deliveries: list[Any] = []

    class ForbiddenApiClient:
        def __init__(self, _config: Any) -> None:
            raise AssertionError("explicit-server webhook mode must not authenticate an API token")

    def accepted(server: str, signed: Any, **options: Any) -> dict[str, Any]:
        deliveries.append((server, signed, options))
        assert "Authorization" not in signed.headers
        return {
            "accepted": True,
            "status": 202,
            "request_id": signed.request_id,
            "event_id": signed.event_id,
            "body_sha256": hashlib.sha256(signed.body).hexdigest(),
        }

    monkeypatch.setattr(cli_module, "TitraClient", ForbiddenApiClient)
    monkeypatch.setattr(cli_module, "deliver_webhook", accepted)
    result = CliRunner().invoke(
        cli,
        [
            "--server",
            "https://explicit-webhook.example",
            "--state-dir",
            str(tmp_path / "state"),
            "--output",
            "json",
            "webhook",
            "send",
            "--endpoint-id",
            "a" * 32,
            "--file",
            str(payload),
            "--secret-env",
            "TEST_WEBHOOK_SECRET",
            "--yes",
        ],
        env={
            "TITRA_API_KEY": ambient_api_key,
            "TITRA_API_TOKEN": "",
            "TEST_WEBHOOK_SECRET": "A" * 43,
        },
    )

    assert result.exit_code == 0, result.output
    assert len(deliveries) == 1
    assert deliveries[0][0] == "https://explicit-webhook.example"
    [receipt_path] = list((tmp_path / "state" / "webhook-delivery-receipts").glob("*.json"))
    receipt_text = receipt_path.read_text(encoding="utf-8")
    assert json.loads(receipt_text)["owner_id"] is None
    if ambient_api_key:
        assert ambient_api_key not in result.output
        assert ambient_api_key not in receipt_text


def test_webhook_explicit_server_only_receipt_can_retry_without_api_token(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    payload = tmp_path / "event.json"
    payload.write_text("{}", encoding="utf-8")
    deliveries: list[Any] = []

    class ForbiddenApiClient:
        def __init__(self, _config: Any) -> None:
            raise AssertionError("server-only webhook retry must not construct an API client")

    def fail_then_accept(server: str, signed: Any, **options: Any) -> dict[str, Any]:
        deliveries.append((server, signed, options))
        assert "Authorization" not in signed.headers
        if len(deliveries) == 1:
            raise OutcomeUnknownError("synthetic delivery uncertainty")
        return {
            "accepted": True,
            "status": 202,
            "request_id": signed.request_id,
            "event_id": signed.event_id,
            "body_sha256": hashlib.sha256(signed.body).hexdigest(),
        }

    monkeypatch.setattr(cli_module, "TitraClient", ForbiddenApiClient)
    monkeypatch.setattr(cli_module, "deliver_webhook", fail_then_accept)
    runner = CliRunner()
    common = [
        "--server",
        "https://explicit-webhook.example",
        "--state-dir",
        str(tmp_path / "state"),
        "--output",
        "json",
        "webhook",
    ]
    environment = {
        "TITRA_API_KEY": "",
        "TITRA_API_TOKEN": "",
        "TEST_WEBHOOK_SECRET": "A" * 43,
    }
    sent = runner.invoke(
        cli,
        [
            *common,
            "send",
            "--endpoint-id",
            "a" * 32,
            "--file",
            str(payload),
            "--secret-env",
            "TEST_WEBHOOK_SECRET",
            "--yes",
        ],
        env=environment,
    )
    assert sent.exit_code == 6, sent.output
    [receipt_path] = list((tmp_path / "state" / "webhook-delivery-receipts").glob("*.json"))
    receipt_id = json.loads(receipt_path.read_text(encoding="utf-8"))["receipt_id"]

    retried = runner.invoke(
        cli,
        [
            *common,
            "retry",
            receipt_id,
            "--secret-env",
            "TEST_WEBHOOK_SECRET",
            "--yes",
        ],
        env=environment,
    )

    assert retried.exit_code == 0, retried.output
    assert len(deliveries) == 2
    assert deliveries[1][1].event_id == deliveries[0][1].event_id
    assert deliveries[1][1].body == deliveries[0][1].body
    assert json.loads(receipt_path.read_text(encoding="utf-8"))["owner_id"] is None


def test_webhook_owner_lookup_redacts_reflected_api_key(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def reflected(_self: FakeClient) -> dict[str, Any]:
        raise cli_module.RemoteApiError("receiver reflected top-secret-token")

    monkeypatch.setattr(FakeClient, "current_user", reflected)
    result = CliRunner().invoke(cli, [*base_args(tmp_path), "webhook", "list"])

    assert result.exit_code == 5, result.output
    assert "top-secret-token" not in result.output
    assert "<redacted>" in result.stderr


def test_webhook_explicit_profile_is_not_replaced_by_inherited_connection(
    tmp_path: Path,
) -> None:
    payload = tmp_path / "event.json"
    payload.write_text("{}", encoding="utf-8")
    credentials = tmp_path / "credentials.toml"
    credentials.write_text(
        'default_profile = "selected"\n'
        "[profiles.selected]\n"
        'server = "https://selected.example"\n'
        f'api_key = "{"B" * 43}"\n',
        encoding="utf-8",
    )
    credentials.chmod(0o600)
    result = CliRunner().invoke(
        cli,
        [
            "--credentials",
            str(credentials),
            "--profile",
            "selected",
            "--output",
            "json",
            "webhook",
            "prepare",
            "--endpoint-id",
            "a" * 32,
            "--file",
            str(payload),
            "--secret-env",
            "TEST_WEBHOOK_SECRET",
        ],
        env={
            "TITRA_SERVER": "https://inherited.example",
            "TITRA_API_KEY": "C" * 43,
            "TEST_WEBHOOK_SECRET": "A" * 43,
        },
    )
    assert result.exit_code == 0, result.output
    assert json.loads(result.stdout)["data"]["server"] == "https://selected.example"
    assert "inherited.example" not in result.output


def test_webhook_rejects_reuse_of_environment_api_key(tmp_path: Path) -> None:
    payload = tmp_path / "event.json"
    payload.write_text("{}", encoding="utf-8")
    shared_secret = "A" * 43
    result = CliRunner().invoke(
        cli,
        [
            "--output",
            "json",
            "webhook",
            "prepare",
            "--endpoint-id",
            "a" * 32,
            "--file",
            str(payload),
            "--secret-env",
            "TEST_WEBHOOK_SECRET",
        ],
        env={
            "TITRA_SERVER": "https://titra.example",
            "TITRA_API_KEY": shared_secret,
            "TEST_WEBHOOK_SECRET": shared_secret,
        },
    )
    assert result.exit_code == 2
    assert "must not be the Titra API key" in result.stderr
    assert shared_secret not in result.output


def test_webhook_payload_read_is_bounded_to_server_limit(tmp_path: Path) -> None:
    payload = tmp_path / "too-large.json"
    payload.write_bytes(b"{" + b" " * (64 * 1024) + b"}")
    result = CliRunner().invoke(
        cli,
        [
            "--server",
            "https://titra.example",
            "webhook",
            "prepare",
            "--endpoint-id",
            "a" * 32,
            "--file",
            str(payload),
            "--secret-env",
            "TEST_WEBHOOK_SECRET",
        ],
        env={"TEST_WEBHOOK_SECRET": "A" * 43},
    )
    assert result.exit_code == 2
    assert "exceeds the 65536-byte" in result.stderr
