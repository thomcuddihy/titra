from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DOCS = ROOT / "docs"


def test_v6_endpoint_guide_has_interactive_and_noninteractive_examples() -> None:
    guide = (DOCS / "v6-endpoint-guide.md").read_text(encoding="utf-8")
    endpoints = {
        "GET /capabilities/v2",
        "GET /user/me",
        "GET /project/list",
        "GET /project/get/:projectId",
        "POST /project/create",
        "PATCH /project/details/:projectId",
        "PATCH /project/archive/:projectId",
        "DELETE /project/delete/:projectId",
        "GET /project/users/:projectId",
        "GET /project/tasks/:projectId",
        "GET /project/task/stats/:projectId",
        "GET /project/recovery/:projectId",
        "POST /project/recovery/:projectId",
        "POST /project/task/create",
        "GET /project/task/get/:taskId",
        "PATCH /project/task/details/:taskId",
        "DELETE /project/task/delete/:taskId",
        "POST /timeentry/create",
        "GET /timeentry/get/:timecardId",
        "PATCH /timeentry/task/:timecardId",
        "PATCH /timeentry/details/:timecardId",
        "DELETE /timeentry/delete/:timecardId",
        "GET /timeentry/daterange-page/:fromDate/:toDate",
        "GET /project/timeentriesfordaterange-page/:projectId/:fromDate/:toDate",
        "GET /timeentry/list/:date",
        "GET /timeentry/daterange/:fromDate/:toDate",
        "GET /project/timeentries/:projectId",
        "GET /project/timeentriesfordaterange/:projectId/:fromDate/:toDate",
        "GET /task-suggestions",
        "GET /task-suggestions/get/:suggestionId",
        "DELETE /task-suggestions/delete/:suggestionId",
        "POST /timer/start",
        "GET /timer/get",
        "POST /timer/stop",
        "POST /user/action-verification/webhook/:endpointId",
    }
    table_lines = [line for line in guide.splitlines() if line.startswith("|")]
    for endpoint in endpoints:
        matches = [line for line in table_lines if f"`{endpoint}`" in line]
        assert matches, f"missing documented v6 endpoint: {endpoint}"
        cells = [cell.strip() for cell in matches[0].strip("|").split("|")]
        assert len(cells) == 3
        assert cells[1] and cells[1] != "—", f"missing interactive example: {endpoint}"
        assert cells[2] and cells[2] != "—", f"missing noninteractive example: {endpoint}"


def test_distributed_docs_are_generic_and_self_contained() -> None:
    paths = [ROOT / "README.md", *sorted(DOCS.glob("*.md"))]
    text = "\n".join(path.read_text(encoding="utf-8") for path in paths)
    for private_or_removed_reference in (
        "/mnt/c/Users/",
        "post-deployment-v6.md",
        "verification.md",
        "notes/",
        "test-task-edit-contract.py",
        "task_edit_bridge.mjs",
    ):
        assert private_or_removed_reference not in text

    fenced_commands = "\n".join(re.findall(r"```bash\n(.*?)```", text, flags=re.DOTALL))
    assert "--api-key" not in fenced_commands
    assert "TITRA_API_KEY=" not in fenced_commands
    assert "TITRA_API_TOKEN=" not in fenced_commands


def test_recovery_and_webhook_contracts_are_explicitly_documented() -> None:
    usage = (DOCS / "usage.md").read_text(encoding="utf-8")
    for phrase in (
        "before sending `timer start`",
        "pending intent is retained",
        "titra timer recover-start --yes",
        "immutable `/user/me` user ID",
        "--expect-timer-id CURRENT_TIMER_ID --yes",
        "does not erase the older pending\nintent",
    ):
        assert phrase in usage

    webhooks = (DOCS / "webhooks.md").read_text(encoding="utf-8")
    for phrase in (
        "Delivery disables HTTP redirects",
        "HTTP status is `202`",
        "`application/vnd.titra.v2+json`",
        "response `X-Request-ID` equals the request ID",
        "contains exactly `accepted: true`",
        "treated as outcome unknown, not success",
        "writes a private, fsynced delivery receipt",
        "webhook retry RECEIPT_ID",
        "604800",
        "never print the body/base64, signature, or secret",
    ):
        assert phrase in webhooks


def test_v7_runbook_documents_safe_profile_url_and_mutation_modes() -> None:
    runbook = (DOCS / "v7-api-and-testing.md").read_text(encoding="utf-8")
    for phrase in (
        "capabilities check --require-v7",
        "security check --require-hsts",
        "--credentials ~/.titra-cli.toml",
        "scripts/test-live-v7.py",
        "--allow-mutations",
        "--allow-timer",
        "--allow-v7-mutation-tests",
        "--allow-v7-timer-tests",
        "OAuth token encryption is configured",
        "never delete a resource whose ID and marker no longer match",
        "--min-command-spacing 1 --min-request-spacing 0.5",
        "--resume-cleanup /private/run-directory/v6-recovery.json",
        "never sends a create, replay, fence-recovery, or timer-stop command",
        "cleanup-completed-after-failure",
    ):
        assert phrase in runbook
    fenced_commands = "\n".join(re.findall(r"```bash\n(.*?)```", runbook, flags=re.DOTALL))
    assert "--api-key" not in fenced_commands
    assert "TITRA_API_KEY=" not in fenced_commands
