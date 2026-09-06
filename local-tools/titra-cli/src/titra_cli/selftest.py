"""Local quality checks and privacy-preserving live v5/v6/v7 API verification.

The live checks deliberately execute the public ``titra`` command in child
processes.  Credentials are injected through the child environment, never a
command-line argument, and captured command output is not echoed because it can
contain real Titra data.
"""

from __future__ import annotations

import argparse
import getpass
import ipaddress
import json
import math
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import time
import uuid
from collections.abc import Callable, Mapping, Sequence
from contextlib import suppress
from copy import deepcopy
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any, Protocol
from urllib.parse import urlsplit, urlunsplit

from .config import resolve_config
from .durations import hours_to_seconds, seconds_to_hours
from .errors import ConfigurationError


class SelfTestError(RuntimeError):
    """A local check or live contract check failed safely."""


@dataclass(frozen=True, slots=True)
class CheckResult:
    name: str
    status: str
    detail: str = ""


@dataclass(frozen=True, slots=True)
class CommandResult:
    returncode: int
    stdout: str
    stderr: str


@dataclass(frozen=True, slots=True)
class LiveConnection:
    """One atomically resolved live-test credential source."""

    server: str
    api_token: str
    expected_username: str | None
    profile: str


class JsonInvoker(Protocol):
    def invoke_json(
        self, arguments: Sequence[str], *, allowed_codes: frozenset[int] = frozenset({0})
    ) -> tuple[Any, int]: ...


_ENV_NAME = re.compile(r"[A-Za-z_][A-Za-z0-9_]*\Z")
_SAFE_NAMESPACE = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,39}\Z")
_RECOVERY_MARKER = re.compile(
    r"__(?P<namespace>[A-Za-z0-9][A-Za-z0-9_.-]{0,39})_"
    r"(?P<timestamp>\d{8}T\d{6}Z)_(?P<entropy>[A-Za-z0-9]{4,32})__\Z"
)
_RECOVERY_RESOURCE_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}\Z")
_RECOVERY_MANIFEST_MAX_BYTES = 256 * 1024
_RECOVERY_GROUP_MAX_ITEMS = 8
_BEARER = re.compile(r"(?i)(bearer\s+)[^\s\"']+")
_JSON_SECRET = re.compile(
    r"(?i)(\"?(?:api[_-]?key|api[_-]?token)\"?\s*[:=]\s*\"?)[^\s\",}]+",
)


# This is intentionally an exact, client-side copy of the v6 discovery contract; the v7
# contract below is derived only by explicit reviewed additions.
# A future server contract change must be reviewed here before the live harness will
# authorize any mutation tests. Only declared deployment booleans are installation policy.
_EXPECTED_V2_CAPABILITIES: dict[str, Any] = json.loads(
    r"""
{
  "apiVersion": 2,
  "capabilitiesVersion": 2,
  "features": {
    "identity": {"read": 1},
    "projects": {"list": 1, "create": 1, "read": 1, "detailsEdit": 1,
      "archive": 1, "emptyDelete": 1, "fenceRecovery": 1, "timeEntries": 1,
      "users": 2, "tasks": 2, "taskStats": 1},
    "timeEntries": {"create": 1, "get": 1, "delete": 1, "listByDay": 1,
      "listByRange": 1, "taskEdit": 1, "detailsEdit": 1},
    "taskSuggestions": {"list": 1, "read": 1, "delete": 1},
    "timers": {"start": 1, "get": 1, "stop": 1, "atomicTransitions": 2},
    "webhooks": {"actionVerificationReceiver": 3},
    "pagination": {"stableCursor": 1},
    "idempotency": {"create": 1}
  },
  "contracts": {
    "errors": {"version": 1, "mediaType": "application/problem+json",
      "routes": [
        {"path": "/capabilities/v2", "methods": ["GET"]},
        {"path": "/user/action-verification/webhook/:endpointId", "methods": ["POST"]}
      ],
      "otherAdvertisedRoutes": "legacy-v1-envelope"},
    "dateOnly": 1, "timecardRevisionETag": 1, "resourceRevisionETag": 1,
    "projectUserPrivacy": 1, "projectFenceRecovery": 1, "webhookHmacSha256": 1,
    "webhookRetry": {"version": 1, "authenticationTimestamp": "fresh",
      "actionTimestamp": "original", "configurationBinding": "revision",
      "retentionSeconds": 604800, "clientSafetyMarginSeconds": 600},
    "timerStartReplay": {"version": 1, "scope": "user",
      "activeReplay": "returnExisting", "consumedReplay": "conflict",
      "consumedErrorCode": "timer-operation-consumed",
      "retentionSeconds": 604800, "clientSafetyMarginSeconds": 600},
    "expectedUserId": {"version": 1, "header": "X-Titra-Expected-User-Id",
      "appliesTo": "authenticatedRequests", "required": false, "mismatchStatus": 412}
  },
  "mutationPreconditions": {
    "version": 2,
    "operations": [
      {"id": "timeEntry.create", "method": "POST", "path": "/timeentry/create",
        "headers": ["Content-Type: application/json"],
        "optionalHeaders": ["Idempotency-Key"],
        "guards": ["projectAccess", "timeEntryRule", "migrationLease"]},
      {"id": "timeEntry.delete", "method": "DELETE",
        "path": "/timeentry/delete/:timecardId", "headers": ["If-Match"],
        "guards": ["owner", "dateRevision", "timeEntryRule", "migrationLease"]},
      {"id": "timeEntry.taskEdit", "method": "PATCH",
        "path": "/timeentry/task/:timecardId",
        "headers": ["Content-Type: application/json", "If-Match"],
        "bodyPreconditions": ["expectedTask"],
        "guards": ["owner", "projectAccess", "timeEntryRule", "migrationLease"]},
      {"id": "timeEntry.detailsEdit", "method": "PATCH",
        "path": "/timeentry/details/:timecardId",
        "headers": ["Content-Type: application/json", "If-Match"],
        "bodyPreconditions": ["expected mirrors changes", "acceptLegacyConversion when required"],
        "guards": ["owner", "projectAccess", "timeEntryRule", "migrationLease"]},
      {"id": "project.create", "method": "POST", "path": "/project/create",
        "headers": ["Content-Type: application/json"],
        "optionalHeaders": ["Idempotency-Key"], "guards": ["authenticatedUser"]},
      {"id": "project.detailsEdit", "method": "PATCH",
        "path": "/project/details/:projectId",
        "headers": ["Content-Type: application/json", "If-Match"],
        "bodyPreconditions": ["expected mirrors changes"],
        "guards": ["projectAdministrator"]},
      {"id": "project.archive", "method": "PATCH",
        "path": "/project/archive/:projectId",
        "headers": ["Content-Type: application/json", "If-Match"],
        "bodyPreconditions": ["expectedArchived"], "guards": ["projectAdministrator"]},
      {"id": "project.emptyDelete", "method": "DELETE",
        "path": "/project/delete/:projectId",
        "headers": ["Content-Type: application/json", "If-Match"],
        "bodyPreconditions": ["expectedName"], "guards": ["projectOwner", "emptyProject"]},
      {"id": "project.fenceRecovery", "method": "POST",
        "path": "/project/recovery/:projectId",
        "headers": ["Content-Type: application/json", "If-Match"],
        "bodyPreconditions": ["type", "recoveryId", "acknowledgeStaleFence=true"],
        "guards": ["projectAdministrator", "oldProcessBoot", "minimumFenceAge",
          "trackedFence", "verifiedResourceOutcome", "exactCompareAndSwap"]},
      {"id": "projectTask.create", "method": "POST", "path": "/project/task/create",
        "headers": ["Content-Type: application/json"],
        "optionalHeaders": ["Idempotency-Key"],
        "bodyPreconditions": ["start/end canonical UTC RFC3339 milliseconds"],
        "guards": ["projectAdministrator", "sameProjectDependencies"]},
      {"id": "projectTask.detailsEdit", "method": "PATCH",
        "path": "/project/task/details/:taskId",
        "headers": ["Content-Type: application/json", "If-Match"],
        "bodyPreconditions": ["expected mirrors changes"],
        "guards": ["projectAdministrator", "sameProjectDependencies", "notDefaultWhenRenaming"]},
      {"id": "projectTask.delete", "method": "DELETE",
        "path": "/project/task/delete/:taskId",
        "headers": ["Content-Type: application/json", "If-Match"],
        "bodyPreconditions": ["expectedName", "acknowledgeRecordedEntries when required"],
        "guards": ["projectAdministrator", "notDefault", "noDependants"]},
      {"id": "taskSuggestion.delete", "method": "DELETE",
        "path": "/task-suggestions/delete/:suggestionId",
        "headers": ["Content-Type: application/json", "If-Match"],
        "bodyPreconditions": ["expectedName", "acknowledgeReferencedRecords when required"],
        "guards": ["owner"]},
      {"id": "timer.start", "method": "POST", "path": "/timer/start",
        "headers": ["Content-Type: application/json for a nonempty body"],
        "bodyPreconditions": ["operationId for client-attributed replay"],
        "guards": ["noDifferentActiveTimer", "unconsumedOperationId"]},
      {"id": "timer.stop", "method": "POST", "path": "/timer/stop",
        "headers": ["Content-Type: application/json", "If-Match"],
        "bodyPreconditions": ["timerId"], "guards": ["exactActiveTimer"]},
      {"id": "webhook.actionVerification", "method": "POST",
        "path": "/user/action-verification/webhook/:endpointId",
        "headers": ["Content-Type: application/json", "X-Titra-Webhook-Timestamp",
          "X-Titra-Webhook-Event-Id", "X-Titra-Webhook-Signature"],
        "guards": ["enabledSecureInterface", "hmacSha256", "replayReceipt", "eventOrdering"]}
    ]
  },
  "idempotency": {"version": 1, "header": "Idempotency-Key", "minKeyLength": 16,
    "maxKeyLength": 128, "retentionSeconds": 604800,
    "operations": ["timeentry.create", "project.create", "project-task.create"]},
  "timeEntryPagination": {"version": 1, "defaultLimit": 200, "maxLimit": 500,
    "consistency": "live-keyset", "ownerPath": "timeentry/daterange-page",
    "projectPath": "project/timeentriesfordaterange-page"},
  "deployment": {"projectFenceRecoveryEnabled": false,
    "webhookActionVerificationEnabled": false},
  "limits": {"taskCodePoints": 1000, "taskEditBodyBytes": 65536,
    "webhookBodyBytes": 65536, "webhookTimestampSkewSeconds": 300,
    "webhookProcessingLeaseSeconds": 60, "webhookReplayRetentionSeconds": 604800,
    "timerStartRetainedOperations": 4096,
    "projectFenceRecoveryMinimumAgeSeconds": 900}
}
"""
)

_EXPECTED_V7_CAPABILITIES = deepcopy(_EXPECTED_V2_CAPABILITIES)
_EXPECTED_V7_CAPABILITIES["capabilitiesVersion"] = 3
_EXPECTED_V7_CAPABILITIES["features"]["security"] = {"policyDiscovery": 1}
_EXPECTED_V7_CAPABILITIES["contracts"]["security"] = {
    "version": 1,
    "releaseProfile": "security-v7",
    "apiTokens": {
        "storage": "sha256-domain-separated",
        "legacyPlaintextMigration": "lazy-guarded",
        "inactiveUsersRejected": True,
    },
    "authentication": {
        "verificationDeadlineEnforced": ["httpApi", "ddpMethods", "ddpPublications"],
        "oidcIdentitySource": "userinfo",
        "oidcVerifiedEmailLinkingDefault": "disabled",
    },
    "integrations": {
        "browserCredentialPublication": "disabled",
        "outboundRequests": "server-proxied-bounded",
    },
    "publicProjects": {"operatorDisableEnforcedServerSide": True},
    "legacyJavaScript": {"default": "disabled", "literalAllowRuleExecuted": False},
    "browserHeaders": {"version": 1, "hsts": "operator-opt-in"},
}
_EXPECTED_V7_CAPABILITIES["deployment"]["security"] = {
    "hstsEnabled": False,
    "oauthEncryptionConfigured": False,
    "oidcVerifiedEmailLinkingEnabled": False,
    "publicProjectsDisabled": False,
    "unsafeLegacyScriptsEnabled": False,
}


def redact_secrets(text: str, secrets: Sequence[str] = ()) -> str:
    """Remove known secrets and common bearer/token representations from diagnostics."""

    redacted = text
    for secret in sorted((value for value in secrets if value), key=len, reverse=True):
        redacted = redacted.replace(secret, "<redacted>")
    redacted = _BEARER.sub(r"\1<redacted>", redacted)
    return _JSON_SECRET.sub(r"\1<redacted>", redacted)


def validate_live_url(value: str, *, insecure: bool = False) -> str:
    """Validate and normalize a live-test URL without making a network request."""

    parsed = urlsplit(value.strip())
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise SelfTestError("The live URL must be an absolute HTTP(S) URL.")
    if parsed.username is not None or parsed.password is not None:
        raise SelfTestError("Do not put credentials in the live URL.")
    if parsed.query or parsed.fragment:
        raise SelfTestError("The live URL must not contain a query string or fragment.")
    if parsed.scheme == "http" and not insecure and not _is_loopback(parsed.hostname):
        raise SelfTestError(
            "Remote HTTP is refused. Use HTTPS, or explicitly pass --insecure for a test system."
        )
    path = parsed.path.rstrip("/")
    return urlunsplit((parsed.scheme, parsed.netloc, path, "", ""))


def _is_loopback(hostname: str) -> bool:
    if hostname.casefold() == "localhost":
        return True
    try:
        return ipaddress.ip_address(hostname).is_loopback
    except ValueError:
        return False


def read_api_token(
    environment: Mapping[str, str],
    variable_name: str,
    *,
    allow_prompt: bool,
    prompt: Callable[[str], str] = getpass.getpass,
) -> str:
    """Read a token from one named variable or a hidden terminal prompt."""

    if not _ENV_NAME.fullmatch(variable_name):
        raise SelfTestError("--token-env must be a valid environment-variable name.")
    value = environment.get(variable_name, "")
    if not value and allow_prompt:
        value = prompt("Titra API token (input hidden): ")
    if not value or not value.strip():
        raise SelfTestError(
            f"No API token was supplied through {variable_name}; hidden prompting is unavailable."
        )
    if any(character in value for character in "\r\n\0"):
        raise SelfTestError("The API token contains an invalid control character.")
    return value


def _deployment_matches(value: Any, expected: dict[str, Any]) -> bool:
    if not isinstance(value, dict) or set(value) != set(expected):
        return False
    for name, expected_value in expected.items():
        actual = value.get(name)
        if isinstance(expected_value, bool):
            if type(actual) is not bool:
                return False
        elif isinstance(expected_value, dict):
            if (
                not isinstance(actual, dict)
                or set(actual) != set(expected_value)
                or any(type(actual.get(flag)) is not bool for flag in expected_value)
            ):
                return False
        elif actual != expected_value:
            return False
    return True


