from __future__ import annotations

import pytest

from titra_cli import v7_harness


def test_v7_harness_maps_private_profile_and_all_explicit_gates() -> None:
    args = v7_harness.parser().parse_args(
        [
            "--profile",
            "production-test",
            "--credentials",
            "/home/tester/.titra-cli.toml",
            "--expected-user-id",
            "user-1",
            "--project",
            "project-1",
            "--allow-mutations",
            "--allow-timer",
            "--skip-local",
        ]
    )
    values = v7_harness.selftest_arguments(args)
    assert values[:2] == ["--live-api-version", "v7"]
    assert "--allow-v7-mutation-tests" in values
    assert "--allow-v7-timer-tests" in values
    assert values[values.index("--credentials") + 1] == "/home/tester/.titra-cli.toml"
    assert "production-test" in values
    assert "--no-token-prompt" in values
    assert values[values.index("--min-command-spacing") + 1] == "1.0"
    assert values[values.index("--min-request-spacing") + 1] == "0.5"


def test_v7_harness_maps_url_and_environment_token_without_token_value() -> None:
    args = v7_harness.parser().parse_args(
        [
            "--live-url",
            "https://titra.example.test",
            "--token-env",
            "PRIVATE_TITRA_TOKEN",
        ]
    )
    values = v7_harness.selftest_arguments(args)
    assert "https://titra.example.test" in values
    assert "PRIVATE_TITRA_TOKEN" in values
    assert not any("secret" in value.casefold() for value in values)
    assert "--allow-v7-mutation-tests" not in values


def test_v7_harness_refuses_timer_without_mutation_gate() -> None:
    args = v7_harness.parser().parse_args(["--profile", "test", "--allow-timer"])
    with pytest.raises(ValueError, match="requires --allow-mutations"):
        v7_harness.selftest_arguments(args)


def test_v7_harness_maps_cleanup_only_recovery_and_custom_pacing() -> None:
    marker = "__v7-test_20260904T010203Z_Abcd1234__"
    args = v7_harness.parser().parse_args(
        [
            "--profile",
            "test",
            "--expected-user-id",
            "user-1",
            "--resume-cleanup",
            "/private/run/v6-recovery.json",
            "--expected-recovery-marker",
            marker,
            "--min-command-spacing",
            "1.25",
            "--min-request-spacing",
            "0.5",
        ]
    )
    values = v7_harness.selftest_arguments(args)
    assert values[values.index("--resume-cleanup") + 1] == "/private/run/v6-recovery.json"
    assert values[values.index("--expected-recovery-marker") + 1] == marker
    assert values[values.index("--min-command-spacing") + 1] == "1.25"
    assert values[values.index("--min-request-spacing") + 1] == "0.5"
    assert "--allow-v7-mutation-tests" not in values


@pytest.mark.parametrize(
    "arguments, message",
    [
        (["--profile", "test", "--resume-cleanup", "/x/v6-recovery.json"], "requires"),
        (
            [
                "--profile",
                "test",
                "--expected-recovery-marker",
                "__v7-test_20260904T010203Z_Abcd1234__",
            ],
            "requires",
        ),
        (
            [
                "--profile",
                "test",
                "--resume-cleanup",
                "/x/v6-recovery.json",
                "--expected-recovery-marker",
                "__v7-test_20260904T010203Z_Abcd1234__",
                "--allow-mutations",
            ],
            "cannot be combined",
        ),
    ],
)
def test_v7_harness_recovery_flags_fail_closed(arguments: list[str], message: str) -> None:
    args = v7_harness.parser().parse_args(arguments)
    with pytest.raises(ValueError, match=message):
        v7_harness.selftest_arguments(args)
