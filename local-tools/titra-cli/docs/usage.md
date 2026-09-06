# Complete CLI usage guide

## Installation

Titra CLI requires Python 3.11 or newer. Install it into an isolated environment:

```bash
python -m venv .venv
. .venv/bin/activate
python -m pip install .
titra --version
```

For development under this repository's WSL2 setup, use `environment.yml` as described in
`development.md`.

## Credentials and global options

Generate an API key in Titra's Settings page. The recommended configuration is a private named
profile:

```bash
titra config init \
  --profile production \
  --server https://titra.example.org \
  --username 'Expected display name'
titra --profile production auth check
```

The key prompt is hidden. Global options must appear before the command, for example:

```bash
titra --profile production --output json record list --month
```

Available connection options are `--profile`, `--server`, `--api-key`, `--username`,
`--credentials`, `--timezone`, `--insecure`, and `--timeout`. Prefer a credential file or
environment injection to `--api-key`, which can be exposed in command history. Presentation and
state options are `--output`, `--color/--no-color`, and `--state-dir`.

Run these checks before creating data:

```bash
titra config show       # token is replaced by <redacted>
titra config check
titra doctor
titra capabilities show --version 2
titra capabilities check --require-v6
```

See `security.md` for credential precedence, private-file checks, HTTPS policy, and write safety.

## Project and predefined-task workflow

```bash
titra project list
titra project show 'Internal support'
titra project create 'Internal support' --description 'Support work' --dry-run
titra project create 'Internal support' --description 'Support work' --yes

titra task list 'Internal support'
titra task create 'Internal support' 'Incident review' \
  --start 2026-08-01 --end 2026-12-31 --estimated-hours 20 \
  --custom-fields '{"workstream":"support"}' --dry-run

# V6 lifecycle and statistics
titra project users 'Internal support'
titra project edit 'Internal support' --changes '{"budget":120}' --dry-run
titra task stats 'Internal support'
titra task show TASK_ID
titra task edit TASK_ID --changes '{"estimatedHours":24}' --dry-run
titra task delete TASK_ID --expect-project-id PROJECT_ID --expect-name 'Incident review' \
  --if-match '"titra-project-task-revision-2"' --yes
titra project delete PROJECT_ID --expect-name 'Internal support' \
  --if-match '"titra-project-revision-4"' --yes
```

Projects can be referenced by exact ID, unique ID prefix, or unique case-insensitive name. The
CLI refuses ambiguous references. Remove `--dry-run` and add `--yes` only after inspecting a
creation payload.

### Verified stale project-fence recovery (v6 only)

An interrupted project child write or task deletion can intentionally leave a safety fence that
blocks destructive operations. An owner or project administrator can inspect the bounded,
non-payload state:

```bash
titra project recovery inspect PROJECT_ID
```

Copy one exact recoverable reservation or lock ID from that output, preview the clear, then apply
it only if appropriate:

```bash
titra project recovery recover PROJECT_ID --type writer \
  --recovery-id 'writer:stale-resource-id' --dry-run
titra project recovery recover PROJECT_ID --type writer \
  --recovery-id 'writer:stale-resource-id' --yes
```

Use `--type task-delete` for a stale task-deletion lock. The server requires a different process
boot, a minimum age, an unchanged exact fence snapshot, and a resource-aware safe state. It will
not clear legacy/untracked, active, recent, malformed, or unexpectedly changed state. The CLI
always fetches a fresh ETag and refuses IDs not marked recoverable in that preview.

Recovery is unavailable by default. A deployment operator must assert the exact server setting
`TITRA_FENCE_RECOVERY_MODE=single-instance`, and the server advertises the capability only in
that mode. Never enable it when multiple app processes or replicas can write concurrently: a
different boot ID alone cannot prove another process is dead.

If the command exits 6, the response was uncertain. Run `inspect` again. A missing target means
the clear probably completed; a remaining recoverable target may be submitted as a new,
explicitly reviewed action. Never loop or blindly retry this maintenance command.

## Creating and inspecting records

```bash
titra record create \
  --project 'Internal support' \
  --task 'Incident review' \
  --date 2026-08-30 \
  --start 09:15 \
  --duration 1h20m \
  --dry-run

titra record create --project 'Internal support' --task 'Incident review' \
  --date 2026-08-30 --start 09:15 --duration 1h20m --yes

titra record list --today
titra record list --from 2026-08-01 --to 2026-08-31
titra record show RECORD_ID
titra record edit-details RECORD_ID --changes '{"hours":1.25}' --dry-run
```

Use exactly one of `--duration` or decimal `--hours`. `time` is an alias for `record`. Canonical
records use `dateOnly`; legacy timestamps are labelled and retain their stored UTC calendar date
instead of being silently shifted.

Both command-line and dashboard creation expose the optional record task rate and JSON custom
fields; predefined-task creation exposes the same JSON custom-fields object. The CLI validates
that each custom-fields value is an object before previewing or sending it.

