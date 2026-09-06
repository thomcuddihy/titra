"""Security and serialization contracts for configuration and output handling."""

from __future__ import annotations

import csv
import json
import os
import stat
from dataclasses import dataclass
from datetime import UTC, datetime
from io import StringIO
from pathlib import Path
from typing import Any

import pytest
import tomli_w

from titra_cli import config as config_module
from titra_cli.config import (
    CONFIG_FILENAME,
    load_config_file,
    resolve_config,
    write_profile,
)
from titra_cli.errors import ConfigurationError, CredentialSecurityError
from titra_cli.models import ResolvedConfig
from titra_cli.output import OutputMode, Renderer

FAKE_CWD_TOKEN = "fake-cwd-token-for-tests-only"
FAKE_HOME_TOKEN = "fake-home-token-for-tests-only"
FAKE_EXPLICIT_TOKEN = "fake-explicit-token-for-tests-only"
FAKE_ENV_TOKEN = "fake-env-token-for-tests-only"


class TtyStringIO(StringIO):
    """String buffer that behaves like an interactive terminal."""

    def isatty(self) -> bool:
        return True


@dataclass(frozen=True)
class JsonFixture:
    identifier: str
    happened_at: datetime


def _profile_document(
    *,
    server: str | None,
    api_key: str | None,
    username: str | None = None,
    timezone: str | None = None,
    profile: str = "default",
) -> dict[str, Any]:
    value: dict[str, Any] = {}
    if server is not None:
        value["server"] = server
    if api_key is not None:
        value["api_key"] = api_key
    if username is not None:
        value["username"] = username
    if timezone is not None:
        value["timezone"] = timezone
    return {
        "default_profile": profile,
        "profiles": {profile: value},
    }


def _write_test_config(path: Path, value: dict[str, Any], *, mode: int = 0o600) -> Path:
    """Write a fake credential fixture only inside pytest's temporary directory."""

    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(tomli_w.dumps(value).encode("utf-8"))
    if os.name == "posix":
        path.chmod(mode)
    return path


def _resolve_from_process(
    tmp_path: Path,
    *,
    server: str = "https://titra.example.test",
    api_key: str = FAKE_ENV_TOKEN,
    verify_tls: bool = True,
) -> ResolvedConfig:
    return resolve_config(
        server=server,
        api_key=api_key,
        verify_tls=verify_tls,
        environ={},
        cwd=tmp_path / "cwd",
        home=tmp_path / "home",
    )


def test_complete_cwd_profile_wins_as_one_atomic_credential_source(tmp_path: Path) -> None:
    cwd = tmp_path / "cwd"
    home = tmp_path / "home"
    cwd_file = _write_test_config(
        cwd / CONFIG_FILENAME,
        _profile_document(
            server="https://cwd.example.test/",
            api_key=FAKE_CWD_TOKEN,
        ),
    )
    _write_test_config(
        home / CONFIG_FILENAME,
        _profile_document(
            server="https://home.example.test",
            api_key=FAKE_HOME_TOKEN,
            username="Home User Must Not Leak",
            timezone="Pacific/Honolulu",
        ),
    )

    resolved = resolve_config(environ={}, cwd=cwd, home=home)

    assert resolved.server == "https://cwd.example.test"
    assert resolved.api_key == FAKE_CWD_TOKEN
    assert resolved.username is None
    assert resolved.timezone == "Australia/Brisbane"
    assert resolved.source_files == (cwd_file.absolute(),)


def test_incomplete_cwd_profile_never_inherits_home_secret(tmp_path: Path) -> None:
    cwd = tmp_path / "untrusted-repository"
    home = tmp_path / "home"
    _write_test_config(
        cwd / CONFIG_FILENAME,
        _profile_document(server="https://attacker.example.test", api_key=None),
    )
    _write_test_config(
        home / CONFIG_FILENAME,
        _profile_document(
            server="https://trusted.example.test",
            api_key=FAKE_HOME_TOKEN,
        ),
    )

    with pytest.raises(ConfigurationError, match="refusing to combine credential sources") as exc:
        resolve_config(environ={}, cwd=cwd, home=home)

    assert FAKE_HOME_TOKEN not in str(exc.value)


