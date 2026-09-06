from __future__ import annotations

import subprocess
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pytest

from titra_cli import selftest


def test_validate_live_url_normalizes_https() -> None:
    assert selftest.validate_live_url(" https://titra.example.test/base/ ") == (
        "https://titra.example.test/base"
    )


@pytest.mark.parametrize("url", ["http://localhost:3000/", "http://127.0.0.1:3000/"])
def test_validate_live_url_allows_loopback_http(url: str) -> None:
    assert selftest.validate_live_url(url).startswith("http://")


def test_validate_live_url_refuses_remote_plain_http() -> None:
    with pytest.raises(selftest.SelfTestError, match="Remote HTTP is refused"):
        selftest.validate_live_url("http://titra.example.test")


def test_validate_live_url_requires_explicit_insecure_override() -> None:
    assert (
        selftest.validate_live_url("http://titra.example.test/", insecure=True)
        == "http://titra.example.test"
    )


@pytest.mark.parametrize(
    "url, message",
    [
        ("titra.example.test", "absolute HTTP"),
        ("https://user:secret@titra.example.test", "credentials"),
        ("https://titra.example.test?q=1", "query string"),
        ("https://titra.example.test/#frag", "query string"),
    ],
)
def test_validate_live_url_rejects_unsafe_or_ambiguous_values(url: str, message: str) -> None:
    with pytest.raises(selftest.SelfTestError, match=message):
        selftest.validate_live_url(url)


def test_read_api_token_prefers_named_environment_without_prompt() -> None:
    called = False

    def prompt(_message: str) -> str:
        nonlocal called
        called = True
        return "wrong"

    assert (
        selftest.read_api_token(
            {"PRIVATE_TOKEN": "correct"}, "PRIVATE_TOKEN", allow_prompt=True, prompt=prompt
        )
        == "correct"
    )
    assert called is False


def test_read_api_token_uses_hidden_prompt_when_allowed() -> None:
    assert (
        selftest.read_api_token(
            {}, "PRIVATE_TOKEN", allow_prompt=True, prompt=lambda _message: "prompt-secret"
        )
        == "prompt-secret"
    )


@pytest.mark.parametrize("name", ["bad-name", "9TOKEN", "TOKEN NAME"])
def test_read_api_token_rejects_invalid_environment_names(name: str) -> None:
    with pytest.raises(selftest.SelfTestError, match="valid environment"):
        selftest.read_api_token({}, name, allow_prompt=False)


def test_read_api_token_never_accepts_empty_or_control_characters() -> None:
    with pytest.raises(selftest.SelfTestError, match="No API token"):
        selftest.read_api_token({}, "TOKEN", allow_prompt=False)
    with pytest.raises(selftest.SelfTestError, match="No API token"):
        selftest.read_api_token({"TOKEN": "   "}, "TOKEN", allow_prompt=False)
    with pytest.raises(selftest.SelfTestError, match="control character"):
        selftest.read_api_token({"TOKEN": "secret\nvalue"}, "TOKEN", allow_prompt=False)


def test_build_cli_environment_removes_unrelated_titra_sources(tmp_path: Path) -> None:
    result = selftest.build_cli_environment(
        {
            "PATH": "kept",
            "TITRA_URL": "https://wrong.invalid",
            "titra_api_token": "wrong-token",
            "TITRA_PROFILE": "wrong-profile",
            "PRIVATE_LIVE_TOKEN": "duplicate-token",
        },
        server="https://right.example.test",
        api_token="right-token",
        state_directory=tmp_path,
        expected_username="Expected User",
        secret_variable="PRIVATE_LIVE_TOKEN",
        minimum_request_spacing=0.5,
    )
    assert result["PATH"] == "kept"
    assert "TITRA_URL" not in result
    assert "titra_api_token" not in result
    assert "TITRA_PROFILE" not in result
    assert "PRIVATE_LIVE_TOKEN" not in result
    assert result["TITRA_SERVER"] == "https://right.example.test"
    assert result["TITRA_API_KEY"] == "right-token"
    assert result["TITRA_USERNAME"] == "Expected User"
    assert result["TITRA_TIMEZONE"] == "UTC"
    assert result["TITRA_CLI_MIN_REQUEST_SPACING_SECONDS"] == "0.5"


def test_without_test_credentials_protects_local_check_processes() -> None:
    result = selftest.without_test_credentials(
        {
            "PATH": "kept",
            "TITRA_V5_API_TOKEN": "default-secret",
            "titra_api_key": "case-insensitive-secret",
            "CUSTOM_V5_SECRET": "custom-secret",
        },
        secret_variable="CUSTOM_V5_SECRET",
    )
    assert result == {"PATH": "kept"}