Deletion is intentionally exact-ID and guarded:

```bash
titra record show RECORD_ID
titra record delete RECORD_ID --expect-project-id PROJECT_ID \
  --expect-task 'Incident review' --dry-run
titra record delete RECORD_ID --expect-project-id PROJECT_ID \
  --expect-task 'Incident review' --if-match '"titra-date-revision-3"' --yes
```

The required project and exact Task pins prevent a stale cleanup plan from selecting a changed or
replaced record. The optional prior ETag pins every field. The CLI retrieves its own fresh snapshot,
checks the authenticated immutable owner, and saves a private recovery receipt before deleting. It
refuses a stale or missing ETag. Inspection and deletion need the v5 API extensions.

## Changing a Task without changing the time record

This requires the task-edit server extension developed after v5. Check `titra doctor` first.

```bash
titra record edit-task RECORD_ID --task 'Incident review and follow-up' --dry-run
```

Review the old/new Task, date, hours, project and ETag. Dry-run performs reads only and writes no
receipt. For a script applying that exact preview, copy the old Task and ETag into the command:

```bash
titra record edit-task RECORD_ID --task 'Incident review and follow-up' \
  --expect-task 'Incident review' --if-match '"titra-date-revision-3"' --yes
```

The sample revision is illustrative; always use the ETag actually returned for your record.
Omit `--yes` in a terminal for confirmation, or use the Time records interactive menu.
An actual change updates only Task and the revision metadata, not hours, dates, project, rate,
identity or custom fields. No date migration occurs. The old/new record is recorded in a private
receipt and the saved record is read back before reporting success.

If the command reports an unknown outcome (exit 6), do not repeat it. Use its receipt ID:

```bash
titra record reconcile-task-edit RECEIPT_ID
```

This only reads the server and compares it to the receipt; it does not repair, retry or delete
anything. Use the same profile and state directory. See `task-editing.md` for interpretation.

## Personal task suggestions (v6)

Autocomplete suggestions belong only to the authenticated user. They can be inspected and
cleaned up without changing historical time records:

```bash
titra suggestion list
titra suggestion show SUGGESTION_ID
titra suggestion delete SUGGESTION_ID --expect-name 'Incident review' --dry-run
titra suggestion delete SUGGESTION_ID --expect-name 'Incident review' \
  --if-match '"titra-task-suggestion-revision-1"' \
  --acknowledge-referenced-records --yes
```

## Timed work

For a foreground session, start `titra track`. Press Enter when finished, describe the work,
review measured elapsed time, subtract breaks or provide an exact replacement, and confirm the
record preview.

A detached workflow survives closing the terminal:

```bash
titra timer start --project 'Internal support' --task 'Investigation' \
  --operation-id operator-investigation-20260903
titra timer status
titra timer pause
titra timer resume
titra timer stop --project 'Internal support' --task 'Investigation' --break 10m \
  --expect-timer-id operator-investigation-20260903 --yes
```

On a v6 server, the CLI durably records the operation ID, immutable `/user/me` user ID, profile,
exact server, project, and task before sending `timer start`. Automation should supply a unique,
recognizable `--operation-id`; interactive starts may omit it and let the CLI generate one. If the
POST or its confirming GET is interrupted, that pending intent is retained and a different start
cannot replace it.

Run `titra timer status` first after an uncertain start. If the server timer has the journaled
operation ID, status promotes it to active local state with the original project/task metadata and
clears the pending intent. If no timer is visible yet, the intent stays pending because a late
commit is still possible. To reconcile or exactly replay it after a restart, run:

```bash
titra timer recover-start --yes
```

Interactive use previews the durable intent. Recovery authenticates the same immutable owner,
observes the server, and only then reuses the saved operation ID if no timer is visible and the
server advertises its per-user consumed-ID ledger. A consumed ID conflicts rather than resurrecting
a timer that another client already stopped. The server's public replay guarantee is 604800
seconds; the CLI stops at age 604200 to reserve a 600-second transport margin. Recovery offers no
abandon, replacement, project, task, or operation-ID override. Never delete the private state file
to get past the guard.
When the server returns its exact `timer-operation-consumed` response, the saved operation is
conclusively resolved and the CLI clears only that pending start; every other conflict or malformed
response keeps the recovery evidence.

If a different timer is active, both it and the pending intent are left untouched. Inspect the
current timer, then deliberately adopt that exact timer only if it is the one you intend to manage:

```bash
# Interactive: shows the exact server timer and asks before changing local association.
titra --profile default timer adopt --project 'Internal support' --task 'Other work'

# Noninteractive v6 timer: an exact ID prevents a changed timer being adopted.
titra --profile default timer adopt --project 'Internal support' --task 'Other work' \
  --expect-timer-id CURRENT_TIMER_ID --yes

# Noninteractive legacy timer (whose timerId is null): guard by its exact start timestamp.
titra --profile default timer adopt --project 'Internal support' --task 'Other work' \
  --expect-timer-id null --expect-start-time '2026-09-03T01:23:45.678Z' --yes
```