def test_home_profile_is_used_when_cwd_has_no_credential_file(tmp_path: Path) -> None:
    cwd = tmp_path / "cwd"
    home = tmp_path / "home"
    home_file = _write_test_config(
        home / CONFIG_FILENAME,
        _profile_document(
            server="https://home.example.test",
            api_key=FAKE_HOME_TOKEN,
            username="Home User",
        ),
    )

    resolved = resolve_config(environ={}, cwd=cwd, home=home)

    assert resolved.server == "https://home.example.test"
    assert resolved.api_key == FAKE_HOME_TOKEN
    assert resolved.username == "Home User"
    assert resolved.source_files == (home_file.absolute(),)


def test_explicit_file_is_isolated_from_implicit_files(tmp_path: Path) -> None:
    cwd = tmp_path / "cwd"
    home = tmp_path / "home"
    explicit = _write_test_config(
        tmp_path / "explicit.toml",
        _profile_document(server="https://explicit.example.test", api_key=None),
    )
    _write_test_config(
        cwd / CONFIG_FILENAME,
        _profile_document(server="https://cwd.example.test", api_key=FAKE_CWD_TOKEN),
    )
    _write_test_config(
        home / CONFIG_FILENAME,
        _profile_document(server="https://home.example.test", api_key=FAKE_HOME_TOKEN),
    )

    with pytest.raises(ConfigurationError, match="incomplete in higher-precedence file"):
        resolve_config(explicit_file=explicit, environ={}, cwd=cwd, home=home)


def test_complete_explicit_file_wins_without_loading_implicit_files(tmp_path: Path) -> None:
    cwd = tmp_path / "cwd"
    home = tmp_path / "home"
    explicit = _write_test_config(
        tmp_path / "explicit.toml",
        _profile_document(
            server="https://explicit.example.test",
            api_key=FAKE_EXPLICIT_TOKEN,
        ),
    )
    # If inspected, this insecure implicit file would raise before resolution.
    _write_test_config(
        cwd / CONFIG_FILENAME,
        _profile_document(server="https://cwd.example.test", api_key=FAKE_CWD_TOKEN),
        mode=0o644,
    )

    resolved = resolve_config(explicit_file=explicit, environ={}, cwd=cwd, home=home)

    assert resolved.server == "https://explicit.example.test"
    assert resolved.api_key == FAKE_EXPLICIT_TOKEN
    assert resolved.source_files == (explicit.absolute(),)


@pytest.mark.parametrize(
    ("server_name", "key_name"),
    [
        ("TITRA_URL", "TITRA_API_TOKEN"),
        ("TITRA_SERVER", "TITRA_API_KEY"),
    ],
)
def test_environment_alias_pairs_are_complete_atomic_sources(
    tmp_path: Path,
    server_name: str,
    key_name: str,
) -> None:
    cwd = tmp_path / "cwd"
    home = tmp_path / "home"
    # A process-level complete source must not inspect an insecure repository file.
    _write_test_config(
        cwd / CONFIG_FILENAME,
        _profile_document(server="https://untrusted.example.test", api_key=FAKE_CWD_TOKEN),
        mode=0o644,
    )
    environment = {
        server_name: "https://environment.example.test/",
        key_name: FAKE_ENV_TOKEN,
    }

    resolved = resolve_config(environ=environment, cwd=cwd, home=home)

    assert resolved.server == "https://environment.example.test"
    assert resolved.api_key == FAKE_ENV_TOKEN
    assert resolved.source_files == ()


@pytest.mark.parametrize(
    "environment",
    [
        {"TITRA_URL": "https://only-server.example.test"},
        {"TITRA_API_TOKEN": FAKE_ENV_TOKEN},
    ],
)
def test_partial_process_credentials_fail_instead_of_falling_back_to_files(
    tmp_path: Path,
    environment: dict[str, str],
) -> None:
    home = tmp_path / "home"
    _write_test_config(
        home / CONFIG_FILENAME,
        _profile_document(server="https://home.example.test", api_key=FAKE_HOME_TOKEN),
    )

    with pytest.raises(ConfigurationError, match="provide both server and API key"):
        resolve_config(environ=environment, cwd=tmp_path / "cwd", home=home)