def validate_v2_capabilities(value: Any, *, release_profile: str = "v6") -> dict[str, Any]:
    """Require the exact reviewed v6 or v7 discovery contract.

    Deployment enablement flags may be true or false, but their names and types
    are fixed. Every other key, value, operation, and list order must match the
    reviewed contract exactly; additive changes therefore fail closed.
    """

    if not isinstance(value, dict):
        raise SelfTestError("The /capabilities/v2 document is not an object.")
    if release_profile not in {"v6", "v7"}:
        raise SelfTestError("The requested capabilities release profile is invalid.")
    expected = _EXPECTED_V7_CAPABILITIES if release_profile == "v7" else _EXPECTED_V2_CAPABILITIES
    deployment = value.get("deployment")
    expected_deployment = expected["deployment"]
    if not _deployment_matches(deployment, expected_deployment):
        raise SelfTestError(
            f"The /capabilities/v2 deployment contract does not match {release_profile}."
        )
    normalized = {**value, "deployment": expected_deployment}
    if normalized != expected:
        raise SelfTestError(
            f"The /capabilities/v2 document does not exactly match {release_profile}."
        )
    return value


def resolve_live_connection(
    *,
    live_url: str | None,
    token_env: str,
    credentials: str | None,
    profile: str | None,
    expected_username: str | None,
    insecure: bool,
    timeout: float,
    environment: Mapping[str, str],
    cwd: Path,
    home: Path,
    allow_prompt: bool,
    prompt: Callable[[str], str] = getpass.getpass,
) -> LiveConnection:
    """Resolve either a legacy token variable or one complete credential profile."""

    if credentials is not None or profile is not None:
        try:
            resolved = resolve_config(
                profile=profile,
                explicit_file=Path(credentials) if credentials is not None else None,
                verify_tls=not insecure,
                timeout=timeout,
                environ=without_test_credentials(environment, secret_variable=token_env),
                cwd=cwd,
                home=home,
                interactive=False,
            )
        except ConfigurationError as exc:
            raise SelfTestError(
                "The selected credential profile could not be resolved securely."
            ) from exc
        server = validate_live_url(resolved.server, insecure=insecure)
        if live_url is not None and validate_live_url(live_url, insecure=insecure) != server:
            raise SelfTestError(
                "--live-url does not match the server in the selected credential profile."
            )
        return LiveConnection(
            server=server,
            api_token=resolved.api_key,
            expected_username=expected_username or resolved.username,
            profile=resolved.profile,
        )
    if live_url is None:
        raise SelfTestError("Live checks require --live-url or a credential profile.")
    return LiveConnection(
        server=validate_live_url(live_url, insecure=insecure),
        api_token=read_api_token(
            environment,
            token_env,
            allow_prompt=allow_prompt,
            prompt=prompt,
        ),
        expected_username=expected_username,
        profile="default",
    )


def without_test_credentials(
    base: Mapping[str, str], *, secret_variable: str | None = None
) -> dict[str, str]:
    """Remove Titra configuration and the selected live secret from a child environment."""

    return {
        key: value
        for key, value in base.items()
        if not key.upper().startswith("TITRA_") and key != secret_variable
    }


def build_cli_environment(
    base: Mapping[str, str],
    *,
    server: str,
    api_token: str,
    state_directory: Path,
    expected_username: str | None = None,
    profile: str | None = None,
    secret_variable: str | None = None,
    minimum_request_spacing: float = 0.0,
) -> dict[str, str]:
    """Build an isolated child environment with an atomic server/token pair."""

    child = without_test_credentials(base, secret_variable=secret_variable)
    child.update(
        {
            "TITRA_SERVER": server,
            "TITRA_API_KEY": api_token,
            "TITRA_TIMEZONE": "UTC",
            "TITRA_STATE_DIR": str(state_directory),
            "TITRA_CLI_MIN_REQUEST_SPACING_SECONDS": str(minimum_request_spacing),
        }
    )
    if expected_username:
        child["TITRA_USERNAME"] = expected_username
    if profile:
        child["TITRA_PROFILE"] = profile
    return child


def parse_cli_envelope(output: str) -> Any:
    """Parse the CLI's stable JSON envelope without displaying its data."""

    try:
        envelope = json.loads(output)
    except json.JSONDecodeError as exc:
        raise SelfTestError("The CLI did not return valid JSON.") from exc
    if not isinstance(envelope, dict) or envelope.get("schema") != "titra-cli/v1":
        raise SelfTestError("The CLI returned an unexpected JSON schema.")
    if "data" not in envelope:
        raise SelfTestError("The CLI JSON envelope has no data field.")
    return envelope["data"]


def synthetic_marker(
    namespace: str,
    *,
    now: datetime | None = None,
    entropy: str | None = None,
) -> str:
    """Create a unique, recognizable task label for one live write test."""

    if not _SAFE_NAMESPACE.fullmatch(namespace):
        raise SelfTestError(
            "The namespace must be 1-40 letters, digits, dots, underscores, or hyphens."
        )
    current = (now or datetime.now(UTC)).astimezone(UTC)
    suffix = entropy or uuid.uuid4().hex[:10]
    if not re.fullmatch(r"[A-Za-z0-9]{4,32}", suffix):
        raise SelfTestError("Synthetic marker entropy is invalid.")
    timestamp = current.strftime("%Y%m%dT%H%M%SZ")
    return f"__{namespace}_{timestamp}_{suffix}__"


