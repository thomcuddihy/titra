"""Click command tree and terminal workflows."""

from __future__ import annotations

import hmac
import json
import os
import queue
import re
import sys
import threading
import time
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, NoReturn
from uuid import uuid4
from zoneinfo import ZoneInfo

import click
from rich.live import Live
from rich.text import Text

from . import __version__
from .api import TitraClient, validate_task_edit
from .config import (
    CONFIG_FILENAME,
    DEFAULT_TIMEZONE,
    resolve_config,
    validate_server_url,
    write_profile,
)
from .dates import DateRange, choose_date_range, parse_date, parse_timestamp
from .durations import format_duration, hours_to_seconds, parse_duration, seconds_to_hours
from .errors import (
    AuthenticationError,
    ConfigurationError,
    ConflictError,
    ExitCode,
    OutcomeUnknownError,
    PartialResultError,
    RateLimitError,
    RemoteApiError,
    TitraCliError,
)
from .models import ResolvedConfig
from .output import OutputMode, Renderer, redact_sensitive
from .reporting import calendar_rows, report_meta, summary_rows, timesheet_rows
from .services import (
    fetch_report_dataset,
    project_rows,
    record_preview,
    record_rows,
    resolve_project,
)
from .state import StateStore
from .task_edits import apply_task_edit, prepare_task_edit, reconcile_task_edit
from .timer import (
    TimerManager,
    assert_expected_identity,
    assert_idempotency_retry_within_retention,
)
from .v2_contract import exact_v7_capabilities
from .webhook_delivery import WebhookDeliveryManager, assert_webhook_body_excludes_credentials
from .webhooks import (
    MAX_BODY_BYTES,
    SignedWebhook,
    deliver_webhook,
    read_secret_file,
    sign_webhook,
)

_START_TIME = re.compile(r"^(?:[01]\d|2[0-3]):[0-5]\d$")


def _submit_creation_receipt(
    config: ResolvedConfig,
    client: TitraClient,
    store: StateStore,
    receipt: dict[str, Any],
    *,
    retry: bool = False,
) -> tuple[str, Path]:
    store.add_secret(config.api_key)
    if receipt.get("profile") != config.profile or str(receipt.get("server", "")).rstrip(
        "/"
    ) != config.server.rstrip("/"):
        raise ConfigurationError("Creation receipt belongs to a different profile or server.")
    operation = receipt.get("operation")
    payload = receipt.get("payload")
    key = receipt.get("idempotency_key")
    owner_id = receipt.get("owner_id")
    created_at = receipt.get("created_at")
    if (
        receipt.get("schema") != "titra-cli/create-receipt/v2"
        or operation not in {"project.create", "project-task.create", "timeentry.create"}
        or not isinstance(payload, dict)
        or not isinstance(key, str)
        or not isinstance(owner_id, str)
        or not owner_id
        or not isinstance(created_at, str)
        or not created_at
    ):
        raise ConfigurationError("Creation receipt is malformed.")
    current_user = assert_expected_identity(client, config)
    if current_user.get("_id") != owner_id:
        raise ConflictError(
            "Creation receipt belongs to a different API user and was left untouched."
        )
    if not client.supports_idempotent_create(str(operation)):
        raise ConfigurationError(
            "This server does not advertise durable idempotent creation; refusing receipt retry."
        )
    if retry:
        assert_idempotency_retry_within_retention(client, created_at)
    receipt["status"] = "submitting"
    path = store.save_creation_receipt(receipt)
    try:
        recovery_result: dict[str, Any] | None = None
        if retry:
            recovery_result = client.recover_idempotent_create(
                str(operation),
                payload,
                idempotency_key=key,
            )
            result_id = recovery_result.get("result_id")
            if (
                set(recovery_result)
                != {
                    "operation",
                    "result_id",
                    "idempotency_replayed",
                    "idempotency_expires_at",
                }
                or recovery_result.get("operation") != operation
                or not isinstance(result_id, str)
                or not result_id
                or type(recovery_result.get("idempotency_replayed")) is not bool
                or not isinstance(recovery_result.get("idempotency_expires_at"), str)
                or not recovery_result["idempotency_expires_at"]
            ):
                raise OutcomeUnknownError(
                    "Idempotent create recovery returned an inconsistent result; reconcile "
                    "before retrying."
                )
        elif operation == "project.create":
            result_id = client.create_project(payload, idempotency_key=key)
        elif operation == "project-task.create":
            result_id = client.create_task(payload, idempotency_key=key)
        else:
            result_id = client.create_time_entry(payload, idempotency_key=key)
    except BaseException:
        receipt["status"] = "outcome_unknown"
        store.save_creation_receipt(receipt)
        raise
    receipt["status"] = "completed"
    receipt["result_id"] = result_id
    if recovery_result is not None:
        receipt["recovery"] = redact_sensitive(
            recovery_result,
            secrets=(config.api_key,),
        )
    path = store.save_creation_receipt(receipt)
    return result_id, path


def _verify_creation_receipt_replay(
    config: ResolvedConfig,
    client: TitraClient,
    store: StateStore,
    receipt: dict[str, Any],
    *,
    expected_result_id: str,
) -> tuple[dict[str, Any], Path]:
    """Replay a completed create without replacing its original receipt evidence."""

    store.add_secret(config.api_key)
    if receipt.get("profile") != config.profile or str(receipt.get("server", "")).rstrip(
        "/"
    ) != config.server.rstrip("/"):
        raise ConfigurationError("Creation receipt belongs to a different profile or server.")
    operation = receipt.get("operation")
    payload = receipt.get("payload")
    key = receipt.get("idempotency_key")
    owner_id = receipt.get("owner_id")
    created_at = receipt.get("created_at")
    result_id = receipt.get("result_id")
    if (
        receipt.get("schema") != "titra-cli/create-receipt/v2"
        or receipt.get("status") != "completed"
        or operation not in {"project.create", "project-task.create", "timeentry.create"}
        or not isinstance(payload, dict)
        or not payload
        or not isinstance(key, str)
        or not key
        or not isinstance(owner_id, str)
        or not owner_id
        or not isinstance(created_at, str)
        or not created_at
        or not isinstance(result_id, str)
        or not result_id
    ):
        raise ConfigurationError("Completed creation receipt is malformed.")
    if not hmac.compare_digest(result_id, expected_result_id):
        raise ConflictError(
            "--expect-result-id does not match the creation receipt's stored result ID."
        )
    current_user = assert_expected_identity(client, config)
    if current_user.get("_id") != owner_id:
        raise ConflictError(
            "Creation receipt belongs to a different API user and was left untouched."
        )
    assert_idempotency_retry_within_retention(client, created_at)
    marker: dict[str, Any] = {
        "status": "replay_verifying",
        "started_at": datetime.now(UTC).isoformat(timespec="seconds"),
        "expected_result_id": result_id,
    }
    receipt["replay_verification"] = marker
    path = store.save_creation_receipt(receipt)
    try:
        observed = client.replay_idempotent_create(
            str(operation),
            payload,
            idempotency_key=key,
            expected_result_id=result_id,
        )
    except BaseException as exc:
        marker["status"] = "replay_outcome_unknown"
        marker["checked_at"] = datetime.now(UTC).isoformat(timespec="seconds")
        marker["error_type"] = type(exc).__name__
        details = getattr(exc, "details", None)
        if isinstance(details, dict):
            marker["observation"] = redact_sensitive(details, secrets=(config.api_key,))
        receipt["replay_verification"] = marker
        store.save_creation_receipt(receipt)
        raise
    marker.update(
        {
            "status": "verified",
            "checked_at": datetime.now(UTC).isoformat(timespec="seconds"),
            "observation": redact_sensitive(observed, secrets=(config.api_key,)),
        }
    )
    receipt["replay_verification"] = marker
    path = store.save_creation_receipt(receipt)
    return {
        "receipt_id": receipt["receipt_id"],
        "operation": operation,
        "status": receipt["status"],
        "replay_status": "verified",
        **observed,
    }, path


class ReportedClickError(click.ClickException):
    def __init__(self, error: TitraCliError) -> None:
        retry_suffix = (
            f" Retry after {error.retry_after_seconds} seconds."
            if isinstance(error, RateLimitError) and error.retry_after_seconds is not None
            else ""
        )
        super().__init__(f"{error}{retry_suffix}")
        self.__dict__["exit_code"] = int(error.exit_code)


class SafeGroup(click.Group):
    def invoke(self, ctx: click.Context) -> Any:
        try:
            return super().invoke(ctx)
        except TitraCliError as exc:
            raise ReportedClickError(exc) from exc


@dataclass(slots=True)
class AppContext:
    profile: str | None
    server: str | None
    api_key: str | None
    username: str | None
    timezone_name: str | None
    credentials: Path | None
    output_mode: str
    color: bool
    verify_tls: bool
    timeout: float
    state_dir: Path | None
    expected_user_id: str | None = None
    _config: ResolvedConfig | None = field(default=None, init=False)
    _renderer: Renderer | None = field(default=None, init=False)

    @property
    def renderer(self) -> Renderer:
        if self._renderer is None:
            self._renderer = Renderer(
                self.output_mode,
                color=self.color,
                secrets=[self.api_key] if self.api_key else (),
            )
        return self._renderer

    @property
    def store(self) -> StateStore:
        configured = self.state_dir or (
            Path(os.environ["TITRA_STATE_DIR"]) if os.environ.get("TITRA_STATE_DIR") else None
        )
        secret = self._config.api_key if self._config is not None else self.api_key
        return StateStore(configured, secrets=[secret] if secret else ())

    def resolve(self, *, interactive: bool = False) -> ResolvedConfig:
        if self._config is None:
            can_prompt = interactive and sys.stdin.isatty()
            self._config = resolve_config(
                profile=self.profile,
                server=self.server,
                api_key=self.api_key,
                username=self.username,
                timezone=self.timezone_name,
                explicit_file=self.credentials,
                verify_tls=self.verify_tls,
                timeout=self.timeout,
                interactive=can_prompt,
                prompt_text=lambda label: click.prompt(label, err=True),
                prompt_secret=lambda label: click.prompt(label, hide_input=True, err=True),
            )
            self.renderer.add_secret(self._config.api_key)
        return self._config

    @contextmanager
    def client(self, *, interactive: bool = False) -> Iterator[tuple[ResolvedConfig, TitraClient]]:
        config = self.resolve(interactive=interactive)
        with TitraClient(config) as client:
            if self.expected_user_id is not None:
                client.bind_expected_user_id(self.expected_user_id)
            try:
                yield config, client
            except TitraCliError as exc:
                # Remote error messages may echo request credentials; never display them.
                exc.message = exc.message.replace(config.api_key, "<redacted>")
                raise


def _today(config: ResolvedConfig) -> datetime:
    return datetime.now(ZoneInfo(config.timezone))


def _require_confirmation(app: AppContext, message: str, *, yes: bool) -> bool:
    if yes:
        return True
    if not _terminal_is_interactive():
        raise ConfigurationError(f"{message} Re-run with --yes for noninteractive use.")
    return click.confirm(message, default=False, err=True)


def _terminal_is_interactive() -> bool:
    """Keep terminal detection in one place so menu behavior is testable."""

    return sys.stdin.isatty()


def _preview_then_confirm(
    app: AppContext,
    preview: dict[str, Any],
    *,
    title: str,
    message: str,
    yes: bool,
) -> bool:
    """Show the exact pending mutation before an interactive confirmation."""

    # Load local credentials before rendering user-controlled fields so a value equal
    # to the API token is redacted even when the operator ultimately cancels.
    app.resolve()
    if not yes and _terminal_is_interactive():
        app.renderer.error_console.print(f"{app.renderer.sanitize(title)}:")
        app.renderer.error_console.print_json(
            json.dumps(app.renderer.sanitize(preview), ensure_ascii=False, default=str)
        )
    return _require_confirmation(app, message, yes=yes)


def _parse_customfields(value: str | None) -> dict[str, Any] | None:
    if value is None:
        return None
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError as exc:
        raise ConfigurationError(f"Invalid --custom-fields JSON: {exc}") from exc
    if not isinstance(parsed, dict):
        raise ConfigurationError("--custom-fields must be a JSON object.")
    return parsed


def _parse_json_object(value: str, label: str) -> dict[str, Any]:
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError as exc:
        raise ConfigurationError(f"Invalid {label} JSON: {exc}") from exc
    if not isinstance(parsed, dict) or not parsed:
        raise ConfigurationError(f"{label} must be a nonempty JSON object.")
    return parsed


def _date_range_from_options(config: ResolvedConfig, options: dict[str, Any]) -> DateRange:
    return choose_date_range(
        from_date=options.get("from_date"),
        to_date=options.get("to_date"),
        today=bool(options.get("today")),
        week=bool(options.get("week")),
        month=bool(options.get("month")),
        calendar_month=options.get("calendar_month"),
        now=_today(config).date(),
    )


def date_range_options(function: Any) -> Any:
    options = [
        click.option("--calendar-month", metavar="YYYY-MM", help="One complete calendar month."),
        click.option("--month", is_flag=True, help="Current calendar month."),
        click.option("--week", is_flag=True, help="Current Monday-to-Sunday week."),
        click.option("--today", is_flag=True, help="Current calendar day."),
        click.option("--to", "to_date", metavar="YYYY-MM-DD"),
        click.option("--from", "from_date", metavar="YYYY-MM-DD"),
    ]
    for option in reversed(options):
        function = option(function)
    return function


@click.group(cls=SafeGroup, invoke_without_command=True, no_args_is_help=False)
@click.option("--profile", help="Named profile from the credential file.")
@click.option("--server", metavar="URL", help="Titra server URL; pair with --api-key.")
@click.option("--username", help="Expected Titra display name and local profile label.")
@click.option(
    "--api-key", help="Titra API key (prefer a credential file or TITRA_API_KEY).", hide_input=True
)
@click.option(
    "--credentials",
    type=click.Path(path_type=Path, dir_okay=False),
    help="Use only this credential TOML file.",
)
@click.option("--timezone", "timezone_name", help="IANA reporting timezone.")
@click.option(
    "--output",
    "output_mode",
    type=click.Choice([value.value for value in OutputMode], case_sensitive=False),
    default="auto",
    show_default=True,
)
@click.option("--color/--no-color", default=True, show_default=True)
@click.option(
    "--insecure",
    is_flag=True,
    help="Allow non-loopback HTTP or disable TLS certificate verification.",
)
@click.option("--timeout", type=click.FloatRange(min=0.1), default=20.0, show_default=True)
@click.option("--state-dir", type=click.Path(path_type=Path, file_okay=False))
@click.option(
    "--expect-user-id",
    "expected_user_id",
    help="Pin authenticated requests to this immutable user ID.",
)
@click.version_option(__version__)
@click.pass_context
def cli(
    ctx: click.Context,
    profile: str | None,
    server: str | None,
    username: str | None,
    api_key: str | None,
    credentials: Path | None,
    timezone_name: str | None,
    output_mode: str,
    color: bool,
    insecure: bool,
    timeout: float,
    state_dir: Path | None,
    expected_user_id: str | None,
) -> None:
    """Track time, manage projects, and report against a Titra server."""

    ctx.obj = AppContext(
        profile,
        server,
        api_key,
        username,
        timezone_name,
        credentials,
        output_mode,
        color,
        not insecure,
        timeout,
        state_dir,
        expected_user_id,
    )
    if ctx.invoked_subcommand is None:
        if sys.stdin.isatty() and sys.stdout.isatty():
            ctx.invoke(interactive_command)
        else:
            click.echo(ctx.get_help())


@cli.group("config", cls=SafeGroup)
def config_group() -> None:
    """Create, inspect, and validate credential profiles."""


@config_group.command("init")
@click.option("--file", "file_path", type=click.Path(path_type=Path, dir_okay=False))
@click.option("--profile", "profile_name", default="default", show_default=True)
@click.option("--server", prompt=True)
@click.option("--username")
@click.option("--api-key", prompt=True, hide_input=True)
@click.option("--timezone", "timezone_name", default=DEFAULT_TIMEZONE, show_default=True)
@click.option("--default/--no-default", "make_default", default=True)
@click.option("--allow-insecure-http", is_flag=True)
@click.option("--force", is_flag=True, help="Replace an existing profile.")
@click.pass_obj
def config_init(
    app: AppContext,
    file_path: Path | None,
    profile_name: str,
    server: str,
    username: str | None,
    api_key: str,
    timezone_name: str,
    make_default: bool,
    allow_insecure_http: bool,
    force: bool,
) -> None:
    """Securely create or update a named profile."""

    destination = file_path or (Path.home() / CONFIG_FILENAME)
    write_profile(
        destination,
        profile=profile_name,
        server=server,
        api_key=api_key,
        username=username,
        timezone=timezone_name,
        make_default=make_default,
        overwrite_profile=force,
        allow_insecure_http=allow_insecure_http,
    )
    app.renderer.emit(
        {"file": str(destination.expanduser().absolute()), "profile": profile_name},
        title="Credential profile created",
        columns=["file", "profile"],
    )


