"""Stable machine output and readable terminal tables."""

from __future__ import annotations

import csv
import json
import re
import sys
from collections.abc import Iterable
from dataclasses import asdict, is_dataclass
from enum import Enum, StrEnum
from io import StringIO
from typing import Any, TextIO, cast

from rich.console import Console
from rich.table import Table

from .errors import ConfigurationError

_SECRET_KEY_NAMES = frozenset(
    {
        "authorization",
        "proxyauthorization",
        "apikey",
        "apitoken",
        "token",
        "accesstoken",
        "refreshtoken",
        "password",
        "passwd",
        "secret",
        "webhooksecret",
        "signature",
        "idempotencykey",
        "idempotencykeys",
    }
)


class OutputMode(StrEnum):
    AUTO = "auto"
    HUMAN = "human"
    JSON = "json"
    JSONL = "jsonl"
    CSV = "csv"
    TSV = "tsv"
    ID = "id"
    NONE = "none"
    SILENT = "silent"


def _json_default(value: Any) -> Any:
    if is_dataclass(value) and not isinstance(value, type):
        return asdict(cast(Any, value))
    if hasattr(value, "isoformat"):
        return value.isoformat()
    if isinstance(value, Enum):
        return value.value
    raise TypeError(f"Cannot serialize {type(value).__name__}")


def _secret_key(value: Any) -> bool:
    if not isinstance(value, str):
        return False
    normalized = "".join(character for character in value.lower() if character.isalnum())
    return normalized in _SECRET_KEY_NAMES


def _redact_text(value: str, secrets: Iterable[str]) -> str:
    redacted = value
    for secret in sorted({item for item in secrets if item}, key=len, reverse=True):
        redacted = redacted.replace(secret, "<redacted>")
    return redacted