def write_sanitized_report(
    path: str | Path,
    *,
    api_version: str,
    outcome: str,
    results: Sequence[CheckResult],
    recovery_status: str | None = None,
) -> None:
    """Atomically write a private summary containing no connection or response data."""

    destination = Path(path).expanduser().absolute()
    if destination.exists() and destination.is_symlink():
        raise SelfTestError("Refusing to replace a symlinked live-test report.")
    if not destination.parent.is_dir():
        raise SelfTestError("The live-test report parent directory does not exist.")
    value: dict[str, Any] = {
        "schema": "titra-cli-live-test-report/v1",
        "api_version": api_version,
        "outcome": outcome,
        "results": [
            {"name": result.name, "status": result.status, "detail": result.detail}
            for result in results
        ],
    }
    if recovery_status is not None:
        value["recovery_status"] = recovery_status
    temporary = destination.with_name(f".{destination.name}.tmp-{os.getpid()}")
    try:
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
        descriptor = os.open(temporary, flags, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(value, handle, indent=2, sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, destination)
        if os.name == "posix":
            destination.chmod(0o600)
    except OSError as exc:
        with suppress(OSError):
            temporary.unlink(missing_ok=True)
        raise SelfTestError("The sanitized live-test report could not be saved.") from exc


def _recovery_status(state_directory: Path | None) -> str | None:
    if state_directory is None:
        return None
    path = state_directory / "v6-recovery.json"
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return "unreadable-recovery-manifest" if path.exists() or path.is_symlink() else None
    status = value.get("status") if isinstance(value, dict) else None
    return status if isinstance(status, str) else None


def _v6_manifest_requires_recovery(path: Path) -> bool:
    """Fail safe when a v6 manifest is unresolved, incomplete, or unreadable."""

    try:
        if path.is_symlink():
            return True
        if not path.exists():
            return False
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return True
    if (
        not isinstance(value, dict)
        or value.get("schema") != "titra-cli-v6-live-recovery/v2"
        or not isinstance(value.get("status"), str)
        or not isinstance(value.get("server"), str)
        or not value["server"]
        or not isinstance(value.get("owner_id"), str)
        or not value["owner_id"]
    ):
        return True
    resources = value.get("resources")
    pending = value.get("pending")
    required_groups = {"projects", "tasks", "records", "suggestions", "timers"}
    required_pending_groups = {"projects", "tasks", "records", "replays"}
    if (
        not isinstance(resources, dict)
        or not required_groups.issubset(resources)
        or any(not isinstance(group, dict) or bool(group) for group in resources.values())
        or not isinstance(pending, dict)
        or not required_pending_groups.issubset(pending)
        or any(not isinstance(group, dict) or bool(group) for group in pending.values())
    ):
        return True
    return value["status"] not in {"completed", "cleanup-completed-after-failure"}


def _should_preserve_state(state_directory: Path | None, *, v5_write: bool) -> bool:
    if state_directory is None:
        return False
    return v5_write or _v6_manifest_requires_recovery(state_directory / "v6-recovery.json")


class CliInvoker:
    """Run the installed CLI with capture, timeout, and secret-safe failures."""

    def __init__(
        self,
        *,
        python: str,
        environment: Mapping[str, str],
        project_root: Path,
        api_token: str,
        timeout: float,
        insecure: bool,
        minimum_spacing: float = 0.0,
        sleeper: Callable[[float], None] = time.sleep,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        if not math.isfinite(minimum_spacing) or minimum_spacing < 0:
            raise SelfTestError("Minimum CLI command spacing must be a finite nonnegative number.")
        self.python = python
        self.environment = dict(environment)
        self.project_root = project_root
        self.api_token = api_token
        self.timeout = timeout
        self.minimum_spacing = minimum_spacing
        self.sleeper = sleeper
        self.clock = clock
        self._last_invocation_started: float | None = None
        self.global_arguments = ["--output", "json", "--no-color"]
        if insecure:
            self.global_arguments.append("--insecure")

    def bind_expected_user_id(self, user_id: str) -> None:
        if (
            not user_id
            or user_id != user_id.strip()
            or any(
                character not in "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-"
                for character in user_id
            )
        ):
            raise SelfTestError("Expected user ID contains unsafe characters.")
        if len(user_id) > 128:
            raise SelfTestError("Expected user ID is too long.")
        option = ["--expect-user-id", user_id]
        if "--expect-user-id" in self.global_arguments:
            index = self.global_arguments.index("--expect-user-id")
            if self.global_arguments[index : index + 2] != option:
                raise SelfTestError("CLI invoker is already bound to another expected user ID.")
            return
        self.global_arguments.extend(option)

    def invoke(
        self, arguments: Sequence[str], *, allowed_codes: frozenset[int] = frozenset({0})
    ) -> CommandResult:
        now = self.clock()
        if self._last_invocation_started is not None:
            remaining = self.minimum_spacing - (now - self._last_invocation_started)
            if remaining > 0:
                self.sleeper(remaining)
                now = self.clock()
        self._last_invocation_started = now
        command = [
            self.python,
            "-m",
            "titra_cli",
            *self.global_arguments,
            *arguments,
        ]
        try:
            completed = subprocess.run(
                command,
                cwd=self.project_root,
                env=self.environment,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=self.timeout,
                check=False,
            )
        except subprocess.TimeoutExpired as exc:
            raise SelfTestError(
                f"CLI command timed out: {' '.join(arguments[:2]) or 'unknown command'}"
            ) from exc
        result = CommandResult(
            completed.returncode,
            redact_secrets(completed.stdout, [self.api_token]),
            redact_secrets(completed.stderr, [self.api_token]),
        )
        if result.returncode not in allowed_codes:
            diagnostic = result.stderr.strip() or "no safe diagnostic was returned"
            raise SelfTestError(
                f"CLI command {' '.join(arguments[:2])!r} failed with exit "
                f"{result.returncode}: {diagnostic}"
            )
        return result

    def invoke_json(
        self, arguments: Sequence[str], *, allowed_codes: frozenset[int] = frozenset({0})
    ) -> tuple[Any, int]:
        result = self.invoke(arguments, allowed_codes=allowed_codes)
        if not result.stdout.strip():
            return None, result.returncode
        return parse_cli_envelope(result.stdout), result.returncode


class LiveV5Suite:
    """Exercise v5 capabilities while keeping real record data out of output."""

    def __init__(
        self,
        invoker: JsonInvoker,
        *,
        namespace: str,
        reporter: Callable[[CheckResult], None] | None = None,
        sleeper: Callable[[float], None] = time.sleep,
    ) -> None:
        self.invoker = invoker
        self.namespace = namespace
        self.reporter = reporter or (lambda _result: None)
        self.sleeper = sleeper
        self.results: list[CheckResult] = []

    def _record(self, name: str, status: str = "PASS", detail: str = "") -> None:
        result = CheckResult(name, status, detail)
        self.results.append(result)
        self.reporter(result)

    def _resolve_project(self, reference: str) -> str:
        project, _ = self.invoker.invoke_json(("project", "show", reference))
        if not isinstance(project, dict) or not project.get("_id"):
            raise SelfTestError("Project lookup did not return a project ID.")
        return str(project["_id"])

    def run_read_only(
        self, *, project: str | None = None, record_id: str | None = None
    ) -> tuple[list[CheckResult], str | None]:
        authentication, _ = self.invoker.invoke_json(("auth", "check"))
        if not isinstance(authentication, dict) or authentication.get("ok") is not True:
            raise SelfTestError("Authentication check returned an invalid result.")
        self._record("authentication and current-user endpoint")

        doctor, _ = self.invoker.invoke_json(("doctor",))
        capabilities = doctor.get("capabilities") if isinstance(doctor, dict) else None
        required = {"projects", "identity", "record_delete"}
        if not isinstance(capabilities, dict) or any(
            capabilities.get(name) is not True for name in required
        ):
            raise SelfTestError("The server does not report all required v5 API capabilities.")
        self._record("v5 capability report")

        projects, _ = self.invoker.invoke_json(("project", "list", "--include-archived"))
        if not isinstance(projects, list):
            raise SelfTestError("Project listing did not return a list.")
        self._record("project listing", detail=f"{len(projects)} project(s) visible")

        project_id = self._resolve_project(project) if project else None
        if project_id:
            self._record("project resolution")
            _report, code = self.invoker.invoke_json(
                (
                    "report",
                    "summary",
                    "--today",
                    "--team",
                    "--project",
                    project_id,
                    "--group-by",
                    "user",
                ),
                allowed_codes=frozenset({0, 7}),
            )
            self._record(
                "project-user endpoint",
                status="WARN" if code == 7 else "PASS",
                detail="report contained malformed rows" if code == 7 else "",
            )

        candidate_id = record_id
        if candidate_id is None:
            records, code = self.invoker.invoke_json(
                ("record", "list", "--today", "--raw"),
                allowed_codes=frozenset({0, 7}),
            )
            if not isinstance(records, list):
                raise SelfTestError("Owned-record listing did not return a list.")
            candidate = next(
                (
                    item
                    for item in records
                    if isinstance(item, dict) and isinstance(item.get("_id"), str)
                ),
                None,
            )
            candidate_id = str(candidate["_id"]) if candidate else None
            self._record(
                "owned-record listing",
                status="WARN" if code == 7 else "PASS",
                detail="record details retained in memory only",
            )
        if candidate_id:
            record, _ = self.invoker.invoke_json(("record", "show", candidate_id))
            if not isinstance(record, dict) or str(record.get("_id")) != candidate_id:
                raise SelfTestError("Owned-record inspection returned an unexpected record.")
            self._record("owned-record inspection endpoint")
        else:
            self._record(
                "owned-record inspection endpoint",
                status="SKIP",
                detail="no --record-id and no owned record today",
            )
        return list(self.results), project_id

    def run_write(self, *, project_id: str) -> list[CheckResult]:
        marker = synthetic_marker(self.namespace)
        self._record("synthetic write namespace", detail=marker)
        now = datetime.now(UTC)
        record_id: str | None = None
        create_attempted = False
        primary_error: BaseException | None = None
        try:
            create_attempted = True
            created, code = self.invoker.invoke_json(
                (
                    "record",
                    "create",
                    "--project",
                    project_id,
                    "--task",
                    marker,
                    "--date",
                    now.date().isoformat(),
                    "--start",
                    now.strftime("%H:%M"),
                    "--duration",
                    "1m",
                    "--yes",
                ),
                allowed_codes=frozenset({0, 6}),
            )
            if code == 0:
                if not isinstance(created, dict) or not created.get("timecardId"):
                    raise SelfTestError("Record creation did not return a timecard ID.")
                record_id = str(created["timecardId"])
                self._record("synthetic record creation")
            else:
                record_id = self._discover_marker(project_id, marker)
                if record_id is None:
                    raise SelfTestError(
                        "The create response was uncertain and no matching synthetic record was "
                        f"found. Do not retry blindly. Search for task {marker!r}."
                    )
                self._record("synthetic record creation", status="WARN", detail="reconciled")

            record, _ = self.invoker.invoke_json(("record", "show", record_id))
            self._assert_synthetic(record, record_id, project_id, marker)
            self._record("new record inspection and ownership")

            _report, report_code = self.invoker.invoke_json(
                (
                    "report",
                    "summary",
                    "--today",
                    "--project",
                    project_id,
                    "--group-by",
                    "task",
                ),
                allowed_codes=frozenset({0, 7}),
            )
            self._record(
                "summary reporting over synthetic record",
                status="WARN" if report_code == 7 else "PASS",
            )
        except BaseException as exc:
            primary_error = exc
            raise
        finally:
            if create_attempted:
                try:
                    record_id = record_id or self._discover_marker(project_id, marker)
                    if record_id:
                        self._delete_synthetic(record_id, project_id, marker)
                    else:
                        self._record(
                            "synthetic record cleanup",
                            status="WARN",
                            detail=f"no matching record found; marker {marker}",
                        )
                except BaseException as cleanup_error:
                    if primary_error is None:
                        raise
                    self._record(
                        "synthetic record cleanup",
                        status="FAIL",
                        detail=f"manual inspection required for marker {marker}",
                    )
                    if hasattr(primary_error, "add_note"):
                        primary_error.add_note(
                            "Cleanup also failed. Inspect the server for the synthetic task "
                            f"marker {marker!r}: {cleanup_error}"
                        )
        return list(self.results)

    def _discover_marker(self, project_id: str, marker: str) -> str | None:
        for attempt in range(3):
            records, _ = self.invoker.invoke_json(
                ("record", "list", "--today", "--raw"),
                allowed_codes=frozenset({0, 7}),
            )
            if not isinstance(records, list):
                raise SelfTestError("Cannot reconcile the synthetic record: invalid record list.")
            matches = [
                item
                for item in records
                if isinstance(item, dict)
                and str(item.get("projectId")) == project_id
                and item.get("task") == marker
                and item.get("_id")
            ]
            if len(matches) > 1:
                raise SelfTestError(
                    f"More than one record matched synthetic marker {marker!r}; refusing cleanup."
                )
            if matches:
                return str(matches[0]["_id"])
            if attempt < 2:
                self.sleeper(0.5)
        return None

    @staticmethod
    def _assert_synthetic(record: Any, record_id: str, project_id: str, marker: str) -> None:
        if not isinstance(record, dict):
            raise SelfTestError("Synthetic record inspection returned invalid data.")
        if (
            str(record.get("_id")) != record_id
            or str(record.get("projectId")) != project_id
            or record.get("task") != marker
        ):
            raise SelfTestError("Synthetic record identity mismatch; refusing to delete anything.")

    def _delete_synthetic(self, record_id: str, project_id: str, marker: str) -> None:
        record, code = self.invoker.invoke_json(
            ("record", "show", record_id), allowed_codes=frozenset({0, 4})
        )
        if code == 4:
            self._record("synthetic record cleanup", detail="already absent")
            return
        self._assert_synthetic(record, record_id, project_id, marker)
        _deleted, delete_code = self.invoker.invoke_json(
            (
                "record",
                "delete",
                record_id,
                "--expect-project-id",
                project_id,
                "--expect-task",
                marker,
                "--yes",
            ),
            allowed_codes=frozenset({0, 6}),
        )
        _remaining, reconcile_code = self.invoker.invoke_json(
            ("record", "show", record_id), allowed_codes=frozenset({0, 4})
        )
        if reconcile_code != 4:
            suffix = " after an uncertain delete" if delete_code == 6 else ""
            raise SelfTestError(
                f"Synthetic record still exists{suffix}; it was not deleted a second time. "
                f"Inspect ID {record_id!r} and marker {marker!r}."
            )
        self._record(
            "ETag-guarded synthetic record deletion",
            status="WARN" if delete_code == 6 else "PASS",
            detail="uncertain response reconciled as deleted" if delete_code == 6 else "",
        )


class RecoveryManifest:
    """Private, secret-free recovery state for a disposable v6 live test."""

    def __init__(self, path: Path, marker: str, *, server: str, owner_id: str) -> None:
        normalized_server = server.rstrip("/")
        if not normalized_server or not owner_id:
            raise SelfTestError("The v6 recovery manifest requires a server and owner ID.")
        self.path = path
        self.value: dict[str, Any] = {
            "schema": "titra-cli-v6-live-recovery/v2",
            "status": "running",
            "marker": marker,
            "server": normalized_server,
            "owner_id": owner_id,
            "pending": {
                "projects": {},
                "tasks": {},
                "records": {},
                "replays": {},
            },
            "resources": {
                "projects": {},
                "tasks": {},
                "records": {},
                "suggestions": {},
                "timers": {},
            },
        }
        self._known_resources: dict[str, dict[str, str]] = {
            kind: {} for kind in ("projects", "tasks", "records", "suggestions", "timers")
        }
        self._save()

    @classmethod
    def load_for_cleanup(
        cls,
        path: str | Path,
        *,
        server: str,
        owner_id: str,
        expected_marker: str,
    ) -> RecoveryManifest:
        """Load one private manifest without following a replacement file or broadening scope."""

        selected = Path(path).expanduser().absolute()
        if selected.name != "v6-recovery.json":
            raise SelfTestError("Recovery cleanup requires a file named exactly v6-recovery.json.")
        try:
            before = selected.lstat()
            parent = selected.parent.lstat()
        except OSError as exc:
            raise SelfTestError("The selected v6 recovery manifest cannot be inspected.") from exc
        if stat.S_ISLNK(before.st_mode) or not stat.S_ISREG(before.st_mode):
            raise SelfTestError(
                "The selected v6 recovery manifest must be a regular non-symlink file."
            )
        if before.st_nlink != 1:
            raise SelfTestError("The selected v6 recovery manifest must not have hard links.")
        if stat.S_ISLNK(parent.st_mode) or not stat.S_ISDIR(parent.st_mode):
            raise SelfTestError("The v6 recovery manifest parent must be a real directory.")
        if before.st_size > _RECOVERY_MANIFEST_MAX_BYTES:
            raise SelfTestError("The selected v6 recovery manifest is unexpectedly large.")
        if os.name == "posix":
            effective_user = os.geteuid()
            if before.st_uid != effective_user or parent.st_uid != effective_user:
                raise SelfTestError(
                    "The v6 recovery manifest and its directory must be user-owned."
                )
            if stat.S_IMODE(before.st_mode) & 0o077 or stat.S_IMODE(parent.st_mode) & 0o077:
                raise SelfTestError(
                    "The v6 recovery manifest and its directory must not be accessible to others."
                )

        flags = os.O_RDONLY
        if hasattr(os, "O_NOFOLLOW"):
            flags |= os.O_NOFOLLOW
        try:
            descriptor = os.open(selected, flags)
            with os.fdopen(descriptor, "r", encoding="utf-8") as handle:
                opened = os.fstat(handle.fileno())
                if (opened.st_dev, opened.st_ino) != (before.st_dev, before.st_ino):
                    raise SelfTestError("The v6 recovery manifest changed while it was opened.")
                if (
                    not stat.S_ISREG(opened.st_mode)
                    or opened.st_nlink != 1
                    or opened.st_size != before.st_size
                    or stat.S_IMODE(opened.st_mode) != stat.S_IMODE(before.st_mode)
                ):
                    raise SelfTestError("The v6 recovery manifest metadata changed while opening.")
                if os.name == "posix" and opened.st_uid != os.geteuid():
                    raise SelfTestError("The opened v6 recovery manifest is not user-owned.")
                rendered = handle.read(_RECOVERY_MANIFEST_MAX_BYTES + 1)
        except (OSError, UnicodeError) as exc:
            raise SelfTestError("The selected v6 recovery manifest cannot be read safely.") from exc
        if len(rendered.encode("utf-8")) > _RECOVERY_MANIFEST_MAX_BYTES:
            raise SelfTestError("The selected v6 recovery manifest is unexpectedly large.")

        def unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
            value: dict[str, Any] = {}
            for key, item in pairs:
                if key in value:
                    raise SelfTestError("The v6 recovery manifest contains duplicate JSON keys.")
                value[key] = item
            return value

        try:
            value = json.loads(rendered, object_pairs_hook=unique_object)
        except json.JSONDecodeError as exc:
            raise SelfTestError("The selected v6 recovery manifest is not valid JSON.") from exc
        instance = cls.__new__(cls)
        instance.path = selected
        instance.value = value
        instance.validate_cleanup_scope(
            server=server,
            owner_id=owner_id,
            expected_marker=expected_marker,
        )
        loaded_resources = instance.value["resources"]
        assert isinstance(loaded_resources, dict)
        instance._known_resources = {
            kind: dict(group) for kind, group in loaded_resources.items() if isinstance(group, dict)
        }
        return instance

    def validate_cleanup_scope(
        self, *, server: str, owner_id: str, expected_marker: str
    ) -> tuple[str, str]:
        """Validate the complete persisted cleanup vocabulary and return its possible UTC days."""

        if not isinstance(self.value, dict) or set(self.value) != {
            "schema",
            "status",
            "marker",
            "server",
            "owner_id",
            "pending",
            "resources",
        }:
            raise SelfTestError("The v6 recovery manifest has an unexpected top-level shape.")
        self.assert_scope(server=server, owner_id=owner_id)
        marker = self.value.get("marker")
        match = _RECOVERY_MARKER.fullmatch(marker) if isinstance(marker, str) else None
        if match is None or marker != expected_marker:
            raise SelfTestError(
                "The v6 recovery manifest marker does not match the exact expected marker."
            )
        try:
            started = datetime.strptime(match.group("timestamp"), "%Y%m%dT%H%M%SZ").replace(
                tzinfo=UTC
            )
        except ValueError as exc:
            raise SelfTestError("The v6 recovery manifest marker timestamp is invalid.") from exc
        if self.value.get("status") not in {"running", "recovery-required"}:
            raise SelfTestError("The v6 recovery manifest is not in a resumable cleanup state.")

        pending = self.value.get("pending")
        resources = self.value.get("resources")
        if not isinstance(pending, dict) or set(pending) != {
            "projects",
            "tasks",
            "records",
            "replays",
        }:
            raise SelfTestError("The v6 recovery manifest has invalid pending-resource groups.")
        if not isinstance(resources, dict) or set(resources) != {
            "projects",
            "tasks",
            "records",
            "suggestions",
            "timers",
        }:
            raise SelfTestError("The v6 recovery manifest has invalid resource groups.")
        if any(
            not isinstance(group, dict) or len(group) > _RECOVERY_GROUP_MAX_ITEMS
            for group in (*pending.values(), *resources.values())
        ):
            raise SelfTestError("The v6 recovery manifest contains an invalid or oversized group.")

        project_name = f"{marker}-project"
        task_name = f"{marker}-task"
        edited_task_name = f"{marker}-task-edited"
        record_one_task = f"{marker}-record-one"
        record_one_edited_task = f"{marker}-record-one-edited"
        task_names = {task_name, edited_task_name}
        record_tasks = {record_one_task, record_one_edited_task, edited_task_name}

        def checked_resources(kind: str, identities: set[str]) -> dict[str, str]:
            group = resources[kind]
            assert isinstance(group, dict)
            if any(
                not isinstance(resource_id, str)
                or _RECOVERY_RESOURCE_ID.fullmatch(resource_id) is None
                or not isinstance(identity, str)
                or identity not in identities
                for resource_id, identity in group.items()
            ):
                raise SelfTestError(f"The v6 recovery manifest has an invalid {kind} identity.")
            return group

        projects = checked_resources("projects", {project_name})
        tasks = checked_resources("tasks", task_names)
        records = checked_resources("records", record_tasks)
        suggestions = checked_resources("suggestions", record_tasks)
        timers = checked_resources("timers", {marker})
        if timers:
            if any(re.fullmatch(r"selftest:[a-f0-9]{32}", item) is None for item in timers):
                raise SelfTestError("The v6 recovery manifest has an invalid timer identity.")
            raise SelfTestError(
                "The manifest contains an unresolved timer; cleanup recovery will not stop or "
                "replay it."
            )
        if (tasks or records or suggestions) and not projects:
            raise SelfTestError("A child resource has no manifest-bound disposable project.")

        pending_projects = pending["projects"]
        pending_tasks = pending["tasks"]
        pending_records = pending["records"]
        pending_replays = pending["replays"]
        assert all(
            isinstance(group, dict)
            for group in (pending_projects, pending_tasks, pending_records, pending_replays)
        )
        if pending_replays:
            raise SelfTestError(
                "The manifest contains an unresolved replay probe; recovery will not replay it."
            )
        if pending_projects:
            expected_intent = {
                "name": project_name,
                "description": f"Disposable Titra v6 live test {marker}",
                "marker": marker,
            }
            if pending_projects != {project_name: expected_intent} or projects:
                raise SelfTestError("The pending project-create identity is not exact.")
        if pending_tasks:
            if set(pending_tasks) != {task_name} or len(projects) != 1:
                raise SelfTestError("The pending task-create identity is not exact.")
            task_intent = pending_tasks[task_name]
            expected_task_intent = {
                "projectId": next(iter(projects)),
                "name": task_name,
                "marker": marker,
                "estimatedHours": 0.05,
            }
            if task_intent != expected_task_intent or tasks:
                raise SelfTestError("The pending task-create fields are not exact.")

        first_day = started.date().isoformat()
        second_day = (started.date() + timedelta(days=1)).isoformat()
        allowed_days = {first_day, second_day}
        expected_hours = {
            record_one_task: seconds_to_hours(hours_to_seconds(0.017)),
            edited_task_name: seconds_to_hours(hours_to_seconds(0.034)),
        }
        if set(pending_records) - set(expected_hours) or (pending_records and len(projects) != 1):
            raise SelfTestError("The pending record-create identity is not exact.")
        for intent_id, intent in pending_records.items():
            if not isinstance(intent, dict) or set(intent) != {
                "projectId",
                "task",
                "date",
                "hours",
            }:
                raise SelfTestError("A pending record-create shape is invalid.")
            if (
                intent.get("projectId") != next(iter(projects))
                or intent.get("task") != intent_id
                or intent.get("date") not in allowed_days
                or type(intent.get("hours")) not in {int, float}
                or abs(float(intent["hours"]) - expected_hours[intent_id]) > 0.000001
            ):
                raise SelfTestError("A pending record-create value is not exact.")
        return first_day, second_day

    def assert_scope(self, *, server: str, owner_id: str) -> None:
        if (
            self.value.get("schema") != "titra-cli-v6-live-recovery/v2"
            or self.value.get("server") != server.rstrip("/")
            or self.value.get("owner_id") != owner_id
        ):
            raise SelfTestError(
                "The v6 recovery manifest belongs to another server or token owner."
            )

    def set_status(self, status: str) -> None:
        if status in {"completed", "cleanup-completed-after-failure"} and self.has_unresolved():
            raise SelfTestError(
                "Cannot mark v6 recovery complete while a create intent or resource remains."
            )
        self.value["status"] = status
        self._save()

    def remember(self, kind: str, resource_id: str, identity: str) -> None:
        resources = self.value["resources"]
        assert isinstance(resources, dict)
        group = resources[kind]
        assert isinstance(group, dict)
        group[resource_id] = identity
        self._known_resources[kind][resource_id] = identity
        self._save()

    def remember_many(self, kind: str, identities: Mapping[str, str]) -> None:
        resources = self.value["resources"]
        assert isinstance(resources, dict)
        group = resources[kind]
        assert isinstance(group, dict)
        group.update(identities)
        self._known_resources[kind].update(identities)
        self._save()

    def update_identity(self, kind: str, resource_id: str, identity: str) -> None:
        resources = self.value["resources"]
        assert isinstance(resources, dict)
        group = resources[kind]
        assert isinstance(group, dict)
        if resource_id not in group:
            raise SelfTestError("Cannot update an unjournaled synthetic resource identity.")
        group[resource_id] = identity
        self._known_resources[kind][resource_id] = identity
        self._save()

    def begin_create(self, kind: str, intent_id: str, intent: Mapping[str, Any]) -> None:
        pending = self.value["pending"]
        assert isinstance(pending, dict)
        group = pending[kind]
        assert isinstance(group, dict)
        if intent_id in group:
            raise SelfTestError("A synthetic create intent is already pending.")
        group[intent_id] = dict(intent)
        self._save()

    def resolve_create(self, kind: str, intent_id: str, resource_id: str, identity: str) -> None:
        pending = self.value["pending"]
        resources = self.value["resources"]
        assert isinstance(pending, dict) and isinstance(resources, dict)
        pending_group = pending[kind]
        resource_group = resources[kind]
        assert isinstance(pending_group, dict) and isinstance(resource_group, dict)
        if intent_id not in pending_group:
            raise SelfTestError("Cannot resolve an unjournaled synthetic create intent.")
        resource_group[resource_id] = identity
        self._known_resources[kind][resource_id] = identity
        pending_group.pop(intent_id)
        self._save()

    def begin_replay(self, intent_id: str, intent: Mapping[str, Any]) -> None:
        pending = self.value["pending"]
        assert isinstance(pending, dict)
        replays = pending["replays"]
        assert isinstance(replays, dict)
        if intent_id in replays:
            raise SelfTestError("An idempotency replay probe is already pending.")
        replays[intent_id] = dict(intent)
        self._save()

    def resolve_replay(self, intent_id: str) -> None:
        pending = self.value["pending"]
        assert isinstance(pending, dict)
        replays = pending["replays"]
        assert isinstance(replays, dict)
        if intent_id not in replays:
            raise SelfTestError("Cannot resolve an unjournaled idempotency replay probe.")
        replays.pop(intent_id)
        self._save()

    def forget(self, kind: str, resource_id: str) -> None:
        resources = self.value["resources"]
        assert isinstance(resources, dict)
        group = resources[kind]
        assert isinstance(group, dict)
        group.pop(resource_id, None)
        self._save()

    def has_unresolved(self) -> bool:
        pending = self.value["pending"]
        resources = self.value["resources"]
        assert isinstance(pending, dict) and isinstance(resources, dict)
        return any(bool(group) for group in pending.values()) or any(
            bool(group) for group in resources.values()
        )

    def known_resources(self) -> dict[str, dict[str, str]]:
        return {kind: dict(group) for kind, group in self._known_resources.items()}

    def restore_known_resources(self) -> None:
        resources = self.value["resources"]
        assert isinstance(resources, dict)
        for kind, identities in self._known_resources.items():
            group = resources[kind]
            assert isinstance(group, dict)
            group.update(identities)
        self._save()

    def _save(self) -> None:
        temporary = self.path.with_name(f".{self.path.name}.tmp-{os.getpid()}-{uuid.uuid4().hex}")
        try:
            flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
            descriptor = os.open(temporary, flags, 0o600)
            with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
                json.dump(self.value, handle, indent=2, sort_keys=True)
                handle.write("\n")
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, self.path)
            if os.name == "posix":
                directory = os.open(self.path.parent, os.O_RDONLY)
                try:
                    os.fsync(directory)
                finally:
                    os.close(directory)
        except OSError as exc:
            with suppress(OSError):
                temporary.unlink(missing_ok=True)
            raise SelfTestError("The private v6 recovery manifest could not be saved.") from exc


class LiveV6Suite:
    """Fail-closed v6 reads and an optional self-contained mutation lifecycle."""

    def __init__(
        self,
        invoker: JsonInvoker,
        *,
        namespace: str,
        state_directory: Path,
        server: str | None = None,
        expected_user_id: str | None = None,
        release_profile: str = "v6",
        reporter: Callable[[CheckResult], None] | None = None,
        sleeper: Callable[[float], None] = time.sleep,
    ) -> None:
        self.invoker = invoker
        self.namespace = namespace
        self.state_directory = state_directory
        self.server = server.rstrip("/") if server else None
        self.expected_user_id = expected_user_id
        if release_profile not in {"v6", "v7"}:
            raise SelfTestError("The live API release profile must be v6 or v7.")
        self.release_profile = release_profile
        self.reporter = reporter or (lambda _result: None)
        self.sleeper = sleeper
        self.results: list[CheckResult] = []
        self.v2_capabilities: dict[str, Any] | None = None
        if expected_user_id is not None:
            binder = getattr(invoker, "bind_expected_user_id", None)
            if not callable(binder):
                raise SelfTestError("The v6 command invoker cannot bind an expected user ID.")
            binder(expected_user_id)

    def _authenticated_user_id(self) -> str:
        authentication, _ = self.invoker.invoke_json(("auth", "check"))
        user = authentication.get("user") if isinstance(authentication, dict) else None
        user_id = user.get("_id") if isinstance(user, dict) else None
        if (
            not isinstance(authentication, dict)
            or authentication.get("ok") is not True
            or not isinstance(user_id, str)
            or not user_id
        ):
            raise SelfTestError("Authentication check returned no stable current-user identity.")
        if self.expected_user_id is not None and user_id != self.expected_user_id:
            raise SelfTestError("The API token owner does not match --expected-user-id.")
        return user_id

    def _assert_mutation_identity(self, manifest: RecoveryManifest | None = None) -> str:
        if self.server is None or self.expected_user_id is None:
            raise SelfTestError(
                "V6 mutation checks require an exact server and --expected-user-id binding."
            )
        if manifest is not None:
            manifest.assert_scope(server=self.server, owner_id=self.expected_user_id)
        return self._authenticated_user_id()

    def _invoke_mutation(
        self,
        manifest: RecoveryManifest,
        arguments: Sequence[str],
        *,
        allowed_codes: frozenset[int] = frozenset({0}),
    ) -> tuple[Any, int]:
        self._assert_mutation_identity(manifest)
        return self.invoker.invoke_json(arguments, allowed_codes=allowed_codes)

    def _record(self, name: str, status: str = "PASS", detail: str = "") -> None:
        result = CheckResult(name, status, detail)
        self.results.append(result)
        self.reporter(result)

    def run_read_only(
        self, *, project: str | None = None, record_id: str | None = None
    ) -> tuple[list[CheckResult], str | None]:
        advertised, _ = self.invoker.invoke_json(("capabilities", "show", "--version", "2"))
        if not isinstance(advertised, dict) or advertised.get("source") != "/capabilities/v2/":
            raise SelfTestError("Capability discovery did not use exactly /capabilities/v2/.")
        self.v2_capabilities = validate_v2_capabilities(
            advertised.get("document"), release_profile=self.release_profile
        )
        required_flag = f"--require-{self.release_profile}"
        checked, _ = self.invoker.invoke_json(("capabilities", "check", required_flag))
        if (
            not isinstance(checked, dict)
            or checked.get("ok") is not True
            or checked.get("source") != "/capabilities/v2/"
            or checked.get("requirement") != self.release_profile
            or (
                self.release_profile == "v7"
                and (
                    not isinstance(checked.get("security"), dict)
                    or not isinstance(checked["security"].get("http"), dict)
                    or checked["security"]["http"].get("ok") is not True
                )
            )
        ):
            raise SelfTestError(
                f"The CLI's required-{self.release_profile} capability check did not pass exactly."
            )
        self._record(
            "exact /capabilities/v2 contract gate"
            if self.release_profile == "v6"
            else "exact /capabilities/v2 v7 contract gate"
        )

        self._authenticated_user_id()
        self._record("authentication and current-user endpoint")

        doctor, _ = self.invoker.invoke_json(("doctor",))
        capabilities = doctor.get("capabilities") if isinstance(doctor, dict) else None
        required_true = {
            "projects",
            "identity",
            "record_delete",
            "record_task_edit",
            "idempotent_create",
            "timeentry_pagination",
            "v6_ready",
            "project_lifecycle",
            "project_task_lifecycle",
            "task_stats",
            "record_details_edit",
            "task_suggestions",
            "atomic_timers",
        }
        required_exact = {
            "api_version": 2,
            "capabilities_version": 3 if self.release_profile == "v7" else 2,
            "capability_source": "/capabilities/v2/",
        }
        if self.release_profile == "v7":
            required_true.add("v7_ready")
        if (
            not isinstance(capabilities, dict)
            or any(capabilities.get(name) is not True for name in required_true)
            or any(capabilities.get(name) != value for name, value in required_exact.items())
        ):
            raise SelfTestError(
                f"The CLI did not negotiate all required {self.release_profile} API capabilities."
            )
        self._record(f"{self.release_profile} CLI capability negotiation")

        projects, _ = self.invoker.invoke_json(("project", "list", "--include-archived"))
        if not isinstance(projects, list):
            raise SelfTestError("Project listing did not return a list.")
        self._record("project listing", detail=f"{len(projects)} project(s) visible")

        suggestions, _ = self.invoker.invoke_json(("suggestion", "list", "--page-size", "100"))
        if not isinstance(suggestions, list):
            raise SelfTestError("Task-suggestion listing did not return a list.")
        self._record("personal task-suggestion listing", detail="contents retained in memory only")

        _timer, timer_code = self.invoker.invoke_json(
            ("timer", "status"), allowed_codes=frozenset({0, 4})
        )
        self._record(
            "atomic timer read",
            status="SKIP" if timer_code == 4 else "PASS",
            detail="no active timer" if timer_code == 4 else "active timer left unchanged",
        )

        project_id: str | None = None
        if project is not None:
            snapshot, _ = self.invoker.invoke_json(("project", "show", project))
            if not isinstance(snapshot, dict) or not snapshot.get("_id"):
                raise SelfTestError("Project lookup did not return a project ID.")
            project_id = str(snapshot["_id"])
            tasks, _ = self.invoker.invoke_json(("task", "list", project_id))
            if not isinstance(tasks, list):
                raise SelfTestError("Project-task listing did not return a list.")
            users, _ = self.invoker.invoke_json(("project", "users", project_id))
            if not isinstance(users, list):
                raise SelfTestError("Project-user listing did not return a list.")
            stats, _ = self.invoker.invoke_json(("task", "stats", project_id))
            if not isinstance(stats, dict) or str(stats.get("projectId")) != project_id:
                raise SelfTestError("Project-task statistics returned an unexpected project.")
            self._record("project/user/task snapshots and task statistics")

        records, code = self.invoker.invoke_json(
            ("record", "list", "--today", "--raw", "--api-page-size", "1"),
            allowed_codes=frozenset({0, 7}),
        )
        if not isinstance(records, list):
            raise SelfTestError("Owned-record listing did not return a list.")
        self._record(
            "stable paginated owned-record listing",
            status="WARN" if code == 7 else "PASS",
            detail="record contents retained in memory only",
        )
        candidate_id = record_id
        if candidate_id is None:
            candidate = next(
                (item for item in records if isinstance(item, dict) and item.get("_id")), None
            )
            candidate_id = str(candidate["_id"]) if candidate else None
        if candidate_id:
            snapshot, _ = self.invoker.invoke_json(("record", "show", candidate_id))
            if not isinstance(snapshot, dict) or str(snapshot.get("_id")) != candidate_id:
                raise SelfTestError("Owned-record inspection returned an unexpected record.")
            self._record("owned-record revision snapshot")
        else:
            self._record(
                "owned-record revision snapshot",
                status="SKIP",
                detail="no --record-id and no owned record today",
            )
        return list(self.results), project_id

    def run_disposable_mutations(self, *, include_timer: bool = False) -> list[CheckResult]:
        owner_id = self._assert_mutation_identity()
        if include_timer:
            self._require_no_active_timer()
        marker = synthetic_marker(self.namespace)
        assert self.server is not None
        manifest = RecoveryManifest(
            self.state_directory / "v6-recovery.json",
            marker,
            server=self.server,
            owner_id=owner_id,
        )
        project_name = f"{marker}-project"
        project_description = f"Disposable Titra v6 live test {marker}"
        edited_description = f"{project_description}; edited"
        task_name = f"{marker}-task"
        edited_task_name = f"{marker}-task-edited"
        estimated_hours = 0.05
        record_one_task = f"{marker}-record-one"
        record_one_edited_task = f"{marker}-record-one-edited"
        record_two_task = edited_task_name
        record_one_hours = seconds_to_hours(hours_to_seconds(0.017))
        record_two_hours = seconds_to_hours(hours_to_seconds(0.034))
        record_day = datetime.now(UTC).date().isoformat()
        project_id: str | None = None
        task_id: str | None = None
        record_ids: dict[str, str] = {}
        primary_error: BaseException | None = None
        self._record("disposable v6 namespace", detail=marker)
        try:
            project_id = self._create_project(manifest, project_name, project_description, marker)
            self._verify_project(project_id, project_name, marker, archived=False)
            self._record("disposable project create/get")
            self._inspect_project_recovery(project_id)
            users, _ = self.invoker.invoke_json(("project", "users", project_id))
            if not isinstance(users, list):
                raise SelfTestError("Disposable project-user endpoint returned invalid data.")
            self._record("disposable project-user endpoint before time records")

            self._mutate_and_verify(
                manifest,
                (
                    "project",
                    "edit",
                    project_id,
                    "--changes",
                    json.dumps({"description": edited_description}, separators=(",", ":")),
                    "--yes",
                ),
                lambda: self._verify_project(
                    project_id,
                    project_name,
                    marker,
                    archived=False,
                    description=edited_description,
                ),
                "project details edit",
            )
            self._mutate_and_verify(
                manifest,
                ("project", "archive", project_id, "--yes"),
                lambda: self._verify_project(project_id, project_name, marker, archived=True),
                "project archive",
            )
            self._mutate_and_verify(
                manifest,
                ("project", "restore", project_id, "--yes"),
                lambda: self._verify_project(project_id, project_name, marker, archived=False),
                "project restore",
            )

            task_id = self._create_task(
                manifest, project_id, task_name, marker, estimated_hours=estimated_hours
            )
            self._verify_task(
                task_id,
                project_id,
                task_name,
                marker,
                estimated_hours=estimated_hours,
            )
            self._record("disposable predefined task create/get")
            self._mutate_and_verify(
                manifest,
                (
                    "task",
                    "edit",
                    task_id,
                    "--changes",
                    json.dumps({"name": edited_task_name}, separators=(",", ":")),
                    "--yes",
                ),
                lambda: self._verify_task(
                    task_id,
                    project_id,
                    edited_task_name,
                    marker,
                    estimated_hours=estimated_hours,
                ),
                "predefined task edit",
            )
            manifest.update_identity("tasks", task_id, edited_task_name)
            tasks, _ = self.invoker.invoke_json(("task", "list", project_id))
            listed_task = (
                next(
                    (
                        item
                        for item in tasks
                        if isinstance(item, dict) and str(item.get("_id")) == task_id
                    ),
                    None,
                )
                if isinstance(tasks, list)
                else None
            )
            if not isinstance(listed_task, dict) or listed_task.get("name") != edited_task_name:
                raise SelfTestError("Disposable predefined task was absent from task listing.")
            self._record("disposable predefined-task listing")

            if include_timer:
                self._exercise_timer(manifest, project_id, edited_task_name, marker)

            record_ids[record_one_task] = self._create_record(
                manifest,
                project_id,
                record_one_task,
                record_day,
                record_one_hours,
                verify_replay=True,
            )
            record_ids[record_two_task] = self._create_record(
                manifest, project_id, record_two_task, record_day, record_two_hours
            )
            for task, record_id in record_ids.items():
                expected_hours = record_one_hours if task == record_one_task else record_two_hours
                self._verify_record(record_id, project_id, task, marker, hours=expected_hours)
            self._record("two disposable time records create/get")

            users, _ = self.invoker.invoke_json(("project", "users", project_id))
            expected_user_id = self.expected_user_id
            if (
                not isinstance(users, list)
                or not isinstance(expected_user_id, str)
                or not any(
                    isinstance(item, dict)
                    and str(item.get("id") or item.get("_id")) == expected_user_id
                    for item in users
                )
            ):
                raise SelfTestError(
                    "Disposable project-user listing omitted the caller after time-record creation."
                )
            self._record("disposable project-user listing after time records")

            first_id = record_ids[record_one_task]
            self._mutate_and_verify(
                manifest,
                ("record", "edit-task", first_id, "--task", record_one_edited_task, "--yes"),
                lambda: self._verify_record(
                    first_id,
                    project_id,
                    record_one_edited_task,
                    marker,
                    hours=record_one_hours,
                ),
                "time-entry task edit",
            )
            manifest.update_identity("records", first_id, record_one_edited_task)
            second_id = record_ids[record_two_task]
            self._mutate_and_verify(
                manifest,
                (
                    "record",
                    "edit-details",
                    second_id,
                    "--changes",
                    '{"hours":0.033}',
                    "--yes",
                ),
                lambda: self._verify_record(
                    second_id, project_id, record_two_task, marker, hours=0.033
                ),
                "time-entry details edit",
            )

            self._verify_paginated_records(project_id, set(record_ids.values()))
            stats, _ = self.invoker.invoke_json(("task", "stats", project_id))
            self._verify_task_stats(
                stats,
                project_id=project_id,
                task_id=task_id,
                task_name=edited_task_name,
                estimated_hours=estimated_hours,
                actual_hours=0.033,
            )
            self._record("task statistics over disposable records")

            # Use bounded production pages here: the pager's one-item-page behavior is
            # exhaustively unit-tested, while a large personal suggestion history plus
            # deliberate request pacing can otherwise exceed the subprocess timeout.
            suggestions, _ = self.invoker.invoke_json(("suggestion", "list", "--page-size", "100"))
            if not isinstance(suggestions, list):
                raise SelfTestError("Synthetic task-suggestion listing was invalid.")
            suggestion_count = self._inspect_synthetic_suggestions(
                manifest,
                suggestions,
                marker=marker,
                expected_names={record_one_task, record_two_task},
            )
            self._record(
                "personal suggestions read after record creation",
                detail=f"{suggestion_count} synthetic suggestion(s) verified",
            )
        except BaseException as exc:
            primary_error = exc
            manifest.set_status("recovery-required")
            raise
        finally:
            try:
                self._cleanup_disposable(
                    manifest,
                    marker=marker,
                    project_id=project_id,
                    project_name=project_name,
                    task_id=task_id,
                    task_names={task_name, edited_task_name},
                    task_estimated_hours=estimated_hours,
                    record_tasks={
                        record_one_task,
                        record_one_edited_task,
                        record_two_task,
                    },
                    record_shapes={
                        (record_day, record_one_task, record_one_hours),
                        (record_day, record_one_edited_task, record_one_hours),
                        (record_day, record_two_task, record_two_hours),
                        (record_day, record_two_task, 0.033),
                    },
                )
                self._verify_cleanup_absent(
                    manifest,
                    marker=marker,
                    project_name=project_name,
                )
                manifest.set_status(
                    "cleanup-completed-after-failure" if primary_error else "completed"
                )
            except BaseException as cleanup_error:
                manifest.restore_known_resources()
                manifest.set_status("recovery-required")
                if primary_error is None:
                    raise
                self._record(
                    "disposable v6 cleanup",
                    status="FAIL",
                    detail=f"use private recovery manifest for marker {marker}",
                )
                if hasattr(primary_error, "add_note"):
                    primary_error.add_note(
                        "Cleanup also failed. Use the private v6-recovery.json manifest; "
                        f"synthetic marker {marker!r}: {cleanup_error}"
                    )
        return list(self.results)

    def resume_disposable_cleanup(
        self,
        manifest: RecoveryManifest,
        *,
        expected_marker: str,
    ) -> list[CheckResult]:
        """Resume only cleanup described by an exact existing manifest; never create or replay."""

        if self.server is None or self.expected_user_id is None:
            raise SelfTestError(
                "Cleanup recovery requires an exact server and --expected-user-id binding."
            )
        recovery_days = manifest.validate_cleanup_scope(
            server=self.server,
            owner_id=self.expected_user_id,
            expected_marker=expected_marker,
        )
        project_name = f"{expected_marker}-project"
        task_name = f"{expected_marker}-task"
        edited_task_name = f"{expected_marker}-task-edited"
        record_one_task = f"{expected_marker}-record-one"
        record_one_edited_task = f"{expected_marker}-record-one-edited"
        record_one_hours = seconds_to_hours(hours_to_seconds(0.017))
        record_two_hours = seconds_to_hours(hours_to_seconds(0.034))
        record_shapes = {
            (day, task, hours)
            for day in recovery_days
            for task, hours in (
                (record_one_task, record_one_hours),
                (record_one_edited_task, record_one_hours),
                (edited_task_name, record_two_hours),
                (edited_task_name, 0.033),
            )
        }
        try:
            self._cleanup_disposable(
                manifest,
                marker=expected_marker,
                project_id=None,
                project_name=project_name,
                task_id=None,
                task_names={task_name, edited_task_name},
                task_estimated_hours=0.05,
                record_tasks={record_one_task, record_one_edited_task, edited_task_name},
                record_shapes=record_shapes,
            )
            self._verify_cleanup_absent(
                manifest,
                marker=expected_marker,
                project_name=project_name,
            )
            manifest.set_status("cleanup-completed-after-failure")
        except BaseException:
            manifest.restore_known_resources()
            manifest.set_status("recovery-required")
            raise
        self._record("resumed identity-checked disposable cleanup")
        return list(self.results)

    def _verify_cleanup_absent(
        self,
        manifest: RecoveryManifest,
        *,
        marker: str,
        project_name: str,
    ) -> None:
        """Prove exact known IDs and both marker-indexed collections are absent."""

        self._assert_mutation_identity(manifest)
        if manifest.has_unresolved():
            raise SelfTestError("Cleanup post-validation found unresolved manifest state.")
        for kind, identities in manifest.known_resources().items():
            if kind == "timers":
                continue
            singular = {
                "projects": "project",
                "tasks": "task",
                "records": "record",
                "suggestions": "suggestion",
            }.get(kind)
            if singular is None:
                raise SelfTestError("Cleanup post-validation found an unknown resource kind.")
            for resource_id in identities:
                _value, code = self.invoker.invoke_json(
                    (singular, "show", resource_id), allowed_codes=frozenset({0, 4})
                )
                if code != 4:
                    raise SelfTestError(
                        f"Cleanup post-validation found synthetic {singular} {resource_id!r}."
                    )

        known_timers = manifest.known_resources().get("timers", {})
        if known_timers:
            current, code = self.invoker.invoke_json(
                ("timer", "status"), allowed_codes=frozenset({0, 4})
            )
            if code == 0 and isinstance(current, dict) and current.get("timerId") in known_timers:
                raise SelfTestError(
                    "Cleanup post-validation found the synthetic timer still active."
                )

        projects, _ = self.invoker.invoke_json(("project", "list", "--include-archived"))
        if not isinstance(projects, list):
            raise SelfTestError(
                "Cleanup post-validation could not inspect active/archived projects."
            )
        if any(
            isinstance(project, dict)
            and (
                project.get("name") == project_name or marker in str(project.get("description", ""))
            )
            for project in projects
        ):
            raise SelfTestError("Cleanup post-validation found a marker-owned project.")

        suggestions, _ = self.invoker.invoke_json(("suggestion", "list", "--page-size", "100"))
        if not isinstance(suggestions, list):
            raise SelfTestError("Cleanup post-validation could not inspect task suggestions.")
        if any(
            isinstance(suggestion, dict) and marker in str(suggestion.get("name", ""))
            for suggestion in suggestions
        ):
            raise SelfTestError("Cleanup post-validation found a marker-owned task suggestion.")
        if manifest.has_unresolved():
            raise SelfTestError("Cleanup post-validation changed the empty manifest state.")
        self._record("post-cleanup exact-ID and marker absence")

    def _inspect_project_recovery(self, project_id: str) -> None:
        deployment = (
            self.v2_capabilities.get("deployment")
            if isinstance(self.v2_capabilities, dict)
            else None
        )
        enabled = (
            isinstance(deployment, dict) and deployment.get("projectFenceRecoveryEnabled") is True
        )
        if not enabled:
            self._record(
                "disposable project fence-recovery inspection",
                status="SKIP",
                detail="deployment capability disabled",
            )
            return
        snapshot, _ = self.invoker.invoke_json(("project", "recovery", "inspect", project_id))
        if not isinstance(snapshot, dict) or str(snapshot.get("projectId")) != project_id:
            raise SelfTestError("Project fence-recovery inspection returned another project.")
        self._record("disposable project fence-recovery inspection")

    def _require_no_active_timer(self) -> None:
        _timer, code = self.invoker.invoke_json(
            ("timer", "status"), allowed_codes=frozenset({0, 4})
        )
        if code == 0:
            raise SelfTestError("An active timer already exists; no v6 mutation test was started.")
        self._record("timer mutation preflight", detail="no active timer")

    def _exercise_timer(
        self,
        manifest: RecoveryManifest,
        project_id: str,
        task: str,
        marker: str,
    ) -> None:
        operation_id = f"selftest:{uuid.uuid4().hex}"
        # Persist the caller-known server timer ID before the POST. If this
        # process or its child dies after the server commit, recovery can still
        # distinguish our timer from unrelated user-global timer activity.
        manifest.remember("timers", operation_id, marker)
        start_code: int | None = None
        primary_error: BaseException | None = None
        try:
            started, start_code = self._invoke_mutation(
                manifest,
                (
                    "timer",
                    "start",
                    "--project",
                    project_id,
                    "--task",
                    task,
                    "--operation-id",
                    operation_id,
                ),
                allowed_codes=frozenset({0, 6}),
            )
            if start_code == 0 and (
                not isinstance(started, dict)
                or started.get("task") != task
                or str(started.get("project_id") or started.get("projectId")) != project_id
            ):
                raise SelfTestError("Timer start returned an unexpected identity.")
            status, status_code = self.invoker.invoke_json(
                ("timer", "status"), allowed_codes=frozenset({0, 4})
            )
            if (
                status_code != 0
                or not isinstance(status, dict)
                or status.get("running") is not True
                or status.get("timerId") != operation_id
                or status.get("task") != task
                or str(status.get("projectId")) != project_id
            ):
                raise SelfTestError("The newly started synthetic timer could not be identified.")
        except BaseException as exc:
            primary_error = exc
            raise
        finally:
            try:
                current, current_code = self.invoker.invoke_json(
                    ("timer", "status"), allowed_codes=frozenset({0, 4})
                )
                if current_code == 4:
                    if start_code == 0:
                        # A received success response proves the start request
                        # completed. Its later absence is therefore conclusive:
                        # there is no delayed, unidentifiable start left to land.
                        manifest.forget("timers", operation_id)
                        if primary_error is None:
                            raise SelfTestError(
                                "The synthetic timer disappeared before its guarded stop."
                            )
                    else:
                        # Absence immediately after an interrupted/lost start is
                        # not proof that the request cannot commit later. Keep
                        # the caller-known timer ID in the private manifest and
                        # fail closed; never declare cleanup complete or blindly
                        # replay an operation which could arrive after a stop.
                        raise SelfTestError(
                            "The timer-start outcome remains unknown while no timer is "
                            "visible. The retained manifest identifies any delayed commit."
                        )
                elif not isinstance(current, dict) or current.get("timerId") != operation_id:
                    raise SelfTestError(
                        "A different timer is active; it was not stopped. Use the retained "
                        "manifest to reconcile the synthetic timer intent."
                    )
                else:
                    _stopped, stop_code = self._invoke_mutation(
                        manifest,
                        (
                            "timer",
                            "stop",
                            "--expect-timer-id",
                            operation_id,
                            "--draft-only",
                            "--yes",
                        ),
                        allowed_codes=frozenset({0, 6}),
                    )
                    remaining, remaining_code = self.invoker.invoke_json(
                        ("timer", "status"), allowed_codes=frozenset({0, 4})
                    )
                    if remaining_code == 4:
                        manifest.forget("timers", operation_id)
                    elif isinstance(remaining, dict) and remaining.get("timerId") != operation_id:
                        manifest.forget("timers", operation_id)
                        raise SelfTestError(
                            "The synthetic timer was replaced by another timer after its guarded "
                            "stop; the replacement was left untouched."
                        )
                    else:
                        suffix = " after an uncertain response" if stop_code == 6 else ""
                        raise SelfTestError(
                            f"The synthetic timer is still active{suffix}; stop was not retried."
                        )
            except BaseException as cleanup_error:
                if primary_error is None:
                    raise
                if hasattr(primary_error, "add_note"):
                    primary_error.add_note(
                        "The one guarded timer stop also failed; use retained private state: "
                        f"{cleanup_error}"
                    )
        self._record(
            "atomic timer start/status/stop",
            status="WARN" if start_code == 6 else "PASS",
            detail="uncertain start reconciled by status" if start_code == 6 else "",
        )

    def _create_project(
        self, manifest: RecoveryManifest, name: str, description: str, marker: str
    ) -> str:
        manifest.begin_create(
            "projects",
            name,
            {"name": name, "description": description, "marker": marker},
        )
        created, code = self._invoke_mutation(
            manifest,
            ("project", "create", name, "--description", description, "--yes"),
            allowed_codes=frozenset({0, 6}),
        )
        project_id = (
            str(created.get("projectId"))
            if code == 0 and isinstance(created, dict) and created.get("projectId")
            else self._discover_project(name)
        )
        if not project_id:
            raise SelfTestError(
                f"Project creation was not confirmed. Do not retry; inspect marker {name!r}."
            )
        manifest.resolve_create("projects", name, project_id, name)
        self._verify_project(project_id, name, marker, archived=False, description=description)
        if code == 6:
            self._record("disposable project creation response", "WARN", "reconciled by GET")
            self._record(
                "project idempotency replay",
                "WARN",
                "initial create response was uncertain; no replay attempted",
            )
        else:
            receipt_id = created.get("receipt_id") if isinstance(created, dict) else None
            if not isinstance(receipt_id, str) or not receipt_id:
                raise SelfTestError(
                    "Project create returned no durable receipt for the idempotency replay probe."
                )
            self._verify_creation_replay(
                manifest,
                receipt_id=receipt_id,
                operation="project.create",
                result_id=project_id,
                label="project idempotency replay",
            )
        return project_id

    def _discover_project(self, name: str) -> str | None:
        for attempt in range(3):
            projects, _ = self.invoker.invoke_json(("project", "list", "--include-archived"))
            if not isinstance(projects, list):
                raise SelfTestError("Cannot reconcile project creation: invalid project list.")
            matches = [
                item
                for item in projects
                if isinstance(item, dict)
                and item.get("name") == name
                and (item.get("_id") or item.get("id"))
            ]
            if len(matches) > 1:
                raise SelfTestError(
                    "Multiple projects have the synthetic marker; refusing cleanup."
                )
            if matches:
                return str(matches[0].get("_id") or matches[0]["id"])
            if attempt < 2:
                self.sleeper(0.5)
        return None

    def _verify_project(
        self,
        project_id: str,
        name: str,
        marker: str,
        *,
        archived: bool,
        description: str | None = None,
    ) -> dict[str, Any]:
        project, _ = self.invoker.invoke_json(("project", "show", project_id))
        if (
            not isinstance(project, dict)
            or str(project.get("_id")) != project_id
            or project.get("name") != name
            or project.get("role") != "owner"
            or project.get("userId") != self.expected_user_id
            or marker not in str(project.get("description", ""))
            or (project.get("archived") is True) is not archived
            or (description is not None and project.get("description") != description)
        ):
            raise SelfTestError("Synthetic project identity/state mismatch; refusing cleanup.")
        return project

    def _create_task(
        self,
        manifest: RecoveryManifest,
        project_id: str,
        name: str,
        marker: str,
        *,
        estimated_hours: float,
    ) -> str:
        today = datetime.now(UTC).date().isoformat()
        manifest.begin_create(
            "tasks",
            name,
            {
                "projectId": project_id,
                "name": name,
                "marker": marker,
                "estimatedHours": estimated_hours,
            },
        )
        created, code = self._invoke_mutation(
            manifest,
            (
                "task",
                "create",
                project_id,
                name,
                "--start",
                today,
                "--end",
                today,
                "--estimated-hours",
                str(estimated_hours),
                "--yes",
            ),
            allowed_codes=frozenset({0, 6}),
        )
        task_id = (
            str(created.get("taskId"))
            if code == 0 and isinstance(created, dict) and created.get("taskId")
            else self._discover_task(project_id, name)
        )
        if not task_id:
            raise SelfTestError(
                f"Task creation was not confirmed. Do not retry; inspect marker {marker!r}."
            )
        manifest.resolve_create("tasks", name, task_id, name)
        if code == 6:
            self._record("disposable task creation response", "WARN", "reconciled by GET")
            self._record(
                "project-task idempotency replay",
                "WARN",
                "initial create response was uncertain; no replay attempted",
            )
        else:
            receipt_id = created.get("receipt_id") if isinstance(created, dict) else None
            if not isinstance(receipt_id, str) or not receipt_id:
                raise SelfTestError(
                    "Task create returned no durable receipt for the idempotency replay probe."
                )
            self._verify_creation_replay(
                manifest,
                receipt_id=receipt_id,
                operation="project-task.create",
                result_id=task_id,
                label="project-task idempotency replay",
            )
        return task_id

    def _discover_task(self, project_id: str, name: str) -> str | None:
        for attempt in range(3):
            tasks, _ = self.invoker.invoke_json(("task", "list", project_id))
            if not isinstance(tasks, list):
                raise SelfTestError("Cannot reconcile task creation: invalid task list.")
            matches = [
                item
                for item in tasks
                if isinstance(item, dict) and item.get("name") == name and item.get("_id")
            ]
            if len(matches) > 1:
                raise SelfTestError("Multiple tasks have the synthetic marker; refusing cleanup.")
            if matches:
                return str(matches[0]["_id"])
            if attempt < 2:
                self.sleeper(0.5)
        return None

    def _verify_task(
        self,
        task_id: str,
        project_id: str,
        name: str,
        marker: str,
        *,
        estimated_hours: float | None = None,
    ) -> dict[str, Any]:
        task, _ = self.invoker.invoke_json(("task", "show", task_id))
        estimate_matches = estimated_hours is None or (
            isinstance(task, dict)
            and isinstance(task.get("estimatedHours"), (int, float))
            and abs(float(task["estimatedHours"]) - estimated_hours) < 0.000001
        )
        if (
            not isinstance(task, dict)
            or str(task.get("_id")) != task_id
            or str(task.get("projectId")) != project_id
            or task.get("name") != name
            or marker not in name
            or not estimate_matches
        ):
            raise SelfTestError("Synthetic predefined-task identity mismatch; refusing cleanup.")
        return task

    def _create_record(
        self,
        manifest: RecoveryManifest,
        project_id: str,
        task: str,
        day: str,
        hours: float,
        *,
        verify_replay: bool = False,
    ) -> str:
        canonical_hours = seconds_to_hours(hours_to_seconds(hours))
        manifest.begin_create(
            "records",
            task,
            {
                "projectId": project_id,
                "task": task,
                "date": day,
                "hours": canonical_hours,
            },
        )
        created, code = self._invoke_mutation(
            manifest,
            (
                "record",
                "create",
                "--project",
                project_id,
                "--task",
                task,
                "--date",
                day,
                "--hours",
                str(canonical_hours),
                "--yes",
            ),
            allowed_codes=frozenset({0, 6}),
        )
        record_id = (
            str(created.get("timecardId"))
            if code == 0 and isinstance(created, dict) and created.get("timecardId")
            else self._discover_record(project_id, task)
        )
        if not record_id:
            raise SelfTestError(
                f"Record creation was not confirmed. Do not retry; inspect task marker {task!r}."
            )
        manifest.resolve_create("records", task, record_id, task)
        if code == 6:
            self._record("disposable record creation response", "WARN", "reconciled by GET")
            if verify_replay:
                self._record(
                    "time-entry idempotency replay",
                    "WARN",
                    "initial create response was uncertain; no replay attempted",
                )
        elif verify_replay:
            draft_id = created.get("draft_id") if isinstance(created, dict) else None
            if not isinstance(draft_id, str) or not draft_id:
                raise SelfTestError(
                    "Record create returned no durable draft for the idempotency replay probe."
                )
            self._verify_draft_replay(
                manifest,
                draft_id=draft_id,
                result_ids=[record_id],
                label="time-entry idempotency replay",
            )
        return record_id

    def _verify_creation_replay(
        self,
        manifest: RecoveryManifest,
        *,
        receipt_id: str,
        operation: str,
        result_id: str,
        label: str,
    ) -> None:
        intent_id = f"creation:{receipt_id}"
        manifest.begin_replay(
            intent_id,
            {
                "kind": "creation",
                "receiptId": receipt_id,
                "operation": operation,
                "expectedResultIds": [result_id],
            },
        )
        replay, _ = self._invoke_mutation(
            manifest,
            (
                "creation",
                "verify-replay",
                receipt_id,
                "--expect-result-id",
                result_id,
                "--yes",
            ),
        )
        required_keys = {
            "receipt_id",
            "operation",
            "status",
            "replay_status",
            "result_id",
            "idempotency_replayed",
            "idempotency_expires_at",
            "receipt",
        }
        if (
            not isinstance(replay, dict)
            or set(replay) != required_keys
            or replay.get("receipt_id") != receipt_id
            or replay.get("operation") != operation
            or replay.get("status") != "completed"
            or replay.get("replay_status") != "verified"
            or replay.get("result_id") != result_id
            or replay.get("idempotency_replayed") is not True
            or not isinstance(replay.get("idempotency_expires_at"), str)
            or not replay["idempotency_expires_at"]
            or not isinstance(replay.get("receipt"), str)
            or not replay["receipt"]
        ):
            raise SelfTestError("Creation idempotency replay returned an unexpected contract.")
        manifest.resolve_replay(intent_id)
        self._record(label)

    def _verify_draft_replay(
        self,
        manifest: RecoveryManifest,
        *,
        draft_id: str,
        result_ids: list[str],
        label: str,
    ) -> None:
        intent_id = f"draft:{draft_id}"
        manifest.begin_replay(
            intent_id,
            {
                "kind": "draft",
                "draftId": draft_id,
                "expectedResultIds": list(result_ids),
            },
        )
        arguments: list[str] = ["draft", "verify-replay", draft_id]
        for result_id in result_ids:
            arguments.extend(("--expect-result-id", result_id))
        arguments.append("--yes")
        replay, _ = self._invoke_mutation(manifest, tuple(arguments))
        required_keys = {
            "draft_id",
            "status",
            "replay_status",
            "result_ids",
            "replays",
        }
        replays = replay.get("replays") if isinstance(replay, dict) else None
        if (
            not isinstance(replay, dict)
            or set(replay) != required_keys
            or replay.get("draft_id") != draft_id
            or replay.get("status") != "submitted"
            or replay.get("replay_status") != "verified"
            or replay.get("result_ids") != result_ids
            or not isinstance(replays, list)
            or len(replays) != len(result_ids)
            or any(
                not isinstance(item, dict)
                or set(item)
                != {
                    "operation",
                    "result_id",
                    "idempotency_replayed",
                    "idempotency_expires_at",
                }
                or item.get("operation") != "timeentry.create"
                or item.get("result_id") != expected_id
                or item.get("idempotency_replayed") is not True
                or not isinstance(item.get("idempotency_expires_at"), str)
                or not item["idempotency_expires_at"]
                for item, expected_id in zip(replays, result_ids, strict=True)
            )
        ):
            raise SelfTestError("Time-entry idempotency replay returned an unexpected contract.")
        manifest.resolve_replay(intent_id)
        self._record(label)

    def _project_records_for_day(self, project_id: str, day: str) -> list[dict[str, Any]]:
        records, _ = self.invoker.invoke_json(
            (
                "record",
                "list",
                "--from",
                day,
                "--to",
                day,
                "--project",
                project_id,
                "--team",
                "--raw",
                "--limit",
                "500",
                "--api-page-size",
                "1",
            ),
            allowed_codes=frozenset({0, 7}),
        )
        if not isinstance(records, list):
            raise SelfTestError("Synthetic record pagination returned an invalid list.")
        return [item for item in records if isinstance(item, dict)]

    def _today_project_records(self, project_id: str) -> list[dict[str, Any]]:
        return self._project_records_for_day(project_id, datetime.now(UTC).date().isoformat())

    def _today_owned_records(self) -> list[dict[str, Any]]:
        records, _ = self.invoker.invoke_json(
            (
                "record",
                "list",
                "--today",
                "--raw",
                "--limit",
                "500",
                "--api-page-size",
                "1",
            ),
            allowed_codes=frozenset({0, 7}),
        )
        if not isinstance(records, list):
            raise SelfTestError("Owned time-entry pagination returned an invalid list.")
        return [item for item in records if isinstance(item, dict)]

    def _discover_record(self, project_id: str, task: str, *, day: str | None = None) -> str | None:
        for attempt in range(3):
            matches = [
                item
                for item in (
                    self._project_records_for_day(project_id, day)
                    if day is not None
                    else self._today_project_records(project_id)
                )
                if str(item.get("projectId")) == project_id
                and item.get("task") == task
                and item.get("_id")
            ]
            if len(matches) > 1:
                raise SelfTestError("Multiple records have the synthetic marker; refusing cleanup.")
            if matches:
                return str(matches[0]["_id"])
            if attempt < 2:
                self.sleeper(0.5)
        return None

    def _verify_record(
        self,
        record_id: str,
        project_id: str,
        task: str,
        marker: str,
        *,
        hours: float | None = None,
    ) -> dict[str, Any]:
        record, _ = self.invoker.invoke_json(("record", "show", record_id))
        hours_match = hours is None or (
            isinstance(record, dict)
            and isinstance(record.get("hours"), (int, float))
            and abs(float(record["hours"]) - hours) < 0.000001
        )
        if (
            not isinstance(record, dict)
            or str(record.get("_id")) != record_id
            or str(record.get("projectId")) != project_id
            or record.get("task") != task
            or marker not in task
            or not hours_match
        ):
            raise SelfTestError("Synthetic record identity/state mismatch; refusing cleanup.")
        return record

    def _mutate_and_verify(
        self,
        manifest: RecoveryManifest,
        arguments: Sequence[str],
        verifier: Callable[[], Any],
        label: str,
    ) -> None:
        _result, code = self._invoke_mutation(manifest, arguments, allowed_codes=frozenset({0, 6}))
        verifier()
        self._record(
            label,
            status="WARN" if code == 6 else "PASS",
            detail="uncertain response reconciled by GET" if code == 6 else "",
        )

    def _verify_paginated_records(self, project_id: str, expected_ids: set[str]) -> None:
        project_records = self._today_project_records(project_id)
        owned_records = self._today_owned_records()
        project_observed = {str(item.get("_id")) for item in project_records if item.get("_id")}
        owned_observed = {str(item.get("_id")) for item in owned_records if item.get("_id")}
        if not expected_ids.issubset(project_observed) or not expected_ids.issubset(owned_observed):
            raise SelfTestError(
                "Stable owner and project pagination did not return both disposable records."
            )
        self._record("stable pagination includes both disposable records")

    @staticmethod
    def _verify_task_stats(
        value: Any,
        *,
        project_id: str,
        task_id: str,
        task_name: str,
        estimated_hours: float,
        actual_hours: float,
    ) -> None:
        tasks = value.get("tasks") if isinstance(value, dict) else None
        matches = (
            [
                item
                for item in tasks
                if isinstance(item, dict) and str(item.get("taskId")) == task_id
            ]
            if isinstance(tasks, list)
            else []
        )
        expected_variance = actual_hours - estimated_hours

        def close(actual: Any, expected: float) -> bool:
            return isinstance(actual, (int, float)) and abs(float(actual) - expected) < 0.000001

        if (
            not isinstance(value, dict)
            or str(value.get("projectId")) != project_id
            or len(matches) != 1
            or matches[0].get("taskName") != task_name
            or not close(matches[0].get("estimatedHours"), estimated_hours)
            or not close(matches[0].get("actualHours"), actual_hours)
            or not close(matches[0].get("variance"), expected_variance)
            or not close(value.get("totalEstimatedHours"), estimated_hours)
            or not close(value.get("totalActualHours"), actual_hours)
        ):
            raise SelfTestError(
                "Task statistics did not match the disposable estimate and recorded hours."
            )

    def _inspect_synthetic_suggestions(
        self,
        manifest: RecoveryManifest,
        suggestions: list[Any],
        *,
        marker: str,
        expected_names: set[str],
        required: bool = True,
    ) -> int:
        candidates: dict[str, str] = {}
        for item in suggestions:
            if not isinstance(item, dict) or item.get("name") not in expected_names:
                continue
            suggestion_id = item.get("_id")
            name = item.get("name")
            if (
                not isinstance(suggestion_id, str)
                or not isinstance(name, str)
                or marker not in name
                or suggestion_id in candidates
            ):
                raise SelfTestError("Synthetic task-suggestion listing was ambiguous.")
            candidates[suggestion_id] = name
        if required and set(candidates.values()) != expected_names:
            raise SelfTestError("Not all marker-owned task suggestions were returned.")
        if candidates:
            manifest.remember_many("suggestions", candidates)
        for suggestion_id, expected_name in candidates.items():
            suggestion, _ = self.invoker.invoke_json(("suggestion", "show", suggestion_id))
            if (
                not isinstance(suggestion, dict)
                or str(suggestion.get("_id")) != suggestion_id
                or suggestion.get("name") != expected_name
            ):
                raise SelfTestError("Synthetic task-suggestion identity mismatch.")
        return len(candidates)

    def _cleanup_disposable(
        self,
        manifest: RecoveryManifest,
        *,
        marker: str,
        project_id: str | None,
        project_name: str,
        task_id: str | None,
        task_names: set[str],
        task_estimated_hours: float,
        record_tasks: set[str],
        record_shapes: set[tuple[str, str, float]],
    ) -> None:
        self._assert_mutation_identity(manifest)
        self._reconcile_pending_creates(manifest, marker=marker)
        self._journal_marker_resources(
            manifest,
            marker=marker,
            project_name=project_name,
            task_names=task_names,
            task_estimated_hours=task_estimated_hours,
            record_tasks=record_tasks,
            record_shapes=record_shapes,
        )
        resources = manifest.value["resources"]
        pending = manifest.value["pending"]
        assert isinstance(pending, dict)
        assert isinstance(resources, dict)
        stored_projects = resources["projects"]
        stored_tasks = resources["tasks"]
        assert isinstance(stored_projects, dict) and isinstance(stored_tasks, dict)
        if project_id is not None and stored_projects and project_id not in stored_projects:
            raise SelfTestError("Project ID disagrees with the recovery manifest.")
        if task_id is not None and stored_tasks and task_id not in stored_tasks:
            raise SelfTestError("Task ID disagrees with the recovery manifest.")
        resolved_project_id = project_id or (
            next(iter(stored_projects)) if stored_projects else None
        )
        allowed_project_ids = set(stored_projects)

        suggestions, _ = self.invoker.invoke_json(("suggestion", "list", "--page-size", "100"))
        if not isinstance(suggestions, list):
            raise SelfTestError("Cannot reconcile synthetic task suggestions during cleanup.")
        self._inspect_synthetic_suggestions(
            manifest,
            suggestions,
            marker=marker,
            expected_names=record_tasks,
            required=False,
        )

        replay_intents = pending["replays"]
        assert isinstance(replay_intents, dict)
        if replay_intents:
            raise SelfTestError("An idempotency replay outcome is unresolved; cleanup was stopped.")
        stored_timers = resources["timers"]
        assert isinstance(stored_timers, dict)
        if stored_timers:
            raise SelfTestError(
                "Synthetic timer outcome is unresolved; resource cleanup was stopped."
            )

        stored_records = resources["records"]
        assert isinstance(stored_records, dict)
        for record_id in list(stored_records):
            record, code = self.invoker.invoke_json(
                ("record", "show", record_id), allowed_codes=frozenset({0, 4})
            )
            if code == 4:
                manifest.forget("records", record_id)
                continue
            task = str(record.get("task")) if isinstance(record, dict) else ""
            record_etag = record.get("etag") if isinstance(record, dict) else None
            if (
                resolved_project_id is None
                or not isinstance(record, dict)
                or str(record.get("_id")) != record_id
                or str(record.get("projectId")) not in allowed_project_ids
                or task != stored_records[record_id]
                or marker not in task
                or not isinstance(record_etag, str)
                or not record_etag
            ):
                raise SelfTestError("Record cleanup identity mismatch; no delete was attempted.")
            self._delete_then_require_absent(
                manifest,
                "record",
                record_id,
                extra=(
                    "--expect-project-id",
                    str(record["projectId"]),
                    "--expect-task",
                    task,
                    "--if-match",
                    record_etag,
                ),
            )
            manifest.forget("records", record_id)

        stored_suggestions = resources["suggestions"]
        assert isinstance(stored_suggestions, dict)
        for suggestion_id, expected_name in list(stored_suggestions.items()):
            suggestion, code = self.invoker.invoke_json(
                ("suggestion", "show", suggestion_id), allowed_codes=frozenset({0, 4})
            )
            if code == 4:
                manifest.forget("suggestions", suggestion_id)
                continue
            suggestion_etag = suggestion.get("etag") if isinstance(suggestion, dict) else None
            if (
                not isinstance(suggestion, dict)
                or str(suggestion.get("_id")) != suggestion_id
                or suggestion.get("name") != expected_name
                or marker not in str(expected_name)
                or not isinstance(suggestion_etag, str)
                or not suggestion_etag
            ):
                raise SelfTestError(
                    "Suggestion cleanup identity mismatch; no delete was attempted."
                )
            self._delete_then_require_absent(
                manifest,
                "suggestion",
                suggestion_id,
                extra=(
                    "--expect-name",
                    str(expected_name),
                    "--if-match",
                    suggestion_etag,
                    "--acknowledge-referenced-records",
                ),
            )
            manifest.forget("suggestions", suggestion_id)

        for stored_task_id in list(stored_tasks):
            task, code = self.invoker.invoke_json(
                ("task", "show", stored_task_id), allowed_codes=frozenset({0, 4})
            )
            if code == 4:
                manifest.forget("tasks", stored_task_id)
            else:
                task_etag = task.get("etag") if isinstance(task, dict) else None
                if (
                    resolved_project_id is None
                    or not isinstance(task, dict)
                    or str(task.get("_id")) != stored_task_id
                    or str(task.get("projectId")) not in allowed_project_ids
                    or task.get("name") != stored_tasks[stored_task_id]
                    or marker not in str(task.get("name"))
                    or not isinstance(task_etag, str)
                    or not task_etag
                ):
                    raise SelfTestError("Task cleanup identity mismatch; no delete was attempted.")
                self._delete_then_require_absent(
                    manifest,
                    "task",
                    stored_task_id,
                    extra=(
                        "--expect-project-id",
                        str(task["projectId"]),
                        "--expect-name",
                        str(task["name"]),
                        "--if-match",
                        task_etag,
                        "--acknowledge-recorded-entries",
                    ),
                )
                manifest.forget("tasks", stored_task_id)

        for stored_project_id, expected_name in list(stored_projects.items()):
            project, code = self.invoker.invoke_json(
                ("project", "show", stored_project_id), allowed_codes=frozenset({0, 4})
            )
            if code == 4:
                manifest.forget("projects", stored_project_id)
            else:
                project_etag = project.get("etag") if isinstance(project, dict) else None
                if (
                    not isinstance(project, dict)
                    or str(project.get("_id")) != stored_project_id
                    or project.get("name") != expected_name
                    or expected_name != project_name
                    or marker not in str(project.get("description", ""))
                    or not isinstance(project_etag, str)
                    or not project_etag
                ):
                    raise SelfTestError(
                        "Project cleanup identity mismatch; no delete was attempted."
                    )
                self._delete_then_require_absent(
                    manifest,
                    "project",
                    stored_project_id,
                    extra=(
                        "--expect-name",
                        project_name,
                        "--if-match",
                        project_etag,
                    ),
                )
                manifest.forget("projects", stored_project_id)
        if manifest.has_unresolved():
            raise SelfTestError(
                "Recovery manifest still contains a pending intent or synthetic resource."
            )
        self._record("identity-checked disposable v6 cleanup")

    def _journal_marker_resources(
        self,
        manifest: RecoveryManifest,
        *,
        marker: str,
        project_name: str,
        task_names: set[str],
        task_estimated_hours: float,
        record_tasks: set[str],
        record_shapes: set[tuple[str, str, float]],
    ) -> None:
        """Discover every exact marker match before cleanup, including broken replay duplicates."""

        projects, _ = self.invoker.invoke_json(("project", "list", "--include-archived"))
        if not isinstance(projects, list):
            raise SelfTestError("Cannot reconcile disposable projects during cleanup.")
        for candidate in projects:
            if not isinstance(candidate, dict) or candidate.get("name") != project_name:
                continue
            project_id = candidate.get("_id") or candidate.get("id")
            if not isinstance(project_id, str) or not project_id:
                raise SelfTestError("A marker-matched project has no stable ID.")
            project, _ = self.invoker.invoke_json(("project", "show", project_id))
            if (
                not isinstance(project, dict)
                or str(project.get("_id")) != project_id
                or project.get("name") != project_name
                or project.get("role") != "owner"
                or project.get("userId") != self.expected_user_id
                or marker not in str(project.get("description", ""))
                or type(project.get("archived", False)) is not bool
            ):
                raise SelfTestError("Marker-matched project identity mismatch; cleanup stopped.")
            manifest.remember("projects", project_id, project_name)

        resources = manifest.value["resources"]
        assert isinstance(resources, dict)
        stored_projects = resources["projects"]
        assert isinstance(stored_projects, dict)
        for project_id in list(stored_projects):
            tasks, _ = self.invoker.invoke_json(("task", "list", project_id))
            if not isinstance(tasks, list):
                raise SelfTestError("Cannot reconcile disposable tasks during cleanup.")
            for candidate in tasks:
                if not isinstance(candidate, dict) or candidate.get("name") not in task_names:
                    continue
                task_id = candidate.get("_id")
                name = candidate.get("name")
                if (
                    not isinstance(task_id, str)
                    or not task_id
                    or not isinstance(name, str)
                    or marker not in name
                ):
                    raise SelfTestError("A marker-matched task has no safe identity.")
                task = self._verify_task(
                    task_id,
                    project_id,
                    name,
                    marker,
                    estimated_hours=task_estimated_hours,
                )
                if str(task.get("projectId")) != project_id:
                    raise SelfTestError("Marker-matched task belongs to another project.")
                manifest.remember("tasks", task_id, name)

            records_by_id: dict[str, dict[str, Any]] = {}
            for expected_day in sorted({shape[0] for shape in record_shapes}):
                for record in self._project_records_for_day(project_id, expected_day):
                    record_id = record.get("_id")
                    if isinstance(record_id, str):
                        records_by_id[record_id] = record
            for record in records_by_id.values():
                task_name = record.get("task")
                if task_name not in record_tasks:
                    continue
                record_id = record.get("_id")
                record_day = record.get("dateOnly")
                record_hours = record.get("hours")
                shape_matches = (
                    isinstance(record_day, str)
                    and isinstance(record_hours, (int, float))
                    and not isinstance(record_hours, bool)
                    and any(
                        record_day == expected_day
                        and task_name == expected_task
                        and abs(float(record_hours) - expected_hours) < 0.000001
                        for expected_day, expected_task, expected_hours in record_shapes
                    )
                )
                if (
                    not isinstance(record_id, str)
                    or not record_id
                    or not isinstance(task_name, str)
                    or marker not in task_name
                    or str(record.get("projectId")) != project_id
                    or not shape_matches
                ):
                    raise SelfTestError("A marker-matched record has no safe identity.")
                self._verify_record(record_id, project_id, task_name, marker)
                manifest.remember("records", record_id, task_name)

    def _reconcile_pending_creates(self, manifest: RecoveryManifest, *, marker: str) -> None:
        pending = manifest.value["pending"]
        assert isinstance(pending, dict)
        pending_projects = pending["projects"]
        pending_tasks = pending["tasks"]
        pending_records = pending["records"]
        assert (
            isinstance(pending_projects, dict)
            and isinstance(pending_tasks, dict)
            and isinstance(pending_records, dict)
        )

        for intent_id, intent in list(pending_projects.items()):
            if (
                not isinstance(intent, dict)
                or intent.get("name") != intent_id
                or intent.get("marker") != marker
                or marker not in str(intent.get("description", ""))
            ):
                raise SelfTestError("Pending project-create identity is invalid.")
            discovered = self._discover_project(intent_id)
            if discovered is not None:
                self._verify_project(
                    discovered,
                    intent_id,
                    marker,
                    archived=False,
                    description=str(intent["description"]),
                )
                manifest.resolve_create("projects", intent_id, discovered, intent_id)

        for intent_id, intent in list(pending_tasks.items()):
            project = intent.get("projectId") if isinstance(intent, dict) else None
            estimate = intent.get("estimatedHours") if isinstance(intent, dict) else None
            if (
                not isinstance(intent, dict)
                or intent.get("name") != intent_id
                or intent.get("marker") != marker
                or not isinstance(project, str)
                or not isinstance(estimate, (int, float))
            ):
                raise SelfTestError("Pending task-create identity is invalid.")
            discovered = self._discover_task(project, intent_id)
            if discovered is not None:
                self._verify_task(
                    discovered,
                    project,
                    intent_id,
                    marker,
                    estimated_hours=float(estimate),
                )
                manifest.resolve_create("tasks", intent_id, discovered, intent_id)

        for intent_id, intent in list(pending_records.items()):
            project = intent.get("projectId") if isinstance(intent, dict) else None
            task = intent.get("task") if isinstance(intent, dict) else None
            day = intent.get("date") if isinstance(intent, dict) else None
            hours = intent.get("hours") if isinstance(intent, dict) else None
            if (
                not isinstance(intent, dict)
                or task != intent_id
                or marker not in str(task)
                or not isinstance(project, str)
                or not isinstance(day, str)
                or not isinstance(hours, (int, float))
            ):
                raise SelfTestError("Pending record-create identity is invalid.")
            discovered = self._discover_record(project, intent_id, day=day)
            if discovered is not None:
                self._verify_record(
                    discovered,
                    project,
                    intent_id,
                    marker,
                    hours=float(hours),
                )
                manifest.resolve_create("records", intent_id, discovered, intent_id)

        if any(bool(pending[kind]) for kind in ("projects", "tasks", "records")):
            raise SelfTestError(
                "A pending create intent could not be reconciled; no dependent cleanup ran."
            )

    def _delete_then_require_absent(
        self,
        manifest: RecoveryManifest,
        kind: str,
        resource_id: str,
        *,
        extra: Sequence[str] = (),
    ) -> None:
        _deleted, delete_code = self._invoke_mutation(
            manifest,
            (kind, "delete", resource_id, *extra, "--yes"),
            allowed_codes=frozenset({0, 6}),
        )
        _remaining, code = self.invoker.invoke_json(
            (kind, "show", resource_id), allowed_codes=frozenset({0, 4})
        )
        if code != 4:
            suffix = " after an uncertain response" if delete_code == 6 else ""
            raise SelfTestError(f"Synthetic {kind} still exists{suffix}; deletion was not retried.")


def _is_source_root(candidate: Path) -> bool:
    return all(
        (
            (candidate / "pyproject.toml").is_file(),
            (candidate / "src" / "titra_cli").is_dir(),
            (candidate / "tests").is_dir(),
        )
    )


def project_root(explicit: str | Path | None = None) -> Path:
    """Find a source checkout, while permitting installed live-only use."""

    if explicit is not None:
        selected = Path(explicit).expanduser().resolve()
        if not selected.is_dir():
            raise SelfTestError(f"The source root is not a directory: {selected}")
        return selected
    current = Path.cwd().resolve()
    if _is_source_root(current):
        return current
    module_root = Path(__file__).resolve().parents[2]
    return module_root if _is_source_root(module_root) else current


def local_check_commands(python: str) -> tuple[tuple[str, tuple[str, ...]], ...]:
    return (
        (
            "unit and contract tests",
            (python, "-m", "pytest", "--cov=titra_cli", "--cov-branch"),
        ),
        ("Ruff lint", (python, "-m", "ruff", "check", "src", "tests", "scripts")),
        (
            "Ruff format check",
            (python, "-m", "ruff", "format", "--check", "src", "tests", "scripts"),
        ),
        ("strict mypy", (python, "-m", "mypy", "src")),
    )


def run_local_checks(
    *,
    python: str,
    root: Path,
    environment: Mapping[str, str] | None = None,
    executor: Callable[..., subprocess.CompletedProcess[Any]] = subprocess.run,
) -> list[CheckResult]:
    results: list[CheckResult] = []
    base_environment = dict(environment) if environment is not None else dict(os.environ)
    with tempfile.TemporaryDirectory(prefix="titra-cli-coverage-") as coverage_directory:
        check_environment = dict(base_environment)
        check_environment["COVERAGE_FILE"] = str(Path(coverage_directory) / ".coverage")
        check_environment["PYTHONPATH"] = str(root / "src")
        for name, command in local_check_commands(python):
            print(f"[RUN ] {name}", flush=True)
            completed = executor(
                command,
                cwd=root,
                check=False,
                env=check_environment,
            )
            if completed.returncode != 0:
                raise SelfTestError(f"{name} failed with exit {completed.returncode}.")
            result = CheckResult(name, "PASS")
            results.append(result)
            print(f"[PASS] {name}", flush=True)
    return results


def _print_result(result: CheckResult) -> None:
    detail = f" — {result.detail}" if result.detail else ""
    print(f"[{result.status:4}] {result.name}{detail}", flush=True)


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Run Titra CLI unit/static checks and optional privacy-preserving v5/v6/v7 live checks."
        )
    )
    parser.add_argument("--live-url", help="Base URL of an explicitly selected test server.")
    parser.add_argument(
        "--live-api-version",
        choices=("v5", "v6", "v7"),
        default="v5",
        help="Live suite to run (default: %(default)s).",
    )
    parser.add_argument(
        "--credentials",
        help="Private Titra CLI TOML credential file; never copied into test output.",
    )
    parser.add_argument(
        "--profile",
        help="Credential profile name (uses --credentials, cwd, then home discovery).",
    )
    parser.add_argument(
        "--token-env",
        default="TITRA_V5_API_TOKEN",
        help="Environment variable containing the API token (default: %(default)s).",
    )
    parser.add_argument(
        "--no-token-prompt",
        action="store_true",
        help="Fail instead of using a hidden prompt when --token-env is unset.",
    )
    parser.add_argument("--expected-username", help="Fail if the token owner has another name.")
    parser.add_argument(
        "--expected-user-id",
        help=("Fail if /user/me returns another immutable ID; required for v6 mutation tests."),
    )
    parser.add_argument(
        "--project",
        help="Owned/team project ID or unique name for project-user and optional write checks.",
    )
    parser.add_argument(
        "--record-id",
        help="Owned record ID for a read-only record-inspection check.",
    )
    parser.add_argument(
        "--allow-write-tests",
        action="store_true",
        help="V5 only: create and immediately delete one labelled one-minute record.",
    )
    parser.add_argument(
        "--allow-v6-mutation-tests",
        action="store_true",
        help=("V6 only: create, exercise, and identity-check cleanup of one disposable project."),
    )
    parser.add_argument(
        "--allow-v6-timer-tests",
        action="store_true",
        help=("Also start/status/stop one marked timer; requires the v6 disposable mutation test."),
    )
    parser.add_argument(
        "--allow-v7-mutation-tests",
        action="store_true",
        help=(
            "V7 only: run the complete v6-compatible disposable lifecycle after requiring "
            "the v7 API/security profile."
        ),
    )
    parser.add_argument(
        "--allow-v7-timer-tests",
        action="store_true",
        help=("Also test one marked timer; requires --allow-v7-mutation-tests."),
    )
    parser.add_argument(
        "--namespace", help="Synthetic resource namespace (a version-specific default is used)."
    )
    parser.add_argument(
        "--insecure",
        action="store_true",
        help="Explicitly allow remote HTTP or disable TLS verification for a test system.",
    )
    parser.add_argument(
        "--timeout", type=float, default=30.0, help="Per-command live timeout in seconds."
    )
    parser.add_argument(
        "--min-command-spacing",
        type=float,
        default=1.0,
        help="Minimum seconds between live CLI process starts (default: %(default)s).",
    )
    parser.add_argument(
        "--min-request-spacing",
        type=float,
        default=0.5,
        help=(
            "Minimum seconds between HTTP request starts within each live CLI process "
            "(default: %(default)s)."
        ),
    )
    parser.add_argument(
        "--resume-cleanup",
        help="V6/V7 only: resume cleanup from an existing private v6-recovery.json.",
    )
    parser.add_argument(
        "--expected-recovery-marker",
        help="Exact synthetic marker required with --resume-cleanup.",
    )
    parser.add_argument(
        "--skip-local",
        action="store_true",
        help="Skip pytest, Ruff, formatting, and mypy; run only requested live checks.",
    )
    parser.add_argument(
        "--source-root",
        help="Titra CLI source directory; needed for local checks when invoked outside it.",
    )
    parser.add_argument(
        "--report-json",
        help="Atomically write a private, sanitized result summary to this existing directory.",
    )
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    token = ""
    state_directory: Path | None = None
    preserve_state = False
    owns_state_directory = False
    local_results: list[CheckResult] = []
    live_results: list[CheckResult] | None = None
    failure_result: CheckResult | None = None

    def finish(exit_code: int, outcome: str) -> int:
        if not args.report_json:
            return exit_code
        results = [*local_results, *(live_results or [])]
        if failure_result is not None:
            results.append(failure_result)
        try:
            write_sanitized_report(
                args.report_json,
                api_version=args.live_api_version if live_requested else "local",
                outcome=outcome,
                results=results,
                recovery_status=_recovery_status(state_directory),
            )
        except SelfTestError as report_error:
            print(f"ERROR: {report_error}", file=sys.stderr)
            return 1
        return exit_code

    live_requested = bool(args.live_url or args.credentials or args.profile)
    try:
        modern_mutation_tests = args.allow_v6_mutation_tests or args.allow_v7_mutation_tests
        modern_timer_tests = args.allow_v6_timer_tests or args.allow_v7_timer_tests
        if args.timeout <= 0:
            raise SelfTestError("--timeout must be greater than zero.")
        if not math.isfinite(args.min_command_spacing) or not 0 <= args.min_command_spacing <= 60:
            raise SelfTestError("--min-command-spacing must be a finite value from 0 to 60.")
        if not math.isfinite(args.min_request_spacing) or not 0 <= args.min_request_spacing <= 60:
            raise SelfTestError("--min-request-spacing must be a finite value from 0 to 60.")
        if args.resume_cleanup and not live_requested:
            raise SelfTestError("--resume-cleanup requires live server credentials.")
        if args.resume_cleanup and args.live_api_version not in {"v6", "v7"}:
            raise SelfTestError("--resume-cleanup requires --live-api-version v6 or v7.")
        if args.resume_cleanup and not args.expected_user_id:
            raise SelfTestError("--resume-cleanup requires --expected-user-id.")
        if args.resume_cleanup and not args.expected_recovery_marker:
            raise SelfTestError("--resume-cleanup requires --expected-recovery-marker.")
        if args.expected_recovery_marker and not args.resume_cleanup:
            raise SelfTestError("--expected-recovery-marker requires --resume-cleanup.")
        if args.resume_cleanup and (
            args.allow_write_tests
            or modern_mutation_tests
            or modern_timer_tests
            or args.project
            or args.record_id
            or args.namespace
        ):
            raise SelfTestError(
                "--resume-cleanup cannot be combined with new mutation, timer, resource-read, "
                "or namespace options."
            )
        if args.allow_write_tests and not live_requested:
            raise SelfTestError("--allow-write-tests requires --live-url or a credential profile.")
        if args.allow_write_tests and not args.project:
            raise SelfTestError("Write tests require an explicit --project.")
        if args.allow_write_tests and args.live_api_version != "v5":
            raise SelfTestError("--allow-write-tests is only valid with --live-api-version v5.")
        if args.allow_v6_mutation_tests and not live_requested:
            raise SelfTestError("--allow-v6-mutation-tests requires live server credentials.")
        if args.allow_v6_mutation_tests and args.live_api_version != "v6":
            raise SelfTestError("--allow-v6-mutation-tests requires --live-api-version v6.")
        if args.allow_v6_mutation_tests and not args.expected_user_id:
            raise SelfTestError("--allow-v6-mutation-tests requires --expected-user-id.")
        if args.expected_user_id is not None and (
            not args.expected_user_id.strip()
            or args.expected_user_id != args.expected_user_id.strip()
        ):
            raise SelfTestError("--expected-user-id must be a nonempty ID without outer spaces.")
        if args.allow_v6_timer_tests and not args.allow_v6_mutation_tests:
            raise SelfTestError("--allow-v6-timer-tests requires --allow-v6-mutation-tests.")
        if args.allow_v7_mutation_tests and args.live_api_version != "v7":
            raise SelfTestError("--allow-v7-mutation-tests requires --live-api-version v7.")
        if args.allow_v7_mutation_tests and not live_requested:
            raise SelfTestError("--allow-v7-mutation-tests requires live server credentials.")
        if args.allow_v7_mutation_tests and not args.expected_user_id:
            raise SelfTestError("--allow-v7-mutation-tests requires --expected-user-id.")
        if args.allow_v7_timer_tests and not args.allow_v7_mutation_tests:
            raise SelfTestError("--allow-v7-timer-tests requires --allow-v7-mutation-tests.")
        if args.allow_v7_timer_tests and args.live_api_version != "v7":
            raise SelfTestError("--allow-v7-timer-tests requires --live-api-version v7.")
        if args.allow_v6_mutation_tests and args.allow_v7_mutation_tests:
            raise SelfTestError("Select only one modern live mutation-test mode.")
        if args.allow_v6_timer_tests and args.allow_v7_timer_tests:
            raise SelfTestError("Select only one modern live timer-test mode.")
        if args.allow_write_tests and modern_mutation_tests:
            raise SelfTestError("Select only one live mutation-test mode.")
        root = project_root(args.source_root)
        if not args.skip_local:
            if not _is_source_root(root):
                raise SelfTestError(
                    "Local checks require the Titra CLI source checkout. Run from that directory "
                    "or supply --source-root; installed live-only checks use --skip-local."
                )
            local_environment = without_test_credentials(os.environ, secret_variable=args.token_env)
            local_results.extend(
                run_local_checks(
                    python=sys.executable,
                    root=root,
                    environment=local_environment,
                )
            )
        if not live_requested:
            print("All requested local checks passed.")
            return finish(0, "passed")

        connection = resolve_live_connection(
            live_url=args.live_url,
            token_env=args.token_env,
            credentials=args.credentials,
            profile=args.profile,
            expected_username=args.expected_username,
            insecure=args.insecure,
            timeout=args.timeout,
            environment=os.environ,
            cwd=Path.cwd(),
            home=Path.home(),
            allow_prompt=not args.no_token_prompt and sys.stdin.isatty(),
        )
        token = connection.api_token
        recovery_manifest: RecoveryManifest | None = None
        if args.resume_cleanup:
            recovery_path = Path(args.resume_cleanup).expanduser().absolute()
            state_directory = recovery_path.parent
            recovery_manifest = RecoveryManifest.load_for_cleanup(
                recovery_path,
                server=connection.server,
                owner_id=args.expected_user_id,
                expected_marker=args.expected_recovery_marker,
            )
        else:
            state_directory = Path(
                tempfile.mkdtemp(prefix=f"titra-cli-{args.live_api_version}-test-")
            )
            owns_state_directory = True
        environment = build_cli_environment(
            os.environ,
            server=connection.server,
            api_token=token,
            state_directory=state_directory,
            expected_username=connection.expected_username,
            profile=connection.profile,
            secret_variable=args.token_env,
            minimum_request_spacing=args.min_request_spacing,
        )
        invoker = CliInvoker(
            python=sys.executable,
            environment=environment,
            project_root=root,
            api_token=token,
            timeout=args.timeout,
            insecure=args.insecure,
            minimum_spacing=args.min_command_spacing,
        )
        namespace = args.namespace or f"titra-cli-{args.live_api_version}-test"
        if args.live_api_version == "v5":
            v5_suite = LiveV5Suite(invoker, namespace=namespace, reporter=_print_result)
            live_results = v5_suite.results
            _results, resolved_project = v5_suite.run_read_only(
                project=args.project, record_id=args.record_id
            )
            if args.allow_write_tests:
                if not resolved_project:
                    raise SelfTestError("The selected write-test project could not be resolved.")
                v5_suite.run_write(project_id=resolved_project)
        else:
            v6_suite = LiveV6Suite(
                invoker,
                namespace=namespace,
                state_directory=state_directory,
                server=connection.server,
                expected_user_id=args.expected_user_id,
                release_profile=args.live_api_version,
                reporter=_print_result,
            )
            live_results = v6_suite.results
            v6_suite.run_read_only(project=args.project, record_id=args.record_id)
            if recovery_manifest is not None:
                v6_suite.resume_disposable_cleanup(
                    recovery_manifest,
                    expected_marker=args.expected_recovery_marker,
                )
            elif modern_mutation_tests:
                v6_suite.run_disposable_mutations(include_timer=modern_timer_tests)
        print("All requested Titra CLI checks passed.")
        return finish(0, "passed")
    except KeyboardInterrupt:
        preserve_state = _should_preserve_state(
            state_directory,
            v5_write=args.allow_write_tests,
        )
        print("Interrupted; synthetic-resource cleanup was attempted.", file=sys.stderr)
        if preserve_state:
            print(f"Private test recovery state retained at: {state_directory}", file=sys.stderr)
        failure_result = CheckResult("test run", "FAIL", "interrupted; see private state")
        return finish(130, "interrupted")
    except SelfTestError as exc:
        preserve_state = _should_preserve_state(
            state_directory,
            v5_write=args.allow_write_tests,
        )
        print(f"ERROR: {redact_secrets(str(exc), [token])}", file=sys.stderr)
        if preserve_state:
            print(f"Private test recovery state retained at: {state_directory}", file=sys.stderr)
        failure_result = CheckResult("test run", "FAIL", "see stderr and private state")
        return finish(1, "failed")
    except Exception as exc:
        preserve_state = _should_preserve_state(
            state_directory,
            v5_write=args.allow_write_tests,
        )
        diagnostic = redact_secrets(str(exc), [token]).strip()
        suffix = f": {diagnostic}" if diagnostic else ""
        print(
            f"ERROR: unexpected self-test failure ({type(exc).__name__}){suffix}",
            file=sys.stderr,
        )
        if preserve_state:
            print(f"Private test recovery state retained at: {state_directory}", file=sys.stderr)
        failure_result = CheckResult(
            "test run", "FAIL", "unexpected failure; see stderr and private state"
        )
        return finish(1, "failed")
    finally:
        token = ""
        if state_directory is not None and owns_state_directory and not preserve_state:
            shutil.rmtree(state_directory, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
