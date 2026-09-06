"""Shared, serialization-friendly domain models."""

from __future__ import annotations

import re
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal


def _optional_nonempty_string(value: dict[str, Any], key: str) -> str | None:
    candidate = value.get(key)
    if candidate is None:
        return None
    if not isinstance(candidate, str) or not candidate:
        raise ValueError(f"{key} must be a nonempty string or null")
    return candidate


@dataclass(frozen=True, slots=True)
class ResolvedConfig:
    profile: str
    server: str
    api_key: str
    username: str | None
    timezone: str
    verify_tls: bool = True
    timeout: float = 20.0
    source_files: tuple[Path, ...] = ()

    def redacted(self) -> dict[str, Any]:
        return {
            "profile": self.profile,
            "server": self.server,
            "api_key": "<redacted>" if self.api_key else "",
            "username": self.username,
            "timezone": self.timezone,
            "verify_tls": self.verify_tls,
            "timeout": self.timeout,
            "source_files": [str(path) for path in self.source_files],
        }


@dataclass(slots=True)
class ActiveTimer:
    version: int
    profile: str
    server: str
    started_at: str
    phase: str = "running"
    owner_id: str | None = None
    project_id: str | None = None
    task: str | None = None
    timer_id: str | None = None
    paused_at: str | None = None
    pauses: list[dict[str, str]] = field(default_factory=list)

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> ActiveTimer:
        return cls(
            version=int(value.get("version", 1)),
            profile=str(value["profile"]),
            server=str(value["server"]),
            started_at=str(value["started_at"]),
            phase=str(value.get("phase", "running")),
            owner_id=_optional_nonempty_string(value, "owner_id"),
            project_id=value.get("project_id"),
            task=value.get("task"),
            timer_id=_optional_nonempty_string(value, "timer_id"),
            paused_at=value.get("paused_at"),
            pauses=list(value.get("pauses", [])),
        )

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True, slots=True)
class PendingTimerStart:
    """A v6 timer-start identity journaled before the mutating request."""

    version: int
    profile: str
    server: str
    operation_id: str
    created_at: str
    owner_id: str | None = None
    project_id: str | None = None
    task: str | None = None

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> PendingTimerStart:
        operation_id = value.get("operation_id")
        if (
            not isinstance(operation_id, str)
            or not 8 <= len(operation_id) <= 128
            or re.fullmatch(r"[A-Za-z0-9._:-]+", operation_id) is None
        ):
            raise ValueError("operation_id must be 8-128 safe ASCII characters")
        return cls(
            version=int(value.get("version", 1)),
            profile=str(value["profile"]),
            server=str(value["server"]),
            operation_id=operation_id,
            created_at=str(value["created_at"]),
            owner_id=_optional_nonempty_string(value, "owner_id"),
            project_id=value.get("project_id"),
            task=value.get("task"),
        )

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


DraftStatus = Literal[
    "pending_stop", "pending", "submitting", "outcome_unknown", "submitted", "discarded"
]


@dataclass(slots=True)
class RecordDraft:
    version: int
    draft_id: str
    profile: str
    server: str
    created_at: str
    status: DraftStatus
    payloads: list[dict[str, Any]]
    owner_id: str | None = None
    timer: dict[str, Any] | None = None
    note: str | None = None
    result_ids: list[str] = field(default_factory=list)
    idempotency_keys: list[str] = field(default_factory=list)
    first_submitted_at: str | None = None
    replay_verification: dict[str, Any] | None = None

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> RecordDraft:
        return cls(
            version=int(value.get("version", 1)),
            draft_id=str(value["draft_id"]),
            profile=str(value["profile"]),
            server=str(value["server"]),
            created_at=str(value["created_at"]),
            status=value.get("status", "pending"),
            payloads=list(value.get("payloads", [])),
            owner_id=_optional_nonempty_string(value, "owner_id"),
            timer=value.get("timer"),
            note=value.get("note"),
            result_ids=list(value.get("result_ids", [])),
            idempotency_keys=list(value.get("idempotency_keys", [])),
            first_submitted_at=_optional_nonempty_string(value, "first_submitted_at"),
            replay_verification=_optional_mapping(value, "replay_verification"),
        )

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def utc_now_iso() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


def _optional_mapping(value: dict[str, Any], key: str) -> dict[str, Any] | None:
    candidate = value.get(key)
    if candidate is None:
        return None
    if not isinstance(candidate, dict):
        raise ValueError(f"{key} must be a JSON object or null")
    return dict(candidate)
