"""Reusable project selection, record retrieval, and report preparation."""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass
from typing import Any

from .api import TitraClient
from .dates import DateRange, entry_calendar_date
from .errors import ConfigurationError, ConflictError, NotFoundError
from .models import ResolvedConfig
from .reporting import NormalizedEntry, normalize_entries


def project_name(project: dict[str, Any]) -> str:
    return str(project.get("name") or project.get("_id") or "unnamed")


def resolve_project(projects: Iterable[dict[str, Any]], reference: str) -> dict[str, Any]:
    values = list(projects)
    exact_id = [value for value in values if str(value.get("_id")) == reference]
    if exact_id:
        return exact_id[0]
    exact_name = [
        value for value in values if project_name(value).casefold() == reference.casefold()
    ]
    if len(exact_name) == 1:
        return exact_name[0]
    if len(exact_name) > 1:
        raise ConflictError(f"More than one project is named {reference!r}; use its exact ID.")
    prefix = [value for value in values if str(value.get("_id", "")).startswith(reference)]
    if len(prefix) == 1:
        return prefix[0]
    if len(prefix) > 1:
        raise ConflictError(f"Project ID prefix {reference!r} is ambiguous.")
    raise NotFoundError(f"Project not found: {reference}")


def project_rows(projects: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    rows = [
        {
            "id": str(project.get("_id") or ""),
            "name": project_name(project),
            "customer": str(project.get("customer") or ""),
            "archived": bool(project.get("archived", False)),
            "public": bool(project.get("public", False)),
            "rate": project.get("rate", ""),
            "budget": project.get("budget", ""),
        }
        for project in projects
    ]
    return sorted(rows, key=lambda row: (row["archived"], row["name"].casefold(), row["id"]))


def _resolve_users(user_map: dict[str, str], references: Iterable[str]) -> set[str]:
    selected: set[str] = set()
    for reference in references:
        if reference in user_map:
            selected.add(reference)
            continue
        exact = [
            user_id for user_id, name in user_map.items() if name.casefold() == reference.casefold()
        ]
        if len(exact) == 1:
            selected.add(exact[0])
        elif len(exact) > 1:
            raise ConflictError(f"User name {reference!r} is ambiguous; use an exact user ID.")
        else:
            raise NotFoundError(f"User not found in report data: {reference}")
    return selected


@dataclass(slots=True)
class ReportDataset:
    raw_entries: list[dict[str, Any]]
    entries: list[NormalizedEntry]
    projects: dict[str, dict[str, Any]]
    users: dict[str, str]
    malformed: list[dict[str, Any]]
    fetch_meta: dict[str, Any]


def fetch_report_dataset(
    client: TitraClient,
    config: ResolvedConfig,
    value: DateRange,
    *,
    project_references: Iterable[str] = (),
    user_references: Iterable[str] = (),
    team: bool = False,
    page_size: int = 200,
) -> ReportDataset:
    all_projects = client.list_projects()
    project_map = {str(project.get("_id")): project for project in all_projects}
    selected_projects = [resolve_project(all_projects, ref) for ref in project_references]
    selected_ids = {str(project.get("_id")) for project in selected_projects}
    users: dict[str, str] = {}
    fetch_meta: dict[str, Any] = {
        "complete": True,
        "consistency": "not-fetched",
        "duplicates": 0,
        "pages": 0,
    }

    if team:
        if not selected_projects:
            raise ConfigurationError("Team reports require at least one --project filter.")
        raw_entries = []
        seen: set[str] = set()
        for project in selected_projects:
            project_id = str(project.get("_id"))
            for entry in client.list_project_time_entries(project_id, value, page_size=page_size):
                record_id = str(entry.get("_id") or "")
                if record_id and record_id in seen:
                    continue
                if record_id:
                    seen.add(record_id)
                raw_entries.append(entry)
            current_meta = getattr(
                client,
                "last_timeentry_fetch",
                {
                    "complete": None,
                    "consistency": "legacy-array-unverified",
                    "duplicates": 0,
                    "pages": 1,
                },
            )
            fetch_meta["pages"] += int(current_meta.get("pages", 0))
            fetch_meta["duplicates"] += int(current_meta.get("duplicates", 0))
            if current_meta.get("complete") is not True:
                fetch_meta["complete"] = current_meta.get("complete")
            fetch_meta["consistency"] = current_meta.get("consistency", "unknown")
            for user in client.project_users(project_id):
                user_id = str(user.get("_id") or "")
                if user_id:
                    users[user_id] = str(user.get("name") or user_id)
    else:
        raw_entries = client.list_own_time_entries(value, page_size=page_size)
        fetch_meta = dict(
            getattr(
                client,
                "last_timeentry_fetch",
                {
                    "complete": None,
                    "consistency": "legacy-array-unverified",
                    "duplicates": 0,
                    "pages": 1,
                },
            )
        )
        if selected_ids:
            raw_entries = [
                entry for entry in raw_entries if str(entry.get("projectId")) in selected_ids
            ]
        try:
            current = client.current_user()
        except NotFoundError:
            current = {}
        current_id = str(current.get("_id") or "")
        if current_id:
            users[current_id] = str(current.get("name") or current_id)

    if user_references:
        selected_users = _resolve_users(users, user_references)
        raw_entries = [entry for entry in raw_entries if str(entry.get("userId")) in selected_users]

    normalized: list[NormalizedEntry] = []
    malformed: list[dict[str, Any]] = []
    for entry in raw_entries:
        try:
            normalized.extend(
                normalize_entries(
                    [entry], timezone=config.timezone, projects=project_map, users=users
                )
            )
        except ConfigurationError as exc:
            malformed.append({"id": entry.get("_id"), "error": str(exc)})
    return ReportDataset(raw_entries, normalized, project_map, users, malformed, fetch_meta)


def record_rows(dataset: ReportDataset) -> list[dict[str, Any]]:
    rows = [
        {
            "date": entry.day.isoformat(),
            "start": entry.start_time or "",
            "hours": float(entry.hours),
            "project": entry.project,
            "task": entry.task,
            "user": entry.user,
            "legacy": entry.legacy_date,
            "id": entry.record_id,
        }
        for entry in dataset.entries
    ]
    return sorted(rows, key=lambda row: (row["date"], row["start"], row["id"]), reverse=True)


def record_preview(
    entry: dict[str, Any], *, config: ResolvedConfig, projects: dict[str, dict[str, Any]]
) -> dict[str, Any]:
    day, legacy = entry_calendar_date(entry, config.timezone)
    project_id = str(entry.get("projectId") or "")
    return {
        "id": str(entry.get("_id") or ""),
        "date": day.isoformat(),
        "start": entry.get("startTime") or "",
        "hours": entry.get("hours"),
        "project": project_name(projects.get(project_id, {"_id": project_id})),
        "task": entry.get("task") or "",
        "legacy": legacy,
        "revision": entry.get("dateRevision", "legacy"),
    }
