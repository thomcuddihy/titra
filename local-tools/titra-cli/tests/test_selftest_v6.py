from __future__ import annotations

import json
import os
import stat
from copy import deepcopy
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest
from click.testing import CliRunner

from titra_cli import selftest
from titra_cli.cli import cli


def test_exact_v2_gate_accepts_only_deployment_boolean_variation() -> None:
    document = deepcopy(selftest._EXPECTED_V2_CAPABILITIES)
    document["deployment"]["projectFenceRecoveryEnabled"] = True
    assert selftest.validate_v2_capabilities(document) is document

    for mutation in (
        lambda value: value.update({"futureField": True}),
        lambda value: value["features"]["projects"].update({"futureFeature": 1}),
        lambda value: value["limits"].pop("taskCodePoints"),
        lambda value: value["deployment"].update({"projectFenceRecoveryEnabled": 1}),
    ):
        invalid = deepcopy(document)
        mutation(invalid)
        with pytest.raises(selftest.SelfTestError, match="capabilities/v2"):
            selftest.validate_v2_capabilities(invalid)


def test_exact_v7_gate_accepts_only_declared_nested_deployment_booleans() -> None:
    document = deepcopy(selftest._EXPECTED_V7_CAPABILITIES)
    document["deployment"]["security"]["hstsEnabled"] = True
    document["deployment"]["security"]["oauthEncryptionConfigured"] = True
    document["deployment"]["security"]["publicProjectsDisabled"] = True
    assert selftest.validate_v2_capabilities(document, release_profile="v7") is document

    invalid = deepcopy(document)
    invalid["contracts"]["security"]["apiTokens"]["storage"] = "plaintext"
    with pytest.raises(selftest.SelfTestError, match="exactly match v7"):
        selftest.validate_v2_capabilities(invalid, release_profile="v7")

    invalid = deepcopy(document)
    invalid["deployment"]["security"]["hstsEnabled"] = 1
    with pytest.raises(selftest.SelfTestError, match="deployment contract"):
        selftest.validate_v2_capabilities(invalid, release_profile="v7")


