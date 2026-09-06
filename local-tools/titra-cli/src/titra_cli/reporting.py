"""Client-side, calendar-safe reporting and statistics."""

from __future__ import annotations

from collections import defaultdict
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import date, timedelta
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation
from typing import Any

from .dates import entry_calendar_date
from .errors import ConfigurationError

GROUP_FIELDS = {"user", "project", "task", "day", "week", "month"}


@dataclass(frozen=True, slots=True)
class NormalizedEntry:
    record_id: str
    user_id: str
    user: str
    project_id: str
    project: str
    task: str
    day: date
    hours: Decimal
    rate: Decimal | None
    legacy_date: bool
    start_time: str | None


def _decimal(value: Any, *, field: str) -> Decimal:
    try:
        parsed = Decimal(str(value))
    except (InvalidOperation, ValueError) as exc:
        raise ConfigurationError(f"Invalid {field}: {value!r}") from exc
    if not parsed.is_finite():
        raise ConfigurationError(f"Invalid {field}: {value!r}")
    return parsed


def normalize_entries(
    entries: Iterable[dict[str, Any]],
    *,
    timezone: str,
    projects: dict[str, dict[str, Any]] | None = None,
    users: dict[str, str] | None = None,
) -> list[NormalizedEntry]:
    project_map = projects or {}
    user_map = users or {}
    normalized: list[NormalizedEntry] = []
    for entry in entries:
        day, legacy = entry_calendar_date(entry, timezone)
        project_id = str(entry.get("projectId") or "")
        user_id = str(entry.get("userId") or "")
        project = project_map.get(project_id, {})
        rate_value = entry.get("taskRate")
        if rate_value is None:
            rate_value = project.get("rate")
        normalized.append(
            NormalizedEntry(
                record_id=str(entry.get("_id") or ""),
                user_id=user_id,
                user=user_map.get(user_id, user_id or "unknown"),
                project_id=project_id,
                project=str(project.get("name") or project_id or "unknown"),
                task=str(entry.get("task") or ""),
                day=day,
                hours=_decimal(entry.get("hours", 0), field="hours"),
                rate=_decimal(rate_value, field="rate") if rate_value is not None else None,
                legacy_date=legacy,
                start_time=str(entry.get("startTime")) if entry.get("startTime") else None,
            )
        )
    return normalized


def _week_label(day: date) -> str:
    start = day - timedelta(days=day.weekday())
    return start.isoformat()


def _group_value(entry: NormalizedEntry, field: str) -> str:
    if field == "user":
        return entry.user
    if field == "project":
        return entry.project
    if field == "task":
        return entry.task
    if field == "day":
        return entry.day.isoformat()
    if field == "week":
        return _week_label(entry.day)
    if field == "month":
        return entry.day.strftime("%Y-%m")
    raise ConfigurationError(f"Unsupported report grouping: {field}")


def validate_groupings(group_by: Iterable[str]) -> tuple[str, ...]:
    result: list[str] = []
    for raw in group_by:
        for field in raw.split(","):
            cleaned = field.strip().lower()
            if not cleaned:
                continue
            if cleaned not in GROUP_FIELDS:
                raise ConfigurationError(
                    f"Unknown grouping {cleaned!r}; choose from {', '.join(sorted(GROUP_FIELDS))}."
                )
            if cleaned not in result:
                result.append(cleaned)
    return tuple(result or ["project"])


def summary_rows(
    entries: Iterable[NormalizedEntry], group_by: Iterable[str]
) -> list[dict[str, Any]]:
    groupings = validate_groupings(group_by)
    buckets: dict[tuple[str, ...], list[NormalizedEntry]] = defaultdict(list)
    for entry in entries:
        buckets[tuple(_group_value(entry, field) for field in groupings)].append(entry)
    rows: list[dict[str, Any]] = []
    for key, values in buckets.items():
        total = sum((entry.hours for entry in values), Decimal(0))
        billable = sum(
            (entry.hours * entry.rate for entry in values if entry.rate is not None), Decimal(0)
        )
        row: dict[str, Any] = dict(zip(groupings, key, strict=True))
        row.update(
            {
                "entries": len(values),
                "hours": float(total.quantize(Decimal("0.000001"))),
                "average_hours": float(
                    (total / len(values)).quantize(Decimal("0.000001"), rounding=ROUND_HALF_UP)
                ),
                "billable_value": float(billable.quantize(Decimal("0.01"))),
                "legacy_records": sum(entry.legacy_date for entry in values),
            }
        )
        rows.append(row)
    return sorted(rows, key=lambda row: tuple(str(row[field]) for field in groupings))


def timesheet_rows(entries: Iterable[NormalizedEntry]) -> list[dict[str, Any]]:
    rows = [
        {
            "date": entry.day.isoformat(),
            "start": entry.start_time or "",
            "project": entry.project,
            "task": entry.task,
            "user": entry.user,
            "hours": float(entry.hours),
            "legacy_date": entry.legacy_date,
            "id": entry.record_id,
        }
        for entry in entries
    ]
    return sorted(rows, key=lambda row: (row["date"], row["start"], row["id"]), reverse=True)


def calendar_rows(entries: Iterable[NormalizedEntry]) -> list[dict[str, Any]]:
    buckets: dict[date, list[NormalizedEntry]] = defaultdict(list)
    for entry in entries:
        buckets[entry.day].append(entry)
    return [
        {
            "date": day.isoformat(),
            "entries": len(values),
            "hours": float(sum((value.hours for value in values), Decimal(0))),
            "projects": len({value.project_id for value in values}),
            "legacy_records": sum(value.legacy_date for value in values),
        }
        for day, values in sorted(buckets.items(), reverse=True)
    ]


def report_meta(entries: Iterable[NormalizedEntry]) -> dict[str, Any]:
    values = list(entries)
    return {
        "entries": len(values),
        "hours": float(sum((entry.hours for entry in values), Decimal(0))),
        "legacy_records": sum(entry.legacy_date for entry in values),
    }