Adopting the timer that matches a pending start restores its saved metadata rather than replacing
it. Guardedly adopting a genuinely different current timer does not erase the older pending
intent; stop or otherwise resolve the current timer, then reconcile the saved start explicitly.
The adoption preview also binds the observed start timestamp, so a timer changed between preview
and confirmation is rejected.

Active timers, pending starts, and record drafts are bound to the immutable authenticated user ID.
Changing an API token to another account—even one with the same display name—cannot reuse the old
timer labels or submit/replay its drafts. State written by an older CLI has no owner ID and is
readable for inspection but fails closed for mutations. Use guarded `timer adopt` to rebind an
exactly observed active timer; unresolved pending starts and drafts are never silently rebound.
Timer state filenames also bind the complete profile name and server. If the CLI detects a file
from the older truncated-profile filename scheme, it will not migrate or overwrite that ambiguous
file; inspect the live timer and use exact guarded adoption to create the new binding.

Timer stop first resolves any requested project, reads the current server timer, and asks for
confirmation of that exact timer. Noninteractive use requires `--yes`; `--expect-timer-id` can
also pin an ID obtained by an earlier process. Only after approval does it create a durable local
draft and send the stop. On v6, the reviewed timer ID and fresh revision are saved before the stop
request. If its response is lost, run
`titra draft recover-stop DRAFT_ID --yes`; the server returns the bounded stop receipt or applies
that same compare-and-swap once. The same command recovers a fully journaled `pending_stop` draft
left by an interrupt or process death after dispatch. A new stop must receive Boolean
`changed=true`; only this explicit recovery path accepts the prior receipt's `changed=false`, so
two clients cannot each turn one stopped interval into a record draft. Inspect recovery state with `titra draft list` and
`titra draft show DRAFT_ID`. Use `draft finalize`, `submit`, `reconcile`, `retry`, or `discard` as
described in `commands.md`. Every one of those operations authenticates and matches the draft's
saved profile, server, and immutable owner—even discard. Never use general record retry for an
`outcome_unknown` write until reconciliation finds no matching server record. If record details
were supplied to `timer stop`, their submission has a separate preview after the server timer is
successfully stopped. The CLI refuses an idempotent replay during the final 600 seconds of the
advertised 604800-second window, beginning
at age 604200 seconds; expired drafts and creation receipts must be reconciled manually.

A confirmed stop may safely bind the exact timer it just reviewed, even from a new state
directory. Automation that already knows the intended timer should still pass
`--expect-timer-id`; cancellation without a record always requires it:

```bash
titra timer cancel --expect-timer-id CURRENT_TIMER_ID --yes
```

For a legacy timer with no ID, use literal `--expect-timer-id null`; the CLI still binds the
previewed exact start timestamp before stopping it.
Cancellation records its discard intent before contacting the server and sets the final discarded
status under the same operation lock. If the stop response is lost, `draft recover-stop` preserves
that intent, so the cancelled interval is never exposed as a submittable record draft.

## Reports and machine output

```bash
titra report summary --calendar-month 2026-08 --group-by project --group-by task
titra --output csv report timesheet --month
titra report calendar --from 2026-08-01 --to 2026-08-31
titra report summary --team --project PROJECT_ID --group-by user,project
```

Output modes are `auto`, `human`, `json`, `jsonl`, `csv`, `tsv`, `id`, `none`, and `silent`.
Machine-readable data goes only to stdout; diagnostics and warnings go to stderr. JSON uses the
stable `titra-cli/v1` envelope. CSV and TSV neutralize spreadsheet-formula prefixes.

Examples for automation:

```bash
project_id=$(titra --output id project show 'Internal support')
titra --output json record list --project "$project_id" --month >records.json
titra --output none record create --project "$project_id" --task 'Build' \
  --date 2026-08-30 --duration 30m --yes
```

The stable exit-code table is in the main README. In particular, exit `6` means a write outcome
is unknown and must be reconciled, while exit `7` means useful partial output was emitted but
malformed rows were skipped.

## Interactive dashboard and help

Running `titra` in a terminal opens the interactive dashboard; `titra interactive` opens it
explicitly. Nested menus cover timers, records, projects and recovery, predefined tasks and
statistics, personal suggestions, reports, drafts/receipts, capability checks, and signed
webhook diagnostics. The Connection/API menu also exposes the v7 HTTP security-header check both
with and without an explicit HSTS requirement. Every mutation uses the same preview and confirmation rules as its command
line form. An input error returns to the current menu instead of closing the dashboard. In a
pipe or script, running without a subcommand prints help instead.

Every group and command has local help:

```bash
titra --help
titra record --help
titra record create --help
```

For automated package and v5 verification, see `live-v5-testing.md`. For the read-only and
explicitly opted-in synthetic lifecycle checks to run after v6 deployment, see
`live-v6-testing.md`. The separate signed receiver is documented in `webhooks.md`.
