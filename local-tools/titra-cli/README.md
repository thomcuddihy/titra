# Titra CLI

`titra` is a safe, interactive and scriptable terminal client for Titra. It is intended for
daily time capture, automation, export, and calendar-aware reporting. Its only maintenance
operation is the v6 server's narrowly verified stale project-fence recovery; it is not a
general database repair or date-migration tool.

The CLI negotiates the server's advertised capabilities at runtime. Commands supported by older
Titra releases remain available, while commands that require newer REST extensions fail closed
with an actionable compatibility message when the server does not advertise them.

## Highlights

- Human tables plus JSON, JSONL, CSV, TSV, ID-only, and silent output.
- Named credential profiles with strict source precedence and full token redaction.
- Project and predefined-task inspection/creation.
- Time-record inspection, creation, export, task-only editing, and ETag-guarded deletion.
- Exact-name/revision checks, private before/after receipts, and read-only edit reconciliation.
- Foreground live tracking and detached server timers.
- Durable drafts and creation receipts. A v6 server can safely resolve/retry a lost create
  response with the original persisted idempotency key, and recover a lost timer-stop response
  from the exact journaled timer ID and revision; older servers are never retried blindly.
- Complete cursor paging on v6, with explicit live-query consistency and display-truncation
  metadata. Legacy arrays remain compatible and are labelled completeness-unverified.
- Reports grouped by user, project, task, day, week, and calendar month.
- Canonical `dateOnly` handling. Ambiguous legacy timestamps are labelled and retain their
  stored UTC calendar date rather than being silently moved into another timezone.
- V7-aware API diagnostics: exact capabilitiesVersion 3 security-policy discovery, explicit
  response-header validation, actionable verification-gate
  errors, and validated rate-limit delays with no automatic request replay.

## Development installation

```bash
cd local-tools/titra-cli
conda env create -f environment.yml
conda run -n titra-cli-dev titra --help
```

The environment created during development is named `titra-cli-dev`.

For a normal installation into an existing Python 3.11+ environment:

```bash
python -m pip install .
```

## First configuration

Generate an API token in Titra's Settings page. Do not paste it into shell history or support
logs. Create a private home profile:

```bash
titra config init --profile production --server https://titra.example.org \
  --username "Expected display name"
titra config check
```

The API-key prompt is hidden. The default file is `~/.titra-cli.toml` and is written with mode
`0600` on POSIX systems. A current-directory `.titra-cli.toml` is also supported, but files are
never merged: server and token always come atomically from one complete profile.

On WSL, files on a Windows-backed mount can appear broadly accessible and will intentionally fail
the private-permission check. Store credentials in the Linux home directory, such as
`~/.titra-cli.toml`, or use an explicitly selected private Linux file with `--credentials`.

For non-loopback HTTP, configuration and use require the conspicuous insecure opt-in. HTTPS and
certificate verification are the default.

## Common commands

```bash
# Inspect
titra project list
titra record list --month
titra --output json record list --from 2026-08-01 --to 2026-08-31
titra record show RECORD_ID

# Create safely
titra project create "Internal support" --description "Support work" --yes
titra record create --project "Internal support" --task "Incident review" \
  --date 2026-08-30 --start 09:15 --duration 1h20m --yes

# Live or detached timer
titra track
titra timer start --project "Internal support" --task "Investigation"
titra timer status
# If a v6 start or its confirming GET was interrupted:
titra timer recover-start --yes
titra timer pause
titra timer resume
titra timer stop --project "Internal support" --task "Investigation" \
  --break 10m --expect-timer-id CURRENT_TIMER_ID --yes
titra timer cancel --expect-timer-id CURRENT_TIMER_ID --yes
# If a v6 stop response was lost:
titra draft recover-stop DRAFT_ID --yes

# Reports and exports
titra report summary --calendar-month 2026-08 --group-by project --group-by task
titra --output csv report timesheet --month
titra report summary --team --project PROJECT_ID --group-by user,project

# Exact-ID guarded deletion
titra record show RECORD_ID
titra record delete RECORD_ID --expect-project-id PROJECT_ID \
  --expect-task 'Incident review' --dry-run
titra record delete RECORD_ID --expect-project-id PROJECT_ID \
  --expect-task 'Incident review' --if-match '"titra-date-revision-3"' --yes

# Task-only edit (requires the advertised API extension)
titra record edit-task RECORD_ID --task 'Incident review and follow-up' --dry-run
titra record edit-task RECORD_ID --task 'Incident review and follow-up' \
  --expect-task 'Incident review' --if-match '"titra-date-revision-3"' --yes

# Inspect or resume a v6 create whose response was interrupted
titra creation list
titra creation retry RECEIPT_ID --yes
titra creation verify-replay RECEIPT_ID --expect-result-id RESULT_ID --yes
titra draft verify-replay DRAFT_ID --expect-result-id RECORD_ID --yes

# Inspect a project safety fence, then clear only one server-verified stale target
titra project recovery inspect PROJECT_ID
titra project recovery recover PROJECT_ID --type writer \
  --recovery-id WRITER_RESERVATION_ID --dry-run
titra project recovery recover PROJECT_ID --type task-delete \
  --recovery-id TASK_DELETE_LOCK_ID --yes
```

