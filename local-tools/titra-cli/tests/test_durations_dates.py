from __future__ import annotations

from datetime import UTC, date, datetime

import pytest

from titra_cli.dates import (
    DateRange,
    apply_break_to_segments,
    choose_date_range,
    chunk_date_range,
    entry_calendar_date,
    parse_date,
    parse_month,
    parse_timestamp,
    split_timer_by_local_day,
)
from titra_cli.durations import (
    format_duration,
    hours_to_seconds,
    parse_duration,
    seconds_to_hours,
)
from titra_cli.errors import ConfigurationError


@pytest.mark.parametrize(
    ("text", "seconds"),
    [
        ("1h30m", 5400),
        ("1.5 hours", 5400),
        ("90m", 5400),
        ("01:30", 5400),
        ("01:30:05", 5405),
        ("45 sec", 45),
        ("1h 2m 3s", 3723),
        ("0.5s", 1),
    ],
)
def test_parse_duration_valid(text: str, seconds: int) -> None:
    assert parse_duration(text) == seconds


@pytest.mark.parametrize("text", ["", "90", "1 hour nonsense", "-1h", "1:75", "0s", "nan h"])
def test_parse_duration_rejects_ambiguous_or_nonpositive_values(text: str) -> None:
    with pytest.raises(ConfigurationError):
        parse_duration(text)


def test_duration_conversions_are_stable() -> None:
    assert seconds_to_hours(5400) == 1.5
    assert hours_to_seconds(1.5) == 5400
    assert hours_to_seconds(0.0003) == 1
    assert format_duration(3723) == "01:02:03"
    assert format_duration(-60, include_seconds=False) == "-00:01"
    with pytest.raises(ConfigurationError):
        seconds_to_hours(-1)
    with pytest.raises(ConfigurationError):
        hours_to_seconds(0)


@pytest.mark.parametrize("value", ["2026-8-01", "2026-02-30", "not-a-date"])
def test_parse_date_is_strict(value: str) -> None:
    with pytest.raises(ConfigurationError):
        parse_date(value)


def test_month_and_range_shortcuts() -> None:
    assert parse_month("2024-02") == DateRange(date(2024, 2, 1), date(2024, 2, 29))
    now = date(2026, 8, 30)
    assert choose_date_range(
        from_date=None,
        to_date=None,
        today=True,
        week=False,
        month=False,
        calendar_month=None,
        now=now,
    ) == DateRange(now, now)
    assert choose_date_range(
        from_date=None,
        to_date=None,
        today=False,
        week=True,
        month=False,
        calendar_month=None,
        now=now,
    ) == DateRange(date(2026, 8, 24), date(2026, 8, 30))
    assert choose_date_range(
        from_date=None,
        to_date=None,
        today=False,
        week=False,
        month=False,
        calendar_month=None,
        now=now,
    ) == DateRange(date(2026, 8, 1), date(2026, 8, 31))


def test_range_shortcuts_are_mutually_exclusive() -> None:
    with pytest.raises(ConfigurationError):
        choose_date_range(
            from_date="2026-01-01",
            to_date=None,
            today=True,
            week=False,
            month=False,
            calendar_month=None,
        )
    with pytest.raises(ConfigurationError):
        DateRange(date(2026, 2, 1), date(2026, 1, 1))


def test_chunk_date_range_is_inclusive_and_nonoverlapping() -> None:
    chunks = chunk_date_range(DateRange(date(2026, 1, 1), date(2026, 7, 20)), days=90)
    assert chunks == [
        DateRange(date(2026, 1, 1), date(2026, 3, 31)),
        DateRange(date(2026, 4, 1), date(2026, 6, 29)),
        DateRange(date(2026, 6, 30), date(2026, 7, 20)),
    ]


def test_canonical_date_wins_over_timestamp() -> None:
    day, legacy = entry_calendar_date(
        {"dateOnly": "2026-08-30", "date": "1999-01-01T23:00:00Z"},
        "Australia/Brisbane",
    )
    assert day == date(2026, 8, 30)
    assert legacy is False


def test_legacy_date_preserves_stored_utc_day_instead_of_transforming() -> None:
    day, legacy = entry_calendar_date({"date": "2026-08-30T23:30:00Z"}, "Australia/Brisbane")
    assert day == date(2026, 8, 30)
    assert legacy is True


def test_timestamp_requires_offset() -> None:
    assert parse_timestamp("2026-01-01T00:00:00Z").tzinfo is not None
    with pytest.raises(ConfigurationError):
        parse_timestamp("2026-01-01T00:00:00")


def test_timer_split_at_brisbane_midnight() -> None:
    segments = split_timer_by_local_day(
        started_at=datetime(2026, 8, 30, 13, 30, tzinfo=UTC),  # 23:30 Brisbane
        stopped_at=datetime(2026, 8, 30, 15, 30, tzinfo=UTC),  # 01:30 Brisbane
        timezone_name="Australia/Brisbane",
    )
    assert [(item.calendar_date, item.seconds) for item in segments] == [
        (date(2026, 8, 30), 1800),
        (date(2026, 8, 31), 5400),
    ]
    assert segments[0].start_time.isoformat(timespec="minutes") == "23:30"
    assert segments[1].start_time.isoformat(timespec="minutes") == "00:00"


def test_timer_split_subtracts_pause_by_overlap_and_break_from_end() -> None:
    start = datetime(2026, 8, 30, 13, 30, tzinfo=UTC)
    stop = datetime(2026, 8, 30, 15, 30, tzinfo=UTC)
    segments = split_timer_by_local_day(
        started_at=start,
        stopped_at=stop,
        timezone_name="Australia/Brisbane",
        pauses=[
            (
                datetime(2026, 8, 30, 13, 45, tzinfo=UTC),
                datetime(2026, 8, 30, 14, 15, tzinfo=UTC),
            )
        ],
    )
    assert sum(item.seconds for item in segments) == 5400
    adjusted = apply_break_to_segments(segments, 900)
    assert sum(item.seconds for item in adjusted) == 4500
    with pytest.raises(ConfigurationError):
        apply_break_to_segments(segments, 5401)


def test_timer_duration_is_absolute_across_dst_fall_back() -> None:
    # In New York, 01:30 occurs twice; offsets make the elapsed duration unambiguous.
    segments = split_timer_by_local_day(
        started_at=datetime.fromisoformat("2026-11-01T01:30:00-04:00"),
        stopped_at=datetime.fromisoformat("2026-11-01T01:30:00-05:00"),
        timezone_name="America/New_York",
    )
    assert sum(item.seconds for item in segments) == 3600
