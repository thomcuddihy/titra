"""Typed errors and stable process exit codes."""

from __future__ import annotations

from dataclasses import dataclass
from enum import IntEnum
from typing import Any


class ExitCode(IntEnum):
    OK = 0
    USAGE = 2
    AUTH = 3
    NOT_FOUND_OR_CONFLICT = 4
    REMOTE = 5
    OUTCOME_UNKNOWN = 6
    PARTIAL = 7
    INTERRUPTED = 130


@dataclass(slots=True)
class TitraCliError(Exception):
    message: str
    exit_code: ExitCode = ExitCode.USAGE
    details: Any = None

    def __str__(self) -> str:
        return self.message


class ConfigurationError(TitraCliError):
    pass


class CredentialSecurityError(ConfigurationError):
    pass


class AuthenticationError(TitraCliError):
    def __init__(self, message: str, details: Any = None) -> None:
        super().__init__(message, ExitCode.AUTH, details)


class ActionVerificationRequiredError(AuthenticationError):
    """The credential is valid, but v7 has suspended ordinary API access."""


class RateLimitError(TitraCliError):
    """A definite HTTP 429 rejection with a validated retry delay, when supplied."""

    def __init__(
        self, message: str, retry_after_seconds: int | None = None, details: Any = None
    ) -> None:
        super().__init__(message, ExitCode.REMOTE, details)
        self.retry_after_seconds = retry_after_seconds


class NotFoundError(TitraCliError):
    def __init__(self, message: str, details: Any = None) -> None:
        super().__init__(message, ExitCode.NOT_FOUND_OR_CONFLICT, details)


class ConflictError(NotFoundError):
    pass


class RemoteApiError(TitraCliError):
    def __init__(self, message: str, details: Any = None) -> None:
        super().__init__(message, ExitCode.REMOTE, details)


class WriteRejectedError(RemoteApiError):
    """An explicit server rejection of a guarded task-only write."""


class OutcomeUnknownError(TitraCliError):
    def __init__(self, message: str, details: Any = None) -> None:
        super().__init__(message, ExitCode.OUTCOME_UNKNOWN, details)


class PartialResultError(TitraCliError):
    def __init__(self, message: str, details: Any = None) -> None:
        super().__init__(message, ExitCode.PARTIAL, details)