def test_flags_override_environment_as_a_complete_pair(tmp_path: Path) -> None:
    resolved = resolve_config(
        server="https://flags.example.test",
        api_key="fake-flags-token-for-tests-only",
        environ={
            "TITRA_URL": "https://environment.example.test",
            "TITRA_API_TOKEN": FAKE_ENV_TOKEN,
        },
        cwd=tmp_path / "cwd",
        home=tmp_path / "home",
    )

    assert resolved.server == "https://flags.example.test"
    assert resolved.api_key == "fake-flags-token-for-tests-only"


def test_private_regular_credential_file_is_accepted(tmp_path: Path) -> None:
    credential_file = _write_test_config(
        tmp_path / "credentials.toml",
        _profile_document(server="https://safe.example.test", api_key=FAKE_EXPLICIT_TOKEN),
    )

    loaded = load_config_file(credential_file)

    assert loaded["profiles"]["default"]["api_key"] == FAKE_EXPLICIT_TOKEN


@pytest.mark.skipif(os.name != "posix", reason="POSIX permission bits are required")
def test_group_or_other_readable_credential_file_is_rejected(tmp_path: Path) -> None:
    credential_file = _write_test_config(
        tmp_path / "credentials.toml",
        _profile_document(server="https://unsafe.example.test", api_key=FAKE_EXPLICIT_TOKEN),
        mode=0o640,
    )

    with pytest.raises(CredentialSecurityError, match="accessible by group or other users"):
        load_config_file(credential_file)


def test_symlinked_credential_file_is_rejected_when_supported(tmp_path: Path) -> None:
    target = _write_test_config(
        tmp_path / "real-credentials.toml",
        _profile_document(server="https://safe.example.test", api_key=FAKE_EXPLICIT_TOKEN),
    )
    link = tmp_path / "linked-credentials.toml"
    try:
        link.symlink_to(target)
    except (NotImplementedError, OSError) as exc:
        pytest.skip(f"Symbolic links are not available: {exc}")

    with pytest.raises(CredentialSecurityError, match="symlinked credential file"):
        load_config_file(link)


def test_resolved_configuration_redacts_the_entire_token(tmp_path: Path) -> None:
    token = "super-secret-middle-value-never-display"
    resolved = ResolvedConfig(
        profile="production",
        server="https://titra.example.test",
        api_key=token,
        username="Test User",
        timezone="Australia/Brisbane",
        source_files=(tmp_path / "credentials.toml",),
    )

    redacted = resolved.redacted()
    serialized = json.dumps(redacted)

    assert redacted["api_key"] == "<redacted>"
    assert token not in serialized
    assert token[:8] not in serialized
    assert token[-8:] not in serialized


def test_https_url_is_normalized_and_proxy_path_is_preserved(tmp_path: Path) -> None:
    resolved = _resolve_from_process(
        tmp_path,
        server="https://titra.example.test/company/",
    )

    assert resolved.server == "https://titra.example.test/company"
    assert resolved.verify_tls is True


@pytest.mark.parametrize(
    "server",
    [
        "titra.example.test",
        "ftp://titra.example.test",
        "https://user:password@titra.example.test",
        "https://titra.example.test?token=query",
        "https://titra.example.test/#fragment",
    ],
)
def test_unsafe_or_ambiguous_server_urls_are_rejected(tmp_path: Path, server: str) -> None:
    with pytest.raises(ConfigurationError):
        _resolve_from_process(tmp_path, server=server)


def test_non_loopback_http_requires_explicit_tls_opt_out(tmp_path: Path) -> None:
    with pytest.raises(ConfigurationError, match="non-loopback HTTP"):
        _resolve_from_process(tmp_path, server="http://titra.example.test")

    resolved = _resolve_from_process(
        tmp_path,
        server="http://titra.example.test",
        verify_tls=False,
    )

    assert resolved.server == "http://titra.example.test"
    assert resolved.verify_tls is False


@pytest.mark.parametrize("server", ["http://localhost:3000/", "http://127.0.0.1:3000"])
def test_loopback_http_is_allowed_without_disabling_tls(tmp_path: Path, server: str) -> None:
    resolved = _resolve_from_process(tmp_path, server=server)

    assert resolved.server == server.rstrip("/")
    assert resolved.verify_tls is True