def test_redact_secrets_removes_exact_bearer_and_json_forms() -> None:
    secret = "very-secret-token"
    rendered = selftest.redact_secrets(
        f"exact={secret} Authorization: Bearer another-secret "
        '"api_key":"third-secret" api-token=fourth-secret',
        [secret],
    )
    assert secret not in rendered
    assert "another-secret" not in rendered
    assert "third-secret" not in rendered
    assert "fourth-secret" not in rendered
    assert rendered.count("<redacted>") == 4


def test_parse_cli_envelope_returns_only_data() -> None:
    assert selftest.parse_cli_envelope(
        '{"schema":"titra-cli/v1","data":{"ok":true},"meta":{}}'
    ) == {"ok": True}


@pytest.mark.parametrize(
    "output",
    ["not-json", '{"schema":"different","data":{}}', '{"schema":"titra-cli/v1"}'],
)
def test_parse_cli_envelope_rejects_invalid_output(output: str) -> None:
    with pytest.raises(selftest.SelfTestError):
        selftest.parse_cli_envelope(output)


def test_synthetic_marker_is_deterministic_when_dependencies_are_injected() -> None:
    marker = selftest.synthetic_marker(
        "safe.namespace",
        now=datetime(2026, 8, 30, 1, 2, 3, tzinfo=UTC),
        entropy="Abcd1234",
    )
    assert marker == "__safe.namespace_20260830T010203Z_Abcd1234__"


@pytest.mark.parametrize("namespace", ["", "spaces are bad", "/root", "a" * 41])
def test_synthetic_marker_rejects_unsafe_namespaces(namespace: str) -> None:
    with pytest.raises(selftest.SelfTestError, match="namespace"):
        selftest.synthetic_marker(namespace)


