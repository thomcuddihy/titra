"""Strict duration parsing and display helpers."""

from __future__ import annotations

import re
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation

from .errors import ConfigurationError

_TOKEN_PATTERN = re.compile(
    r"(?P<value>\d+(?:\.\d+)?)\s*(?P<unit>hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)",
    re.IGNORECASE,
)
_CLOCK_PATTERN = re.compile(r"^(?P<hours>\d+):(?P<minutes>[0-5]\d)(?::(?P<seconds>[0-5]\d))?$")
_UNIT_SECONDS = {
    "h": Decimal(3600),
    "hr": Decimal(3600),
    "hrs": Decimal(3600),
    "hour": Decimal(3600),
    "hours": Decimal(3600),
    "m": Decimal(60),
    "min": Decimal(60),
    "mins": Decimal(60),
    "minute": Decimal(60),
    "minutes": Decimal(60),
    "s": Decimal(1),
    "sec": Decimal(1),
    "secs": Decimal(1),
    "second": Decimal(1),
    "seconds": Decimal(1),
}


def parse_duration(value: str, *, allow_zero: bool = False) -> int:
    """Parse `1h 20m`, `90m`, `1.5h`, or `01:30:00` into whole seconds."""

    text = value.strip()
    if not text:
        raise ConfigurationError("Duration cannot be empty.")
    clock_match = _CLOCK_PATTERN.fullmatch(text)
    if clock_match:
        seconds = (
            int(clock_match.group("hours")) * 3600
            + int(clock_match.group("minutes")) * 60
            + int(clock_match.group("seconds") or 0)
        )
    else:
        position = 0
        total = Decimal(0)
        matched = False
        for match in _TOKEN_PATTERN.finditer(text):
            if text[position : match.start()].strip():
                raise ConfigurationError(f"Invalid duration: {value!r}")
            matched = True
            try:
                amount = Decimal(match.group("value"))
            except InvalidOperation as exc:
                raise ConfigurationError(f"Invalid duration: {value!r}") from exc
            total += amount * _UNIT_SECONDS[match.group("unit").lower()]
            position = match.end()
        if not matched or text[position:].strip():
            raise ConfigurationError(
                f"Invalid duration {value!r}; use forms such as 1h30m, 90m, or 01:30:00."
            )
        seconds = int(total.quantize(Decimal(1), rounding=ROUND_HALF_UP))
    if seconds < 0 or (seconds == 0 and not allow_zero):
        raise ConfigurationError("Duration must be greater than zero.")
    return seconds


def seconds_to_hours(seconds: int) -> float:
    if seconds < 0:
        raise ConfigurationError("Duration cannot be negative.")
    hours = (Decimal(seconds) / Decimal(3600)).quantize(Decimal("0.000001"))
    return float(hours)


def hours_to_seconds(hours: float) -> int:
    try:
        value = Decimal(str(hours))
    except InvalidOperation as exc:
        raise ConfigurationError("Hours must be numeric.") from exc
    if not value.is_finite() or value <= 0:
        raise ConfigurationError("Hours must be greater than zero.")
    return int((value * Decimal(3600)).quantize(Decimal(1), rounding=ROUND_HALF_UP))


def format_duration(seconds: int, *, include_seconds: bool = True) -> str:
    sign = "-" if seconds < 0 else ""
    remaining = abs(int(seconds))
    hours, remaining = divmod(remaining, 3600)
    minutes, secs = divmod(remaining, 60)
    if include_seconds or secs:
        return f"{sign}{hours:02d}:{minutes:02d}:{secs:02d}"
    return f"{sign}{hours:02d}:{minutes:02d}"