def test_write_profile_uses_private_atomic_replacement(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    destination = tmp_path / "private" / "credentials.toml"
    real_replace = os.replace
    observed: dict[str, Any] = {}

    def inspect_then_replace(
        source: str | os.PathLike[str], target: str | os.PathLike[str]
    ) -> None:
        source_path = Path(source)
        target_path = Path(target)
        observed["source"] = source_path
        observed["target"] = target_path
        observed["mode"] = stat.S_IMODE(source_path.stat().st_mode)
        real_replace(source, target)

    monkeypatch.setattr(config_module.os, "replace", inspect_then_replace)

    write_profile(
        destination,
        profile="production",
        server="https://titra.example.test/",
        api_key=FAKE_EXPLICIT_TOKEN,
        username="Test User",
        timezone="Australia/Brisbane",
    )

    assert observed["source"] != destination
    assert observed["source"].parent == destination.parent
    assert observed["target"] == destination
    assert not observed["source"].exists()
    loaded = load_config_file(destination)
    assert loaded == {
        "default_profile": "production",
        "profiles": {
            "production": {
                "server": "https://titra.example.test",
                "api_key": FAKE_EXPLICIT_TOKEN,
                "timezone": "Australia/Brisbane",
                "username": "Test User",
            }
        },
    }
    if os.name == "posix":
        assert observed["mode"] == 0o600
        assert stat.S_IMODE(destination.stat().st_mode) == 0o600
        assert stat.S_IMODE(destination.parent.stat().st_mode) == 0o700


def test_write_profile_does_not_overwrite_existing_profile_without_force(tmp_path: Path) -> None:
    destination = tmp_path / "credentials.toml"
    write_profile(
        destination,
        profile="default",
        server="https://first.example.test",
        api_key="fake-first-token-for-tests-only",
        username=None,
        timezone="Australia/Brisbane",
    )
    original_bytes = destination.read_bytes()

    with pytest.raises(ConfigurationError, match="already exists"):
        write_profile(
            destination,
            profile="default",
            server="https://second.example.test",
            api_key="fake-second-token-for-tests-only",
            username=None,
            timezone="Australia/Brisbane",
        )

    assert destination.read_bytes() == original_bytes


def test_failed_atomic_replacement_removes_temporary_file(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    destination = tmp_path / "private" / "credentials.toml"

    def fail_replace(_source: object, _target: object) -> None:
        raise OSError("simulated replacement failure")

    monkeypatch.setattr(config_module.os, "replace", fail_replace)

    with pytest.raises(ConfigurationError, match="Cannot securely write credential file"):
        write_profile(
            destination,
            profile="default",
            server="https://titra.example.test",
            api_key=FAKE_EXPLICIT_TOKEN,
            username=None,
            timezone="Australia/Brisbane",
        )

    assert not destination.exists()
    assert list(destination.parent.glob(f".{destination.name}.tmp-*")) == []


def test_json_output_has_one_stable_envelope_and_serializes_supported_values() -> None:
    stdout = StringIO()
    fixture = JsonFixture("entry-1", datetime(2026, 8, 30, 1, 2, 3, tzinfo=UTC))
    renderer = Renderer("json", stdout=stdout, stderr=StringIO())

    renderer.emit(fixture, meta={"count": 1})

    assert json.loads(stdout.getvalue()) == {
        "schema": "titra-cli/v1",
        "data": {
            "identifier": "entry-1",
            "happened_at": "2026-08-30T01:02:03+00:00",
        },
        "meta": {"count": 1},
    }
    assert stdout.getvalue().endswith("\n")
    assert len(stdout.getvalue().splitlines()) == 1


def test_json_output_recursively_redacts_known_secret_values_and_secret_keys() -> None:
    secret = "exact-api-token-for-output-test"
    partial = secret[:-1]
    stdout = StringIO()
    renderer = Renderer("json", stdout=stdout, stderr=StringIO(), secrets=[secret])

    renderer.emit(
        {
            "task": f"before:{secret}:after",
            "nested": [
                {"api_key": "unregistered-key-value", "safe": partial},
                {f"field-{secret}": secret},
                {"idempotency_keys": ["must-not-render"]},
            ],
        },
        meta={"authorization": "Bearer another-value"},
    )

    rendered = stdout.getvalue()
    value = json.loads(rendered)
    assert secret not in rendered
    assert value["data"]["task"] == "before:<redacted>:after"
    assert value["data"]["nested"][0] == {
        "api_key": "<redacted>",
        "safe": partial,
    }
    assert value["data"]["nested"][1] == {"field-<redacted>": "<redacted>"}
    assert value["data"]["nested"][2] == {"idempotency_keys": "<redacted>"}
    assert value["meta"]["authorization"] == "<redacted>"


def test_human_output_and_diagnostics_redact_secrets_added_after_construction() -> None:
    secret = "late-bound-api-token"
    stdout = StringIO()
    stderr = StringIO()
    renderer = Renderer("human", color=False, stdout=stdout, stderr=stderr)
    renderer.add_secret(secret)

    renderer.emit(
        {"nested": {"token": "peer-token", "message": f"echo={secret}"}},
        title=f"Result {secret}",
    )
    renderer.warn(f"warning {secret}")
    renderer.status(f"status {secret}")
    renderer.error(f"error {secret}")

    rendered = stdout.getvalue() + stderr.getvalue()
    assert secret not in rendered
    assert "peer-token" not in rendered
    assert "<redacted>" in rendered


def test_jsonl_output_emits_exactly_one_object_per_row() -> None:
    stdout = StringIO()
    renderer = Renderer("jsonl", stdout=stdout, stderr=StringIO())

    renderer.emit([{"_id": "one", "hours": 1}, {"_id": "two", "hours": 2}])

    lines = stdout.getvalue().splitlines()
    assert len(lines) == 2
    assert [json.loads(line) for line in lines] == [
        {"_id": "one", "hours": 1},
        {"_id": "two", "hours": 2},
    ]


@pytest.mark.parametrize(
    ("mode", "delimiter"),
    [("csv", ","), ("tsv", "\t")],
)
def test_delimited_output_has_deterministic_columns_and_round_trips_special_text(
    mode: str,
    delimiter: str,
) -> None:
    stdout = StringIO()
    renderer = Renderer(mode, stdout=stdout, stderr=StringIO())
    renderer.emit(
        [
            {"name": "comma, tab\t and newline\nvalue", "hours": 1.25},
            {"name": "Unicode 🕒", "hours": 2},
        ],
        columns=["name", "hours"],
    )

    parsed = list(csv.DictReader(StringIO(stdout.getvalue()), delimiter=delimiter))

    assert list(parsed[0]) == ["name", "hours"]
    assert parsed == [
        {"name": "comma, tab\t and newline\nvalue", "hours": "1.25"},
        {"name": "Unicode 🕒", "hours": "2"},
    ]


@pytest.mark.parametrize(
    ("dangerous", "expected"),
    [
        ("=1+1", "'=1+1"),
        ("+SUM(A1:A2)", "'+SUM(A1:A2)"),
        ("-2+3", "'-2+3"),
        ("@command", "'@command"),
        ("\ttab-command", "'\ttab-command"),
        ("\rcarriage-return", "'\rcarriage-return"),
        ("\nnewline-command", "'\nnewline-command"),
    ],
)
def test_csv_output_neutralizes_spreadsheet_formula_strings(
    dangerous: str,
    expected: str,
) -> None:
    stdout = StringIO()
    Renderer("csv", stdout=stdout, stderr=StringIO()).emit(
        [{"task": dangerous}],
        columns=["task"],
    )

    parsed = next(csv.DictReader(StringIO(stdout.getvalue())))

    assert parsed["task"] == expected


def test_csv_formula_protection_does_not_change_numbers_or_safe_text() -> None:
    stdout = StringIO()
    Renderer("csv", stdout=stdout, stderr=StringIO()).emit(
        [{"value": -42}, {"value": "ordinary text"}],
        columns=["value"],
    )

    parsed = list(csv.DictReader(StringIO(stdout.getvalue())))

    assert parsed == [{"value": "-42"}, {"value": "ordinary text"}]


def test_id_output_supports_all_documented_identifier_keys() -> None:
    stdout = StringIO()
    renderer = Renderer("id", stdout=stdout, stderr=StringIO())

    renderer.emit(
        [
            {"_id": "mongo-id"},
            {"id": "plain-id"},
            {"timecardId": "timecard-id"},
            {"projectId": "project-id"},
            {"name": "no identifier"},
        ]
    )

    assert stdout.getvalue().splitlines() == [
        "mongo-id",
        "plain-id",
        "timecard-id",
        "project-id",
    ]


def test_human_output_renders_table_and_empty_result_message() -> None:
    stdout = StringIO()
    renderer = Renderer("human", color=False, stdout=stdout, stderr=StringIO())

    renderer.emit(
        [{"project_id": "project-1", "hours": 1.5}],
        title="Time report",
        columns=["project_id", "hours"],
    )

    rendered = stdout.getvalue()
    assert "Time report" in rendered
    assert "Project Id" in rendered
    assert "project-1" in rendered
    assert "1.5" in rendered

    empty_stdout = StringIO()
    Renderer("human", color=False, stdout=empty_stdout, stderr=StringIO()).emit([])
    assert "No results." in empty_stdout.getvalue()


def test_human_output_renders_single_objects_vertically() -> None:
    stdout = StringIO()
    renderer = Renderer("human", color=False, stdout=stdout, stderr=StringIO())

    renderer.emit(
        {
            "_id": "record-1",
            "draft_id": "draft-1",
            "dateRevision": 2,
            "status": "submitted",
            "payloads": [{"hours": 1.5}],
        },
        title="Tracked work",
    )

    rendered = stdout.getvalue()
    assert "Field" in rendered
    assert "Value" in rendered
    assert "Draft Id" in rendered
    assert "draft-1" in rendered
    assert "Date Revision" in rendered
    assert "record-1" in rendered
    assert "Payloads" in rendered
    assert "hours" in rendered


def test_auto_output_uses_json_when_redirected_and_human_when_interactive() -> None:
    redirected = StringIO()
    Renderer("auto", stdout=redirected, stderr=StringIO()).emit({"_id": "entry-1"})
    assert json.loads(redirected.getvalue())["data"] == {"_id": "entry-1"}

    terminal = TtyStringIO()
    Renderer("auto", color=False, stdout=terminal, stderr=StringIO()).emit([{"_id": "entry-1"}])
    assert "entry-1" in terminal.getvalue()
    with pytest.raises(json.JSONDecodeError):
        json.loads(terminal.getvalue())


@pytest.mark.parametrize("mode", ["none", "silent"])
def test_none_and_silent_modes_emit_no_success_output(mode: str) -> None:
    stdout = StringIO()
    stderr = StringIO()
    renderer = Renderer(mode, stdout=stdout, stderr=stderr)

    renderer.emit({"_id": "entry-1"}, title="Must not appear")

    assert stdout.getvalue() == ""
    assert stderr.getvalue() == ""


def test_redirected_human_diagnostics_never_contain_ansi_sequences() -> None:
    stdout = StringIO()
    stderr = StringIO()
    renderer = Renderer("human", color=True, stdout=stdout, stderr=stderr)

    renderer.emit([{"task": "Review", "hours": 1}], title="Report")
    renderer.warn("warning text")
    renderer.status("status text")
    renderer.error("error text")

    assert "\x1b[" not in stdout.getvalue()
    assert "\x1b[" not in stderr.getvalue()
    assert "Warning: warning text" in stderr.getvalue()
    assert "status text" in stderr.getvalue()
    assert "Error: error text" in stderr.getvalue()


def test_machine_output_never_contaminates_stderr() -> None:
    stdout = StringIO()
    stderr = StringIO()

    Renderer(OutputMode.JSON.value, stdout=stdout, stderr=stderr).emit({"ok": True})

    assert json.loads(stdout.getvalue())["data"] == {"ok": True}
    assert stderr.getvalue() == ""


def test_unknown_output_mode_is_a_configuration_error() -> None:
    with pytest.raises(ConfigurationError, match="Unknown output mode"):
        Renderer("xml", stdout=StringIO(), stderr=StringIO())
