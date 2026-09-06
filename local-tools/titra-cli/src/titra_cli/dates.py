"""Calendar-date rules, range shortcuts, legacy fallback, and timer splitting."""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass
from datetime import UTC, date, datetime, time, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from .errors import ConfigurationError


@dataclass(frozen=True, slots=True)
class DateRange:
    start: date
    end: date

    def __post_init__(self) -> None:
        if self.start > self.end:
            raise ConfigurationError("The start date must not be after the end date.")

    def as_dict(self) -> dict[str, str]:
        return {"from": self.start.isoformat(), "to": self.end.isoformat()}


@dataclass(frozen=True, slots=True)
class TimerSegment:
    calendar_date: date
    start_time: time
    seconds: int


def parse_date(value: str) -> date:
    try:
        parsed = date.fromisoformat(value)
    except ValueError as exc:
        raise ConfigurationError(f"Invalid date {value!r}; expected YYYY-MM-DD.") from exc
    if parsed.isoformat() != value:
        raise ConfigurationError(f"Invalid date {value!r}; expected YYYY-MM-DD.")
    return parsed


def parse_month(value: str) -> DateRange:
    try:
        first = date.fromisoformat(f"{value}-01")
    except ValueError as exc:
        raise ConfigurationError(f"Invalid calendar month {value!r}; expected YYYY-MM.") from exc
    if first.month == 12:
        following = date(first.year + 1, 1, 1)
    else:
        following = date(first.year, first.month + 1, 1)
    return DateRange(first, following - timedelta(days=1))


def current_month(day: date) -> DateRange:
    return parse_month(day.strftime("%Y-%m"))


def current_week(day: date) -> DateRange:
    start = day - timedelta(days=day.weekday())
    return DateRange(start, start + timedelta(days=6))


def choose_date_range(
    *,
    from_date: str | None,
    to_date: str | None,
    today: bool,
    week: bool,
    month: bool,
    calendar_month: str | None,
    now: date | None = None,
) -> DateRange:
    day = date.today() if now is None else now
    shortcuts = sum(bool(value) for value in (today, week, month, calendar_month))
    explicit = from_date is not None or to_date is not None
    if shortcuts + int(explicit) > 1:
        raise ConfigurationError(
            "Use only one of --from/--to, --today, --week, --month, or --calendar-month."
        )
    if today:
        return DateRange(day, day)
    if week:
        return current_week(day)
    if month:
        return current_month(day)
    if calendar_month:
        return parse_month(calendar_month)
    if explicit:
        start = parse_date(from_date) if from_date else parse_date(to_date or "")
        end = parse_date(to_date) if to_date else start
        return DateRange(start, end)
    return current_month(day)


def chunk_date_range(value: DateRange, *, days: int = 90) -> list[DateRange]:
    if days <= 0:
        raise ConfigurationError("Date-range chunk size must be positive.")
    chunks: list[DateRange] = []
    cursor = value.start
    while cursor <= value.end:
        chunk_end = min(cursor + timedelta(days=days - 1), value.end)
        chunks.append(DateRange(cursor, chunk_end))
        cursor = chunk_end + timedelta(days=1)
    return chunks


def parse_timestamp(value: str) -> datetime:
    normalized = value.strip()
    if normalized.endswith("Z"):
        normalized = f"{normalized[:-1]}+00:00"
    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError as exc:
        raise ConfigurationError(f"Invalid timestamp: {value!r}") from exc
    if parsed.tzinfo is None:
        raise ConfigurationError(f"Timestamp has no UTC offset: {value!r}")
    return parsed


def entry_calendar_date(entry: dict[str, Any], timezone_name: str) -> tuple[date, bool]:
    canonical = entry.get("dateOnly")
    if isinstance(canonical, str):
        try:
            return parse_date(canonical), False
        except ConfigurationError:
            pass
    stored = entry.get("date")
    if not isinstance(stored, str):
        raise ConfigurationError(f"Time entry {entry.get('_id', '<unknown>')} has no usable date.")
    # Legacy combined timestamps have no trustworthy originating timezone. Preserve
    # their stored UTC calendar date so reporting does not silently move old work.
    parsed = parse_timestamp(stored).astimezone(UTC)
    return parsed.date(), True


def _subtract_intervals(
    start: datetime, end: datetime, pauses: Iterable[tuple[datetime, datetime]]
) -> int:
    total = (end.astimezone(UTC) - start.astimezone(UTC)).total_seconds()
    for pause_start, pause_end in pauses:
        overlap_start = max(start.astimezone(UTC), pause_start.astimezone(UTC))
        overlap_end = min(end.astimezone(UTC), pause_end.astimezone(UTC))
        if overlap_end > overlap_start:
            total -= (overlap_end - overlap_start).total_seconds()
    return max(0, round(total))


def split_timer_by_local_day(
    *,
    started_at: datetime,
    stopped_at: datetime,
    timezone_name: str,
    pauses: Iterable[tuple[datetime, datetime]] = (),
) -> list[TimerSegment]:
    if started_at.tzinfo is None or stopped_at.tzinfo is None:
        raise ConfigurationError("Timer timestamps must include a UTC offset.")
    if stopped_at <= started_at:
        raise ConfigurationError("Timer stop must be after timer start.")
    zone = ZoneInfo(timezone_name)
    local_start = started_at.astimezone(zone)
    local_stop = stopped_at.astimezone(zone)
    parsed_pauses = list(pauses)
    segments: list[TimerSegment] = []
    cursor = local_start
    while cursor.date() < local_stop.date():
        boundary = datetime.combine(cursor.date() + timedelta(days=1), time.min, tzinfo=zone)
        seconds = _subtract_intervals(cursor, boundary, parsed_pauses)
        if seconds:
            segments.append(
                TimerSegment(cursor.date(), cursor.time().replace(tzinfo=None), seconds)
            )
        cursor = boundary
    seconds = _subtract_intervals(cursor, local_stop, parsed_pauses)
    if seconds:
        segments.append(TimerSegment(cursor.date(), cursor.time().replace(tzinfo=None), seconds))
    return segments


def apply_break_to_segments(segments: list[TimerSegment], break_seconds: int) -> list[TimerSegment]:
    if break_seconds < 0:
        raise ConfigurationError("Break duration cannot be negative.")
    remaining = break_seconds
    result = list(segments)
    for index in range(len(result) - 1, -1, -1):
        segment = result[index]
        deduction = min(segment.seconds, remaining)
        remaining -= deduction
        kept = segment.seconds - deduction
        if kept:
            result[index] = TimerSegment(segment.calendar_date, segment.start_time, kept)
        else:
            result.pop(index)
        if not remaining:
            break
    if remaining:
        raise ConfigurationError("Break duration is not shorter than the tracked duration.")
    return result