@config_group.command("show")
@click.pass_obj
def config_show(app: AppContext) -> None:
    """Show resolved settings with the API key fully redacted."""

    app.renderer.emit(app.resolve(interactive=False).redacted(), title="Resolved configuration")


@config_group.command("check")
@click.pass_obj
def config_check(app: AppContext) -> None:
    """Validate credentials against the configured server."""

    _check_auth(app)


def _check_auth(app: AppContext) -> None:
    with app.client() as (config, client):
        user = assert_expected_identity(client, config)
        app.renderer.emit(
            {"ok": True, "profile": config.profile, "server": config.server, "user": user},
            title="Authentication successful",
        )


@cli.group("auth", cls=SafeGroup)
def auth_group() -> None:
    """Authentication checks."""


@auth_group.command("check")
@click.pass_obj
def auth_check(app: AppContext) -> None:
    """Confirm the key and optional expected username."""

    _check_auth(app)


_REQUIRED_V6_FEATURES = {
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
}

_REQUIRED_V6_CONTRACTS = {
    "dateOnly": 1,
    "timecardRevisionETag": 1,
    "resourceRevisionETag": 1,
    "projectUserPrivacy": 1,
    "projectFenceRecovery": 1,
    "webhookHmacSha256": 1,
}


def _v6_capability_gaps(
    document: dict[str, Any] | None, *, minimum_capabilities_version: int = 2
) -> list[str]:
    if not isinstance(document, dict):
        return ["capabilities/v2 document"]
    gaps: list[str] = []
    if document.get("apiVersion") != 2:
        gaps.append("apiVersion=2")
    capabilities_version = document.get("capabilitiesVersion")
    if type(capabilities_version) is not int or capabilities_version < minimum_capabilities_version:
        gaps.append(f"capabilitiesVersion>={minimum_capabilities_version}")
    features = document.get("features")
    for group, expected in _REQUIRED_V6_FEATURES.items():
        actual_group = features.get(group) if isinstance(features, dict) else None
        for feature, minimum in expected.items():
            actual = actual_group.get(feature) if isinstance(actual_group, dict) else None
            if type(actual) is not int or actual < minimum:
                gaps.append(f"features.{group}.{feature}>={minimum}")
    contracts = document.get("contracts")
    for contract, minimum in _REQUIRED_V6_CONTRACTS.items():
        actual = contracts.get(contract) if isinstance(contracts, dict) else None
        if type(actual) is not int or actual < minimum:
            gaps.append(f"contracts.{contract}>={minimum}")
    errors = contracts.get("errors") if isinstance(contracts, dict) else None
    if not isinstance(errors, dict) or errors.get("version") != 1:
        gaps.append("contracts.errors.version=1")
    expected_user = contracts.get("expectedUserId") if isinstance(contracts, dict) else None
    if expected_user != {
        "version": 1,
        "header": "X-Titra-Expected-User-Id",
        "appliesTo": "authenticatedRequests",
        "required": False,
        "mismatchStatus": 412,
    }:
        gaps.append("contracts.expectedUserId exact v1 contract")
    webhook_retry = contracts.get("webhookRetry") if isinstance(contracts, dict) else None
    if webhook_retry != {
        "version": 1,
        "authenticationTimestamp": "fresh",
        "actionTimestamp": "original",
        "configurationBinding": "revision",
        "retentionSeconds": 604800,
        "clientSafetyMarginSeconds": 600,
    }:
        gaps.append("contracts.webhookRetry exact v1 contract")
    timer_start_replay = contracts.get("timerStartReplay") if isinstance(contracts, dict) else None
    if timer_start_replay != {
        "version": 1,
        "scope": "user",
        "activeReplay": "returnExisting",
        "consumedReplay": "conflict",
        "consumedErrorCode": "timer-operation-consumed",
        "retentionSeconds": 604800,
        "clientSafetyMarginSeconds": 600,
    }:
        gaps.append("contracts.timerStartReplay exact v1 contract")
    limits = document.get("limits")
    if not isinstance(limits, dict) or limits.get("timerStartRetainedOperations") != 4096:
        gaps.append("limits.timerStartRetainedOperations=4096")
    mutation_contract = document.get("mutationPreconditions")
    if not isinstance(mutation_contract, dict) or mutation_contract.get("version") != 2:
        gaps.append("mutationPreconditions.version=2")
    idempotency = document.get("idempotency")
    if not isinstance(idempotency, dict) or idempotency.get("version") != 1:
        gaps.append("idempotency.version=1")
    pagination = document.get("timeEntryPagination")
    if not isinstance(pagination, dict) or pagination.get("version") != 1:
        gaps.append("timeEntryPagination.version=1")
    deployment = document.get("deployment")
    for flag in ("projectFenceRecoveryEnabled", "webhookActionVerificationEnabled"):
        if not isinstance(deployment, dict) or type(deployment.get(flag)) is not bool:
            gaps.append(f"deployment.{flag}=boolean")
    return gaps


@cli.group("capabilities", cls=SafeGroup)
def capabilities_group() -> None:
    """Inspect or require an advertised API capability contract."""


@capabilities_group.command("show")
@click.option(
    "--version",
    "version_name",
    type=click.Choice(["auto", "1", "2"]),
    default="auto",
    show_default=True,
)
@click.pass_obj
def capabilities_show(app: AppContext, version_name: str) -> None:
    """Show the negotiated, v1, or v2 capability document without probing a write."""

    with app.client() as (_config, client):
        if version_name == "1":
            document = client.capabilities_v1()
        elif version_name == "2":
            document = client.capabilities_v2()
        else:
            document = client.capabilities()
        source = client.capability_source
    if document is None:
        raise ConfigurationError(f"Titra does not advertise an API v{version_name} contract.")
    app.renderer.emit(
        {"source": source, "document": document},
        title="Titra API capabilities",
    )


@capabilities_group.command("check")
@click.option("--require-v6", is_flag=True, help="Require the complete v6 capability contract.")
@click.option(
    "--require-v7",
    is_flag=True,
    help="Require the exact v7 capability/security contract and HTTP-header profile.",
)
@click.pass_obj
def capabilities_check(app: AppContext, require_v6: bool, require_v7: bool) -> None:
    """Validate discovery, optionally requiring the complete v6 or v7 profile."""

    if require_v6 and require_v7:
        raise ConfigurationError("Use only one of --require-v6 or --require-v7.")
    with app.client() as (_config, client):
        document = client.capabilities_v2() if (require_v6 or require_v7) else client.capabilities()
        source = client.capability_source
        deployment = document.get("deployment") if isinstance(document, dict) else None
        contracts = document.get("contracts") if isinstance(document, dict) else None
        security_deployment = deployment.get("security") if isinstance(deployment, dict) else None
        hsts_enabled = bool(
            isinstance(security_deployment, dict) and security_deployment.get("hstsEnabled") is True
        )
        transport_security = (
            client.api_security_headers_report(require_hsts=hsts_enabled) if require_v7 else None
        )
        security = (
            {
                "contract": contracts.get("security") if isinstance(contracts, dict) else None,
                "deployment": security_deployment,
                "http": transport_security,
            }
            if require_v7
            else None
        )
    if document is None:
        raise ConfigurationError("Titra does not expose a recognized capability document.")
    gaps = (
        _v6_capability_gaps(document, minimum_capabilities_version=3 if require_v7 else 2)
        if (require_v6 or require_v7)
        else []
    )
    if require_v7 and not exact_v7_capabilities(document):
        gaps.append("exact capabilitiesVersion=3 security-v7 contract")
    if require_v7 and transport_security is not None:
        gaps.extend(f"HTTP header {name}" for name in transport_security["missing_or_mismatched"])
    if gaps:
        raise ConfigurationError(
            f"The server does not satisfy the complete {'v7' if require_v7 else 'v6'} profile: "
            + ", ".join(gaps)
        )
    app.renderer.emit(
        {
            "ok": True,
            "requirement": "v7" if require_v7 else ("v6" if require_v6 else "recognized"),
            "source": source,
            "apiVersion": document.get("apiVersion"),
            "capabilitiesVersion": document.get("capabilitiesVersion"),
            **({"security": security} if security is not None else {}),
            "missing": [],
        },
        title="API capability check passed",
    )


@cli.group("security", cls=SafeGroup)
def security_group() -> None:
    """Inspect v7 HTTP/API security behavior."""


@security_group.command("check")
@click.option(
    "--require-hsts",
    is_flag=True,
    help="Also require the explicit one-year HSTS deployment setting.",
)
@click.pass_obj
def security_check(app: AppContext, require_hsts: bool) -> None:
    """Require the v7 response-header profile on the authenticated API."""

    with app.client() as (_config, client):
        report = client.api_security_headers_report(require_hsts=require_hsts)
    if not report["ok"]:
        raise ConfigurationError(
            "The server does not satisfy the v7 HTTP security profile: "
            + ", ".join(report["missing_or_mismatched"])
        )
    app.renderer.emit(report, title="V7 API security check passed")


_ENVIRONMENT_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


def _webhook_options(function: Any) -> Any:
    options = [
        click.option("--request-id", help="Stable 16-80 character request identifier."),
        click.option("--timestamp", type=int, help="Unix timestamp; defaults to the current time."),
        click.option("--secret-file", type=click.Path(path_type=Path, dir_okay=False)),
        click.option("--secret-env", help="Environment variable containing the webhook secret."),
        click.option(
            "--file",
            "payload_file",
            type=click.Path(path_type=Path, dir_okay=False),
            help="Exact JSON body file; omit to read the body from standard input.",
        ),
        click.option("--event-id", help="Unique provider event ID; generated when omitted."),
        click.option("--endpoint-id", required=True, help="Configured 32-hex webhook endpoint ID."),
    ]
    for option in reversed(options):
        function = option(function)
    return function


def _read_webhook_body(payload_file: Path | None) -> bytes:
    if payload_file is not None:
        try:
            with payload_file.open("rb") as handle:
                value = handle.read(MAX_BODY_BYTES + 1)
        except OSError as exc:
            raise ConfigurationError(f"Cannot read webhook JSON file: {payload_file}") from exc
        if len(value) > MAX_BODY_BYTES:
            raise ConfigurationError(
                f"Webhook body exceeds the {MAX_BODY_BYTES}-byte receiver limit."
            )
        return value
    if _terminal_is_interactive():
        raise ConfigurationError(
            "Use --file in a terminal, or pipe one exact JSON object to stdin."
        )
    stream = getattr(sys.stdin, "buffer", sys.stdin)
    stream_value: Any = stream.read(MAX_BODY_BYTES + 1)
    encoded = stream_value.encode("utf-8") if isinstance(stream_value, str) else stream_value
    if len(encoded) > MAX_BODY_BYTES:
        raise ConfigurationError(f"Webhook body exceeds the {MAX_BODY_BYTES}-byte receiver limit.")
    return encoded


def _read_webhook_secret(
    *, secret_env: str | None, secret_file: Path | None, api_key: str | None
) -> str:
    if secret_env and secret_file:
        raise ConfigurationError("Use only one of --secret-env or --secret-file.")
    if secret_file is not None:
        secret = read_secret_file(secret_file)
    elif secret_env:
        if _ENVIRONMENT_NAME.fullmatch(secret_env) is None:
            raise ConfigurationError("--secret-env must be a valid environment variable name.")
        secret = os.environ.get(secret_env, "")
        if not secret:
            raise ConfigurationError(f"Webhook secret environment variable {secret_env} is empty.")
    elif _terminal_is_interactive():
        secret = click.prompt("Webhook HMAC secret", hide_input=True, err=True)
    else:
        raise ConfigurationError("Supply the webhook secret through --secret-env or --secret-file.")
    if api_key and hmac.compare_digest(secret.encode("utf-8"), api_key.encode("utf-8")):
        raise ConfigurationError("The webhook HMAC secret must not be the Titra API key.")
    return secret


def _safe_webhook_preview(signed: SignedWebhook, *, server: str) -> dict[str, Any]:
    preview = signed.redacted_preview()
    headers = dict(preview["headers"])
    headers["X-Titra-Webhook-Signature"] = "<redacted>"
    preview["headers"] = headers
    preview["server"] = server
    return preview


def _resolve_webhook_config(app: AppContext) -> ResolvedConfig:
    """Resolve only the destination settings needed by the separately signed webhook.

    An explicitly selected credential file/profile must not be replaced by an
    inherited Titra connection pair.  Conversely, an explicit or inherited
    server may be used without an API key because the receiver authenticates
    the HMAC signature, not a Bearer token.
    """

    if app.credentials is not None or app.profile is not None:
        if app.server is not None or app.api_key is not None:
            raise ConfigurationError(
                "For webhook delivery, do not combine --credentials/--profile with "
                "--server/--api-key."
            )
        isolated_environment = {
            key: value
            for key, value in os.environ.items()
            if key.upper() not in {"TITRA_SERVER", "TITRA_URL", "TITRA_API_KEY", "TITRA_API_TOKEN"}
        }
        config = resolve_config(
            profile=app.profile,
            username=app.username,
            timezone=app.timezone_name,
            explicit_file=app.credentials,
            verify_tls=app.verify_tls,
            timeout=app.timeout,
            environ=isolated_environment,
            interactive=False,
        )
        app._config = config
        app.renderer.add_secret(config.api_key)
        return config

    explicit_server = app.server.strip() if isinstance(app.server, str) else ""
    explicit_api_key = app.api_key.strip() if isinstance(app.api_key, str) else ""
    if explicit_server and not explicit_api_key:
        # `--server` is a deliberate HMAC-only destination. Never pair it with an
        # unrelated API token inherited from the shell and then authenticate that
        # token against an operator-selected host.
        ambient_api_key = (
            os.environ.get("TITRA_API_KEY", "").strip()
            or os.environ.get("TITRA_API_TOKEN", "").strip()
        )
        app.renderer.add_secret(ambient_api_key)
        if app.timeout <= 0:
            raise ConfigurationError("Timeout must be greater than zero.")
        config = ResolvedConfig(
            profile="webhook",
            server=validate_server_url(
                explicit_server,
                allow_insecure_http=not app.verify_tls,
            ),
            api_key="",
            username=None,
            timezone=DEFAULT_TIMEZONE,
            verify_tls=app.verify_tls,
            timeout=app.timeout,
        )
        app._config = config
        return config

    if app._config is not None:
        return app.resolve(interactive=False)

    environment_server = (
        os.environ.get("TITRA_SERVER", "").strip() or os.environ.get("TITRA_URL", "").strip()
    )
    process_api_key = explicit_api_key or (
        os.environ.get("TITRA_API_KEY", "").strip() or os.environ.get("TITRA_API_TOKEN", "").strip()
    )
    selected_server = explicit_server or environment_server
    if selected_server and not process_api_key:
        if app.timeout <= 0:
            raise ConfigurationError("Timeout must be greater than zero.")
        config = ResolvedConfig(
            profile="webhook",
            server=validate_server_url(
                selected_server,
                allow_insecure_http=not app.verify_tls,
            ),
            api_key="",
            username=None,
            timezone=DEFAULT_TIMEZONE,
            verify_tls=app.verify_tls,
            timeout=app.timeout,
        )
        app._config = config
        return config
    return app.resolve(interactive=False)


def _webhook_sensitive_api_key(app: AppContext, config: ResolvedConfig) -> str | None:
    """Return credentials that must be blocked even when explicit-server mode ignores them."""

    if config.api_key:
        return config.api_key
    explicit_server = app.server.strip() if isinstance(app.server, str) else ""
    explicit_api_key = app.api_key.strip() if isinstance(app.api_key, str) else ""
    if explicit_server and not explicit_api_key:
        return (
            os.environ.get("TITRA_API_KEY", "").strip()
            or os.environ.get("TITRA_API_TOKEN", "").strip()
            or None
        )
    return None


