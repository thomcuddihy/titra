"""Argument-safe convenience wrapper for the v7 post-deployment suite."""

from __future__ import annotations

import argparse
from collections.abc import Sequence
from typing import NoReturn

from . import selftest


def parser() -> argparse.ArgumentParser:
    value = argparse.ArgumentParser(
        description="Run local checks and a fail-closed live Titra v7 verification."
    )
    source = value.add_mutually_exclusive_group(required=True)
    source.add_argument("--live-url", help="Exact deployed Titra URL.")
    source.add_argument("--profile", help="Profile from the selected/discovered private TOML file.")
    value.add_argument("--credentials", help="Private Titra CLI TOML credential file.")
    value.add_argument("--token-env", default="TITRA_V7_API_TOKEN")
    value.add_argument("--expected-username")
    value.add_argument("--expected-user-id")
    value.add_argument("--project")
    value.add_argument("--record-id")
    value.add_argument("--allow-mutations", action="store_true")
    value.add_argument("--allow-timer", action="store_true")
    value.add_argument("--skip-local", action="store_true")
    value.add_argument("--insecure", action="store_true")
    value.add_argument("--timeout", type=float, default=30.0)
    value.add_argument(
        "--min-command-spacing",
        type=float,
        default=1.0,
        help="Minimum seconds between live CLI process starts (default: %(default)s).",
    )
    value.add_argument(
        "--min-request-spacing",
        type=float,
        default=0.5,
        help=(
            "Minimum seconds between HTTP request starts inside each CLI process "
            "(default: %(default)s)."
        ),
    )
    value.add_argument("--namespace")
    value.add_argument("--resume-cleanup", help="Existing private v6-recovery.json to clean only.")
    value.add_argument("--expected-recovery-marker")
    value.add_argument("--report-json")
    return value


def selftest_arguments(args: argparse.Namespace) -> list[str]:
    if args.allow_timer and not args.allow_mutations:
        raise ValueError("--allow-timer requires --allow-mutations")
    if args.resume_cleanup and (args.allow_mutations or args.allow_timer):
        raise ValueError("--resume-cleanup cannot be combined with new mutation or timer tests")
    if args.resume_cleanup and not args.expected_recovery_marker:
        raise ValueError("--resume-cleanup requires --expected-recovery-marker")
    if args.expected_recovery_marker and not args.resume_cleanup:
        raise ValueError("--expected-recovery-marker requires --resume-cleanup")
    values = [
        "--live-api-version",
        "v7",
        "--token-env",
        args.token_env,
        "--timeout",
        str(args.timeout),
        "--min-command-spacing",
        str(args.min_command_spacing),
        "--min-request-spacing",
        str(args.min_request_spacing),
        "--no-token-prompt",
    ]
    for option, data in (
        ("--live-url", args.live_url),
        ("--credentials", args.credentials),
        ("--profile", args.profile),
        ("--expected-username", args.expected_username),
        ("--expected-user-id", args.expected_user_id),
        ("--project", args.project),
        ("--record-id", args.record_id),
        ("--namespace", args.namespace),
        ("--resume-cleanup", args.resume_cleanup),
        ("--expected-recovery-marker", args.expected_recovery_marker),
        ("--report-json", args.report_json),
    ):
        if data is not None:
            values.extend((option, data))
    if args.allow_mutations:
        values.append("--allow-v7-mutation-tests")
    if args.allow_timer:
        values.append("--allow-v7-timer-tests")
    if args.skip_local:
        values.append("--skip-local")
    if args.insecure:
        values.append("--insecure")
    return values


def main(argv: Sequence[str] | None = None) -> NoReturn:
    selected_parser = parser()
    args = selected_parser.parse_args(argv)
    try:
        values = selftest_arguments(args)
    except ValueError as exc:
        selected_parser.error(str(exc))
    raise SystemExit(selftest.main(values))