def redact_sensitive(value: Any, secrets: Iterable[str] = ()) -> Any:
    """Copy a renderable value while removing credential keys and known exact secrets."""

    secret_values = tuple(item for item in secrets if item)
    if is_dataclass(value) and not isinstance(value, type):
        value = asdict(cast(Any, value))
    if isinstance(value, dict):
        return {
            _redact_text(str(key), secret_values): (
                "<redacted>" if _secret_key(key) else redact_sensitive(item, secret_values)
            )
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [redact_sensitive(item, secret_values) for item in value]
    if isinstance(value, tuple):
        return tuple(redact_sensitive(item, secret_values) for item in value)
    if isinstance(value, str):
        return _redact_text(value, secret_values)
    return value


def contains_secret(value: Any, secret: str) -> bool:
    """Return whether a known secret occurs anywhere in nested state, including keys."""

    if not secret:
        return False
    if is_dataclass(value) and not isinstance(value, type):
        value = asdict(cast(Any, value))
    if isinstance(value, dict):
        return any(
            secret in str(key) or contains_secret(item, secret) for key, item in value.items()
        )
    if isinstance(value, (list, tuple)):
        return any(contains_secret(item, secret) for item in value)
    return isinstance(value, str) and secret in value


def _as_rows(data: Any) -> list[dict[str, Any]]:
    if data is None:
        return []
    values = data if isinstance(data, list) else [data]
    rows: list[dict[str, Any]] = []
    for value in values:
        if is_dataclass(value) and not isinstance(value, type):
            value = asdict(cast(Any, value))
        if isinstance(value, dict):
            rows.append(value)
        else:
            rows.append({"value": value})
    return rows


def _cell(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (dict, list)):
        return json.dumps(value, ensure_ascii=False, default=_json_default, sort_keys=True)
    return str(value)


def _spreadsheet_cell(value: Any) -> str:
    rendered = _cell(value)
    if isinstance(value, str) and rendered.startswith(("=", "+", "-", "@", "\t", "\r", "\n")):
        return f"'{rendered}"
    return rendered


def _heading(value: str) -> str:
    words = value.lstrip("_").replace("_", " ")
    words = re.sub(r"(?<=[a-z0-9])(?=[A-Z])", " ", words)
    return words.title()


class Renderer:
    def __init__(
        self,
        mode: str = "auto",
        *,
        color: bool = True,
        stdout: TextIO | None = None,
        stderr: TextIO | None = None,
        secrets: Iterable[str] = (),
    ) -> None:
        try:
            selected = OutputMode(mode)
        except ValueError as exc:
            raise ConfigurationError(f"Unknown output mode: {mode}") from exc
        self.stdout = stdout or sys.stdout
        self.stderr = stderr or sys.stderr
        self._secrets = {secret for secret in secrets if secret}
        if selected is OutputMode.AUTO:
            selected = OutputMode.HUMAN if self.stdout.isatty() else OutputMode.JSON
        if selected is OutputMode.SILENT:
            selected = OutputMode.NONE
        self.mode = selected
        force_terminal = None if color else False
        self.console = Console(file=self.stdout, force_terminal=force_terminal, no_color=not color)
        self.error_console = Console(
            file=self.stderr, force_terminal=force_terminal, no_color=not color
        )

    def add_secret(self, secret: str | None) -> None:
        if secret:
            self._secrets.add(secret)

    def sanitize(self, value: Any) -> Any:
        return redact_sensitive(value, self._secrets)

    def warn(self, message: str) -> None:
        self.error_console.print(f"Warning: {self.sanitize(message)}", style="yellow")

    def status(self, message: str) -> None:
        self.error_console.print(self.sanitize(message), style="dim")

    def error(self, message: str) -> None:
        self.error_console.print(f"Error: {self.sanitize(message)}", style="bold red")

    def emit(
        self,
        data: Any,
        *,
        title: str | None = None,
        columns: list[str] | None = None,
        id_key: str = "_id",
        meta: dict[str, Any] | None = None,
    ) -> None:
        if self.mode is OutputMode.NONE:
            return
        data = self.sanitize(data)
        meta = self.sanitize(meta or {})
        title = self.sanitize(title) if title is not None else None
        rows = _as_rows(data)
        if self.mode is OutputMode.JSON:
            envelope = {"schema": "titra-cli/v1", "data": data, "meta": meta}
            print(
                json.dumps(envelope, ensure_ascii=False, default=_json_default, sort_keys=True),
                file=self.stdout,
            )
            return
        if self.mode is OutputMode.JSONL:
            for row in rows:
                print(
                    json.dumps(row, ensure_ascii=False, default=_json_default, sort_keys=True),
                    file=self.stdout,
                )
            return
        if self.mode in {OutputMode.CSV, OutputMode.TSV}:
            selected_columns = columns or list(dict.fromkeys(key for row in rows for key in row))
            buffer = StringIO()
            writer = csv.DictWriter(
                buffer,
                fieldnames=selected_columns,
                extrasaction="ignore",
                delimiter="," if self.mode is OutputMode.CSV else "\t",
                lineterminator="\n",
            )
            writer.writeheader()
            for row in rows:
                writer.writerow({key: _spreadsheet_cell(row.get(key)) for key in selected_columns})
            self.stdout.write(buffer.getvalue())
            return
        if self.mode is OutputMode.ID:
            for row in rows:
                identifier = row.get(id_key)
                if identifier is None:
                    identifier = row.get("id") or row.get("timecardId") or row.get("projectId")
                if identifier is not None:
                    print(identifier, file=self.stdout)
            return
        self._emit_human(rows, title=title, columns=columns)

    def _emit_human(
        self, rows: list[dict[str, Any]], *, title: str | None, columns: list[str] | None
    ) -> None:
        if not rows:
            self.console.print("No results.", style="dim")
            return
        if len(rows) == 1 and columns is None:
            table = Table(title=title, show_lines=False, header_style="bold")
            table.add_column("Field", no_wrap=True)
            table.add_column("Value", overflow="fold")
            for key, value in rows[0].items():
                table.add_row(_heading(key), _cell(value))
            self.console.print(table)
            return
        selected_columns = columns or list(dict.fromkeys(key for row in rows for key in row))
        table = Table(title=title, show_lines=False, header_style="bold")
        for column in selected_columns:
            table.add_column(_heading(column))
        for row in rows:
            table.add_row(*(_cell(row.get(column)) for column in selected_columns))
        self.console.print(table)