def _prepare_webhook(
    app: AppContext,
    *,
    endpoint_id: str,
    event_id: str | None,
    payload_file: Path | None,
    secret_env: str | None,
    secret_file: Path | None,
    timestamp: int | None,
    request_id: str | None,
) -> tuple[ResolvedConfig, SignedWebhook, dict[str, Any], str]:
    config = _resolve_webhook_config(app)
    sensitive_api_key = _webhook_sensitive_api_key(app, config)
    app.renderer.add_secret(sensitive_api_key)
    body = _read_webhook_body(payload_file)
    secret = _read_webhook_secret(
        secret_env=secret_env,
        secret_file=secret_file,
        api_key=sensitive_api_key,
    )
    assert_webhook_body_excludes_credentials(
        body,
        api_key=sensitive_api_key,
        secret=secret,
    )
    signed = sign_webhook(
        endpoint_id=endpoint_id,
        event_id=event_id or f"titra-cli:{uuid4().hex}",
        body=body,
        secret=secret,
        timestamp=timestamp,
        request_id=request_id,
    )
    return config, signed, _safe_webhook_preview(signed, server=config.server), secret


@cli.group("webhook", cls=SafeGroup)
def webhook_group() -> None:
    """Prepare or send separately authenticated v6 action-verification webhooks."""


@webhook_group.command("prepare")
@_webhook_options
@click.pass_obj
def webhook_prepare(
    app: AppContext,
    endpoint_id: str,
    event_id: str | None,
    payload_file: Path | None,
    secret_env: str | None,
    secret_file: Path | None,
    timestamp: int | None,
    request_id: str | None,
) -> None:
    """Validate and sign an exact body, emitting only a redacted delivery preview."""

    _config, _signed, preview, _secret = _prepare_webhook(
        app,
        endpoint_id=endpoint_id,
        event_id=event_id,
        payload_file=payload_file,
        secret_env=secret_env,
        secret_file=secret_file,
        timestamp=timestamp,
        request_id=request_id,
    )
    app.renderer.emit(preview, title="Signed webhook preview")


@webhook_group.command("send")
@_webhook_options
@click.option("--yes", is_flag=True, help="Approve this exact signed delivery noninteractively.")
@click.pass_obj
def webhook_send(
    app: AppContext,
    endpoint_id: str,
    event_id: str | None,
    payload_file: Path | None,
    secret_env: str | None,
    secret_file: Path | None,
    timestamp: int | None,
    request_id: str | None,
    yes: bool,
) -> None:
    """Send one exact signed body without attaching the Titra API token."""

    config, signed, preview, secret = _prepare_webhook(
        app,
        endpoint_id=endpoint_id,
        event_id=event_id,
        payload_file=payload_file,
        secret_env=secret_env,
        secret_file=secret_file,
        timestamp=timestamp,
        request_id=request_id,
    )
    if not _preview_then_confirm(
        app,
        preview,
        title="Signed webhook delivery preview",
        message="Send this exact signed webhook event?",
        yes=yes,
    ):
        return
    owner_id = _webhook_owner_id(app, config)
    store = app.store
    store.add_secret(_webhook_sensitive_api_key(app, config))
    result, _receipt = WebhookDeliveryManager(
        config,
        store,
        deliver=deliver_webhook,
    ).send_initial(
        signed,
        owner_id=owner_id,
        secret=secret,
    )
    app.renderer.emit(result, title="Webhook delivery accepted", id_key="event_id")


def _webhook_owner_id(
    app: AppContext,
    config: ResolvedConfig,
) -> str | None:
    """Bind a receipt to API identity only when this delivery has an API profile."""

    if not config.api_key:
        return None
    try:
        with TitraClient(config) as client:
            if app.expected_user_id is not None:
                client.bind_expected_user_id(app.expected_user_id)
            user = assert_expected_identity(client, config)
    except TitraCliError as exc:
        exc.message = str(app.renderer.sanitize(exc.message))
        raise
    return str(user["_id"])


@webhook_group.command("list")
@click.pass_obj
def webhook_list(app: AppContext) -> None:
    """List durable delivery receipts for the current profile, server, and owner."""

    config = _resolve_webhook_config(app)
    owner_id = _webhook_owner_id(app, config)
    store = app.store
    store.add_secret(_webhook_sensitive_api_key(app, config))
    rows = WebhookDeliveryManager(config, store).list_receipts(owner_id=owner_id)
    compact = [
        {
            "receipt_id": row["receipt_id"],
            "event_id": row["event_id"],
            "endpoint_id": row["endpoint_id"],
            "status": row["status"],
            "updated_at": row["updated_at"],
            "attempts": len(row["attempts"]),
            "body_bytes": row["body_bytes"],
            "body_sha256": row["body_sha256"],
        }
        for row in rows
    ]
    app.renderer.emit(
        compact,
        title="Webhook delivery receipts",
        columns=[
            "receipt_id",
            "event_id",
            "endpoint_id",
            "status",
            "updated_at",
            "attempts",
            "body_bytes",
            "body_sha256",
        ],
        id_key="receipt_id",
    )


@webhook_group.command("show")
@click.argument("receipt_id")
@click.pass_obj
def webhook_show(app: AppContext, receipt_id: str) -> None:
    """Show safe receipt metadata without revealing its encoded body or credentials."""

    config = _resolve_webhook_config(app)
    owner_id = _webhook_owner_id(app, config)
    store = app.store
    store.add_secret(_webhook_sensitive_api_key(app, config))
    summary = WebhookDeliveryManager(config, store).inspect(
        receipt_id,
        owner_id=owner_id,
    )
    app.renderer.emit(summary, title="Webhook delivery receipt", id_key="receipt_id")


@webhook_group.command("retry")
@click.argument("receipt_id")
@click.option("--secret-file", type=click.Path(path_type=Path, dir_okay=False))
@click.option("--secret-env", help="Environment variable containing the webhook secret.")
@click.option("--yes", is_flag=True, help="Approve this exact retry noninteractively.")
@click.pass_obj
def webhook_retry(
    app: AppContext,
    receipt_id: str,
    secret_file: Path | None,
    secret_env: str | None,
    yes: bool,
) -> None:
    """Retry one durable event/body identity with a freshly signed request."""

    config = _resolve_webhook_config(app)
    sensitive_api_key = _webhook_sensitive_api_key(app, config)
    app.renderer.add_secret(sensitive_api_key)
    secret = _read_webhook_secret(
        secret_env=secret_env,
        secret_file=secret_file,
        api_key=sensitive_api_key,
    )
    owner_id = _webhook_owner_id(app, config)
    store = app.store
    store.add_secret(sensitive_api_key)
    manager = WebhookDeliveryManager(config, store, deliver=deliver_webhook)
    signed, receipt = manager.prepare_retry(
        receipt_id,
        owner_id=owner_id,
        secret=secret,
    )
    preview = {
        **_safe_webhook_preview(signed, server=config.server),
        "receipt_id": receipt_id,
        "previous_status": receipt["status"],
        "previous_attempts": len(receipt["attempts"]),
    }
    if not _preview_then_confirm(
        app,
        preview,
        title="Webhook retry preview",
        message="Retry this exact webhook event and body?",
        yes=yes,
    ):
        return
    result, _receipt = manager.retry(
        receipt_id,
        owner_id=owner_id,
        secret=secret,
        prepared=signed,
        expected_attempts=len(receipt["attempts"]),
    )
    app.renderer.emit(result, title="Webhook retry accepted", id_key="event_id")


@cli.command("doctor")
@click.pass_obj
def doctor(app: AppContext) -> None:
    """Inspect credentials, API capabilities, dates, and local state."""

    with app.client() as (config, client):
        capabilities = client.capability_report()
        identity = client.current_user() if capabilities["identity"] else None
        if (
            identity
            and config.username
            and str(identity.get("name", "")).casefold() != config.username.casefold()
        ):
            raise ConfigurationError("Configured username does not match the API-key owner.")
        app.renderer.emit(
            {
                "cli_version": __version__,
                "python": sys.version.split()[0],
                "profile": config.profile,
                "server": config.server,
                "timezone": config.timezone,
                "identity": identity,
                "capabilities": capabilities,
                "credential_files": [str(path) for path in config.source_files],
                "state_directory": str(app.store.root),
            },
            title="Titra CLI doctor",
        )


@cli.group("project", cls=SafeGroup)
def project_group() -> None:
    """View and create projects."""


@project_group.command("list")
@click.option("--include-archived", is_flag=True)
@click.pass_obj
def project_list(app: AppContext, include_archived: bool) -> None:
    """List projects visible to the API-key owner."""

    with app.client() as (_config, client):
        projects = client.list_projects()
    if not include_archived:
        projects = [project for project in projects if not project.get("archived")]
    app.renderer.emit(
        project_rows(projects),
        title="Projects",
        columns=["id", "name", "customer", "archived", "rate", "budget"],
        id_key="id",
    )


@project_group.command("show")
@click.argument("project")
@click.pass_obj
def project_show(app: AppContext, project: str) -> None:
    """Inspect one project by exact ID, ID prefix, or unambiguous name."""

    with app.client() as (_config, client):
        selected = resolve_project(client.list_projects(), project)
        if client.supports_v2_feature("projects", "read"):
            selected, etag = client.get_project_snapshot(str(selected["_id"]))
            selected = {**selected, "etag": etag}
    app.renderer.emit(selected, title="Project", id_key="_id")


@project_group.command("users")
@click.argument("project")
@click.pass_obj
def project_users(app: AppContext, project: str) -> None:
    """List observed user IDs and caller-visible display names for one project."""

    with app.client() as (_config, client):
        selected = resolve_project(client.list_projects(), project)
        users = client.project_users(str(selected["_id"]))
    rows = [
        {
            "id": str(user.get("_id") or ""),
            "name": user.get("name") if isinstance(user.get("name"), str) else "",
            "name_private": user.get("name") is None,
        }
        for user in users
    ]
    app.renderer.emit(
        rows,
        title=f"Users observed on {selected.get('name')}",
        columns=["id", "name", "name_private"],
        id_key="id",
    )


@project_group.command("create")
@click.argument("name")
@click.option("--description")
@click.option("--color")
@click.option("--customer")
@click.option("--rate", type=float)
@click.option("--budget", type=float)
@click.option("--dry-run", is_flag=True)
@click.option("--yes", is_flag=True)
@click.pass_obj
def project_create(
    app: AppContext,
    name: str,
    description: str | None,
    color: str | None,
    customer: str | None,
    rate: float | None,
    budget: float | None,
    dry_run: bool,
    yes: bool,
) -> None:
    """Create a project after previewing an allow-listed payload."""

    # This is local configuration resolution only; --dry-run still performs no HTTP request.
    app.resolve()
    payload: dict[str, Any] = {"name": name}
    for key, value in {
        "description": description,
        "color": color,
        "customer": customer,
        "rate": rate,
        "budget": budget,
    }.items():
        if value is not None:
            payload[key] = value
    if dry_run:
        app.renderer.emit(payload, title="Project create dry run")
        return
    if not _preview_then_confirm(
        app,
        payload,
        title="Project create preview",
        message=f"Create project {name!r}?",
        yes=yes,
    ):
        app.renderer.status("Project creation cancelled.")
        return
    with app.client() as (config, client):
        # Bind the immutable API user before any other authenticated request in
        # a mutation workflow. Every later read and write then carries the same
        # expected-user precondition, even if the token is rotated concurrently.
        identity = assert_expected_identity(client, config)
        receipt = None
        receipt_path = None
        support_check = getattr(client, "supports_idempotent_create", None)
        if support_check and support_check("project.create"):
            receipt = app.store.create_creation_receipt(
                config,
                "project.create",
                payload,
                owner_id=str(identity["_id"]),
            )
            project_id, receipt_path = _submit_creation_receipt(config, client, app.store, receipt)
        else:
            project_id = client.create_project(payload)
    app.renderer.emit(
        {
            "projectId": project_id,
            **payload,
            **(
                {
                    "receipt_id": receipt["receipt_id"],
                    "receipt": str(receipt_path),
                }
                if receipt is not None and receipt_path is not None
                else {}
            ),
        },
        title="Project created",
        id_key="projectId",
    )


def _project_lifecycle_snapshot(
    client: TitraClient, reference: str
) -> tuple[str, dict[str, Any], str]:
    if not client.supports_v2_feature("projects", "read"):
        raise ConfigurationError("This operation requires the v6 project lifecycle API.")
    selected = resolve_project(client.list_projects(), reference)
    project_id = str(selected["_id"])
    snapshot, etag = client.get_project_snapshot(project_id)
    return project_id, snapshot, etag


