"""Mock-only task-edit contract, journaling, CLI, and reconciliation tests."""

from __future__ import annotations

import json
from copy import deepcopy
from pathlib import Path
from typing import Any

import httpx
import pytest
from click.testing import CliRunner, Result

from titra_cli.api import TitraClient
from titra_cli.cli import cli
from titra_cli.state import StateStore

TOKEN = "secret-never-journal-this"
CAPABILITIES = {
    "apiVersion": 1,
    "features": {"timeEntryTaskUpdate": True},
    "taskUpdate": {
        "requiresIfMatch": True,
        "requiresExpectedTask": True,
        "maxTaskLength": 1000,
        "preservesOtherFields": True,
    },
}
ORIGINAL = {
    "_id": "r1",
    "userId": "u1",
    "projectId": "p1",
    "task": "Old task",
    "hours": 1.237,
    "date": "2026-07-02T00:00:00.000Z",
    "dateOnly": "2026-07-02",
    "startTime": "09:07",
    "dateRevision": 7,
    "customfields": {"nested": {"keep": [1, 2, "exact"]}},
    "taskRate": 71.123456,
}


class Server:
    def __init__(self, root: Path) -> None:
        self.root = root
        self.record = deepcopy(ORIGINAL)
        self.before = deepcopy(ORIGINAL)
        self.capabilities: Any = deepcopy(CAPABILITIES)
        self.capability_status = 200
        self.capability_html = False
        self.etag_override: str | None = "default"
        self.requests: list[httpx.Request] = []
        self.patch_requests: list[httpx.Request] = []
        self.patch_status = 200
        self.mode = "ok"
        self.user = {"_id": "u1", "name": "Alice"}
        self.project_name = "Example Project"

    def etag(self) -> str | None:
        if self.etag_override != "default":
            return self.etag_override
        return f'"titra-date-revision-{self.record.get("dateRevision", "legacy")}"'

    def response(
        self, request: httpx.Request, payload: Any, status: int = 200, *, etag: str | None = None
    ) -> httpx.Response:
        return httpx.Response(
            status,
            content=json.dumps({"statusCode": status, "message": "ok", "payload": payload}),
            headers={"ETag": etag} if etag is not None else None,
            request=request,
        )

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        path = request.url.path
        if path == "/capabilities/v2/":
            if self.capability_html:
                return httpx.Response(self.capability_status, text="<html>v5</html>")
            return self.response(request, None, 404)
        if path == "/capabilities/":
            if self.capability_html:
                return httpx.Response(self.capability_status, text="<html>v5</html>")
            return self.response(request, self.capabilities, self.capability_status)
        if path == "/user/me/":
            return self.response(request, self.user)
        if path == "/project/list/":
            return self.response(request, [{"_id": "p1", "name": self.project_name}])
        if path == "/timeentry/get/r1":
            if self.patch_requests and self.mode == "readback_failure":
                raise httpx.ReadTimeout("network lost", request=request)
            if self.patch_requests and self.mode == "missing":
                return self.response(request, None, 404)
            return self.response(request, deepcopy(self.record), etag=self.etag())
        assert path == "/timeentry/task/r1" and request.method == "PATCH"
        self.patch_requests.append(request)
        receipts = list((self.root / "task-edit-receipts").glob("*.json"))
        assert len(receipts) == 1
        receipt = json.loads(receipts[0].read_text())
        assert receipt["status"] == "submitting"
        assert receipt["before"] == self.before
        payload = json.loads(request.content)
        assert set(payload) == {"task", "expectedTask"}
        assert payload["expectedTask"] == self.before["task"]
        assert request.headers["If-Match"] == self.etag()
        assert TOKEN not in receipts[0].read_text()
        if self.patch_status != 200:
            return self.response(request, None, self.patch_status)
        if self.mode == "timeout_before":
            raise httpx.ReadTimeout(f"secret reflected {TOKEN}", request=request)
        changed = payload["task"] != self.record["task"]
        previous = self.record["task"]
        if changed:
            self.record["task"] = payload["task"]
            self.record["dateRevision"] = self.record.get("dateRevision", 0) + 1
        if self.mode == "timeout_after":
            raise httpx.ReadTimeout("lost PATCH response", request=request)
        if self.mode == "malformed_json":
            return httpx.Response(200, text="<html>lost reply</html>", request=request)
        if self.mode == "diverged":
            self.record["hours"] = 9.999
        if self.mode == "type_changed":
            self.record["customfields"]["nested"]["keep"][0] = True
        if self.mode == "secret_readback":
            self.record["api_key"] = TOKEN
        result = {
            "timecardId": "r1",
            "task": self.record["task"],
            "previousTask": previous,
            "changed": changed,
        }
        if self.mode == "malformed_payload":
            return self.response(request, None, etag=self.etag())
        if self.mode == "wrong_changed":
            result["changed"] = 1
        if self.mode == "wrong_task":
            result["task"] = "silently rewritten"
        if self.mode == "extra_response_fields":
            result["api_key"] = TOKEN
        new_etag = None if self.mode == "no_response_etag" else self.etag()
        return self.response(request, result, etag=new_etag)