def test_cli_invoker_keeps_secret_out_of_argv_and_redacts_failure(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    observed: dict[str, Any] = {}

    def fake_run(command: list[str], **kwargs: Any) -> subprocess.CompletedProcess[str]:
        observed["command"] = command
        observed["environment"] = kwargs["env"]
        return subprocess.CompletedProcess(
            command,
            5,
            stdout="",
            stderr='Authorization: Bearer secret-value; "api_key":"secret-value"',
        )

    monkeypatch.setattr(selftest.subprocess, "run", fake_run)
    invoker = selftest.CliInvoker(
        python="python",
        environment={"TITRA_API_KEY": "secret-value"},
        project_root=tmp_path,
        api_token="secret-value",
        timeout=1,
        insecure=False,
    )
    with pytest.raises(selftest.SelfTestError) as captured:
        invoker.invoke_json(("auth", "check"))
    assert "secret-value" not in str(captured.value)
    assert "secret-value" not in observed["command"]
    assert observed["environment"]["TITRA_API_KEY"] == "secret-value"


def test_cli_invoker_parses_success_and_permitted_empty_error(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    responses = iter(
        [
            subprocess.CompletedProcess(
                [], 0, '{"schema":"titra-cli/v1","data":[1],"meta":{}}', ""
            ),
            subprocess.CompletedProcess([], 4, "", "not found"),
        ]
    )
    monkeypatch.setattr(selftest.subprocess, "run", lambda *_args, **_kwargs: next(responses))
    invoker = selftest.CliInvoker(
        python="python",
        environment={},
        project_root=tmp_path,
        api_token="unused-secret",
        timeout=1,
        insecure=True,
    )
    assert invoker.invoke_json(("project", "list")) == ([1], 0)
    assert invoker.invoke_json(("record", "show", "missing"), allowed_codes=frozenset({0, 4})) == (
        None,
        4,
    )


def test_cli_invoker_places_expected_user_pin_before_every_subcommand(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    commands: list[list[str]] = []

    def fake_run(command: list[str], **_kwargs: Any) -> subprocess.CompletedProcess[str]:
        commands.append(command)
        return subprocess.CompletedProcess(
            command, 0, '{"schema":"titra-cli/v1","data":{},"meta":{}}', ""
        )

    monkeypatch.setattr(selftest.subprocess, "run", fake_run)
    invoker = selftest.CliInvoker(
        python="python",
        environment={},
        project_root=tmp_path,
        api_token="unused-secret",
        timeout=1,
        insecure=False,
    )
    invoker.bind_expected_user_id("immutable-user-1")
    invoker.invoke_json(("auth", "check"))
    invoker.invoke_json(("project", "list"))
    assert len(commands) == 2
    for command in commands:
        pin_index = command.index("--expect-user-id")
        assert command[pin_index + 1] == "immutable-user-1"
        assert pin_index < command.index("auth" if "auth" in command else "project")
    with pytest.raises(selftest.SelfTestError, match="another expected user"):
        invoker.bind_expected_user_id("immutable-user-2")


def test_cli_invoker_enforces_minimum_start_spacing_without_retrying(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    current = 10.0
    starts: list[float] = []
    sleeps: list[float] = []

    def clock() -> float:
        return current

    def sleep(delay: float) -> None:
        nonlocal current
        sleeps.append(delay)
        current += delay

    def fake_run(command: list[str], **_kwargs: Any) -> subprocess.CompletedProcess[str]:
        nonlocal current
        starts.append(current)
        current += 0.25
        return subprocess.CompletedProcess(
            command, 0, '{"schema":"titra-cli/v1","data":{},"meta":{}}', ""
        )

    monkeypatch.setattr(selftest.subprocess, "run", fake_run)
    invoker = selftest.CliInvoker(
        python="python",
        environment={},
        project_root=tmp_path,
        api_token="unused-secret",
        timeout=1,
        insecure=False,
        minimum_spacing=1.0,
        sleeper=sleep,
        clock=clock,
    )
    invoker.invoke_json(("auth", "check"))
    invoker.invoke_json(("project", "list"))

    assert starts == [10.0, 11.0]
    assert sleeps == pytest.approx([0.75])


@pytest.mark.parametrize("spacing", [-1.0, float("inf"), float("nan")])
def test_cli_invoker_rejects_invalid_command_spacing(spacing: float, tmp_path: Path) -> None:
    with pytest.raises(selftest.SelfTestError, match="finite nonnegative"):
        selftest.CliInvoker(
            python="python",
            environment={},
            project_root=tmp_path,
            api_token="unused-secret",
            timeout=1,
            insecure=False,
            minimum_spacing=spacing,
        )


class FakeLiveInvoker:
    def __init__(self, *, uncertain_create: bool = False, mismatched_record: bool = False) -> None:
        self.calls: list[tuple[str, ...]] = []
        self.marker = ""
        self.deleted = False
        self.uncertain_create = uncertain_create
        self.mismatched_record = mismatched_record

    def invoke_json(
        self, arguments: Any, *, allowed_codes: frozenset[int] = frozenset({0})
    ) -> tuple[Any, int]:
        args = tuple(arguments)
        self.calls.append(args)
        if args == ("auth", "check"):
            return {"ok": True}, 0
        if args == ("doctor",):
            return {"capabilities": {"projects": True, "identity": True, "record_delete": True}}, 0
        if args[:2] == ("project", "list"):
            return [{"id": "p1", "name": "Test"}], 0
        if args[:2] == ("project", "show"):
            return {"_id": "p1", "name": "Test"}, 0
        if args[:2] == ("report", "summary"):
            return [], 0
        if args[:2] == ("record", "create"):
            self.marker = args[args.index("--task") + 1]
            if self.uncertain_create:
                return None, 6
            return {"timecardId": "r-new"}, 0
        if args[:2] == ("record", "list"):
            if self.marker and not self.deleted:
                return [
                    {
                        "_id": "r-new",
                        "projectId": "p1",
                        "task": self.marker,
                    }
                ], 0
            return [], 0
        if args[:2] == ("record", "show"):
            if self.deleted:
                assert 4 in allowed_codes
                return None, 4
            return {
                "_id": "r-new",
                "projectId": "wrong" if self.mismatched_record else "p1",
                "task": self.marker,
            }, 0
        if args[:2] == ("record", "delete"):
            self.deleted = True
            return {"deleted": True}, 0
        raise AssertionError(f"Unexpected invocation: {args}")


def test_live_suite_read_only_tests_new_v5_endpoints_without_printing_data() -> None:
    invoker = FakeLiveInvoker()
    suite = selftest.LiveV5Suite(invoker, namespace="test", sleeper=lambda _value: None)
    results, project_id = suite.run_read_only(project="Test")
    assert project_id == "p1"
    assert {result.name for result in results} >= {
        "authentication and current-user endpoint",
        "project-user endpoint",
        "owned-record listing",
    }
    assert not any(
        call[:2] in {("record", "create"), ("record", "delete")} for call in invoker.calls
    )


def test_live_suite_write_creates_verifies_and_deletes_only_synthetic_record() -> None:
    invoker = FakeLiveInvoker()
    results_seen: list[selftest.CheckResult] = []
    suite = selftest.LiveV5Suite(
        invoker,
        namespace="test",
        reporter=results_seen.append,
        sleeper=lambda _value: None,
    )
    suite.run_write(project_id="p1")
    assert invoker.deleted is True
    assert any(call[:2] == ("record", "delete") for call in invoker.calls)
    assert any(result.name == "ETag-guarded synthetic record deletion" for result in results_seen)


def test_live_suite_reconciles_uncertain_create_without_retrying_it() -> None:
    invoker = FakeLiveInvoker(uncertain_create=True)
    suite = selftest.LiveV5Suite(invoker, namespace="test", sleeper=lambda _value: None)
    results = suite.run_write(project_id="p1")
    assert invoker.deleted is True
    assert sum(call[:2] == ("record", "create") for call in invoker.calls) == 1
    creation = next(result for result in results if result.name == "synthetic record creation")
    assert creation.status == "WARN"
    assert creation.detail == "reconciled"


def test_live_suite_refuses_cleanup_when_record_identity_does_not_match() -> None:
    invoker = FakeLiveInvoker(mismatched_record=True)
    suite = selftest.LiveV5Suite(invoker, namespace="test", sleeper=lambda _value: None)
    with pytest.raises(selftest.SelfTestError, match="identity mismatch"):
        suite.run_write(project_id="p1")
    assert invoker.deleted is False


def test_local_check_commands_cover_tests_lint_format_and_types() -> None:
    commands = selftest.local_check_commands("python")
    names = [name for name, _command in commands]
    assert names == ["unit and contract tests", "Ruff lint", "Ruff format check", "strict mypy"]
    assert all(command[0] == "python" for _name, command in commands)


def test_project_root_accepts_explicit_existing_directory(tmp_path: Path) -> None:
    assert selftest.project_root(tmp_path) == tmp_path.resolve()


def test_project_root_rejects_missing_explicit_directory(tmp_path: Path) -> None:
    with pytest.raises(selftest.SelfTestError, match="not a directory"):
        selftest.project_root(tmp_path / "missing")


def test_run_local_checks_stops_at_first_failure(tmp_path: Path) -> None:
    calls: list[tuple[str, ...]] = []

    def executor(command: tuple[str, ...], **_kwargs: Any) -> subprocess.CompletedProcess[Any]:
        calls.append(command)
        return subprocess.CompletedProcess(command, 1 if len(calls) == 2 else 0)

    with pytest.raises(selftest.SelfTestError, match="Ruff lint failed"):
        selftest.run_local_checks(python="python", root=tmp_path, executor=executor)
    assert len(calls) == 2


def test_run_local_checks_isolates_coverage_and_preserves_existing_files(tmp_path: Path) -> None:
    existing = tmp_path / ".coverage"
    existing_parallel = tmp_path / ".coverage.previous-run"
    existing.write_bytes(b"not a sqlite database")
    existing_parallel.write_text("user data", encoding="utf-8")
    observed_files: list[Path] = []

    def executor(command: tuple[str, ...], **kwargs: Any) -> subprocess.CompletedProcess[Any]:
        coverage_file = Path(kwargs["env"]["COVERAGE_FILE"])
        assert kwargs["env"]["PYTHONPATH"] == str(tmp_path / "src")
        observed_files.append(coverage_file)
        coverage_file.write_text("isolated test data", encoding="utf-8")
        return subprocess.CompletedProcess(command, 0)

    results = selftest.run_local_checks(
        python="python",
        root=tmp_path,
        environment={"COVERAGE_FILE": str(existing), "SAFE": "value"},
        executor=executor,
    )

    assert len(results) == 4
    assert len(set(observed_files)) == 1
    isolated_file = observed_files[0]
    assert isolated_file.parent != tmp_path
    assert not isolated_file.parent.exists()
    assert existing.read_bytes() == b"not a sqlite database"
    assert existing_parallel.read_text(encoding="utf-8") == "user data"


def test_run_local_checks_cleans_isolated_coverage_after_failure(tmp_path: Path) -> None:
    observed_file: Path | None = None

    def executor(command: tuple[str, ...], **kwargs: Any) -> subprocess.CompletedProcess[Any]:
        nonlocal observed_file
        observed_file = Path(kwargs["env"]["COVERAGE_FILE"])
        observed_file.write_text("temporary", encoding="utf-8")
        return subprocess.CompletedProcess(command, 1)

    with pytest.raises(selftest.SelfTestError, match="unit and contract tests failed"):
        selftest.run_local_checks(python="python", root=tmp_path, executor=executor)

    assert observed_file is not None
    assert not observed_file.parent.exists()


def test_main_rejects_write_test_without_live_url(capsys: pytest.CaptureFixture[str]) -> None:
    assert selftest.main(["--skip-local", "--allow-write-tests", "--project", "p1"]) == 1
    assert "requires --live-url" in capsys.readouterr().err