@project_group.command("edit")
@click.argument("project")
@click.option(
    "--changes",
    required=True,
    help="JSON object containing only fields to change; null explicitly clears nullable fields.",
)
@click.option("--dry-run", is_flag=True)
@click.option("--yes", is_flag=True)
@click.pass_obj
def project_edit(app: AppContext, project: str, changes: str, dry_run: bool, yes: bool) -> None:
    """Safely edit allow-listed project details using a fresh revision snapshot."""
    requested = _parse_json_object(changes, "--changes")
    allowed = {
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
    if not set(requested).issubset(allowed):
        raise ConfigurationError("--changes contains a field outside the project allow-list.")
    with app.client() as (config, client):
        assert_expected_identity(client, config)
        project_id, snapshot, etag = _project_lifecycle_snapshot(client, project)
        expected = {field: snapshot.get(field) for field in requested}
        preview = {
            "projectId": project_id,
            "etag": etag,
            "expected": expected,
            "changes": requested,
        }
        if dry_run:
            app.renderer.emit(preview, title="Project edit preview", id_key="projectId")
            return
        if not _preview_then_confirm(
            app,
            preview,
            title="Project edit preview",
            message="Apply this exact project edit?",
            yes=yes,
        ):
            return
        result, next_etag = client.edit_project_details(
            project_id, expected=expected, changes=requested, etag=etag
        )
    app.renderer.emit(
        {**result, "etag": next_etag}, title="Project edit completed", id_key="projectId"
    )


def _set_project_archive_state(
    app: AppContext, project: str, *, archived: bool, dry_run: bool, yes: bool
) -> None:
    with app.client() as (config, client):
        assert_expected_identity(client, config)
        project_id, snapshot, etag = _project_lifecycle_snapshot(client, project)
        expected_archived = snapshot.get("archived") is True
        preview = {
            "projectId": project_id,
            "name": snapshot.get("name"),
            "etag": etag,
            "expectedArchived": expected_archived,
            "archived": archived,
        }
        if dry_run:
            app.renderer.emit(preview, title="Project archive preview", id_key="projectId")
            return
        action = "Archive" if archived else "Restore"
        if not _preview_then_confirm(
            app,
            preview,
            title=f"Project {action.lower()} preview",
            message=f"{action} this project?",
            yes=yes,
        ):
            return
        result, next_etag = client.set_project_archived(
            project_id,
            archived=archived,
            expected_archived=expected_archived,
            etag=etag,
        )
    app.renderer.emit(
        {**result, "etag": next_etag}, title=f"Project {action.lower()}d", id_key="projectId"
    )


@project_group.command("archive")
@click.argument("project")
@click.option("--dry-run", is_flag=True)
@click.option("--yes", is_flag=True)
@click.pass_obj
def project_archive(app: AppContext, project: str, dry_run: bool, yes: bool) -> None:
    """Archive a project without deleting its records or tasks."""
    _set_project_archive_state(app, project, archived=True, dry_run=dry_run, yes=yes)


@project_group.command("restore")
@click.argument("project")
@click.option("--dry-run", is_flag=True)
@click.option("--yes", is_flag=True)
@click.pass_obj
def project_restore(app: AppContext, project: str, dry_run: bool, yes: bool) -> None:
    """Restore an archived project."""
    _set_project_archive_state(app, project, archived=False, dry_run=dry_run, yes=yes)


@project_group.command("delete")
@click.argument("project")
@click.option("--expect-name", required=True, help="Exact project name from the preview.")
@click.option("--if-match", help="Require this exact project ETag from a prior read.")
@click.option("--dry-run", is_flag=True)
@click.option("--yes", is_flag=True)
@click.pass_obj
def project_delete(
    app: AppContext,
    project: str,
    expect_name: str,
    if_match: str | None,
    dry_run: bool,
    yes: bool,
) -> None:
    """Delete one owner-controlled empty project; archive nonempty projects instead."""
    with app.client() as (config, client):
        assert_expected_identity(client, config)
        project_id, snapshot, etag = _project_lifecycle_snapshot(client, project)
        if snapshot.get("name") != expect_name:
            raise ConflictError("--expect-name does not match the fresh project preview.")
        if if_match is not None and etag != if_match:
            raise ConflictError("--if-match does not match the fresh project ETag.")
        preview = {"projectId": project_id, "name": expect_name, "etag": etag, "emptyOnly": True}
        if dry_run:
            app.renderer.emit(preview, title="Empty project deletion preview", id_key="projectId")
            return
        if not _preview_then_confirm(
            app,
            preview,
            title="Empty project deletion preview",
            message="Permanently delete this empty project?",
            yes=yes,
        ):
            return
        result = client.delete_empty_project(project_id, expected_name=expect_name, etag=etag)
    app.renderer.emit(result, title="Empty project deleted", id_key="projectId")


@project_group.group("recovery", cls=SafeGroup)
def project_recovery_group() -> None:
    """Inspect and recover verified stale project safety fences."""


def _project_recovery_snapshot(
    client: TitraClient, reference: str
) -> tuple[str, dict[str, Any], str]:
    if not client.supports_project_fence_recovery():
        raise ConfigurationError("This operation requires the v6 project fence recovery API.")
    selected = resolve_project(client.list_projects(), reference)
    project_id = str(selected["_id"])
    snapshot, etag = client.get_project_fence_recovery(project_id)
    return project_id, snapshot, etag


def _project_recovery_candidate(
    snapshot: dict[str, Any], recovery_type: str, recovery_id: str
) -> dict[str, Any]:
    if recovery_type == "writer":
        writers = snapshot.get("writerRecoveries")
        reservations = writers.get("reservations") if isinstance(writers, dict) else None
        if not isinstance(reservations, list):
            raise RemoteApiError("Titra returned invalid project writer recovery state.")
        candidate = next(
            (
                entry
                for entry in reservations
                if isinstance(entry, dict)
                and entry.get("status") == "recoverable"
                and isinstance(entry.get("reservation"), dict)
                and entry["reservation"].get("reservationId") == recovery_id
            ),
            None,
        )
    else:
        task_lock = snapshot.get("taskGraphRecovery")
        candidate = (
            task_lock
            if isinstance(task_lock, dict)
            and task_lock.get("status") == "recoverable"
            and isinstance(task_lock.get("lock"), dict)
            and task_lock["lock"].get("lockId") == recovery_id
            else None
        )
    if not isinstance(candidate, dict):
        raise ConfigurationError(
            "The selected fence is not present and safely recoverable in the fresh preview."
        )
    return candidate


@project_recovery_group.command("inspect")
@click.argument("project")
@click.pass_obj
def project_recovery_inspect(app: AppContext, project: str) -> None:
    """Inspect bounded stale-fence recovery state without changing it."""
    with app.client() as (_config, client):
        project_id, snapshot, etag = _project_recovery_snapshot(client, project)
    app.renderer.emit(
        {**snapshot, "projectId": project_id, "etag": etag},
        title="Project fence recovery",
        id_key="projectId",
    )


@project_recovery_group.command("recover")
@click.argument("project")
@click.option(
    "--type",
    "recovery_type",
    type=click.Choice(["writer", "task-delete"], case_sensitive=True),
    required=True,
)
@click.option("--recovery-id", required=True, help="Exact ID shown by recovery inspect.")
@click.option("--dry-run", is_flag=True)
@click.option("--yes", is_flag=True)
@click.pass_obj
def project_recovery_recover(
    app: AppContext,
    project: str,
    recovery_type: str,
    recovery_id: str,
    dry_run: bool,
    yes: bool,
) -> None:
    """Clear one old fence only when its fresh server preview says it is safe."""
    with app.client() as (config, client):
        assert_expected_identity(client, config)
        project_id, snapshot, etag = _project_recovery_snapshot(client, project)
        candidate = _project_recovery_candidate(snapshot, recovery_type, recovery_id)
        preview = {
            "projectId": project_id,
            "type": recovery_type,
            "recoveryId": recovery_id,
            "minimumAgeSeconds": snapshot.get("minimumAgeSeconds"),
            "etag": etag,
            "candidate": candidate,
        }
        if dry_run:
            app.renderer.emit(preview, title="Project fence recovery dry run")
            return
        if not _preview_then_confirm(
            app,
            preview,
            title="Project fence recovery preview",
            message="Clear this one verified stale project safety fence?",
            yes=yes,
        ):
            return
        result, next_etag = client.recover_project_fence(
            project_id,
            recovery_type=recovery_type,
            recovery_id=recovery_id,
            etag=etag,
        )
    app.renderer.emit(
        {**result, "etag": next_etag},
        title="Project fence recovery completed",
    )


@cli.group("task", cls=SafeGroup)
def task_group() -> None:
    """View and create predefined project tasks."""


@task_group.command("list")
@click.argument("project")
@click.pass_obj
def task_list(app: AppContext, project: str) -> None:
    with app.client() as (_config, client):
        selected = resolve_project(client.list_projects(), project)
        tasks = client.list_tasks(str(selected["_id"]))
    app.renderer.emit(
        tasks,
        title=f"Tasks for {selected.get('name')}",
        columns=["_id", "name", "start", "end", "estimatedHours"],
    )


@task_group.command("create")
@click.argument("project")
@click.argument("name")
@click.option("--start", required=True, metavar="YYYY-MM-DD")
@click.option("--end", required=True, metavar="YYYY-MM-DD")
@click.option("--estimated-hours", type=float)
@click.option("--dependency", "dependencies", multiple=True)
@click.option("--custom-fields")
@click.option("--dry-run", is_flag=True)
@click.option("--yes", is_flag=True)
@click.pass_obj
def task_create(
    app: AppContext,
    project: str,
    name: str,
    start: str,
    end: str,
    estimated_hours: float | None,
    dependencies: tuple[str, ...],
    custom_fields: str | None,
    dry_run: bool,
    yes: bool,
) -> None:
    start_date = parse_date(start)
    end_date = parse_date(end)
    if start_date > end_date:
        raise ConfigurationError("Task start date must not be after its end date.")
    with app.client() as (config, client):
        identity = assert_expected_identity(client, config)
        selected = resolve_project(client.list_projects(), project)
        payload: dict[str, Any] = {
            "projectId": str(selected["_id"]),
            "name": name,
            "start": f"{start_date.isoformat()}T00:00:00.000Z",
            "end": f"{end_date.isoformat()}T23:59:59.999Z",
        }
        if estimated_hours is not None:
            payload["estimatedHours"] = estimated_hours
        if dependencies:
            payload["dependencies"] = list(dependencies)
        custom = _parse_customfields(custom_fields)
        if custom is not None:
            payload["customfields"] = custom
        if dry_run:
            app.renderer.emit(payload, title="Task create dry run")
            return
        if not _preview_then_confirm(
            app,
            payload,
            title="Project-task create preview",
            message=f"Create task {name!r}?",
            yes=yes,
        ):
            return
        receipt = None
        receipt_path = None
        support_check = getattr(client, "supports_idempotent_create", None)
        if support_check and support_check("project-task.create"):
            receipt = app.store.create_creation_receipt(
                config,
                "project-task.create",
                payload,
                owner_id=str(identity["_id"]),
            )
            task_id, receipt_path = _submit_creation_receipt(config, client, app.store, receipt)
        else:
            task_id = client.create_task(payload)
    app.renderer.emit(
        {
            "taskId": task_id,
            **payload,
            **(
                {
                    "receipt_id": receipt["receipt_id"],
                    "receipt": str(receipt_path),
                }
                if receipt is not None and receipt_path is not None
                else {}
            ),
        },
        title="Task created",
        id_key="taskId",
    )


@task_group.command("show")
@click.argument("task_id")
@click.pass_obj
def task_show(app: AppContext, task_id: str) -> None:
    """Inspect one predefined project task and its deletion references."""
    with app.client() as (_config, client):
        if not client.supports_v2_feature("projects", "tasks", minimum=2):
            raise ConfigurationError("This operation requires the v6 project-task lifecycle API.")
        task, etag = client.get_project_task_snapshot(task_id)
    app.renderer.emit({**task, "etag": etag}, title="Project task", id_key="_id")


@task_group.command("edit")
@click.argument("task_id")
@click.option("--changes", required=True, help="Allow-listed task fields as a JSON object.")
@click.option("--dry-run", is_flag=True)
@click.option("--yes", is_flag=True)
@click.pass_obj
def task_edit(app: AppContext, task_id: str, changes: str, dry_run: bool, yes: bool) -> None:
    """Safely edit one predefined project task using a fresh revision snapshot."""
    requested = _parse_json_object(changes, "--changes")
    if not set(requested).issubset({"name", "start", "end", "estimatedHours", "dependencies"}):
        raise ConfigurationError("--changes contains a field outside the project-task allow-list.")
    with app.client() as (config, client):
        assert_expected_identity(client, config)
        if not client.supports_v2_feature("projects", "tasks", minimum=2):
            raise ConfigurationError("This operation requires the v6 project-task lifecycle API.")
        snapshot, etag = client.get_project_task_snapshot(task_id)
        expected = {field: snapshot.get(field) for field in requested}
        preview = {"taskId": task_id, "etag": etag, "expected": expected, "changes": requested}
        if dry_run:
            app.renderer.emit(preview, title="Project-task edit preview", id_key="taskId")
            return
        if not _preview_then_confirm(
            app,
            preview,
            title="Project-task edit preview",
            message="Apply this exact project-task edit?",
            yes=yes,
        ):
            return
        result, next_etag = client.edit_project_task(
            task_id, expected=expected, changes=requested, etag=etag
        )
    app.renderer.emit({**result, "etag": next_etag}, title="Project task edited", id_key="taskId")


@task_group.command("delete")
@click.argument("task_id")
@click.option("--expect-project-id", required=True, help="Exact project ID from task show.")
@click.option("--expect-name", required=True, help="Exact task name from task show.")
@click.option("--if-match", help="Require this exact task ETag from a prior read.")
@click.option("--acknowledge-recorded-entries", is_flag=True)
@click.option("--dry-run", is_flag=True)
@click.option("--yes", is_flag=True)
@click.pass_obj
def task_delete(
    app: AppContext,
    task_id: str,
    expect_project_id: str,
    expect_name: str,
    if_match: str | None,
    acknowledge_recorded_entries: bool,
    dry_run: bool,
    yes: bool,
) -> None:
    """Delete a nondefault, dependency-free project task without changing history."""
    with app.client() as (config, client):
        assert_expected_identity(client, config)
        if not client.supports_v2_feature("projects", "tasks", minimum=2):
            raise ConfigurationError("This operation requires the v6 project-task lifecycle API.")
        snapshot, etag = client.get_project_task_snapshot(task_id)
        if snapshot.get("projectId") != expect_project_id:
            raise ConflictError("--expect-project-id does not match the fresh task snapshot.")
        if snapshot.get("name") != expect_name:
            raise ConflictError("--expect-name does not match the fresh task snapshot.")
        if if_match is not None and etag != if_match:
            raise ConflictError("--if-match does not match the fresh task ETag.")
        preview = {
            **snapshot,
            "etag": etag,
            "acknowledgeRecordedEntries": acknowledge_recorded_entries,
        }
        if dry_run:
            app.renderer.emit(preview, title="Project-task deletion preview", id_key="_id")
            return
        if not _preview_then_confirm(
            app,
            preview,
            title="Project-task deletion preview",
            message="Permanently delete this project task?",
            yes=yes,
        ):
            return
        result = client.delete_project_task(
            task_id,
            expected_name=expect_name,
            acknowledge_recorded_entries=acknowledge_recorded_entries,
            etag=etag,
        )
    app.renderer.emit(result, title="Project task deleted", id_key="taskId")


@cli.group("record", cls=SafeGroup)
def record_group() -> None:
    """Inspect, create, export, rename tasks, and safely delete time records."""


@record_group.command("list")
@date_range_options
@click.option("--project", "projects", multiple=True)
@click.option("--user", "users", multiple=True)
@click.option("--team", is_flag=True, help="Include all users for selected accessible projects.")
@click.option("--limit", type=click.IntRange(min=1), default=500, show_default=True)
@click.option(
    "--api-page-size",
    type=click.IntRange(min=1, max=500),
    default=200,
    show_default=True,
    help="Records requested per v6 API page; useful for paging verification.",
)
@click.option("--raw", is_flag=True, help="Return raw API records instead of normalized rows.")
@click.pass_obj
def record_list(
    app: AppContext,
    from_date: str | None,
    to_date: str | None,
    today: bool,
    week: bool,
    month: bool,
    calendar_month: str | None,
    projects: tuple[str, ...],
    users: tuple[str, ...],
    team: bool,
    limit: int,
    api_page_size: int,
    raw: bool,
) -> None:
    with app.client() as (config, client):
        value = _date_range_from_options(config, locals())
        dataset = fetch_report_dataset(
            client,
            config,
            value,
            project_references=projects,
            user_references=users,
            team=team,
            page_size=api_page_size,
        )
    rows: Any = dataset.raw_entries if raw else record_rows(dataset)
    matched_count = len(rows)
    rows = rows[:limit]
    legacy_count = sum(entry.legacy_date for entry in dataset.entries)
    meta = {
        **value.as_dict(),
        "legacy_records": legacy_count,
        "malformed": dataset.malformed,
        "matched": matched_count,
        "returned": len(rows),
        "truncated": matched_count > len(rows),
        **dataset.fetch_meta,
    }
    if dataset.fetch_meta.get("duplicates"):
        app.renderer.warn(
            f"Ignored {dataset.fetch_meta['duplicates']} duplicate record ID(s) observed while "
            "paging a live dataset."
        )
    if dataset.fetch_meta.get("complete") is not True:
        app.renderer.warn(
            "This server returned legacy unpaged arrays, so response completeness cannot be "
            "proven by the client."
        )
    if legacy_count:
        app.renderer.warn(
            f"{legacy_count} legacy record(s) have no canonical dateOnly; "
            "their stored UTC date was preserved."
        )
    app.renderer.emit(
        rows,
        title="Time records",
        columns=None
        if raw
        else ["date", "start", "hours", "project", "task", "user", "legacy", "id"],
        id_key="id",
        meta=meta,
    )
    if dataset.malformed:
        raise PartialResultError(f"Skipped {len(dataset.malformed)} malformed record(s).")


@record_group.command("show")
@click.argument("record_id")
@click.pass_obj
def record_show(app: AppContext, record_id: str) -> None:
    with app.client() as (_config, client):
        if client.supports_v2_feature("timeEntries", "get"):
            record, etag = client.get_time_entry_snapshot(record_id)
            record = {**record, "etag": etag}
        else:
            record = client.get_time_entry(record_id)
    app.renderer.emit(record, title="Time record", id_key="_id")


@record_group.command("create")
@click.option("--project", required=True)
@click.option("--task", required=True)
@click.option("--date", "date_value", metavar="YYYY-MM-DD")
@click.option("--start", "start_time", metavar="HH:MM")
@click.option("--duration", help="Duration such as 1h30m or 01:30:00.")
@click.option("--hours", type=float)
@click.option("--rate", "task_rate", type=float)
@click.option("--custom-fields")
@click.option("--dry-run", is_flag=True)
@click.option("--yes", is_flag=True)
@click.pass_obj
def record_create(
    app: AppContext,
    project: str,
    task: str,
    date_value: str | None,
    start_time: str | None,
    duration: str | None,
    hours: float | None,
    task_rate: float | None,
    custom_fields: str | None,
    dry_run: bool,
    yes: bool,
) -> None:
    if bool(duration) == bool(hours is not None):
        raise ConfigurationError("Provide exactly one of --duration or --hours.")
    if start_time and not _START_TIME.fullmatch(start_time):
        raise ConfigurationError("Start time must use 24-hour HH:MM format.")
    seconds = parse_duration(duration) if duration else hours_to_seconds(hours or 0)
    with app.client() as (config, client):
        identity = assert_expected_identity(client, config)
        selected = resolve_project(client.list_projects(), project)
        day = parse_date(date_value) if date_value else _today(config).date()
        payload: dict[str, Any] = {
            "projectId": str(selected["_id"]),
            "task": task,
            "date": day.isoformat(),
            "hours": seconds_to_hours(seconds),
        }
        if start_time:
            payload["startTime"] = start_time
        if task_rate is not None:
            payload["taskRate"] = task_rate
        custom = _parse_customfields(custom_fields)
        if custom is not None:
            payload["customfields"] = custom
        if dry_run:
            app.renderer.emit(payload, title="Time-record create dry run")
            return
        if not _preview_then_confirm(
            app,
            payload,
            title="Time-record create preview",
            message="Submit this time record?",
            yes=yes,
        ):
            return
        draft = app.store.create_draft(
            config,
            [payload],
            owner_id=str(identity["_id"]),
            note="Manual record creation.",
        )
        submitted = TimerManager(config, client, app.store).submit_draft(draft)
    app.renderer.emit(
        {
            "draft_id": submitted.draft_id,
            "status": submitted.status,
            "timecardId": submitted.result_ids[0],
        },
        title="Time record created",
        id_key="timecardId",
    )


@record_group.command("delete")
@click.argument("record_id")
@click.option("--expect-project-id", required=True, help="Exact project ID from record show.")
@click.option("--expect-task", required=True, help="Exact Task text from record show.")
@click.option("--if-match", help="Require this exact record ETag from a prior read.")
@click.option("--dry-run", is_flag=True)
@click.option("--yes", is_flag=True)
@click.pass_obj
def record_delete(
    app: AppContext,
    record_id: str,
    expect_project_id: str,
    expect_task: str,
    if_match: str | None,
    dry_run: bool,
    yes: bool,
) -> None:
    """Delete exactly one owned record after preview and a local recovery receipt."""

    with app.client() as (config, client):
        identity = assert_expected_identity(client, config)
        record, etag = client.get_time_entry_snapshot(record_id)
        if record.get("userId") != identity["_id"]:
            raise AuthenticationError(
                "Deletion requires a record owned by the authenticated API user."
            )
        if record.get("projectId") != expect_project_id:
            raise ConflictError("--expect-project-id does not match the fresh record snapshot.")
        if record.get("task") != expect_task:
            raise ConflictError("--expect-task does not match the fresh record snapshot.")
        if if_match is not None and etag != if_match:
            raise ConflictError("--if-match does not match the fresh record ETag.")
        projects = {str(item.get("_id")): item for item in client.list_projects()}
        preview = record_preview(record, config=config, projects=projects)
        if not etag:
            raise ConfigurationError(
                "Server did not provide a deletion ETag; refusing an unsafe delete. "
                "Upgrade the Titra API extension."
            )
        if dry_run:
            app.renderer.emit({**preview, "etag": etag}, title="Delete dry run")
            return
        if not yes:
            if not sys.stdin.isatty():
                raise ConfigurationError("Noninteractive deletion requires --yes.")
            app.renderer.error_console.print("Record selected for deletion:")
            app.renderer.error_console.print_json(
                json.dumps(app.renderer.sanitize(preview), default=str)
            )
            typed = click.prompt("Type the complete record ID to delete", err=True)
            if typed != record_id:
                raise ConfigurationError("Deletion cancelled: record ID did not match.")
        receipt = app.store.save_deletion_receipt(config, record)
        result = client.delete_time_entry(record_id, etag=etag)
    app.renderer.emit(
        {"timecardId": record_id, "deleted": True, "receipt": str(receipt), **result},
        title="Time record deleted",
        id_key="timecardId",
    )


@record_group.command("edit-task")
@click.argument("record_id")
@click.option("--task", required=True, help="Exact new Task text; never trims or normalizes it.")
@click.option("--expect-task", help="Require this exact old Task, including an empty string.")
@click.option("--if-match", help="Require this exact strong revision ETag from a prior read.")
@click.option("--dry-run", is_flag=True, help="Read-only preview; no PATCH or local receipt.")
@click.option("--yes", is_flag=True, help="Approve this single guarded edit noninteractively.")
@click.pass_obj
def record_edit_task(
    app: AppContext,
    record_id: str,
    task: str,
    expect_task: str | None,
    if_match: str | None,
    dry_run: bool,
    yes: bool,
) -> None:
    """Edit only Task, preserving all other saved values and verifying a fresh readback."""
    with app.client() as (config, client):
        plan = prepare_task_edit(
            config, client, record_id, task, expected_task=expect_task, if_match=if_match
        )
        if dry_run:
            app.renderer.emit(
                {**plan.preview, "dry_run": True}, title="Task edit preview", id_key="id"
            )
            return
        if not yes:
            app.renderer.error_console.print("Task-only edit preview:")
            app.renderer.error_console.print_json(
                json.dumps(app.renderer.sanitize(plan.preview), ensure_ascii=False)
            )
            if not _require_confirmation(app, "Apply this exact task-only edit?", yes=False):
                return
        result = apply_task_edit(config, client, app.store, plan)
    app.renderer.emit(result, title="Task edit verified", id_key="timecardId")


@record_group.command("edit-details")
@click.argument("record_id")
@click.option(
    "--changes",
    required=True,
    help="JSON object using only projectId, hours, dateOnly, and/or startTime.",
)
@click.option(
    "--accept-legacy-conversion",
    is_flag=True,
    help="Explicitly accept conversion when changing a legacy record's calendar fields.",
)
@click.option("--dry-run", is_flag=True)
@click.option("--yes", is_flag=True)
@click.pass_obj
def record_edit_details(
    app: AppContext,
    record_id: str,
    changes: str,
    accept_legacy_conversion: bool,
    dry_run: bool,
    yes: bool,
) -> None:
    """Edit narrow time-record details without replacing unrelated saved fields."""
    requested = _parse_json_object(changes, "--changes")
    if not set(requested).issubset({"projectId", "hours", "dateOnly", "startTime"}):
        raise ConfigurationError("--changes contains a field outside the details allow-list.")
    with app.client() as (config, client):
        assert_expected_identity(client, config)
        if not client.supports_v2_feature("timeEntries", "detailsEdit"):
            raise ConfigurationError("This operation requires the v6 time-entry details API.")
        snapshot, etag = client.get_time_entry_snapshot(record_id)
        if not etag:
            raise ConfigurationError("Server returned no record revision ETag.")
        expected = {field: snapshot.get(field) for field in requested}
        preview = {
            "timecardId": record_id,
            "etag": etag,
            "expected": expected,
            "changes": requested,
            "acceptLegacyConversion": accept_legacy_conversion,
        }
        if dry_run:
            app.renderer.emit(preview, title="Time-entry details preview", id_key="timecardId")
            return
        if not _preview_then_confirm(
            app,
            preview,
            title="Time-entry details preview",
            message="Apply this exact time-entry details edit?",
            yes=yes,
        ):
            return
        result, next_etag = client.edit_time_entry_details(
            record_id,
            expected=expected,
            changes=requested,
            etag=etag,
            accept_legacy_conversion=accept_legacy_conversion,
        )
    app.renderer.emit(
        {**result, "etag": next_etag}, title="Time-entry details edited", id_key="timecardId"
    )


@record_group.command("reconcile-task-edit")
@click.argument("receipt_id")
@click.pass_obj
def record_reconcile_task_edit(app: AppContext, receipt_id: str) -> None:
    """Inspect an uncertain task edit with GET only. Never retries or edits its receipt."""
    with app.client() as (config, client):
        result = reconcile_task_edit(config, client, app.store, receipt_id)
    app.renderer.emit(result, title="Read-only task-edit reconciliation", id_key="timecardId")


# Familiar alias for scripts and users who call entries "time".
cli.add_command(record_group, "time")


@cli.group("suggestion", cls=SafeGroup)
def suggestion_group() -> None:
    """Inspect and remove personal task suggestions without altering records."""


@suggestion_group.command("list")
@click.option("--page-size", type=click.IntRange(min=1, max=500), default=100, show_default=True)
@click.pass_obj
def suggestion_list(app: AppContext, page_size: int) -> None:
    with app.client() as (_config, client):
        if not client.supports_v2_feature("taskSuggestions", "list"):
            raise ConfigurationError("This operation requires the v6 task-suggestion API.")
        suggestions = client.list_task_suggestions(limit=page_size)
    app.renderer.emit(
        suggestions,
        title="Personal task suggestions",
        columns=["_id", "name", "lastUsed", "usage"],
        id_key="_id",
    )


@task_group.command("stats")
@click.argument("project")
@click.option("--task", "task_name", help="Return only this exact predefined task name.")
@click.pass_obj
def task_stats(app: AppContext, project: str, task_name: str | None) -> None:
    """Show planned-versus-recorded hours for predefined tasks in one project."""

    with app.client() as (_config, client):
        if not client.supports_v2_feature("projects", "taskStats"):
            raise ConfigurationError("This operation requires the v6 project task-statistics API.")
        selected = resolve_project(client.list_projects(), project)
        result = client.project_task_stats(str(selected["_id"]), task_name=task_name)
    if app.renderer.mode is OutputMode.JSON:
        app.renderer.emit(result, title="Project task statistics", id_key="projectId")
        return
    tasks = result.get("tasks") if isinstance(result, dict) else None
    rows = tasks if isinstance(tasks, list) else []
    app.renderer.emit(
        rows,
        title=f"Task statistics for {selected.get('name')}",
        columns=[
            "taskId",
            "taskName",
            "estimatedHours",
            "actualHours",
            "variance",
            "start",
            "end",
        ],
        id_key="taskId",
    )
    if app.renderer.mode is OutputMode.HUMAN:
        app.renderer.status(
            "Totals: "
            f"estimated={result.get('totalEstimatedHours', 0)}, "
            f"actual={result.get('totalActualHours', 0)}"
        )


@suggestion_group.command("show")
@click.argument("suggestion_id")
@click.pass_obj
def suggestion_show(app: AppContext, suggestion_id: str) -> None:
    with app.client() as (_config, client):
        if not client.supports_v2_feature("taskSuggestions", "read"):
            raise ConfigurationError("This operation requires the v6 task-suggestion API.")
        suggestion, etag = client.get_task_suggestion_snapshot(suggestion_id)
    app.renderer.emit({**suggestion, "etag": etag}, title="Personal task suggestion", id_key="_id")


@suggestion_group.command("delete")
@click.argument("suggestion_id")
@click.option("--expect-name", required=True, help="Exact suggestion name from suggestion show.")
@click.option("--if-match", help="Require this exact suggestion ETag from a prior read.")
@click.option("--acknowledge-referenced-records", is_flag=True)
@click.option("--dry-run", is_flag=True)
@click.option("--yes", is_flag=True)
@click.pass_obj
def suggestion_delete(
    app: AppContext,
    suggestion_id: str,
    expect_name: str,
    if_match: str | None,
    acknowledge_referenced_records: bool,
    dry_run: bool,
    yes: bool,
) -> None:
    """Delete one personal suggestion; historical time records remain unchanged."""
    with app.client() as (config, client):
        assert_expected_identity(client, config)
        if not client.supports_v2_feature("taskSuggestions", "delete"):
            raise ConfigurationError("This operation requires the v6 task-suggestion API.")
        snapshot, etag = client.get_task_suggestion_snapshot(suggestion_id)
        if snapshot.get("name") != expect_name:
            raise ConflictError("--expect-name does not match the fresh suggestion snapshot.")
        if if_match is not None and etag != if_match:
            raise ConflictError("--if-match does not match the fresh suggestion ETag.")
        preview = {
            **snapshot,
            "etag": etag,
            "acknowledgeReferencedRecords": acknowledge_referenced_records,
        }
        if dry_run:
            app.renderer.emit(preview, title="Task-suggestion deletion preview", id_key="_id")
            return
        if not _preview_then_confirm(
            app,
            preview,
            title="Task-suggestion deletion preview",
            message="Delete this personal task suggestion?",
            yes=yes,
        ):
            return
        result = client.delete_task_suggestion(
            suggestion_id,
            expected_name=expect_name,
            acknowledge_referenced_records=acknowledge_referenced_records,
            etag=etag,
        )
    app.renderer.emit(result, title="Task suggestion deleted", id_key="suggestionId")


@cli.group("report", cls=SafeGroup)
def report_group() -> None:
    """Detailed calendar-safe statistics and exports."""


def _report_dataset_from_options(
    app: AppContext,
    *,
    from_date: str | None,
    to_date: str | None,
    today: bool,
    week: bool,
    month: bool,
    calendar_month: str | None,
    projects: tuple[str, ...],
    users: tuple[str, ...],
    team: bool,
) -> tuple[DateRange, Any]:
    with app.client() as (config, client):
        values = locals()
        value = _date_range_from_options(config, values)
        dataset = fetch_report_dataset(
            client,
            config,
            value,
            project_references=projects,
            user_references=users,
            team=team,
        )
    return value, dataset


def report_filter_options(function: Any) -> Any:
    function = click.option("--team", is_flag=True)(function)
    function = click.option("--user", "users", multiple=True)(function)
    function = click.option("--project", "projects", multiple=True)(function)
    return date_range_options(function)


@report_group.command("summary")
@report_filter_options
@click.option("--group-by", multiple=True, default=("project",), show_default=True)
@click.pass_obj
def report_summary(
    app: AppContext,
    from_date: str | None,
    to_date: str | None,
    today: bool,
    week: bool,
    month: bool,
    calendar_month: str | None,
    projects: tuple[str, ...],
    users: tuple[str, ...],
    team: bool,
    group_by: tuple[str, ...],
) -> None:
    value, dataset = _report_dataset_from_options(
        app,
        from_date=from_date,
        to_date=to_date,
        today=today,
        week=week,
        month=month,
        calendar_month=calendar_month,
        projects=projects,
        users=users,
        team=team,
    )
    rows = summary_rows(dataset.entries, group_by)
    meta = {**value.as_dict(), **report_meta(dataset.entries), "malformed": dataset.malformed}
    app.renderer.emit(rows, title="Time summary", meta=meta)
    _finish_report(app, dataset)


@report_group.command("timesheet")
@report_filter_options
@click.pass_obj
def report_timesheet(
    app: AppContext,
    from_date: str | None,
    to_date: str | None,
    today: bool,
    week: bool,
    month: bool,
    calendar_month: str | None,
    projects: tuple[str, ...],
    users: tuple[str, ...],
    team: bool,
) -> None:
    value, dataset = _report_dataset_from_options(
        app,
        from_date=from_date,
        to_date=to_date,
        today=today,
        week=week,
        month=month,
        calendar_month=calendar_month,
        projects=projects,
        users=users,
        team=team,
    )
    app.renderer.emit(
        timesheet_rows(dataset.entries),
        title="Timesheet",
        columns=["date", "start", "project", "task", "user", "hours", "legacy_date", "id"],
        id_key="id",
        meta={**value.as_dict(), **report_meta(dataset.entries), "malformed": dataset.malformed},
    )
    _finish_report(app, dataset)


@report_group.command("calendar")
@report_filter_options
@click.pass_obj
def report_calendar(
    app: AppContext,
    from_date: str | None,
    to_date: str | None,
    today: bool,
    week: bool,
    month: bool,
    calendar_month: str | None,
    projects: tuple[str, ...],
    users: tuple[str, ...],
    team: bool,
) -> None:
    value, dataset = _report_dataset_from_options(
        app,
        from_date=from_date,
        to_date=to_date,
        today=today,
        week=week,
        month=month,
        calendar_month=calendar_month,
        projects=projects,
        users=users,
        team=team,
    )
    app.renderer.emit(
        calendar_rows(dataset.entries),
        title="Calendar totals",
        columns=["date", "hours", "entries", "projects", "legacy_records"],
        meta={**value.as_dict(), **report_meta(dataset.entries), "malformed": dataset.malformed},
    )
    _finish_report(app, dataset)


def _finish_report(app: AppContext, dataset: Any) -> None:
    legacy = sum(entry.legacy_date for entry in dataset.entries)
    if legacy:
        app.renderer.warn(
            f"{legacy} legacy record(s) were grouped by their stored UTC calendar date."
        )
    if dataset.malformed:
        raise PartialResultError(f"Skipped {len(dataset.malformed)} malformed record(s).")


@cli.group("timer", cls=SafeGroup)
def timer_group() -> None:
    """Start, inspect, pause, resume, stop, or cancel the server timer."""


@timer_group.command("start")
@click.option("--project")
@click.option("--task")
@click.option(
    "--operation-id",
    help="Caller-known v6 start ID (8-128 safe ASCII characters) for exact recovery.",
)
@click.pass_obj
def timer_start(
    app: AppContext,
    project: str | None,
    task: str | None,
    operation_id: str | None,
) -> None:
    with app.client() as (config, client):
        assert_expected_identity(client, config)
        project_id = None
        if project:
            project_id = str(resolve_project(client.list_projects(), project)["_id"])
        timer = TimerManager(config, client, app.store).start(
            project_id=project_id,
            task=task,
            operation_id=operation_id,
        )
    app.renderer.emit(timer.to_dict(), title="Timer started")


@timer_group.command("status")
@click.pass_obj
def timer_status(app: AppContext) -> None:
    with app.client() as (config, client):
        status = TimerManager(config, client, app.store).status()
    status["elapsed"] = format_duration(int(status["elapsed_seconds"]))
    app.renderer.emit(status, title="Timer status")


@timer_group.command("recover-start")
@click.option("--yes", is_flag=True)
@click.pass_obj
def timer_recover_start(app: AppContext, yes: bool) -> None:
    """Reconcile or replay one exact journaled v6 timer start."""

    with app.client() as (config, client):
        pending = app.store.load_pending_timer_start(config)
        if not _preview_then_confirm(
            app,
            pending.to_dict(),
            title="Pending timer-start recovery preview",
            message="Reconcile or replay this exact journaled v6 timer start?",
            yes=yes,
        ):
            return
        timer = TimerManager(config, client, app.store).recover_start()
    app.renderer.emit(timer.to_dict(), title="Timer start recovered")


@timer_group.command("adopt")
@click.option("--project")
@click.option("--task")
@click.option(
    "--expect-timer-id",
    help="Require this exact v6 timer ID, or literal 'null' for a legacy timer.",
)
@click.option(
    "--expect-start-time",
    help="Require this exact server start timestamp before replacing local timer state.",
)
@click.option("--yes", is_flag=True)
@click.pass_obj
def timer_adopt(
    app: AppContext,
    project: str | None,
    task: str | None,
    expect_timer_id: str | None,
    expect_start_time: str | None,
    yes: bool,
) -> None:
    """Explicitly attach local project/task metadata to the current server timer."""

    if bool(project) != bool(task):
        raise ConfigurationError("Provide both --project and --task, or neither.")
    if not _terminal_is_interactive() and expect_timer_id is None and expect_start_time is None:
        raise ConfigurationError(
            "Noninteractive timer adoption requires --expect-timer-id or --expect-start-time."
        )
    expected_id = None if expect_timer_id == "null" else expect_timer_id
    with app.client() as (config, client):
        assert_expected_identity(client, config)
        snapshot = client.timer_get()
        observed_id = snapshot.get("timerId")
        if expect_timer_id is not None and observed_id != expected_id:
            raise ConfigurationError("The current server timer does not match --expect-timer-id.")
        if expect_start_time is not None and snapshot.get("startTime") != expect_start_time:
            raise ConfigurationError("The current server timer does not match --expect-start-time.")
        project_id = None
        if project:
            project_id = str(resolve_project(client.list_projects(), project)["_id"])
        preview = {
            "timerId": observed_id,
            "startTime": snapshot.get("startTime"),
            "projectId": project_id,
            "task": task,
        }
        if not _preview_then_confirm(
            app,
            preview,
            title="Timer adoption preview",
            message="Replace local timer association with this exact server timer?",
            yes=yes,
        ):
            return
        timer = TimerManager(config, client, app.store).adopt(
            project_id=project_id,
            task=task,
            expected_timer_id=expected_id if expect_timer_id is not None else None,
            expected_start_time=expect_start_time or str(snapshot.get("startTime")),
        )
    app.renderer.emit(timer.to_dict(), title="Server timer adopted")


@timer_group.command("pause")
@click.pass_obj
def timer_pause(app: AppContext) -> None:
    with app.client() as (config, client):
        timer = TimerManager(config, client, app.store).pause()
    app.renderer.emit(timer.to_dict(), title="Timer paused locally")


@timer_group.command("resume")
@click.pass_obj
def timer_resume(app: AppContext) -> None:
    with app.client() as (config, client):
        timer = TimerManager(config, client, app.store).resume()
    app.renderer.emit(timer.to_dict(), title="Timer resumed")


@timer_group.command("stop")
@click.option("--project")
@click.option("--task")
@click.option("--break", "break_value")
@click.option("--duration", "exact_duration")
@click.option("--split-midnight", is_flag=True)
@click.option("--submit/--draft-only", default=True)
@click.option(
    "--expect-timer-id",
    help="Stop only this exact v6 timer ID; a changed timer is left untouched.",
)
@click.option("--yes", is_flag=True)
@click.pass_obj
def timer_stop(
    app: AppContext,
    project: str | None,
    task: str | None,
    break_value: str | None,
    exact_duration: str | None,
    split_midnight: bool,
    submit: bool,
    expect_timer_id: str | None,
    yes: bool,
) -> None:
    if bool(project) != bool(task):
        raise ConfigurationError("Provide both --project and --task, or neither to keep a draft.")
    if task is not None:
        validate_task_edit(task, "")
    break_seconds = parse_duration(break_value) if break_value else 0
    exact_seconds = parse_duration(exact_duration) if exact_duration else None
    if exact_seconds is not None and exact_seconds <= 0:
        raise ConfigurationError("Exact duration must be greater than zero.")
    if exact_duration is not None and break_value is not None:
        raise ConfigurationError("Use either an exact duration or a break subtraction, not both.")
    if not yes and not _terminal_is_interactive():
        raise ConfigurationError(
            "Stopping a detached timer is a mutation. Re-run with --yes for noninteractive use."
        )
    with app.client() as (config, client):
        assert_expected_identity(client, config)
        project_id = (
            str(resolve_project(client.list_projects(), project)["_id"])
            if project is not None
            else None
        )
        manager = TimerManager(config, client, app.store)
        status = manager.status()
        observed_timer_id = status.get("timerId")
        observed_start_time = status.get("startTime")
        if observed_timer_id is not None and not isinstance(observed_timer_id, str):
            raise ConfigurationError("Titra returned an invalid timer ID; no stop was attempted.")
        if not isinstance(observed_start_time, str) or not observed_start_time:
            raise ConfigurationError(
                "Titra returned no exact timer start time; no stop was attempted."
            )
        elapsed_seconds = int(status["elapsed_seconds"])
        if break_seconds >= elapsed_seconds and break_seconds:
            raise ConfigurationError(
                "Break subtraction must be shorter than the current elapsed duration; "
                "no stop was attempted."
            )
        if expect_timer_id is not None and observed_timer_id != expect_timer_id:
            raise ConflictError(
                "The current server timer does not match --expect-timer-id; no stop was attempted."
            )
        guarded_timer_id = observed_timer_id if isinstance(observed_timer_id, str) else None
        if not _preview_then_confirm(
            app,
            {
                "timerId": observed_timer_id,
                "startTime": observed_start_time,
                "elapsed": format_duration(elapsed_seconds),
                "projectId": project_id or status.get("projectId"),
                "task": task or status.get("task"),
                "submitRecord": bool(project_id is not None and task is not None and submit),
            },
            title="Timer stop preview",
            message="Stop this exact timer?",
            yes=yes,
        ):
            app.renderer.status("Timer stop cancelled; the server timer is still running.")
            return
        draft = manager.capture_stop(
            expected_timer_id=guarded_timer_id,
            expected_start_time=observed_start_time,
        )
        if project and task:
            assert project_id is not None
            draft = manager.prepare_timer_draft(
                draft,
                project_id=project_id,
                task=task,
                break_seconds=break_seconds,
                exact_seconds=exact_seconds,
                split_midnight=split_midnight,
            )
            if submit:
                if not _preview_then_confirm(
                    app,
                    {"draftId": draft.draft_id, "records": draft.payloads},
                    title="Stopped timer record preview",
                    message="Submit stopped timer as time record(s)?",
                    yes=yes,
                ):
                    submit = False
                else:
                    draft = manager.submit_draft(draft)
    app.renderer.emit(draft.to_dict(), title="Stopped timer draft", id_key="draft_id")


@timer_group.command("cancel")
@click.option(
    "--expect-timer-id",
    help="Stop only this exact v6 timer ID; required with --yes and noninteractive use.",
)
@click.option("--yes", is_flag=True)
@click.pass_obj
def timer_cancel(app: AppContext, expect_timer_id: str | None, yes: bool) -> None:
    if expect_timer_id is None and (yes or not _terminal_is_interactive()):
        raise ConfigurationError("Noninteractive timer cancellation requires --expect-timer-id.")
    normalized_expected_id = None if expect_timer_id == "null" else expect_timer_id
    with app.client() as (config, client):
        manager = TimerManager(config, client, app.store)
        status = manager.status()
        observed_id = status.get("timerId")
        observed_start_time = status.get("startTime")
        if not isinstance(observed_start_time, str) or not observed_start_time:
            raise ConfigurationError(
                "Titra returned no exact timer start time; no stop was attempted."
            )
        if expect_timer_id is not None and observed_id != normalized_expected_id:
            raise ConflictError(
                "The current server timer does not match --expect-timer-id; no stop was attempted."
            )
        if not _preview_then_confirm(
            app,
            {
                "timerId": observed_id,
                "startTime": status.get("startTime"),
                "elapsed": format_duration(int(status["elapsed_seconds"])),
                "projectId": status.get("projectId"),
                "task": status.get("task"),
            },
            title="Timer cancellation preview",
            message="Stop this exact timer without creating a time record?",
            yes=yes,
        ):
            return
        guarded_id = (
            normalized_expected_id
            if expect_timer_id is not None
            else (observed_id if isinstance(observed_id, str) else None)
        )
        draft = manager.capture_stop(
            expected_timer_id=guarded_id,
            expected_start_time=observed_start_time,
            discard=True,
        )
    app.renderer.emit(draft.to_dict(), title="Timer cancelled", id_key="draft_id")


@cli.group("creation", cls=SafeGroup)
def creation_group() -> None:
    """Inspect and safely resume durable idempotent create receipts."""


@creation_group.command("list")
@click.pass_obj
def creation_list(app: AppContext) -> None:
    config = app.resolve()
    rows = [
        {
            "id": receipt.get("receipt_id"),
            "created": receipt.get("created_at"),
            "operation": receipt.get("operation"),
            "status": receipt.get("status"),
            "result_id": receipt.get("result_id") or "",
        }
        for receipt in app.store.list_creation_receipts(config)
    ]
    app.renderer.emit(
        rows,
        title="Creation receipts",
        columns=["id", "created", "operation", "status", "result_id"],
        id_key="id",
    )


@creation_group.command("show")
@click.argument("receipt_id")
@click.pass_obj
def creation_show(app: AppContext, receipt_id: str) -> None:
    app.resolve()
    receipt = app.store.load_creation_receipt(receipt_id)
    visible = {**receipt, "idempotency_key": "<redacted>"}
    app.renderer.emit(visible, title="Creation receipt", id_key="receipt_id")


@creation_group.command("retry")
@click.argument("receipt_id")
@click.option("--yes", is_flag=True)
@click.pass_obj
def creation_retry(app: AppContext, receipt_id: str, yes: bool) -> None:
    receipt = app.store.load_creation_receipt(receipt_id)
    if receipt.get("status") not in {"pending", "submitting", "outcome_unknown"}:
        raise ConfigurationError(
            f"Creation receipt {receipt_id} cannot be retried in state {receipt.get('status')}."
        )
    if not _require_confirmation(
        app,
        "Retry this exact request with its original idempotency key?",
        yes=yes,
    ):
        app.renderer.status("Creation retry cancelled.")
        return
    with app.client() as (config, client):
        assert_expected_identity(client, config)
        result_id, path = _submit_creation_receipt(
            config,
            client,
            app.store,
            receipt,
            retry=True,
        )
    app.renderer.emit(
        {
            "receipt_id": receipt_id,
            "operation": receipt["operation"],
            "status": "completed",
            "result_id": result_id,
            "idempotency_replayed": receipt.get("recovery", {}).get("idempotency_replayed"),
            "idempotency_expires_at": receipt.get("recovery", {}).get("idempotency_expires_at"),
            "receipt": str(path),
        },
        title="Creation verified",
        id_key="result_id",
    )


@creation_group.command("verify-replay")
@click.argument("receipt_id")
@click.option(
    "--expect-result-id",
    required=True,
    help="Exact stored result ID; prevents replaying a different receipt result.",
)
@click.option("--yes", is_flag=True)
@click.pass_obj
def creation_verify_replay(
    app: AppContext,
    receipt_id: str,
    expect_result_id: str,
    yes: bool,
) -> None:
    """Prove that a completed v6 create replays to its original resource ID."""

    if not _require_confirmation(
        app,
        "Replay this completed receipt with its original body and idempotency key?",
        yes=yes,
    ):
        return
    with app.client() as (config, client):
        store = app.store
        receipt = store.load_creation_receipt(receipt_id)
        result, path = _verify_creation_receipt_replay(
            config,
            client,
            store,
            receipt,
            expected_result_id=expect_result_id,
        )
    app.renderer.emit(
        {**result, "receipt": str(path)},
        title="Creation replay verified",
        id_key="result_id",
    )


@cli.group("draft", cls=SafeGroup)
def draft_group() -> None:
    """Recover, finalize, reconcile, or discard durable pending writes."""


@draft_group.command("list")
@click.option("--all-profiles", is_flag=True)
@click.pass_obj
def draft_list(app: AppContext, all_profiles: bool) -> None:
    resolved = app.resolve()
    config = None if all_profiles else resolved
    drafts = app.store.list_drafts(config)
    rows = [
        {
            "id": draft.draft_id,
            "created": draft.created_at,
            "status": draft.status,
            "profile": draft.profile,
            "records": len(draft.payloads),
            "result_ids": ",".join(draft.result_ids),
            "note": draft.note or "",
        }
        for draft in drafts
    ]
    app.renderer.emit(
        rows,
        title="Local drafts",
        columns=["id", "created", "status", "profile", "records", "result_ids", "note"],
        id_key="id",
    )


@draft_group.command("show")
@click.argument("draft_id")
@click.pass_obj
def draft_show(app: AppContext, draft_id: str) -> None:
    app.resolve()
    app.renderer.emit(app.store.load_draft(draft_id).to_dict(), title="Draft")


@draft_group.command("finalize")
@click.argument("draft_id")
@click.option("--project", required=True)
@click.option("--task", required=True)
@click.option("--break", "break_value")
@click.option("--duration", "exact_duration")
@click.option("--split-midnight", is_flag=True)
@click.option("--submit", is_flag=True)
@click.option("--yes", is_flag=True)
@click.pass_obj
def draft_finalize(
    app: AppContext,
    draft_id: str,
    project: str,
    task: str,
    break_value: str | None,
    exact_duration: str | None,
    split_midnight: bool,
    submit: bool,
    yes: bool,
) -> None:
    with app.client() as (config, client):
        manager = TimerManager(config, client, app.store)
        draft = app.store.load_draft(draft_id)
        manager.validate_draft_access(draft)
        project_id = str(resolve_project(client.list_projects(), project)["_id"])
        draft = manager.prepare_timer_draft(
            draft,
            project_id=project_id,
            task=task,
            break_seconds=parse_duration(break_value) if break_value else 0,
            exact_seconds=parse_duration(exact_duration) if exact_duration else None,
            split_midnight=split_midnight,
        )
        if submit and _require_confirmation(app, "Submit this finalized draft?", yes=yes):
            draft = manager.submit_draft(draft)
    app.renderer.emit(draft.to_dict(), title="Finalized draft", id_key="draft_id")


@draft_group.command("submit")
@click.argument("draft_id")
@click.option("--yes", is_flag=True)
@click.pass_obj
def draft_submit(app: AppContext, draft_id: str, yes: bool) -> None:
    if not _require_confirmation(app, "Submit this draft exactly once?", yes=yes):
        return
    with app.client() as (config, client):
        manager = TimerManager(config, client, app.store)
        draft = manager.submit_draft(app.store.load_draft(draft_id))
    app.renderer.emit(draft.to_dict(), title="Submitted draft", id_key="draft_id")


@draft_group.command("verify-replay")
@click.argument("draft_id")
@click.option(
    "--expect-result-id",
    "expect_result_ids",
    multiple=True,
    required=True,
    help="Exact stored result ID; repeat once for every record in draft order.",
)
@click.option("--yes", is_flag=True)
@click.pass_obj
def draft_verify_replay(
    app: AppContext,
    draft_id: str,
    expect_result_ids: tuple[str, ...],
    yes: bool,
) -> None:
    """Prove submitted v6 records replay to the same IDs without creating duplicates."""

    if not _require_confirmation(
        app,
        "Replay this submitted draft with its original bodies and idempotency keys?",
        yes=yes,
    ):
        return
    with app.client() as (config, client):
        manager = TimerManager(config, client, app.store)
        result = manager.verify_submitted_draft_replay(
            app.store.load_draft(draft_id),
            expected_result_ids=list(expect_result_ids),
        )
    app.renderer.emit(result, title="Draft replay verified", id_key="draft_id")


@draft_group.command("reconcile")
@click.argument("draft_id")
@click.pass_obj
def draft_reconcile(app: AppContext, draft_id: str) -> None:
    with app.client() as (config, client):
        manager = TimerManager(config, client, app.store)
        result = manager.reconcile_draft(app.store.load_draft(draft_id))
    app.renderer.emit(result, title="Draft reconciliation")


@draft_group.command("recover-stop")
@click.argument("draft_id")
@click.option("--yes", is_flag=True)
@click.pass_obj
def draft_recover_stop(app: AppContext, draft_id: str, yes: bool) -> None:
    """Retry one exact v6 timer stop from its durable CAS receipt."""
    if not _require_confirmation(
        app,
        "Retry the exact journaled v6 timer stop and recover its duration?",
        yes=yes,
    ):
        return
    with app.client() as (config, client):
        manager = TimerManager(config, client, app.store)
        draft = manager.recover_stop(app.store.load_draft(draft_id))
    app.renderer.emit(draft.to_dict(), title="Recovered timer stop", id_key="draft_id")


@draft_group.command("retry")
@click.argument("draft_id")
@click.option("--yes", is_flag=True)
@click.pass_obj
def draft_retry(app: AppContext, draft_id: str, yes: bool) -> None:
    if not _require_confirmation(
        app,
        "I inspected reconciliation and confirm the server has no matching record; mark retryable?",
        yes=yes,
    ):
        return
    with app.client() as (config, client):
        manager = TimerManager(config, client, app.store)
        draft = manager.mark_retryable_after_reconciliation(app.store.load_draft(draft_id))
    app.renderer.emit(draft.to_dict(), title="Draft marked retryable", id_key="draft_id")


@draft_group.command("discard")
@click.argument("draft_id")
@click.option("--yes", is_flag=True)
@click.pass_obj
def draft_discard(app: AppContext, draft_id: str, yes: bool) -> None:
    with app.client() as (config, client):
        manager = TimerManager(config, client, app.store)
        draft = app.store.load_draft(draft_id)
        manager.validate_draft_access(draft)
        if not _preview_then_confirm(
            app,
            draft.to_dict(),
            title="Draft discard preview",
            message="Discard this local draft?",
            yes=yes,
        ):
            return
        draft = manager.discard_draft(draft)
    app.renderer.emit(draft.to_dict(), title="Draft discarded", id_key="draft_id")


def _interactive_project(
    app: AppContext, client: TitraClient, reference: str | None
) -> dict[str, Any]:
    projects = [project for project in client.list_projects() if not project.get("archived")]
    if reference:
        return resolve_project(projects, reference)
    app.renderer.error_console.print("Available projects:")
    for row in project_rows(projects):
        app.renderer.error_console.print(app.renderer.sanitize(f"  {row['id']}  {row['name']}"))
    chosen = click.prompt("Project ID or exact name", err=True)
    return resolve_project(projects, chosen)


def _wait_for_done(app: AppContext, started_at: str) -> None:
    if not _terminal_is_interactive():
        raise ConfigurationError("Foreground tracking requires an interactive terminal.")
    started = parse_timestamp(started_at)
    completed: queue.SimpleQueue[bool] = queue.SimpleQueue()

    def read_line() -> None:
        try:
            sys.stdin.readline()
        finally:
            completed.put(True)

    thread = threading.Thread(target=read_line, daemon=True)
    app.renderer.error_console.print("Tracking. Press Enter when the task is done.")
    thread.start()
    with Live(Text("00:00:00"), console=app.renderer.error_console, refresh_per_second=4) as live:
        while completed.empty():
            elapsed = max(
                0,
                round((datetime.now(UTC) - started.astimezone(UTC)).total_seconds()),
            )
            live.update(Text(f"Elapsed {format_duration(elapsed)}", style="bold cyan"))
            time.sleep(0.2)


def _run_track(app: AppContext, project: str | None, task: str | None) -> None:
    with app.client(interactive=True) as (config, client):
        assert_expected_identity(client, config)
        manager = TimerManager(config, client, app.store)
        project_value = _interactive_project(app, client, project) if project else None
        try:
            timer = manager.start(
                project_id=str(project_value["_id"]) if project_value else None,
                task=task,
            )
        except TitraCliError as exc:
            if "already a running" not in str(exc):
                raise
            if not click.confirm(
                "A server timer is already running. Attach to it?", default=True, err=True
            ):
                raise
            timer = manager.adopt(
                project_id=str(project_value["_id"]) if project_value else None,
                task=task,
            )
        try:
            _wait_for_done(app, timer.started_at)
        except KeyboardInterrupt:
            app.renderer.warn(
                "Foreground monitor stopped; the Titra server timer is still running."
            )
            return
        draft = manager.capture_stop()
        if project_value is None:
            project_value = _interactive_project(app, client, None)
        description = task or click.prompt("Task description", err=True)
        adjustment = click.prompt(
            "Break to subtract (for example 10m), =exact duration, or blank",
            default="",
            show_default=False,
            err=True,
        ).strip()
        break_seconds = 0
        exact_seconds = None
        if adjustment.startswith("="):
            exact_seconds = parse_duration(adjustment[1:])
        elif adjustment:
            break_seconds = parse_duration(adjustment)
        timer_data = draft.timer or {}
        start_day = (
            parse_timestamp(str(timer_data["started_at"]))
            .astimezone(ZoneInfo(config.timezone))
            .date()
        )
        stop_day = (
            parse_timestamp(str(timer_data["stopped_at"]))
            .astimezone(ZoneInfo(config.timezone))
            .date()
        )
        split = False
        if start_day != stop_day and exact_seconds is None:
            split = click.confirm(
                f"Timer crossed midnight ({start_day} to {stop_day}). Split by calendar day?",
                default=True,
                err=True,
            )
        draft = manager.prepare_timer_draft(
            draft,
            project_id=str(project_value["_id"]),
            task=description,
            break_seconds=break_seconds,
            exact_seconds=exact_seconds,
            split_midnight=split,
        )
        app.renderer.error_console.print("Exact payload preview:")
        app.renderer.error_console.print_json(
            json.dumps(app.renderer.sanitize(draft.payloads), ensure_ascii=False)
        )
        if click.confirm("Submit these time record(s)?", default=True, err=True):
            draft = manager.submit_draft(draft)
        else:
            app.renderer.warn(f"Not submitted; retained as draft {draft.draft_id}.")
    app.renderer.emit(draft.to_dict(), title="Tracked work", id_key="draft_id")


@cli.command("track")
@click.option("--project")
@click.option("--task")
@click.pass_obj
def track_command(app: AppContext, project: str | None, task: str | None) -> None:
    """Run a live foreground timer and finalize it interactively."""

    _run_track(app, project, task)


def _prompt_optional(label: str) -> str | None:
    value = click.prompt(label, default="", show_default=False, err=True).strip()
    return value or None


def _prompt_optional_number(label: str) -> float | None:
    value = _prompt_optional(label)
    if value is None:
        return None
    try:
        number = float(value)
    except ValueError as exc:
        raise ConfigurationError(f"{label} must be numeric.") from exc
    if not (-float("inf") < number < float("inf")) or number < 0:
        raise ConfigurationError(f"{label} must be a finite nonnegative number.")
    return number


def _prompt_date_options() -> dict[str, Any]:
    labels = [
        "Current month",
        "Today",
        "Current week",
        "Named calendar month",
        "Custom date range",
    ]
    choice = _menu_selection("Date range", labels, back=False)
    values: dict[str, Any] = {
        "from_date": None,
        "to_date": None,
        "today": False,
        "week": False,
        "month": False,
        "calendar_month": None,
    }
    if choice == 0:
        raise click.Abort()
    if choice == 1:
        values["month"] = True
    elif choice == 2:
        values["today"] = True
    elif choice == 3:
        values["week"] = True
    elif choice == 4:
        values["calendar_month"] = click.prompt("Calendar month (YYYY-MM)", err=True)
    else:
        values["from_date"] = click.prompt("From date (YYYY-MM-DD)", err=True)
        values["to_date"] = click.prompt("To date (YYYY-MM-DD)", err=True)
    return values


def _menu_selection(title: str, labels: list[str], *, back: bool = True) -> int:
    console = click.get_current_context().obj.renderer.error_console
    console.print(f"\n{title}", style="bold")
    for index, label in enumerate(labels, start=1):
        console.print(f"  {index}) {label}")
    console.print(f"  0) {'Back' if back else 'Cancel'}")
    selected = click.prompt(
        "Selection",
        type=click.IntRange(min=0, max=len(labels)),
        err=True,
    )
    return int(selected)


def _run_interactive_action(app: AppContext, action: Callable[[], None]) -> None:
    try:
        action()
    except TitraCliError as exc:
        app.renderer.error(str(exc))
    except click.ClickException as exc:
        app.renderer.error(exc.format_message())
    except click.Abort:
        app.renderer.warn("Action cancelled.")


def _interactive_menu(
    app: AppContext,
    title: str,
    actions: list[tuple[str, Callable[[], None]]],
) -> None:
    while True:
        choice = _menu_selection(title, [label for label, _action in actions])
        if choice == 0:
            return
        _run_interactive_action(app, actions[choice - 1][1])


def _collect_changes(
    app: AppContext,
    title: str,
    fields: list[tuple[str, str, str]],
) -> dict[str, Any]:
    changes: dict[str, Any] = {}
    while True:
        choice = _menu_selection(title, [label for label, _field, _kind in fields], back=False)
        if choice == 0:
            if changes:
                return changes
            raise ConfigurationError("No fields were selected.")
        label, field, kind = fields[choice - 1]
        if kind == "boolean":
            value: Any = (
                click.prompt(label, type=click.Choice(["true", "false"]), err=True) == "true"
            )
        elif kind == "number-null":
            raw = click.prompt(f"{label} (number, or ~ to clear)", err=True).strip()
            value = None if raw == "~" else _parse_nonnegative_number(raw, label)
        elif kind == "date-null":
            raw = click.prompt(f"{label} (YYYY-MM-DD, or ~ to clear)", err=True).strip()
            value = None if raw == "~" else parse_date(raw).isoformat()
        elif kind == "dependencies":
            raw = click.prompt(
                "Dependency task IDs (comma separated; blank clears)",
                default="",
                show_default=False,
                err=True,
            )
            value = [item.strip() for item in raw.split(",") if item.strip()]
        elif kind == "project":
            reference = click.prompt("Project ID or exact name", err=True)
            with app.client() as (_config, client):
                value = str(resolve_project(client.list_projects(), reference)["_id"])
        elif kind == "hours":
            value = _parse_positive_number(click.prompt(label, err=True), label)
        elif kind == "start-null":
            raw = click.prompt(f"{label} (HH:MM, or ~ to clear)", err=True).strip()
            if raw != "~" and not _START_TIME.fullmatch(raw):
                raise ConfigurationError("Start time must use 24-hour HH:MM format.")
            value = None if raw == "~" else raw
        elif kind == "text-null":
            raw = click.prompt(f"{label} (or ~ to clear)", err=True)
            value = None if raw == "~" else raw
        else:
            value = click.prompt(label, err=True)
        changes[field] = value
        if not click.confirm("Change another field?", default=False, err=True):
            return changes


def _parse_nonnegative_number(value: str, label: str) -> float:
    try:
        number = float(value)
    except ValueError as exc:
        raise ConfigurationError(f"{label} must be numeric.") from exc
    if not (-float("inf") < number < float("inf")) or number < 0:
        raise ConfigurationError(f"{label} must be a finite nonnegative number.")
    return number


def _parse_positive_number(value: str, label: str) -> float:
    number = _parse_nonnegative_number(value, label)
    if number <= 0:
        raise ConfigurationError(f"{label} must be greater than zero.")
    return number


def _interactive_timer_stop(context: click.Context) -> None:
    finalize = click.confirm(
        "Finalize the stopped timer into a record now?", default=True, err=True
    )
    if not finalize:
        context.invoke(timer_stop, project=None, task=None, submit=False, yes=False)
        return
    project = click.prompt("Project ID or exact name", err=True)
    task = click.prompt("Task description", err=True)
    adjustment = _prompt_optional("Break to subtract, or =exact duration")
    break_value = None
    exact_duration = None
    if adjustment and adjustment.startswith("="):
        exact_duration = adjustment[1:]
    else:
        break_value = adjustment
    context.invoke(
        timer_stop,
        project=project,
        task=task,
        break_value=break_value,
        exact_duration=exact_duration,
        split_midnight=click.confirm("Split at local midnight if needed?", default=True, err=True),
        submit=True,
        yes=False,
    )


def _interactive_timer_adopt(context: click.Context) -> None:
    project = _prompt_optional("Project ID/name (blank for no local association)")
    task = click.prompt("Task description", err=True) if project else None
    context.invoke(
        timer_adopt,
        project=project,
        task=task,
        expect_timer_id=None,
        expect_start_time=None,
        yes=False,
    )


def _interactive_timer_menu(app: AppContext, context: click.Context) -> None:
    _interactive_menu(
        app,
        "Timer",
        [
            (
                "Start detached timer",
                lambda: context.invoke(
                    timer_start,
                    project=_prompt_optional("Project ID/name (blank for none)"),
                    task=_prompt_optional("Task description (blank for none)"),
                ),
            ),
            ("Status", lambda: context.invoke(timer_status)),
            (
                "Recover an interrupted v6 start",
                lambda: context.invoke(timer_recover_start, yes=False),
            ),
            ("Adopt current server timer", lambda: _interactive_timer_adopt(context)),
            ("Pause locally", lambda: context.invoke(timer_pause)),
            ("Resume", lambda: context.invoke(timer_resume)),
            ("Stop and finalize", lambda: _interactive_timer_stop(context)),
            (
                "Cancel without a record",
                lambda: context.invoke(timer_cancel, expect_timer_id=None, yes=False),
            ),
        ],
    )


def _interactive_record_list(context: click.Context) -> None:
    values = _prompt_date_options()
    project = _prompt_optional("Project ID/name filter (blank for all)")
    team = bool(project) and click.confirm(
        "Include records from all users in this project?", default=False, err=True
    )
    context.invoke(
        record_list,
        **values,
        projects=(project,) if project else (),
        users=(),
        team=team,
        limit=500,
        api_page_size=200,
        raw=False,
    )


def _interactive_record_create(context: click.Context) -> None:
    context.invoke(
        record_create,
        project=click.prompt("Project ID or exact name", err=True),
        task=click.prompt("Task description", err=True),
        date_value=_prompt_optional("Date YYYY-MM-DD (blank for today)"),
        start_time=_prompt_optional("Start time HH:MM (blank for none)"),
        duration=click.prompt("Duration (for example 1h30m)", err=True),
        hours=None,
        task_rate=_prompt_optional_number("Task rate (blank for project default)"),
        custom_fields=_prompt_optional("Custom fields JSON object (blank for none)"),
        dry_run=False,
        yes=False,
    )


def _interactive_record_details(app: AppContext, context: click.Context) -> None:
    changes = _collect_changes(
        app,
        "Time-record field to change",
        [
            ("Project", "projectId", "project"),
            ("Hours", "hours", "hours"),
            ("Calendar date", "dateOnly", "text"),
            ("Start time", "startTime", "start-null"),
        ],
    )
    if "dateOnly" in changes:
        changes["dateOnly"] = parse_date(str(changes["dateOnly"])).isoformat()
    context.invoke(
        record_edit_details,
        record_id=click.prompt("Record ID", err=True),
        changes=json.dumps(changes, ensure_ascii=False),
        accept_legacy_conversion=click.confirm(
            "Explicitly permit legacy calendar conversion if required?", default=False, err=True
        ),
        dry_run=False,
        yes=False,
    )


def _interactive_record_menu(app: AppContext, context: click.Context) -> None:
    _interactive_menu(
        app,
        "Time records",
        [
            ("List", lambda: _interactive_record_list(context)),
            (
                "Show",
                lambda: context.invoke(record_show, record_id=click.prompt("Record ID", err=True)),
            ),
            ("Create", lambda: _interactive_record_create(context)),
            (
                "Edit Task",
                lambda: context.invoke(
                    record_edit_task,
                    record_id=click.prompt("Record ID", err=True),
                    task=click.prompt("New Task", err=True),
                    expect_task=None,
                    if_match=None,
                    dry_run=False,
                    yes=False,
                ),
            ),
            (
                "Reconcile an uncertain Task edit",
                lambda: context.invoke(
                    record_reconcile_task_edit,
                    receipt_id=click.prompt("Task-edit receipt ID", err=True),
                ),
            ),
            (
                "Edit date, duration, start, or project",
                lambda: _interactive_record_details(app, context),
            ),
            (
                "Delete",
                lambda: context.invoke(
                    record_delete,
                    record_id=click.prompt("Record ID", err=True),
                    expect_project_id=click.prompt("Exact project ID", err=True),
                    expect_task=click.prompt(
                        "Exact Task text (may be empty)", default="", show_default=False, err=True
                    ),
                    if_match=_prompt_optional("Exact ETag (blank to use the fresh snapshot)"),
                    dry_run=False,
                    yes=False,
                ),
            ),
        ],
    )


_PROJECT_CHANGE_FIELDS = [
    ("Name", "name", "text"),
    ("Description", "description", "text-null"),
    ("Color", "color", "text-null"),
    ("Customer", "customer", "text-null"),
    ("Rate", "rate", "number-null"),
    ("Budget", "budget", "number-null"),
    ("Start date", "startDate", "date-null"),
    ("End date", "endDate", "date-null"),
    ("Public", "public", "boolean"),
    ("Not billable", "notbillable", "boolean"),
]


def _interactive_project_create(context: click.Context) -> None:
    context.invoke(
        project_create,
        name=click.prompt("Project name", err=True),
        description=_prompt_optional("Description (blank for none)"),
        color=_prompt_optional("Color #RRGGBB (blank for none)"),
        customer=_prompt_optional("Customer (blank for none)"),
        rate=_prompt_optional_number("Rate (blank for none)"),
        budget=_prompt_optional_number("Budget (blank for none)"),
        dry_run=False,
        yes=False,
    )


def _interactive_project_edit(app: AppContext, context: click.Context) -> None:
    changes = _collect_changes(app, "Project field to change", _PROJECT_CHANGE_FIELDS)
    context.invoke(
        project_edit,
        project=click.prompt("Project ID or exact name", err=True),
        changes=json.dumps(changes, ensure_ascii=False),
        dry_run=False,
        yes=False,
    )


def _interactive_project_recovery(app: AppContext, context: click.Context) -> None:
    _interactive_menu(
        app,
        "Project safety-fence recovery",
        [
            (
                "Inspect",
                lambda: context.invoke(
                    project_recovery_inspect,
                    project=click.prompt("Project ID or exact name", err=True),
                ),
            ),
            (
                "Clear one server-verified stale fence",
                lambda: context.invoke(
                    project_recovery_recover,
                    project=click.prompt("Project ID or exact name", err=True),
                    recovery_type=click.prompt(
                        "Fence type", type=click.Choice(["writer", "task-delete"]), err=True
                    ),
                    recovery_id=click.prompt("Exact recovery ID from Inspect", err=True),
                    dry_run=False,
                    yes=False,
                ),
            ),
        ],
    )


def _interactive_project_menu(app: AppContext, context: click.Context) -> None:
    _interactive_menu(
        app,
        "Projects",
        [
            ("List active", lambda: context.invoke(project_list, include_archived=False)),
            (
                "List including archived",
                lambda: context.invoke(project_list, include_archived=True),
            ),
            (
                "Show",
                lambda: context.invoke(
                    project_show, project=click.prompt("Project ID or exact name", err=True)
                ),
            ),
            (
                "Observed users",
                lambda: context.invoke(
                    project_users, project=click.prompt("Project ID or exact name", err=True)
                ),
            ),
            ("Create", lambda: _interactive_project_create(context)),
            ("Edit details", lambda: _interactive_project_edit(app, context)),
            (
                "Archive",
                lambda: context.invoke(
                    project_archive,
                    project=click.prompt("Project ID or exact name", err=True),
                    dry_run=False,
                    yes=False,
                ),
            ),
            (
                "Restore",
                lambda: context.invoke(
                    project_restore,
                    project=click.prompt("Project ID or exact name", err=True),
                    dry_run=False,
                    yes=False,
                ),
            ),
            (
                "Delete an empty project",
                lambda: context.invoke(
                    project_delete,
                    project=click.prompt("Project ID or exact name", err=True),
                    expect_name=click.prompt("Exact current project name", err=True),
                    if_match=_prompt_optional("Exact ETag (blank to use the fresh snapshot)"),
                    dry_run=False,
                    yes=False,
                ),
            ),
            ("Safety-fence recovery", lambda: _interactive_project_recovery(app, context)),
        ],
    )


def _interactive_task_create(context: click.Context) -> None:
    dependencies = _prompt_optional("Dependency task IDs, comma separated")
    context.invoke(
        task_create,
        project=click.prompt("Project ID or exact name", err=True),
        name=click.prompt("Task name", err=True),
        start=click.prompt("Start date YYYY-MM-DD", err=True),
        end=click.prompt("End date YYYY-MM-DD", err=True),
        estimated_hours=_prompt_optional_number("Estimated hours (blank for none)"),
        dependencies=tuple(item.strip() for item in dependencies.split(",") if item.strip())
        if dependencies
        else (),
        custom_fields=_prompt_optional("Custom fields JSON object (blank for none)"),
        dry_run=False,
        yes=False,
    )


def _interactive_task_edit(app: AppContext, context: click.Context) -> None:
    changes = _collect_changes(
        app,
        "Predefined-task field to change",
        [
            ("Name", "name", "text"),
            ("Start date", "start", "date-null"),
            ("End date", "end", "date-null"),
            ("Estimated hours", "estimatedHours", "number-null"),
            ("Dependencies", "dependencies", "dependencies"),
        ],
    )
    context.invoke(
        task_edit,
        task_id=click.prompt("Task ID", err=True),
        changes=json.dumps(changes, ensure_ascii=False),
        dry_run=False,
        yes=False,
    )


def _interactive_task_menu(app: AppContext, context: click.Context) -> None:
    _interactive_menu(
        app,
        "Predefined project tasks",
        [
            (
                "List",
                lambda: context.invoke(
                    task_list, project=click.prompt("Project ID or exact name", err=True)
                ),
            ),
            ("Show", lambda: context.invoke(task_show, task_id=click.prompt("Task ID", err=True))),
            (
                "Planned versus actual statistics",
                lambda: context.invoke(
                    task_stats,
                    project=click.prompt("Project ID or exact name", err=True),
                    task_name=_prompt_optional("Exact task name filter (blank for all)"),
                ),
            ),
            ("Create", lambda: _interactive_task_create(context)),
            ("Edit", lambda: _interactive_task_edit(app, context)),
            (
                "Delete",
                lambda: context.invoke(
                    task_delete,
                    task_id=click.prompt("Task ID", err=True),
                    expect_project_id=click.prompt("Exact project ID", err=True),
                    expect_name=click.prompt("Exact current task name", err=True),
                    if_match=_prompt_optional("Exact ETag (blank to use the fresh snapshot)"),
                    acknowledge_recorded_entries=click.confirm(
                        "Acknowledge that historical records keep this name?",
                        default=False,
                        err=True,
                    ),
                    dry_run=False,
                    yes=False,
                ),
            ),
        ],
    )


def _interactive_suggestion_menu(app: AppContext, context: click.Context) -> None:
    _interactive_menu(
        app,
        "Personal task suggestions",
        [
            ("List", lambda: context.invoke(suggestion_list, page_size=100)),
            (
                "Show",
                lambda: context.invoke(
                    suggestion_show, suggestion_id=click.prompt("Suggestion ID", err=True)
                ),
            ),
            (
                "Delete",
                lambda: context.invoke(
                    suggestion_delete,
                    suggestion_id=click.prompt("Suggestion ID", err=True),
                    expect_name=click.prompt("Exact suggestion name", err=True),
                    if_match=_prompt_optional("Exact ETag (blank to use the fresh snapshot)"),
                    acknowledge_referenced_records=click.confirm(
                        "Acknowledge records that still use this name?", default=False, err=True
                    ),
                    dry_run=False,
                    yes=False,
                ),
            ),
        ],
    )


def _interactive_report(context: click.Context, command: click.Command) -> None:
    values = _prompt_date_options()
    project = _prompt_optional("Project ID/name filter (blank for own records across all)")
    team = bool(project) and click.confirm("Include the project team?", default=False, err=True)
    kwargs: dict[str, Any] = {
        **values,
        "projects": (project,) if project else (),
        "users": (),
        "team": team,
    }
    if command is report_summary:
        group = _prompt_optional("Group by fields, comma separated (default project)")
        groups = tuple(item.strip() for item in group.split(",") if item.strip()) if group else ()
        kwargs["group_by"] = groups or ("project",)
    context.invoke(command, **kwargs)


def _interactive_report_menu(app: AppContext, context: click.Context) -> None:
    _interactive_menu(
        app,
        "Reports",
        [
            ("Summary", lambda: _interactive_report(context, report_summary)),
            ("Timesheet", lambda: _interactive_report(context, report_timesheet)),
            ("Calendar", lambda: _interactive_report(context, report_calendar)),
        ],
    )


def _interactive_draft_finalize(context: click.Context) -> None:
    adjustment = _prompt_optional("Break to subtract, or =exact duration")
    context.invoke(
        draft_finalize,
        draft_id=click.prompt("Draft ID", err=True),
        project=click.prompt("Project ID or exact name", err=True),
        task=click.prompt("Task description", err=True),
        break_value=adjustment if adjustment and not adjustment.startswith("=") else None,
        exact_duration=adjustment[1:] if adjustment and adjustment.startswith("=") else None,
        split_midnight=click.confirm("Split at local midnight if needed?", default=True, err=True),
        submit=click.confirm("Submit after finalizing?", default=False, err=True),
        yes=False,
    )


def _interactive_draft_verify_replay(context: click.Context) -> None:
    draft_id = click.prompt("Draft ID", err=True)
    result_ids = click.prompt(
        "Exact stored result IDs, comma separated in draft order",
        err=True,
    )
    context.invoke(
        draft_verify_replay,
        draft_id=draft_id,
        expect_result_ids=tuple(item.strip() for item in result_ids.split(",") if item.strip()),
        yes=False,
    )


def _interactive_draft_menu(app: AppContext, context: click.Context) -> None:
    _interactive_menu(
        app,
        "Drafts and creation receipts",
        [
            ("List pending drafts", lambda: context.invoke(draft_list, all_profiles=False)),
            (
                "Show draft",
                lambda: context.invoke(draft_show, draft_id=click.prompt("Draft ID", err=True)),
            ),
            ("Finalize stopped timer draft", lambda: _interactive_draft_finalize(context)),
            (
                "Submit draft",
                lambda: context.invoke(
                    draft_submit, draft_id=click.prompt("Draft ID", err=True), yes=False
                ),
            ),
            (
                "Verify submitted draft idempotency replay",
                lambda: _interactive_draft_verify_replay(context),
            ),
            (
                "Reconcile draft",
                lambda: context.invoke(
                    draft_reconcile, draft_id=click.prompt("Draft ID", err=True)
                ),
            ),
            (
                "Recover exact timer stop",
                lambda: context.invoke(
                    draft_recover_stop, draft_id=click.prompt("Draft ID", err=True), yes=False
                ),
            ),
            (
                "Mark reconciled draft retryable",
                lambda: context.invoke(
                    draft_retry, draft_id=click.prompt("Draft ID", err=True), yes=False
                ),
            ),
            (
                "Discard draft",
                lambda: context.invoke(
                    draft_discard, draft_id=click.prompt("Draft ID", err=True), yes=False
                ),
            ),
            ("List creation receipts", lambda: context.invoke(creation_list)),
            (
                "Show creation receipt",
                lambda: context.invoke(
                    creation_show, receipt_id=click.prompt("Receipt ID", err=True)
                ),
            ),
            (
                "Retry exact idempotent creation",
                lambda: context.invoke(
                    creation_retry, receipt_id=click.prompt("Receipt ID", err=True), yes=False
                ),
            ),
            (
                "Verify completed creation idempotency replay",
                lambda: context.invoke(
                    creation_verify_replay,
                    receipt_id=click.prompt("Receipt ID", err=True),
                    expect_result_id=click.prompt("Exact stored result ID", err=True),
                    yes=False,
                ),
            ),
        ],
    )


def _interactive_webhook(context: click.Context, *, send: bool) -> None:
    kwargs = {
        "endpoint_id": click.prompt("Webhook endpoint ID", err=True),
        "event_id": _prompt_optional("Event ID (blank generates a unique ID)"),
        "payload_file": Path(click.prompt("Exact JSON body file", err=True)),
        "secret_env": None,
        "secret_file": None,
        "timestamp": None,
        "request_id": None,
    }
    if send:
        context.invoke(webhook_send, **kwargs, yes=False)
    else:
        context.invoke(webhook_prepare, **kwargs)


def _interactive_webhook_retry(context: click.Context) -> None:
    context.invoke(
        webhook_retry,
        receipt_id=click.prompt("Webhook delivery receipt ID", err=True),
        secret_env=None,
        secret_file=None,
        yes=False,
    )


def _interactive_webhook_show(context: click.Context) -> None:
    context.invoke(
        webhook_show,
        receipt_id=click.prompt("Webhook delivery receipt ID", err=True),
    )


def _interactive_connection_menu(app: AppContext, context: click.Context) -> None:
    _interactive_menu(
        app,
        "Connection and API",
        [
            ("Authentication check", lambda: context.invoke(auth_check)),
            ("Doctor", lambda: context.invoke(doctor)),
            (
                "Show negotiated capabilities",
                lambda: context.invoke(capabilities_show, version_name="auto"),
            ),
            (
                "Require complete v6 capabilities",
                lambda: context.invoke(capabilities_check, require_v6=True, require_v7=False),
            ),
            (
                "Require complete v7 API/security profile",
                lambda: context.invoke(capabilities_check, require_v6=False, require_v7=True),
            ),
            (
                "Check v7 security headers",
                lambda: context.invoke(security_check, require_hsts=False),
            ),
            (
                "Check v7 security headers + HSTS",
                lambda: context.invoke(security_check, require_hsts=True),
            ),
            ("Prepare signed webhook", lambda: _interactive_webhook(context, send=False)),
            ("Send signed webhook", lambda: _interactive_webhook(context, send=True)),
            ("List webhook receipts", lambda: context.invoke(webhook_list)),
            ("Show webhook receipt", lambda: _interactive_webhook_show(context)),
            ("Retry journaled webhook", lambda: _interactive_webhook_retry(context)),
        ],
    )


@cli.command("interactive")
@click.pass_obj
def interactive_command(app: AppContext) -> None:
    """Open the complete interactive terminal dashboard."""

    if not _terminal_is_interactive():
        raise ConfigurationError("Interactive mode requires a terminal.")
    # Prime credentials while prompting is explicitly permitted. Nested command
    # invocations can then share the resolved profile without silently disabling prompts.
    app.resolve(interactive=True)
    context = click.get_current_context()
    actions = [
        ("Track work now", lambda: _run_track(app, None, None)),
        ("Timer", lambda: _interactive_timer_menu(app, context)),
        ("Time records", lambda: _interactive_record_menu(app, context)),
        ("Projects and recovery", lambda: _interactive_project_menu(app, context)),
        ("Predefined tasks and statistics", lambda: _interactive_task_menu(app, context)),
        ("Personal task suggestions", lambda: _interactive_suggestion_menu(app, context)),
        ("Reports", lambda: _interactive_report_menu(app, context)),
        ("Drafts and creation receipts", lambda: _interactive_draft_menu(app, context)),
        (
            "Connection, capabilities, and webhooks",
            lambda: _interactive_connection_menu(app, context),
        ),
    ]
    while True:
        choice = _menu_selection("Titra CLI", [label for label, _action in actions], back=False)
        if choice == 0:
            return
        _run_interactive_action(app, actions[choice - 1][1])


def main() -> NoReturn:
    try:
        cli(standalone_mode=True)
    except BrokenPipeError:
        try:
            sys.stdout.close()
        finally:
            raise SystemExit(0) from None
    except KeyboardInterrupt:
        raise SystemExit(int(ExitCode.INTERRUPTED)) from None
    raise SystemExit(0)
