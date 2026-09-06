from __future__ import annotations

from datetime import date
from typing import Any

import pytest

from titra_cli.dates import DateRange
from titra_cli.errors import ConfigurationError, ConflictError, NotFoundError
from titra_cli.models import ResolvedConfig
from titra_cli.reporting import (
    calendar_rows,
    normalize_entries,
    report_meta,
    summary_rows,
    timesheet_rows,
    validate_groupings,
)
from titra_cli.services import (
    fetch_report_dataset,
    project_rows,
    record_rows,
    resolve_project,
)


def config() -> ResolvedConfig:
    return ResolvedConfig(
        profile="test",
        server="https://titra.example",
        api_key="secret",
        username="Alice",
        timezone="Australia/Brisbane",
    )


def sample_entries() -> list[dict[str, Any]]:
    return [
        {
            "_id": "r1",
            "userId": "u1",
            "projectId": "p1",
            "date": "2026-08-30T00:00:00Z",
            "dateOnly": "2026-08-30",
            "startTime": "09:00",
            "hours": 1.1,
            "task": "Build",
            "taskRate": 100,
        },
        {
            "_id": "r2",
            "userId": "u1",
            "projectId": "p1",
            "date": "2026-08-31T00:00:00Z",
            "dateOnly": "2026-08-31",
            "hours": 2.2,
            "task": "Build",
        },
        {
            "_id": "r3",
            "userId": "u2",
            "projectId": "p2",
            "date": "2026-09-01T23:00:00Z",
            "hours": 0.7,
            "task": "Review",
        },
    ]


def test_normalization_and_decimal_summary() -> None:
    entries = normalize_entries(
        sample_entries(),
        timezone="Australia/Brisbane",
        projects={"p1": {"name": "Alpha", "rate": 50}, "p2": {"name": "Beta"}},
        users={"u1": "Alice", "u2": "Bob"},
    )
    rows = summary_rows(entries, ["user", "project"])
    assert rows == [
        {
            "user": "Alice",
            "project": "Alpha",
            "entries": 2,
            "hours": 3.3,
            "average_hours": 1.65,
            "billable_value": 220.0,
            "legacy_records": 0,
        },
        {
            "user": "Bob",
            "project": "Beta",
            "entries": 1,
            "hours": 0.7,
            "average_hours": 0.7,
            "billable_value": 0.0,
            "legacy_records": 1,
        },
    ]
    assert report_meta(entries) == {"entries": 3, "hours": 4.0, "legacy_records": 1}


def test_timesheet_latest_first_and_calendar_totals() -> None:
    entries = normalize_entries(
        sample_entries(),
        timezone="Australia/Brisbane",
        projects={"p1": {"name": "Alpha"}, "p2": {"name": "Beta"}},
    )
    timesheet = timesheet_rows(entries)
    assert [row["id"] for row in timesheet] == ["r3", "r2", "r1"]
    calendar = calendar_rows(entries)
    assert [row["date"] for row in calendar] == ["2026-09-01", "2026-08-31", "2026-08-30"]


def test_grouping_validation_supports_repeated_and_comma_separated() -> None:
    assert validate_groupings(["user,project", "month", "project"]) == (
        "user",
        "project",
        "month",
    )
    assert validate_groupings([]) == ("project",)
    with pytest.raises(ConfigurationError):
        validate_groupings(["customer"])


def test_project_resolution_is_never_ambiguously_fuzzy() -> None:
    projects = [
        {"_id": "alpha-123", "name": "Same"},
        {"_id": "alpha-456", "name": "Same"},
        {"_id": "beta-789", "name": "Unique"},
    ]
    assert resolve_project(projects, "beta") == projects[2]
    assert resolve_project(projects, "unique") == projects[2]
    with pytest.raises(ConflictError):
        resolve_project(projects, "alpha")
    with pytest.raises(ConflictError):
        resolve_project(projects, "same")
    with pytest.raises(NotFoundError):
        resolve_project(projects, "missing")


def test_project_rows_put_archived_last() -> None:
    rows = project_rows(
        [
            {"_id": "2", "name": "Beta", "archived": True},
            {"_id": "1", "name": "alpha"},
        ]
    )
    assert [row["id"] for row in rows] == ["1", "2"]


class FakeReportClient:
    def __init__(self) -> None:
        self.projects = [
            {"_id": "p1", "name": "Alpha", "rate": 10},
            {"_id": "p2", "name": "Beta"},
        ]

    def list_projects(self) -> list[dict[str, Any]]:
        return self.projects

    def current_user(self) -> dict[str, Any]:
        return {"_id": "u1", "name": "Alice"}

    def list_own_time_entries(
        self, _value: DateRange, *, page_size: int = 200
    ) -> list[dict[str, Any]]:
        assert 1 <= page_size <= 500
        return [*sample_entries()[:2], {"_id": "bad", "projectId": "p1", "hours": 1}]

    def list_project_time_entries(
        self, project_id: str, _value: DateRange, *, page_size: int = 200
    ) -> list[dict[str, Any]]:
        assert 1 <= page_size <= 500
        return [entry for entry in sample_entries() if entry["projectId"] == project_id]

    def project_users(self, project_id: str) -> list[dict[str, Any]]:
        return (
            [{"_id": "u1", "name": "Alice"}]
            if project_id == "p1"
            else [{"_id": "u2", "name": "Bob"}]
        )


def test_fetch_self_dataset_filters_projects_and_quarantines_malformed() -> None:
    dataset = fetch_report_dataset(
        FakeReportClient(),  # type: ignore[arg-type]
        config(),
        DateRange(date(2026, 8, 1), date(2026, 8, 31)),
        project_references=["Alpha"],
    )
    assert [entry.record_id for entry in dataset.entries] == ["r1", "r2"]
    assert dataset.malformed == [{"id": "bad", "error": "Time entry bad has no usable date."}]
    assert [row["id"] for row in record_rows(dataset)] == ["r2", "r1"]


def test_fetch_team_dataset_resolves_names_and_requires_project() -> None:
    with pytest.raises(ConfigurationError):
        fetch_report_dataset(
            FakeReportClient(),  # type: ignore[arg-type]
            config(),
            DateRange(date(2026, 8, 1), date(2026, 9, 30)),
            team=True,
        )
    dataset = fetch_report_dataset(
        FakeReportClient(),  # type: ignore[arg-type]
        config(),
        DateRange(date(2026, 8, 1), date(2026, 9, 30)),
        project_references=["p2"],
        user_references=["Bob"],
        team=True,
    )
    assert len(dataset.entries) == 1
    assert dataset.entries[0].user == "Bob"