Fence recovery is owner/administrator-only, v6-capability-gated, age-gated, and protected by
the exact ETag returned by `inspect`. Legacy, active, recent, malformed, changed, or otherwise
uncertain locks remain blocked. Exit 6 means the clear response may have been lost: inspect
again rather than repeating the POST blindly. The server capability is default-disabled and is
advertised only when the operator explicitly configures exact
`TITRA_FENCE_RECOVERY_MODE=single-instance`; do not enable it for multi-process deployments.

`time` is an alias for `record`.

## Output and exit contract

Data is written to stdout. Prompts, warnings, progress, and errors are written to stderr.
Successful `--output none`/`silent` commands emit no stdout. Machine output contains ISO dates,
numeric hours, and no ANSI sequences.

Automation can add the global `--expect-user-id USER_ID` pin learned from `auth check`; v6 sends
that immutable ID on every authenticated request. The server rejects a reassigned or replaced API
token before reading data or applying a write under another account.

| Exit | Meaning |
|---:|---|
| 0 | Success |
| 2 | Usage, configuration, or invalid input |
| 3 | Authentication or permission failure |
| 4 | Not found, conflict, or failed precondition |
| 5 | Network or remote API failure |
| 6 | Write outcome unknown; reconciliation required |
| 7 | Partial result; malformed rows were skipped |
| 130 | Interrupted |

See `docs/commands.md`, `docs/security.md`, and `docs/development.md` for the complete behavior
and local verification workflow. The end-to-end usage guide is `docs/usage.md`.

For task editing, use [the task-editing guide](docs/task-editing.md), including the distinction
between a fresh preview and an explicitly pinned earlier preview. Installing this CLI alone
does not add editing to a stock or v5 server. `titra doctor` checks the deployed capability;
the CLI will not attempt an update if the server does not advertise it.

For v6 duplicate-safe creation, retention, cursor paging, and live-query consistency, see
[the idempotency and pagination guide](docs/idempotency-and-pagination.md).
For every v6 route, its dashboard path, and a corresponding scriptable command, see the
[v6 endpoint and CLI guide](docs/v6-endpoint-guide.md).
V7 retains that API surface and adds security behavior, with both standard and HSTS-required
header checks available from the interactive Connection/API menu, documented in the
[v7 API and verification guide](docs/v7-api-and-testing.md).

## Automated verification, including v5, v6, and v7

Run every local unit/static check with one executable entry point:

```bash
python scripts/run-tests.py
```

An installed package also provides `titra-cli-test`. Run its local mode from the source checkout
(or supply `--source-root`). A supplied v5 URL and a token entered at a hidden prompt enable
privacy-preserving read-only API checks:

```bash
python scripts/run-tests.py --live-url https://titra-v5.example.org --skip-local
```

For the full new-endpoint check, select a dedicated test project and explicitly opt into one
synthetic record that is verified and immediately ETag-deleted:

```bash
python scripts/run-tests.py --live-url https://titra-v5.example.org \
  --project PROJECT_ID --allow-write-tests --skip-local
```

There is deliberately no token argument. Hidden prompting or a masked `TITRA_V5_API_TOKEN`
environment variable keeps the token out of shell history and process arguments. See
`docs/live-v5-testing.md` for exact safety, cleanup, CI, and failure-recovery behavior.

The v5 interface above remains the default. `--live-api-version v6` selects an exact,
fail-closed `/capabilities/v2/` gate and a broader read-only suite. It can use an atomic
credential source through `--credentials FILE --profile NAME` or normal profile discovery. A
separate `--allow-v6-mutation-tests` opt-in exercises a uniquely marked disposable project,
predefined task, two records, edits, pagination, suggestions, and identity-checked cleanup. Read
[`docs/live-v6-testing.md`](docs/live-v6-testing.md) before enabling it.

Atomic timer writes need the additional `--allow-v6-timer-tests` flag and abort before any
mutation if a timer is already active. `--report-json PATH` writes an optional private sanitized
PASS/SKIP/FAIL and recovery summary without credentials or API payloads.

V6 timer starts are journaled locally before the request. A matching late commit is recovered by
`timer status`, while an exact replay reuses the saved operation ID and metadata; a different
timer is never adopted implicitly over that pending intent. The complete recovery and guarded
`timer adopt` workflow is in [Timed work](docs/usage.md#timed-work). Webhook destination and
accepted-response validation, private pre-POST receipts, redacted inspection, and guarded retry
are specified in [the webhook guide](docs/webhooks.md).

After v7 is deployed, the dedicated wrapper accepts either the established private profile or a
supplied URL plus an environment-held token. It requires the v7 API/security profile before any
optional synthetic write:

```bash
python scripts/test-live-v7.py --credentials ~/.titra-cli.toml \
  --profile production --expected-user-id EXACT_ID --project TEST_PROJECT_ID \
  --min-command-spacing 1 --min-request-spacing 0.5

# Add these only during an approved test window with no active timer:
python scripts/test-live-v7.py --credentials ~/.titra-cli.toml \
  --profile production --expected-user-id EXACT_ID --allow-mutations --allow-timer \
  --min-command-spacing 1 --min-request-spacing 0.5
```

See [`docs/v7-api-and-testing.md`](docs/v7-api-and-testing.md) for read-only and mutation safety,
cleanup, rate-aware pacing, exact-marker `--resume-cleanup`, and URL/token usage. A recovery run
uses the existing private `v6-recovery.json` only: it creates and replays nothing, revalidates
server/owner/marker/resource identity, and retains the completed receipt.