def test_profile_resolution_is_atomic_and_scrubs_environment(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    observed: dict[str, Any] = {}

    def fake_resolve_config(**kwargs: Any) -> Any:
        observed.update(kwargs)
        return SimpleNamespace(
            server="https://v6.example.test/",
            api_key="profile-secret",
            username="Token Owner",
            profile="testing",
        )

    monkeypatch.setattr(selftest, "resolve_config", fake_resolve_config)
    connection = selftest.resolve_live_connection(
        live_url="https://v6.example.test",
        token_env="PRIVATE_TOKEN",
        credentials=str(tmp_path / "credentials.toml"),
        profile="testing",
        expected_username=None,
        insecure=False,
        timeout=5,
        environment={
            "PATH": "safe",
            "PRIVATE_TOKEN": "env-secret",
            "TITRA_API_KEY": "other-secret",
        },
        cwd=tmp_path,
        home=tmp_path,
        allow_prompt=False,
    )
    assert connection == selftest.LiveConnection(
        "https://v6.example.test", "profile-secret", "Token Owner", "testing"
    )
    assert observed["environ"] == {"PATH": "safe"}
    assert observed["interactive"] is False
    assert observed["explicit_file"] == tmp_path / "credentials.toml"


def test_profile_resolution_refuses_cross_server_secret_pairing(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setattr(
        selftest,
        "resolve_config",
        lambda **_kwargs: SimpleNamespace(
            server="https://profile.example.test",
            api_key="secret-not-in-error",
            username=None,
            profile="testing",
        ),
    )
    with pytest.raises(selftest.SelfTestError, match="does not match") as captured:
        selftest.resolve_live_connection(
            live_url="https://other.example.test",
            token_env="TOKEN",
            credentials=str(tmp_path / "credentials.toml"),
            profile="testing",
            expected_username=None,
            insecure=False,
            timeout=5,
            environment={},
            cwd=tmp_path,
            home=tmp_path,
            allow_prompt=False,
        )
    assert "secret-not-in-error" not in str(captured.value)


class FakeV6Invoker:
    def __init__(
        self,
        *,
        active_timer: bool = False,
        project_recovery_enabled: bool = False,
        release_profile: str = "v6",
    ) -> None:
        self.calls: list[tuple[str, ...]] = []
        self.expected_user_pins: list[str] = []
        self.bound_expected_user_id: str | None = None
        self.project: dict[str, Any] | None = None
        self.task: dict[str, Any] | None = None
        self.records: dict[str, dict[str, Any]] = {}
        self.suggestions: dict[str, dict[str, Any]] = {}
        self.next_record = 1
        self.user_id = "test-user"
        self.timer: dict[str, Any] | None = (
            {
                "running": True,
                "task": "existing real timer",
                "projectId": "existing-project",
                "project_id": "existing-project",
                "timerId": "existing-timer-operation",
            }
            if active_timer
            else None
        )
        self.project_recovery_enabled = project_recovery_enabled
        self.release_profile = release_profile

    def bind_expected_user_id(self, user_id: str) -> None:
        if self.bound_expected_user_id not in {None, user_id}:
            raise AssertionError("attempted to rotate the fake invoker identity pin")
        self.bound_expected_user_id = user_id
        self.expected_user_pins.append(user_id)

    def _normalize_arguments(self, arguments: Any) -> tuple[str, ...]:
        args = tuple(arguments)
        if args[:1] == ("--expect-user-id",):
            assert len(args) >= 3
            self.expected_user_pins.append(args[1])
            return args[2:]
        return args

    def invoke_json(
        self, arguments: Any, *, allowed_codes: frozenset[int] = frozenset({0})
    ) -> tuple[Any, int]:
        args = self._normalize_arguments(arguments)
        self.calls.append(args)
        if args == ("capabilities", "show", "--version", "2"):
            document = deepcopy(
                selftest._EXPECTED_V7_CAPABILITIES
                if self.release_profile == "v7"
                else selftest._EXPECTED_V2_CAPABILITIES
            )
            document["deployment"]["projectFenceRecoveryEnabled"] = self.project_recovery_enabled
            return {
                "source": "/capabilities/v2/",
                "document": document,
            }, 0
        if args == ("capabilities", "check", "--require-v6"):
            return {
                "ok": True,
                "source": "/capabilities/v2/",
                "requirement": "v6",
            }, 0
        if args == ("capabilities", "check", "--require-v7"):
            return {
                "ok": True,
                "source": "/capabilities/v2/",
                "requirement": "v7",
                "security": {"http": {"ok": True}},
            }, 0
        if args == ("auth", "check"):
            return {"ok": True, "user": {"_id": self.user_id, "name": "Test"}}, 0
        if args == ("doctor",):
            return {
                "capabilities": {
                    "projects": True,
                    "identity": True,
                    "record_delete": True,
                    "record_task_edit": True,
                    "idempotent_create": True,
                    "timeentry_pagination": True,
                    "v6_ready": True,
                    "v7_ready": self.release_profile == "v7",
                    "project_lifecycle": True,
                    "project_task_lifecycle": True,
                    "task_stats": True,
                    "record_details_edit": True,
                    "task_suggestions": True,
                    "atomic_timers": True,
                    "project_fence_recovery": False,
                    "api_version": 2,
                    "capabilities_version": 3 if self.release_profile == "v7" else 2,
                    "capability_source": "/capabilities/v2/",
                }
            }, 0
        if args == ("timer", "status"):
            if self.timer is None:
                assert 4 in allowed_codes
                return None, 4
            return dict(self.timer), 0
        if args[:2] == ("timer", "start"):
            assert self.timer is None
            project_id = args[args.index("--project") + 1]
            task = args[args.index("--task") + 1]
            operation_id = args[args.index("--operation-id") + 1]
            self.timer = {
                "running": True,
                "projectId": project_id,
                "project_id": project_id,
                "task": task,
                "timerId": operation_id,
            }
            return dict(self.timer), 0
        if args[:2] == ("timer", "stop"):
            assert self.timer is not None
            assert args[args.index("--expect-timer-id") + 1] == self.timer["timerId"]
            self.timer = None
            return {"status": "stopped"}, 0
        if args[:2] == ("creation", "verify-replay"):
            receipt_id = args[2]
            result_id = args[args.index("--expect-result-id") + 1]
            operation = {
                "a" * 32: "project.create",
                "b" * 32: "project-task.create",
            }.get(receipt_id)
            assert operation is not None
            return {
                "receipt_id": receipt_id,
                "operation": operation,
                "status": "completed",
                "replay_status": "verified",
                "result_id": result_id,
                "idempotency_replayed": True,
                "idempotency_expires_at": "2099-01-01T00:00:00.000Z",
                "receipt": f"/private/creation-receipts/{receipt_id}.json",
            }, 0
        if args[:2] == ("draft", "verify-replay"):
            draft_id = args[2]
            result_ids = [
                args[index + 1] for index, value in enumerate(args) if value == "--expect-result-id"
            ]
            return {
                "draft_id": draft_id,
                "status": "submitted",
                "replay_status": "verified",
                "result_ids": result_ids,
                "replays": [
                    {
                        "operation": "timeentry.create",
                        "result_id": result_id,
                        "idempotency_replayed": True,
                        "idempotency_expires_at": "2099-01-01T00:00:00.000Z",
                    }
                    for result_id in result_ids
                ],
            }, 0
        if args[:2] == ("project", "list"):
            return (
                []
                if self.project is None
                else [{"id": self.project["_id"], "name": self.project["name"]}]
            ), 0
        if args[:2] == ("project", "create"):
            self.project = {
                "_id": "project-test",
                "name": args[2],
                "description": args[args.index("--description") + 1],
                "archived": False,
                "role": "owner",
                "userId": self.user_id,
            }
            return {"projectId": "project-test", "receipt_id": "a" * 32}, 0
        if args[:2] == ("project", "show"):
            if self.project is None:
                assert 4 in allowed_codes
                return None, 4
            return {**self.project, "etag": '"titra-project-revision-1"'}, 0
        if args[:2] == ("project", "users"):
            if self.project is not None and not self.records:
                return [], 0
            return [{"id": self.user_id, "name": "Test", "name_private": False}], 0
        if args[:3] == ("project", "recovery", "inspect"):
            assert self.project_recovery_enabled
            return {"projectId": args[3], "writerRecoveries": {}}, 0
        if args[:2] == ("project", "edit"):
            assert self.project is not None
            self.project.update(json.loads(args[args.index("--changes") + 1]))
            return {"projectId": self.project["_id"]}, 0
        if args[:2] == ("project", "archive"):
            assert self.project is not None
            self.project["archived"] = True
            return {"projectId": self.project["_id"]}, 0
        if args[:2] == ("project", "restore"):
            assert self.project is not None
            self.project["archived"] = False
            return {"projectId": self.project["_id"]}, 0
        if args[:2] == ("project", "delete"):
            assert self.task is None and not self.records
            self.project = None
            return {"deleted": True}, 0
        if args[:2] == ("task", "list"):
            return ([] if self.task is None else [dict(self.task)]), 0
        if args[:2] == ("task", "create"):
            self.task = {
                "_id": "task-test",
                "projectId": args[2],
                "name": args[3],
                "estimatedHours": float(args[args.index("--estimated-hours") + 1]),
            }
            return {"taskId": "task-test", "receipt_id": "b" * 32}, 0
        if args[:2] == ("task", "show"):
            if self.task is None:
                assert 4 in allowed_codes
                return None, 4
            return {**self.task, "etag": '"titra-task-revision-1"'}, 0
        if args[:2] == ("task", "edit"):
            assert self.task is not None
            self.task.update(json.loads(args[args.index("--changes") + 1]))
            return {"taskId": self.task["_id"]}, 0
        if args[:2] == ("task", "stats"):
            project_id = self.project["_id"] if self.project is not None else args[2]
            if self.task is None:
                return {
                    "projectId": project_id,
                    "tasks": [],
                    "totalEstimatedHours": 0,
                    "totalActualHours": 0,
                }, 0
            estimated = float(self.task.get("estimatedHours") or 0)
            actual = sum(
                float(record["hours"])
                for record in self.records.values()
                if record.get("task") == self.task.get("name")
            )
            return {
                "projectId": project_id,
                "tasks": [
                    {
                        "taskId": self.task["_id"],
                        "taskName": self.task["name"],
                        "estimatedHours": estimated,
                        "actualHours": actual,
                        "variance": actual - estimated,
                    }
                ],
                "totalEstimatedHours": estimated,
                "totalActualHours": actual,
            }, 0
        if args[:2] == ("task", "delete"):
            self.task = None
            return {"deleted": True}, 0
        if args[:2] == ("record", "list"):
            return [dict(value) for value in self.records.values()], 0
        if args[:2] == ("record", "create"):
            record_id = f"record-{self.next_record}"
            self.next_record += 1
            task = args[args.index("--task") + 1]
            project_id = args[args.index("--project") + 1]
            day = args[args.index("--date") + 1]
            hours = float(args[args.index("--hours") + 1])
            self.records[record_id] = {
                "_id": record_id,
                "projectId": project_id,
                "task": task,
                "dateOnly": day,
                "date": f"{day}T00:00:00.000Z",
                "hours": hours,
            }
            suggestion_id = f"suggestion-{len(self.suggestions) + 1}"
            self.suggestions[suggestion_id] = {"_id": suggestion_id, "name": task}
            return {
                "timecardId": record_id,
                "draft_id": f"{self.next_record - 1:032x}",
            }, 0
        if args[:2] == ("record", "show"):
            record = self.records.get(args[2])
            if record is None:
                assert 4 in allowed_codes
                return None, 4
            return {**record, "etag": '"titra-date-revision-1"'}, 0
        if args[:2] == ("record", "edit-task"):
            self.records[args[2]]["task"] = args[args.index("--task") + 1]
            return {"timecardId": args[2]}, 0
        if args[:2] == ("record", "edit-details"):
            self.records[args[2]].update(json.loads(args[args.index("--changes") + 1]))
            return {"timecardId": args[2]}, 0
        if args[:2] == ("record", "delete"):
            self.records.pop(args[2])
            return {"deleted": True}, 0
        if args[:2] == ("suggestion", "list"):
            return [dict(value) for value in self.suggestions.values()], 0
        if args[:2] == ("suggestion", "show"):
            suggestion = self.suggestions.get(args[2])
            if suggestion is None:
                assert 4 in allowed_codes
                return None, 4
            return {**suggestion, "etag": '"titra-suggestion-revision-1"'}, 0
        if args[:2] == ("suggestion", "delete"):
            self.suggestions.pop(args[2])
            return {"deleted": True}, 0
        raise AssertionError(f"Unexpected invocation: {args}")


class InterruptedCreateInvoker(FakeV6Invoker):
    """Commit one create, hide it briefly, then simulate a caller interruption."""

    def __init__(self, target: str) -> None:
        super().__init__()
        self.target = target
        self.interrupted = False
        self.hidden_reads = 0

    def invoke_json(
        self, arguments: Any, *, allowed_codes: frozenset[int] = frozenset({0})
    ) -> tuple[Any, int]:
        args = self._normalize_arguments(arguments)
        target_command = {
            "project": ("project", "create"),
            "task": ("task", "create"),
            "record": ("record", "create"),
        }[self.target]
        list_command = {
            "project": ("project", "list"),
            "task": ("task", "list"),
            "record": ("record", "list"),
        }[self.target]
        if args[:2] == target_command and not self.interrupted:
            self.interrupted = True
            super().invoke_json(args, allowed_codes=allowed_codes)
            self.hidden_reads = 2
            raise OSError(f"simulated interruption after {self.target} commit")
        result = super().invoke_json(args, allowed_codes=allowed_codes)
        if args[:2] == list_command and self.hidden_reads:
            self.hidden_reads -= 1
            return [], result[1]
        return result


class UncertainCreateInvoker(FakeV6Invoker):
    """Return exit 6 for one committed create and delay its read visibility."""

    def __init__(self, target: str) -> None:
        super().__init__()
        self.target = target
        self.returned_uncertain = False
        self.hidden_reads = 0
        self.uncertain_create: tuple[str, ...] | None = None

    def invoke_json(
        self, arguments: Any, *, allowed_codes: frozenset[int] = frozenset({0})
    ) -> tuple[Any, int]:
        args = self._normalize_arguments(arguments)
        target_command = {
            "project": ("project", "create"),
            "task": ("task", "create"),
            "record": ("record", "create"),
        }[self.target]
        list_command = {
            "project": ("project", "list"),
            "task": ("task", "list"),
            "record": ("record", "list"),
        }[self.target]
        if args[:2] == target_command and not self.returned_uncertain:
            self.returned_uncertain = True
            self.uncertain_create = args
            super().invoke_json(args, allowed_codes=allowed_codes)
            self.hidden_reads = 2
            assert 6 in allowed_codes
            return None, 6
        result = super().invoke_json(args, allowed_codes=allowed_codes)
        if args[:2] == list_command and self.hidden_reads:
            self.hidden_reads -= 1
            return [], result[1]
        return result


class PreCommitCrashInvoker(FakeV6Invoker):
    def __init__(self, target: str) -> None:
        super().__init__()
        self.target = target
        self.crashed = False

    def invoke_json(
        self, arguments: Any, *, allowed_codes: frozenset[int] = frozenset({0})
    ) -> tuple[Any, int]:
        args = self._normalize_arguments(arguments)
        if args[:2] == (self.target, "create") and not self.crashed:
            self.crashed = True
            self.calls.append(args)
            raise OSError(f"simulated crash before {self.target} request")
        return super().invoke_json(args, allowed_codes=allowed_codes)


class ReplayFailureInvoker(FakeV6Invoker):
    """Lose the response to one journaled replay probe after its request starts."""

    def __init__(self, target: str) -> None:
        super().__init__()
        self.target = target
        self.failed = False

    def invoke_json(
        self, arguments: Any, *, allowed_codes: frozenset[int] = frozenset({0})
    ) -> tuple[Any, int]:
        args = self._normalize_arguments(arguments)
        is_target = (
            (
                self.target == "project"
                and args[:2] == ("creation", "verify-replay")
                and args[2] == "a" * 32
            )
            or (
                self.target == "task"
                and args[:2] == ("creation", "verify-replay")
                and args[2] == "b" * 32
            )
            or (self.target == "record" and args[:2] == ("draft", "verify-replay"))
        )
        if is_target and not self.failed:
            self.failed = True
            self.calls.append(args)
            raise OSError(f"simulated lost {self.target} replay response")
        return super().invoke_json(args, allowed_codes=allowed_codes)


class CleanupRateLimitInvoker(FakeV6Invoker):
    """Reject the first cleanup delete exactly once, as a non-replayed HTTP 429 would."""

    def __init__(self) -> None:
        super().__init__(release_profile="v7")
        self.reject_cleanup_once = True

    def invoke_json(
        self, arguments: Any, *, allowed_codes: frozenset[int] = frozenset({0})
    ) -> tuple[Any, int]:
        args = self._normalize_arguments(arguments)
        if args[:2] == ("record", "delete") and self.reject_cleanup_once:
            self.reject_cleanup_once = False
            self.calls.append(args)
            raise selftest.SelfTestError("rate limited; retry after the validated delay")
        return super().invoke_json(args, allowed_codes=allowed_codes)


class UncertainInvisibleTimerInvoker(FakeV6Invoker):
    """Lose the start response while its server outcome remains unobservable."""

    def invoke_json(
        self, arguments: Any, *, allowed_codes: frozenset[int] = frozenset({0})
    ) -> tuple[Any, int]:
        args = self._normalize_arguments(arguments)
        if args[:2] == ("timer", "start"):
            self.calls.append(args)
            assert self.timer is None
            assert 6 in allowed_codes
            return None, 6
        return super().invoke_json(args, allowed_codes=allowed_codes)


class RotatingIdentityInvoker(FakeV6Invoker):
    """Rotate the token owner after one synthetic server mutation."""

    def __init__(self) -> None:
        super().__init__()
        self.auth_checks = 0

    def invoke_json(
        self, arguments: Any, *, allowed_codes: frozenset[int] = frozenset({0})
    ) -> tuple[Any, int]:
        args = self._normalize_arguments(arguments)
        if args == ("auth", "check"):
            self.auth_checks += 1
            if self.auth_checks > 3:
                self.user_id = "rotated-user"
        return super().invoke_json(args, allowed_codes=allowed_codes)


def test_v6_read_only_suite_never_invokes_a_mutation(tmp_path: Path) -> None:
    invoker = FakeV6Invoker()
    suite = selftest.LiveV6Suite(
        invoker,
        namespace="v6-test",
        state_directory=tmp_path,
        server="https://v6.example.test",
        expected_user_id="test-user",
        sleeper=lambda _delay: None,
    )
    results, project_id = suite.run_read_only()
    assert project_id is None
    assert any(result.name == "exact /capabilities/v2 contract gate" for result in results)
    assert ("capabilities", "check", "--require-v6") in invoker.calls
    mutation_words = {"create", "edit", "archive", "restore", "delete", "start", "stop"}
    assert not any(len(call) > 1 and call[1] in mutation_words for call in invoker.calls)


def test_v7_read_only_suite_requires_exact_v7_contract_and_security_check(tmp_path: Path) -> None:
    invoker = FakeV6Invoker(release_profile="v7")
    suite = selftest.LiveV6Suite(
        invoker,
        namespace="v7-test",
        state_directory=tmp_path,
        server="https://v7.example.test",
        expected_user_id="test-user",
        release_profile="v7",
        sleeper=lambda _delay: None,
    )
    results, project_id = suite.run_read_only()
    assert project_id is None
    assert any(result.name == "exact /capabilities/v2 v7 contract gate" for result in results)
    assert ("capabilities", "check", "--require-v7") in invoker.calls
    mutation_words = {"create", "edit", "archive", "restore", "delete", "start", "stop"}
    assert not any(len(call) > 1 and call[1] in mutation_words for call in invoker.calls)


def test_v6_selected_project_reads_users_tasks_and_stats(tmp_path: Path) -> None:
    invoker = FakeV6Invoker()
    invoker.project = {
        "_id": "project-test",
        "name": "Existing test project",
        "description": "read only",
        "archived": False,
    }
    suite = selftest.LiveV6Suite(
        invoker,
        namespace="v6-test",
        state_directory=tmp_path,
        server="https://v6.example.test",
        expected_user_id="test-user",
        sleeper=lambda _delay: None,
    )
    _results, project_id = suite.run_read_only(project="project-test")
    assert project_id == "project-test"
    assert ("project", "users", "project-test") in invoker.calls
    assert ("task", "list", "project-test") in invoker.calls
    assert ("task", "stats", "project-test") in invoker.calls


def test_v6_disposable_flow_exercises_and_cleans_every_created_resource(tmp_path: Path) -> None:
    invoker = FakeV6Invoker()
    suite = selftest.LiveV6Suite(
        invoker,
        namespace="v6-test",
        state_directory=tmp_path,
        server="https://v6.example.test",
        expected_user_id="test-user",
        sleeper=lambda _delay: None,
    )
    suite.run_read_only()
    results = suite.run_disposable_mutations()
    assert invoker.project is None
    assert invoker.task is None
    assert invoker.records == {}
    assert invoker.suggestions == {}
    manifest = json.loads((tmp_path / "v6-recovery.json").read_text(encoding="utf-8"))
    assert manifest["status"] == "completed"
    assert all(not values for values in manifest["resources"].values())
    assert all(not values for values in manifest["pending"].values())
    assert invoker.expected_user_pins
    assert set(invoker.expected_user_pins) == {"test-user"}
    record_creates = [call for call in invoker.calls if call[:2] == ("record", "create")]
    assert len(record_creates) == 2
    assert {call[call.index("--hours") + 1] for call in record_creates} == {
        "0.016944",
        "0.033889",
    }
    assert any(call[:2] == ("record", "edit-task") for call in invoker.calls)
    assert any(call[:2] == ("record", "edit-details") for call in invoker.calls)
    assert any(call[:2] == ("project", "archive") for call in invoker.calls)
    assert any(call[:2] == ("project", "restore") for call in invoker.calls)
    assert invoker.calls.count(("project", "users", "project-test")) >= 2
    assert ("task", "list", "project-test") in invoker.calls
    task_create = next(call for call in invoker.calls if call[:2] == ("task", "create"))
    assert task_create[task_create.index("--estimated-hours") + 1] == "0.05"
    assert sum(call[:2] == ("suggestion", "show") for call in invoker.calls) >= 2
    pagination_calls = [call for call in invoker.calls if call[:2] == ("record", "list")]
    assert pagination_calls
    assert all(
        call[call.index("--api-page-size") + 1] == "1"
        for call in pagination_calls
        if "--api-page-size" in call
    )
    assert any("--team" in call for call in pagination_calls)
    assert any("--team" not in call for call in pagination_calls)
    assert (
        "suggestion",
        "list",
        "--page-size",
        "100",
    ) in invoker.calls
    replay_calls = [call for call in invoker.calls if call[1:2] == ("verify-replay",)]
    assert [call[:2] for call in replay_calls] == [
        ("creation", "verify-replay"),
        ("creation", "verify-replay"),
        ("draft", "verify-replay"),
    ]
    assert [result.name for result in results if result.name.endswith("idempotency replay")] == [
        "project idempotency replay",
        "project-task idempotency replay",
        "time-entry idempotency replay",
    ]
    delete_kinds = [call[0] for call in invoker.calls if len(call) > 1 and call[1] == "delete"]
    assert delete_kinds == ["record", "record", "suggestion", "suggestion", "task", "project"]
    delete_calls = [call for call in invoker.calls if len(call) > 1 and call[1] == "delete"]
    assert all("--if-match" in call for call in delete_calls)
    assert all(
        "--expect-project-id" in call and "--expect-task" in call
        for call in delete_calls
        if call[0] == "record"
    )
    assert all(
        "--expect-project-id" in call and "--expect-name" in call
        for call in delete_calls
        if call[0] == "task"
    )
    assert all(
        "--expect-name" in call for call in delete_calls if call[0] in {"suggestion", "project"}
    )
    assert any(result.name == "identity-checked disposable v6 cleanup" for result in results)


def test_v6_mutation_and_cleanup_stop_if_token_owner_rotates(tmp_path: Path) -> None:
    invoker = RotatingIdentityInvoker()
    suite = selftest.LiveV6Suite(
        invoker,
        namespace="v6-test",
        state_directory=tmp_path,
        server="https://v6.example.test",
        expected_user_id="test-user",
        sleeper=lambda _delay: None,
    )
    suite.run_read_only()
    with pytest.raises(selftest.SelfTestError, match="expected-user-id"):
        suite.run_disposable_mutations()

    assert invoker.project is not None
    assert not any(call[:2] == ("project", "edit") for call in invoker.calls)
    assert not any(call[:2] == ("project", "delete") for call in invoker.calls)
    manifest = json.loads((tmp_path / "v6-recovery.json").read_text(encoding="utf-8"))
    assert manifest["schema"] == "titra-cli-v6-live-recovery/v2"
    assert manifest["server"] == "https://v6.example.test"
    assert manifest["owner_id"] == "test-user"
    assert manifest["status"] == "recovery-required"


@pytest.mark.parametrize(
    "field, invalid",
    [
        ("estimatedHours", 0.0),
        ("actualHours", 0.0),
        ("variance", 0.0),
        ("totalEstimatedHours", 0.0),
        ("totalActualHours", 0.0),
    ],
)
def test_v6_task_stats_require_known_nonzero_values(field: str, invalid: float) -> None:
    value: dict[str, Any] = {
        "projectId": "project-test",
        "totalEstimatedHours": 0.05,
        "totalActualHours": 0.033,
        "tasks": [
            {
                "taskId": "task-test",
                "taskName": "marker-task-edited",
                "estimatedHours": 0.05,
                "actualHours": 0.033,
                "variance": -0.017,
            }
        ],
    }
    target = value["tasks"][0] if field in {"estimatedHours", "actualHours", "variance"} else value
    target[field] = invalid
    with pytest.raises(selftest.SelfTestError, match="statistics"):
        selftest.LiveV6Suite._verify_task_stats(
            value,
            project_id="project-test",
            task_id="task-test",
            task_name="marker-task-edited",
            estimated_hours=0.05,
            actual_hours=0.033,
        )


@pytest.mark.parametrize(
    "target, expected_delete_order",
    [
        ("project", ["project"]),
        ("task", ["task", "project"]),
        ("record", ["record", "suggestion", "task", "project"]),
    ],
)
def test_v6_cleanup_reconciles_late_committed_interrupted_creates(
    target: str, expected_delete_order: list[str], tmp_path: Path
) -> None:
    invoker = InterruptedCreateInvoker(target)
    suite = selftest.LiveV6Suite(
        invoker,
        namespace="v6-test",
        state_directory=tmp_path,
        server="https://v6.example.test",
        expected_user_id="test-user",
        sleeper=lambda _delay: None,
    )
    suite.run_read_only()
    with pytest.raises(OSError, match=f"after {target} commit"):
        suite.run_disposable_mutations()
    manifest = json.loads((tmp_path / "v6-recovery.json").read_text(encoding="utf-8"))
    assert manifest["status"] == "cleanup-completed-after-failure"
    assert all(not values for values in manifest["pending"].values())
    assert all(not values for values in manifest["resources"].values())
    delete_order = [call[0] for call in invoker.calls if len(call) > 1 and call[1] == "delete"]
    assert delete_order == expected_delete_order
    assert sum(call[:2] == (target, "create") for call in invoker.calls) == 1


@pytest.mark.parametrize("target", ["project", "task", "record"])
def test_v6_exit6_create_uses_bounded_reads_without_retrying_create(
    target: str, tmp_path: Path
) -> None:
    invoker = UncertainCreateInvoker(target)
    suite = selftest.LiveV6Suite(
        invoker,
        namespace="v6-test",
        state_directory=tmp_path,
        server="https://v6.example.test",
        expected_user_id="test-user",
        sleeper=lambda _delay: None,
    )
    suite.run_read_only()
    results = suite.run_disposable_mutations()
    assert invoker.uncertain_create is not None
    assert invoker.calls.count(invoker.uncertain_create) == 1
    assert invoker.hidden_reads == 0
    assert any(result.status == "WARN" and "creation response" in result.name for result in results)
    manifest = json.loads((tmp_path / "v6-recovery.json").read_text(encoding="utf-8"))
    assert manifest["status"] == "completed"
    assert all(not values for values in manifest["pending"].values())


@pytest.mark.parametrize("target", ["project", "task", "record"])
def test_v6_precommit_crash_keeps_pending_intent_and_stops_dependent_cleanup(
    target: str, tmp_path: Path
) -> None:
    invoker = PreCommitCrashInvoker(target)
    suite = selftest.LiveV6Suite(
        invoker,
        namespace="v6-test",
        state_directory=tmp_path,
        server="https://v6.example.test",
        expected_user_id="test-user",
        sleeper=lambda _delay: None,
    )
    suite.run_read_only()
    with pytest.raises(OSError, match=f"before {target} request"):
        suite.run_disposable_mutations()
    manifest = json.loads((tmp_path / "v6-recovery.json").read_text(encoding="utf-8"))
    assert manifest["status"] == "recovery-required"
    assert len(manifest["pending"][f"{target}s"]) == 1
    assert not any(call[1] == "delete" for call in invoker.calls if len(call) > 1)


@pytest.mark.parametrize("target", ["project", "task", "record"])
def test_v6_lost_replay_response_retains_resources_and_stops_cleanup(
    target: str, tmp_path: Path
) -> None:
    invoker = ReplayFailureInvoker(target)
    suite = selftest.LiveV6Suite(
        invoker,
        namespace="v6-test",
        state_directory=tmp_path,
        server="https://v6.example.test",
        expected_user_id="test-user",
        sleeper=lambda _delay: None,
    )
    suite.run_read_only()
    with pytest.raises(OSError, match=f"lost {target} replay response"):
        suite.run_disposable_mutations()

    manifest = json.loads((tmp_path / "v6-recovery.json").read_text(encoding="utf-8"))
    assert manifest["status"] == "recovery-required"
    assert len(manifest["pending"]["replays"]) == 1
    assert any(manifest["resources"][kind] for kind in ("projects", "tasks", "records"))
    assert not any(call[1] == "delete" for call in invoker.calls if len(call) > 1)


def test_v6_timer_flow_requires_absence_then_starts_and_stops_once(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    invoker = FakeV6Invoker()
    suite = selftest.LiveV6Suite(
        invoker,
        namespace="v6-test",
        state_directory=tmp_path,
        server="https://v6.example.test",
        expected_user_id="test-user",
        sleeper=lambda _delay: None,
    )
    suite.run_read_only()
    results = suite.run_disposable_mutations(include_timer=True)
    assert invoker.timer is None
    assert sum(call[:2] == ("timer", "start") for call in invoker.calls) == 1
    assert sum(call[:2] == ("timer", "stop") for call in invoker.calls) == 1
    start = next(call for call in invoker.calls if call[:2] == ("timer", "start"))
    stop = next(call for call in invoker.calls if call[:2] == ("timer", "stop"))
    operation_id = start[start.index("--operation-id") + 1]
    assert stop[stop.index("--expect-timer-id") + 1] == operation_id
    assert "--yes" in stop
    assert any(result.name == "atomic timer start/status/stop" for result in results)

    click_stop_calls: list[tuple[str | None, str | None]] = []

    class ClickClient:
        def __init__(self, _config: Any) -> None:
            self.expected_user_id: str | None = None

        def __enter__(self) -> ClickClient:
            return self

        def __exit__(self, *_args: object) -> None:
            return None

        def current_user(self) -> dict[str, str]:
            return {"_id": "test-user", "name": "Test User"}

        def bind_expected_user_id(self, user_id: str) -> None:
            self.expected_user_id = user_id

    class ClickDraft:
        draft_id = "selftest-stop-draft"

        def __init__(self) -> None:
            self.payloads: list[dict[str, Any]] = []

        def to_dict(self) -> dict[str, Any]:
            return {"draft_id": self.draft_id, "status": "pending", "payloads": []}

    class ClickTimerManager:
        def __init__(self, _config: Any, client: ClickClient, _store: Any) -> None:
            assert client.expected_user_id == "test-user"

        def status(self) -> dict[str, Any]:
            return {
                "timerId": operation_id,
                "startTime": "2026-09-03T00:00:00.000Z",
                "elapsed_seconds": 60,
                "projectId": None,
                "task": None,
            }

        def capture_stop(
            self,
            *,
            expected_timer_id: str | None,
            expected_start_time: str | None,
        ) -> ClickDraft:
            click_stop_calls.append((expected_timer_id, expected_start_time))
            return ClickDraft()

    monkeypatch.setattr("titra_cli.cli.TitraClient", ClickClient)
    monkeypatch.setattr("titra_cli.cli.TimerManager", ClickTimerManager)
    base = [
        "--server",
        "https://v6.example.test",
        "--api-key",
        "test-token",
        "--state-dir",
        str(tmp_path / "click-state"),
        "--output",
        "json",
    ]
    accepted = CliRunner().invoke(cli, [*base, *stop])
    assert accepted.exit_code == 0, accepted.output
    assert click_stop_calls == [(operation_id, "2026-09-03T00:00:00.000Z")]

    rejected = CliRunner().invoke(cli, [*base, *(part for part in stop if part != "--yes")])
    assert rejected.exit_code == 2
    assert "--yes" in rejected.stderr
    assert len(click_stop_calls) == 1


def test_v6_uncertain_invisible_timer_start_retains_exact_intent(tmp_path: Path) -> None:
    invoker = UncertainInvisibleTimerInvoker()
    suite = selftest.LiveV6Suite(
        invoker,
        namespace="v6-test",
        state_directory=tmp_path,
        server="https://v6.example.test",
        expected_user_id="test-user",
        sleeper=lambda _delay: None,
    )
    suite.run_read_only()
    with pytest.raises(selftest.SelfTestError, match="could not be identified"):
        suite.run_disposable_mutations(include_timer=True)

    manifest = json.loads((tmp_path / "v6-recovery.json").read_text(encoding="utf-8"))
    assert manifest["status"] == "recovery-required"
    timers = manifest["resources"]["timers"]
    assert len(timers) == 1
    operation_id, marker = next(iter(timers.items()))
    assert operation_id.startswith("selftest:")
    assert marker == manifest["marker"]
    assert sum(call[:2] == ("timer", "start") for call in invoker.calls) == 1
    assert not any(call[:2] == ("timer", "stop") for call in invoker.calls)
    assert not any(len(call) > 1 and call[1] == "delete" for call in invoker.calls)


def test_v6_timer_preflight_aborts_before_any_mutation_when_active(tmp_path: Path) -> None:
    invoker = FakeV6Invoker(active_timer=True)
    suite = selftest.LiveV6Suite(
        invoker,
        namespace="v6-test",
        state_directory=tmp_path,
        server="https://v6.example.test",
        expected_user_id="test-user",
        sleeper=lambda _delay: None,
    )
    with pytest.raises(selftest.SelfTestError, match="already exists"):
        suite.run_disposable_mutations(include_timer=True)
    assert invoker.timer is not None
    assert not any(call[:2] == ("project", "create") for call in invoker.calls)
    assert not any(call[:2] == ("timer", "start") for call in invoker.calls)


def test_v6_reads_enabled_fence_recovery_state_without_posting_recovery(tmp_path: Path) -> None:
    invoker = FakeV6Invoker(project_recovery_enabled=True)
    suite = selftest.LiveV6Suite(
        invoker,
        namespace="v6-test",
        state_directory=tmp_path,
        server="https://v6.example.test",
        expected_user_id="test-user",
        sleeper=lambda _delay: None,
    )
    suite.run_read_only()
    suite.run_disposable_mutations()
    assert any(call[:3] == ("project", "recovery", "inspect") for call in invoker.calls)
    assert not any(call[:3] == ("project", "recovery", "recover") for call in invoker.calls)


def test_recovery_manifest_contains_resource_identity_but_no_credentials(tmp_path: Path) -> None:
    manifest = selftest.RecoveryManifest(
        tmp_path / "recovery.json",
        "marker",
        server="https://v6.example.test",
        owner_id="test-user",
    )
    manifest.remember("projects", "project-id", "marker-project")
    rendered = (tmp_path / "recovery.json").read_text(encoding="utf-8")
    assert "project-id" in rendered
    assert "marker-project" in rendered
    assert "api_key" not in rendered.casefold()
    assert "token" not in rendered.casefold()
    assert '"server": "https://v6.example.test"' in rendered
    assert '"owner_id": "test-user"' in rendered
    manifest.assert_scope(server="https://v6.example.test/", owner_id="test-user")
    with pytest.raises(selftest.SelfTestError, match="another server or token owner"):
        manifest.assert_scope(server="https://other.example.test", owner_id="test-user")
    with pytest.raises(selftest.SelfTestError, match="another server or token owner"):
        manifest.assert_scope(server="https://v6.example.test", owner_id="other-user")
    assert selftest._should_preserve_state(tmp_path, v5_write=False) is False
    (tmp_path / "v6-recovery.json").write_text(rendered, encoding="utf-8")
    assert selftest._should_preserve_state(tmp_path, v5_write=False) is True


def test_v7_cleanup_can_resume_exact_private_manifest_without_any_create_or_replay(
    tmp_path: Path,
) -> None:
    invoker = CleanupRateLimitInvoker()
    suite = selftest.LiveV6Suite(
        invoker,
        namespace="v7-test",
        state_directory=tmp_path,
        server="https://v7.example.test",
        expected_user_id="test-user",
        release_profile="v7",
        sleeper=lambda _delay: None,
    )
    suite.run_read_only()
    with pytest.raises(selftest.SelfTestError, match="rate limited"):
        suite.run_disposable_mutations()

    path = tmp_path / "v6-recovery.json"
    stored = json.loads(path.read_text(encoding="utf-8"))
    marker = stored["marker"]
    assert stored["status"] == "recovery-required"
    assert any(stored["resources"].values())
    calls_before_resume = len(invoker.calls)
    creation_calls_before_resume = [
        call for call in invoker.calls if len(call) > 1 and call[1] in {"create", "verify-replay"}
    ]

    manifest = selftest.RecoveryManifest.load_for_cleanup(
        path,
        server="https://v7.example.test/",
        owner_id="test-user",
        expected_marker=marker,
    )
    resumed = selftest.LiveV6Suite(
        invoker,
        namespace="unused",
        state_directory=tmp_path,
        server="https://v7.example.test",
        expected_user_id="test-user",
        release_profile="v7",
        sleeper=lambda _delay: None,
    )
    results = resumed.resume_disposable_cleanup(manifest, expected_marker=marker)

    resumed_calls = invoker.calls[calls_before_resume:]
    assert not any(
        len(call) > 1 and call[1] in {"create", "verify-replay"} for call in resumed_calls
    )
    assert creation_calls_before_resume == [
        call for call in invoker.calls if len(call) > 1 and call[1] in {"create", "verify-replay"}
    ]
    assert invoker.project is None
    assert invoker.task is None
    assert invoker.records == {}
    assert invoker.suggestions == {}
    completed = json.loads(path.read_text(encoding="utf-8"))
    assert completed["status"] == "cleanup-completed-after-failure"
    assert all(not group for group in completed["pending"].values())
    assert all(not group for group in completed["resources"].values())
    assert any(result.name == "post-cleanup exact-ID and marker absence" for result in results)
    assert any(result.name == "resumed identity-checked disposable cleanup" for result in results)


@pytest.mark.parametrize(
    "scope",
    [
        {
            "server": "https://wrong.example.test",
            "owner_id": "test-user",
            "expected_marker": "__v7-test_20260904T010203Z_Abcd1234__",
        },
        {
            "server": "https://v7.example.test",
            "owner_id": "wrong-user",
            "expected_marker": "__v7-test_20260904T010203Z_Abcd1234__",
        },
        {
            "server": "https://v7.example.test",
            "owner_id": "test-user",
            "expected_marker": "__v7-test_20260904T010203Z_Other123__",
        },
    ],
)
def test_recovery_loader_requires_exact_server_owner_and_operator_marker(
    scope: dict[str, str], tmp_path: Path
) -> None:
    marker = "__v7-test_20260904T010203Z_Abcd1234__"
    path = tmp_path / "v6-recovery.json"
    manifest = selftest.RecoveryManifest(
        path, marker, server="https://v7.example.test", owner_id="test-user"
    )
    manifest.remember("projects", "project-test", f"{marker}-project")
    manifest.set_status("recovery-required")
    with pytest.raises(selftest.SelfTestError, match=r"another server|exact expected marker"):
        selftest.RecoveryManifest.load_for_cleanup(path, **scope)


def test_recovery_loader_rejects_resource_substitution_and_pending_replay(tmp_path: Path) -> None:
    marker = "__v7-test_20260904T010203Z_Abcd1234__"
    path = tmp_path / "v6-recovery.json"
    manifest = selftest.RecoveryManifest(
        path, marker, server="https://v7.example.test", owner_id="test-user"
    )
    manifest.remember("projects", "project-test", "unrelated-real-project")
    manifest.set_status("recovery-required")
    with pytest.raises(selftest.SelfTestError, match="invalid projects identity"):
        selftest.RecoveryManifest.load_for_cleanup(
            path,
            server="https://v7.example.test",
            owner_id="test-user",
            expected_marker=marker,
        )

    manifest.update_identity("projects", "project-test", f"{marker}-project")
    manifest.begin_replay(
        "creation:" + "a" * 32,
        {
            "kind": "creation",
            "receiptId": "a" * 32,
            "operation": "project.create",
            "expectedResultIds": ["project-test"],
        },
    )
    with pytest.raises(selftest.SelfTestError, match="will not replay"):
        selftest.RecoveryManifest.load_for_cleanup(
            path,
            server="https://v7.example.test",
            owner_id="test-user",
            expected_marker=marker,
        )


def test_recovery_loader_refuses_hard_linked_manifest(tmp_path: Path) -> None:
    if os.name != "posix":
        pytest.skip("hard-link safety check is exercised on POSIX")
    marker = "__v7-test_20260904T010203Z_Abcd1234__"
    path = tmp_path / "v6-recovery.json"
    manifest = selftest.RecoveryManifest(
        path, marker, server="https://v7.example.test", owner_id="test-user"
    )
    manifest.set_status("recovery-required")
    os.link(path, tmp_path / "second-link.json")
    with pytest.raises(selftest.SelfTestError, match="hard links"):
        selftest.RecoveryManifest.load_for_cleanup(
            path,
            server="https://v7.example.test",
            owner_id="test-user",
            expected_marker=marker,
        )


def test_completed_empty_manifest_does_not_force_state_retention(tmp_path: Path) -> None:
    manifest = selftest.RecoveryManifest(
        tmp_path / "v6-recovery.json",
        "marker",
        server="https://v6.example.test",
        owner_id="test-user",
    )
    manifest.set_status("completed")
    assert selftest._should_preserve_state(tmp_path, v5_write=False) is False
    (tmp_path / "v6-recovery.json").write_text("not-json", encoding="utf-8")
    assert selftest._should_preserve_state(tmp_path, v5_write=False) is True


@pytest.mark.parametrize("status", ["completed", "cleanup-completed-after-failure"])
@pytest.mark.parametrize("unresolved", ["pending", "resource"])
def test_recovery_manifest_refuses_success_status_with_unresolved_state(
    status: str, unresolved: str, tmp_path: Path
) -> None:
    manifest = selftest.RecoveryManifest(
        tmp_path / "v6-recovery.json",
        "marker",
        server="https://v6.example.test",
        owner_id="test-user",
    )
    if unresolved == "pending":
        manifest.begin_create(
            "projects",
            "marker-project",
            {
                "name": "marker-project",
                "description": "marker",
                "marker": "marker",
            },
        )
    else:
        manifest.remember("projects", "project-id", "marker-project")
    with pytest.raises(selftest.SelfTestError, match=r"Cannot mark .* complete"):
        manifest.set_status(status)
    saved = json.loads(manifest.path.read_text(encoding="utf-8"))
    assert saved["status"] == "running"
    assert saved["pending"]["projects"] or saved["resources"]["projects"]


def test_recovery_manifest_refuses_success_with_pending_replay(tmp_path: Path) -> None:
    manifest = selftest.RecoveryManifest(
        tmp_path / "v6-recovery.json",
        "marker",
        server="https://v6.example.test",
        owner_id="test-user",
    )
    manifest.begin_replay(
        "receipt-1",
        {"operation": "project.create", "expected_result_id": "project-test"},
    )
    with pytest.raises(selftest.SelfTestError, match=r"Cannot mark .* complete"):
        manifest.set_status("completed")
    assert manifest.value["pending"]["replays"]


def test_main_catches_unexpected_oserror_and_preserves_unresolved_manifest(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    state_directory = tmp_path / "live-state"

    def fake_mkdtemp(*, prefix: str) -> str:
        assert prefix == "titra-cli-v6-test-"
        state_directory.mkdir()
        return str(state_directory)

    class FailingSuite:
        def __init__(self, _invoker: Any, **kwargs: Any) -> None:
            self.state_directory = kwargs["state_directory"]
            self.results: list[selftest.CheckResult] = []

        def run_read_only(self, **_kwargs: Any) -> None:
            return None

        def run_disposable_mutations(self, *, include_timer: bool) -> None:
            assert include_timer is False
            manifest = selftest.RecoveryManifest(
                self.state_directory / "v6-recovery.json",
                "safe-marker",
                server="https://v6.example.test",
                owner_id="test-user",
            )
            manifest.remember("projects", "synthetic-project", "safe-marker-project")
            raise OSError("write failed with Authorization: Bearer profile-secret")

    monkeypatch.setattr(selftest.tempfile, "mkdtemp", fake_mkdtemp)
    monkeypatch.setattr(
        selftest,
        "resolve_live_connection",
        lambda **_kwargs: selftest.LiveConnection(
            "https://v6.example.test", "profile-secret", None, "test"
        ),
    )
    monkeypatch.setattr(selftest, "CliInvoker", lambda **_kwargs: object())
    monkeypatch.setattr(selftest, "LiveV6Suite", FailingSuite)

    assert (
        selftest.main(
            [
                "--skip-local",
                "--live-api-version",
                "v6",
                "--live-url",
                "https://v6.example.test",
                "--allow-v6-mutation-tests",
                "--expected-user-id",
                "test-user",
                "--no-token-prompt",
            ]
        )
        == 1
    )
    error = capsys.readouterr().err
    assert "unexpected self-test failure (OSError)" in error
    assert "profile-secret" not in error
    assert "Bearer <redacted>" in error
    assert f"Private test recovery state retained at: {state_directory}" in error
    assert state_directory.is_dir()
    assert (state_directory / "v6-recovery.json").is_file()


def test_sanitized_report_is_atomic_private_and_contains_no_credentials(tmp_path: Path) -> None:
    destination = tmp_path / "report.json"
    selftest.write_sanitized_report(
        destination,
        api_version="v6",
        outcome="failed",
        results=[selftest.CheckResult("contract", "PASS"), selftest.CheckResult("run", "FAIL")],
        recovery_status="recovery-required",
    )
    value = json.loads(destination.read_text(encoding="utf-8"))
    assert value["outcome"] == "failed"
    assert value["recovery_status"] == "recovery-required"
    assert [item["status"] for item in value["results"]] == ["PASS", "FAIL"]
    rendered = destination.read_text(encoding="utf-8").casefold()
    assert "api_key" not in rendered
    assert "credential" not in rendered
    assert "token" not in rendered
    assert not list(tmp_path.glob(".report.json.tmp-*"))
    if os.name == "posix":
        assert stat.S_IMODE(destination.stat().st_mode) == 0o600


def test_sanitized_report_refuses_symlink_target(tmp_path: Path) -> None:
    target = tmp_path / "target.json"
    target.write_text("do not replace", encoding="utf-8")
    link = tmp_path / "report.json"
    try:
        link.symlink_to(target)
    except OSError:
        pytest.skip("symlink creation is unavailable on this test filesystem")
    with pytest.raises(selftest.SelfTestError, match="symlinked"):
        selftest.write_sanitized_report(
            link,
            api_version="v6",
            outcome="passed",
            results=[selftest.CheckResult("contract", "PASS")],
        )
    assert target.read_text(encoding="utf-8") == "do not replace"


def test_v6_cleanup_refuses_project_with_wrong_marker_identity(tmp_path: Path) -> None:
    invoker = FakeV6Invoker()
    invoker.project = {
        "_id": "project-test",
        "name": "marker-project",
        "description": "not the expected marker",
        "archived": False,
    }
    manifest = selftest.RecoveryManifest(
        tmp_path / "recovery.json",
        "marker-unique",
        server="https://v6.example.test",
        owner_id="test-user",
    )
    manifest.remember("projects", "project-test", "marker-project")
    suite = selftest.LiveV6Suite(
        invoker,
        namespace="v6-test",
        state_directory=tmp_path,
        server="https://v6.example.test",
        expected_user_id="test-user",
        sleeper=lambda _delay: None,
    )
    with pytest.raises(selftest.SelfTestError, match="identity mismatch"):
        suite._cleanup_disposable(
            manifest,
            marker="marker-unique",
            project_id="project-test",
            project_name="marker-project",
            task_id=None,
            task_names=set(),
            task_estimated_hours=0.05,
            record_tasks=set(),
            record_shapes=set(),
        )
    assert invoker.project is not None
    assert not any(call[:2] == ("project", "delete") for call in invoker.calls)


def test_v6_mutations_require_separate_explicit_opt_in(
    capsys: pytest.CaptureFixture[str],
) -> None:
    assert selftest.main(["--skip-local", "--allow-v6-mutation-tests"]) == 1
    assert "live server credentials" in capsys.readouterr().err
    assert (
        selftest.main(
            [
                "--skip-local",
                "--live-url",
                "https://v6.example.test",
                "--allow-v6-mutation-tests",
            ]
        )
        == 1
    )
    assert "--live-api-version v6" in capsys.readouterr().err
    assert (
        selftest.main(
            [
                "--skip-local",
                "--live-api-version",
                "v6",
                "--live-url",
                "https://v6.example.test",
                "--allow-v6-mutation-tests",
            ]
        )
        == 1
    )
    assert "requires --expected-user-id" in capsys.readouterr().err
    assert selftest.main(["--skip-local", "--allow-v6-timer-tests"]) == 1
    assert "requires --allow-v6-mutation-tests" in capsys.readouterr().err


def test_v7_mutations_require_the_v7_mode_identity_pin_and_timer_opt_in(
    capsys: pytest.CaptureFixture[str],
) -> None:
    assert selftest.main(["--skip-local", "--allow-v7-mutation-tests"]) == 1
    assert "--live-api-version v7" in capsys.readouterr().err
    assert (
        selftest.main(
            [
                "--skip-local",
                "--live-api-version",
                "v7",
                "--live-url",
                "https://v7.example.test",
                "--allow-v7-mutation-tests",
            ]
        )
        == 1
    )
    assert "requires --expected-user-id" in capsys.readouterr().err
    assert selftest.main(["--skip-local", "--allow-v7-timer-tests"]) == 1
    assert "requires --allow-v7-mutation-tests" in capsys.readouterr().err


def test_v7_read_only_mode_requires_security_profile_before_shared_api_suite(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    calls: list[tuple[str, ...]] = []

    class V7Invoker:
        def invoke_json(
            self, arguments: Any, *, allowed_codes: frozenset[int] = frozenset({0})
        ) -> tuple[Any, int]:
            _ = allowed_codes
            values = tuple(arguments)
            calls.append(values)
            assert values == ("capabilities", "check", "--require-v7")
            return {
                "ok": True,
                "requirement": "v7",
                "source": "/capabilities/v2/",
                "security": {"http": {"ok": True}},
            }, 0

    class V7Suite:
        def __init__(self, invoker: Any, **_kwargs: Any) -> None:
            assert isinstance(invoker, V7Invoker)
            self.invoker = invoker
            self.results: list[selftest.CheckResult] = []

        def _record(self, name: str, *, detail: str = "") -> None:
            self.results.append(selftest.CheckResult(name, "PASS", detail))

        def run_read_only(self, *, project: str | None, record_id: str | None) -> None:
            assert project is None
            assert record_id is None
            checked, _ = self.invoker.invoke_json(("capabilities", "check", "--require-v7"))
            assert checked["requirement"] == "v7"
            self._record("shared v6-compatible API suite")

    monkeypatch.setattr(
        selftest,
        "resolve_live_connection",
        lambda **_kwargs: selftest.LiveConnection(
            "https://v7.example.test", "private-secret", None, "test"
        ),
    )
    monkeypatch.setattr(selftest, "CliInvoker", lambda **_kwargs: V7Invoker())
    monkeypatch.setattr(selftest, "LiveV6Suite", V7Suite)

    assert (
        selftest.main(
            [
                "--skip-local",
                "--live-api-version",
                "v7",
                "--live-url",
                "https://v7.example.test",
                "--no-token-prompt",
            ]
        )
        == 0
    )
    assert calls == [("capabilities", "check", "--require-v7")]
    assert "All requested Titra CLI checks passed." in capsys.readouterr().out