@pytest.fixture
def server(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Server:
    server = Server(tmp_path / "state")
    monkeypatch.setattr(
        "titra_cli.cli.TitraClient",
        lambda config: TitraClient(config, transport=httpx.MockTransport(server.handler)),
    )
    return server


def invoke(server: Server, *args: str, output: str = "json", group: str = "record") -> Result:
    return CliRunner().invoke(
        cli,
        [
            "--server",
            "https://titra.example",
            "--api-key",
            TOKEN,
            "--username",
            "Alice",
            "--state-dir",
            str(server.root),
            "--output",
            output,
            "--no-color",
            group,
            *args,
        ],
    )


def edit(server: Server, task: str = "New task", *args: str, output: str = "json") -> Result:
    return invoke(server, "edit-task", "r1", "--task", task, *args, output=output)


def receipt(server: Server) -> tuple[Path, dict[str, Any]]:
    paths = list((server.root / "task-edit-receipts").glob("*.json"))
    assert len(paths) == 1
    return paths[0], json.loads(paths[0].read_text())


def test_task_edit_success_preserves_all_other_fields_and_precision(server: Server) -> None:
    task = "  [TEST ONLY] CATHAI, FVT :smile: 🧬 e\u0301  "
    result = edit(
        server, task, "--yes", "--expect-task", "Old task", "--if-match", '"titra-date-revision-7"'
    )
    assert result.exit_code == 0, result.output
    data = json.loads(result.stdout)["data"]
    assert data["hours"] == 1.237
    assert data["task"] == task and data["status"] == "verified"
    assert server.record == {**ORIGINAL, "task": task, "dateRevision": 8}
    assert len(server.patch_requests) == 1
    path, audit = receipt(server)
    assert audit["before"] == ORIGINAL and audit["after"] == server.record
    assert audit["before_etag"] == '"titra-date-revision-7"'
    assert audit["after_etag"] == '"titra-date-revision-8"'
    assert audit["retry_safe"] is False
    assert TOKEN not in path.read_text() + result.output


@pytest.mark.parametrize("legacy", [False, True])
@pytest.mark.parametrize("noop", [False, True])
def test_legacy_revision_and_exact_noop(server: Server, legacy: bool, noop: bool) -> None:
    if legacy:
        server.record.pop("dateRevision")
        server.before = deepcopy(server.record)
    result = edit(server, "Old task" if noop else "new", "--yes")
    assert result.exit_code == 0, result.output
    if noop:
        assert server.record == server.before
        assert json.loads(result.stdout)["data"]["status"] == "verified_noop"
    else:
        assert server.record["dateRevision"] == (1 if legacy else 8)


@pytest.mark.parametrize("output", ["human", "json", "jsonl", "csv", "tsv", "id", "silent"])
def test_output_formats(server: Server, output: str) -> None:
    result = edit(server, "New", "--yes", output=output)
    assert result.exit_code == 0, result.output
    if output == "silent":
        assert result.stdout == "" and result.stderr == ""
    elif output == "id":
        assert result.stdout == "r1\n"
    else:
        assert "r1" in result.stdout and "verified" in result.stdout


def test_read_only_preview_and_time_alias(server: Server) -> None:
    result = invoke(server, "edit-task", "r1", "--task", "new", "--dry-run", group="time")
    assert result.exit_code == 0, result.output
    data = json.loads(result.stdout)["data"]
    assert data["previousTask"] == "Old task" and data["task"] == "new"
    assert data["hours"] == 1.237 and data["date"] == "2026-07-02"
    assert not server.root.exists()
    assert all(request.method == "GET" for request in server.requests)


def test_noninteractive_requires_yes_and_writes_nothing(server: Server) -> None:
    result = edit(server)
    assert result.exit_code == 2 and "--yes" in result.stderr
    assert not server.patch_requests and not server.root.exists()


@pytest.mark.parametrize("task", ["", " \n\t", "a" * 1001, "🧬" * 1001])
def test_invalid_task_rejected_before_network(server: Server, task: str) -> None:
    result = edit(server, task, "--yes")
    assert result.exit_code == 2
    assert not server.requests and not server.root.exists()


def test_unicode_codepoint_limit_not_utf16_or_trimmed(server: Server) -> None:
    result = edit(server, "🧬" * 1000, "--yes")
    assert result.exit_code == 0, result.output
    assert server.record["task"] == "🧬" * 1000


def test_invalid_unicode_stored_task_is_rejected_before_receipt(server: Server) -> None:
    server.record["task"] = "\ud800"
    result = edit(server, "new", "--yes")
    assert result.exit_code == 2 and not server.patch_requests
    assert not server.root.exists()


@pytest.mark.parametrize("record_id", ["", "r" * 129])
def test_invalid_record_id_stops_before_network(server: Server, record_id: str) -> None:
    result = invoke(server, "edit-task", record_id, "--task", "new", "--yes")
    assert result.exit_code == 2 and not server.requests


@pytest.mark.parametrize(
    "extra",
    [
        ("--expect-task", "stale"),
        ("--if-match", '"titra-date-revision-6"'),
        ("--expect-task", ""),
    ],
)
def test_stale_operator_guards_abort(server: Server, extra: tuple[str, str]) -> None:
    result = edit(server, "new", "--yes", *extra)
    assert result.exit_code == 4
    assert not server.patch_requests and not server.root.exists()


def test_empty_previous_task_allowed(server: Server) -> None:
    server.record["task"] = ""
    server.before = deepcopy(server.record)
    result = edit(server, "new", "--yes", "--expect-task", "")
    assert result.exit_code == 0, result.output


@pytest.mark.parametrize(
    "etag,expected_exit",
    [
        (None, 2),
        ("*", 5),
        ('W/"titra-date-revision-7"', 5),
        ('"titra-date-revision-8"', 2),
        ('"titra-date-revision-07"', 5),
    ],
)
def test_bad_snapshot_etag_aborts(server: Server, etag: str | None, expected_exit: int) -> None:
    server.etag_override = etag
    result = edit(server, "new", "--yes")
    assert result.exit_code == expected_exit
    assert not server.patch_requests and not server.root.exists()


@pytest.mark.parametrize(
    "field,value", [("userId", "u2"), ("_id", "r2"), ("dateRevision", True), ("task", None)]
)
def test_hostile_snapshot_aborts(server: Server, field: str, value: Any) -> None:
    server.record[field] = value
    result = edit(server, "new", "--yes")
    expected_exit = 5 if field in {"_id", "dateRevision"} else 3 if field == "userId" else 2
    assert result.exit_code == expected_exit
    assert not server.patch_requests and not server.root.exists()


@pytest.mark.parametrize("name", ["Bob", None])
def test_wrong_authenticated_name_aborts(server: Server, name: str | None) -> None:
    server.user["name"] = name
    result = edit(server, "new", "--yes")
    assert result.exit_code == 3 and not server.patch_requests


def test_missing_authenticated_id_aborts(server: Server) -> None:
    server.user = {"name": "Alice"}
    result = edit(server, "new", "--yes")
    assert result.exit_code == 3 and not server.patch_requests


def test_reflected_remote_identity_secret_never_reaches_output(server: Server) -> None:
    server.user = {"_id": "u1", "name": TOKEN}
    result = edit(server, "new", "--yes")
    assert result.exit_code == 3 and TOKEN not in result.output


@pytest.mark.parametrize("revision", [None, -1, 1.0, True, 2**53])
def test_invalid_or_unsafe_stored_revisions_abort(server: Server, revision: Any) -> None:
    server.record["dateRevision"] = revision
    result = edit(server, "new", "--yes")
    assert result.exit_code == 5 and not server.patch_requests


@pytest.mark.parametrize("noop", [False, True])
def test_max_safe_revision_allows_only_noop(server: Server, noop: bool) -> None:
    server.record["dateRevision"] = 2**53 - 1
    server.before = deepcopy(server.record)
    result = edit(server, "Old task" if noop else "new", "--yes")
    assert result.exit_code == (0 if noop else 2), result.output
    assert len(server.patch_requests) == int(noop)


def test_legacy_snapshot_cannot_use_numbered_zero_tag(server: Server) -> None:
    server.record.pop("dateRevision")
    server.etag_override = '"titra-date-revision-0"'
    result = edit(server, "new", "--yes")
    assert result.exit_code == 2 and not server.patch_requests


@pytest.mark.parametrize("where", ["task", "snapshot"])
def test_no_receipt_for_secret_containing_record_or_proposal(server: Server, where: str) -> None:
    if where == "snapshot":
        server.record["task"] = TOKEN
    result = edit(server, TOKEN if where == "task" else "new", "--yes")
    assert result.exit_code == 2 and not server.patch_requests
    assert TOKEN not in result.output and not server.root.exists()


def test_preview_refuses_reflected_secret_from_project_metadata(server: Server) -> None:
    server.project_name = TOKEN
    result = edit(server, "new", "--dry-run")
    assert result.exit_code == 2 and TOKEN not in result.output
    assert not server.patch_requests and not server.root.exists()


@pytest.mark.parametrize("status", [200, 404])
def test_v5_html_capabilities_never_allow_patch(server: Server, status: int) -> None:
    server.capability_status, server.capability_html = status, True
    result = edit(server, "new", "--dry-run")
    assert result.exit_code == 2 and "compatible API" in result.stderr
    assert [request.url.path for request in server.requests] == [
        "/user/me/",
        "/capabilities/v2/",
        "/capabilities/",
    ]
    assert not server.root.exists()


@pytest.mark.parametrize(
    "payload,expected_exit",
    [
        (None, 2),
        ([], 5),
        ({}, 5),
        ({"_id": "u1"}, 5),
        ({**CAPABILITIES, "apiVersion": True}, 2),
        ({**CAPABILITIES, "apiVersion": 2}, 5),
        ({**CAPABILITIES, "features": {"timeEntryTaskUpdate": "true"}}, 2),
        (
            {
                **CAPABILITIES,
                "taskUpdate": {**CAPABILITIES["taskUpdate"], "maxTaskLength": "1000"},
            },
            2,
        ),
        (
            {
                **CAPABILITIES,
                "taskUpdate": {
                    **CAPABILITIES["taskUpdate"],
                    "preservesOtherFields": False,
                },
            },
            2,
        ),
    ],
)
def test_unknown_capability_shapes_fail_closed(
    server: Server, payload: Any, expected_exit: int
) -> None:
    server.capabilities = payload
    result = edit(server, "new", "--yes")
    assert result.exit_code == expected_exit and not server.patch_requests


@pytest.mark.parametrize("status", [401, 403])
@pytest.mark.parametrize("html", [False, True])
def test_capability_auth_failures_remain_auth(server: Server, status: int, html: bool) -> None:
    server.capability_status = status
    server.capability_html = html
    result = edit(server, "new", "--yes")
    assert result.exit_code == 3 and not server.patch_requests


@pytest.mark.parametrize("write_number", [1, 2])
def test_prewrite_journal_failure_prevents_patch(
    server: Server, monkeypatch: pytest.MonkeyPatch, write_number: int
) -> None:
    save = StateStore.save_task_edit_receipt
    calls = 0

    def failing_save(self: StateStore, value: dict[str, Any]) -> Path:
        nonlocal calls
        calls += 1
        if calls == write_number:
            raise OSError("disk full")
        return save(self, value)

    monkeypatch.setattr(StateStore, "save_task_edit_receipt", failing_save)
    result = edit(server, "new", "--yes")
    assert result.exit_code == 2 and "no PATCH sent" in result.stderr
    assert not server.patch_requests


@pytest.mark.parametrize(
    "status,exit_code",
    [(400, 5), (401, 3), (403, 3), (404, 4), (409, 4), (412, 4), (422, 5), (428, 4)],
)
def test_guarded_rejections_journal_without_retry(
    server: Server, status: int, exit_code: int
) -> None:
    server.patch_status = status
    result = edit(server, "new", "--yes")
    assert result.exit_code == exit_code, result.output
    assert len(server.patch_requests) == 1 and server.record == ORIGINAL
    assert receipt(server)[1]["status"] == "rejected"


@pytest.mark.parametrize(
    "mode",
    [
        "timeout_before",
        "timeout_after",
        "malformed_json",
        "malformed_payload",
        "wrong_changed",
        "wrong_task",
        "no_response_etag",
        "readback_failure",
        "diverged",
        "type_changed",
        "extra_response_fields",
        "secret_readback",
    ],
)
def test_uncertain_outcomes_never_retry_and_have_receipt(server: Server, mode: str) -> None:
    server.mode = mode
    result = edit(server, "new", "--yes")
    assert result.exit_code == 6, result.output
    assert "Do not retry" in result.stderr and "reconcile-task-edit" in result.stderr
    assert len(server.patch_requests) == 1
    path, audit = receipt(server)
    assert audit["status"] == "outcome_unknown" and audit["retry_safe"] is False
    assert TOKEN not in path.read_text() + result.output


@pytest.mark.parametrize("status", [500, 502, 503])
def test_server_or_proxy_failures_are_conservatively_uncertain(server: Server, status: int) -> None:
    server.patch_status = status
    result = edit(server, "new", "--yes")
    assert result.exit_code == 6 and len(server.patch_requests) == 1
    assert receipt(server)[1]["status"] == "outcome_unknown"


@pytest.mark.parametrize("fail_at", [3, 4])
def test_postwrite_receipt_failure_cannot_be_reported_safe_to_retry(
    server: Server, monkeypatch: pytest.MonkeyPatch, fail_at: int
) -> None:
    original = StateStore.save_task_edit_receipt
    calls = 0

    def failing(self: StateStore, value: dict[str, Any]) -> Path:
        nonlocal calls
        calls += 1
        if calls >= fail_at:
            raise OSError("disk full after PATCH")
        return original(self, value)

    monkeypatch.setattr(StateStore, "save_task_edit_receipt", failing)
    result = edit(server, "new", "--yes")
    assert result.exit_code == 6 and len(server.patch_requests) == 1
    assert receipt(server)[1]["status"] in {"submitting", "verifying"}


@pytest.mark.parametrize(
    "initial,expected",
    [
        ("timeout_after", "matches_proposed_change"),
        ("timeout_before", "matches_before_snapshot"),
        ("diverged", "diverged"),
        ("missing", "record_unavailable"),
        ("ok", "matches_noop"),
    ],
)
def test_reconcile_is_read_only_and_never_retries_or_rewrites_journal(
    server: Server, initial: str, expected: str
) -> None:
    server.mode = initial
    edit(server, "Old task" if initial == "ok" else "new", "--yes")
    path, audit = receipt(server)
    original_bytes = path.read_bytes()
    request_count = len(server.requests)
    if initial == "timeout_before":
        server.mode = "ok"
    result = invoke(server, "reconcile-task-edit", audit["receipt_id"])
    assert result.exit_code == 0, result.output
    data = json.loads(result.stdout)["data"]
    assert data["status"] == expected and data["retry_safe"] is False
    assert all(request.method == "GET" for request in server.requests[request_count:])
    assert len(server.patch_requests) == 1 and path.read_bytes() == original_bytes


def test_reconcile_rejects_wrong_profile_or_owner_and_path_traversal(server: Server) -> None:
    edit(server, "new", "--yes")
    _, audit = receipt(server)
    server.user = {"_id": "u2", "name": "Alice"}
    result = invoke(server, "reconcile-task-edit", audit["receipt_id"])
    assert result.exit_code == 3
    traversal = invoke(server, "reconcile-task-edit", "../../secret")
    assert traversal.exit_code == 2


@pytest.mark.parametrize(
    "field,value",
    [
        ("schema", "unknown"),
        ("profile", "different"),
        ("server", "https://wrong.example"),
        ("before", None),
        ("proposed_payload", None),
        ("record_id", None),
        ("owner_id", None),
        ("proposed_payload", {"task": None, "expectedTask": "Old task"}),
        ("proposed_payload", {"task": "new", "expectedTask": None}),
        ("proposed_payload", {"task": "new", "expectedTask": "mismatch"}),
    ],
)
def test_reconcile_rejects_malformed_or_wrong_scope_receipts_before_network(
    server: Server, field: str, value: Any
) -> None:
    edit(server, "new", "--yes")
    path, audit = receipt(server)
    audit[field] = value
    path.write_text(json.dumps(audit), encoding="utf-8")
    request_count = len(server.requests)
    result = invoke(server, "reconcile-task-edit", audit["receipt_id"])
    assert result.exit_code == 2, result.output
    assert len(server.requests) == request_count


def test_unrelated_fields_cannot_be_supplied_to_edit_command(server: Server) -> None:
    for option in ("--hours", "--project", "--date", "--custom-fields", "--start"):
        result = edit(server, "new", "--yes", option, "hostile")
        assert result.exit_code == 2
    assert not server.requests and not server.root.exists()
