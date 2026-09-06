# Command reference

Global connection options are `--profile`, `--server`, `--api-key`, `--username`,
`--credentials`, `--timezone`, `--insecure`, `--timeout`, and `--expect-user-id`. The last option
pins every mutation request to one immutable authenticated user ID. Global presentation options are
`--output`, `--color/--no-color`, and `--state-dir`.

## Configuration and diagnosis

- `config init`: securely create/update a named TOML profile.
- `config show`: show resolved settings with the entire token replaced by `<redacted>`.
- `config check` and `auth check`: authenticate and verify an optional expected username.
- `capabilities show [--version auto|1|2]`: print the negotiated or requested discovery
  document and its source endpoint.
- `capabilities check [--require-v6 | --require-v7]`: validate discovery; v7 requires the exact
  capabilitiesVersion 3 `security-v7` contract plus the hardened HTTP response-header profile.
- `security check [--require-hsts]`: validate the authenticated v7 API response headers. HSTS is
  checked only when explicitly required because it must be enabled only behind HTTPS.
- `doctor`: report server capabilities, identity support, timezone, source file, and state path.
- `creation list/show/retry/verify-replay`: inspect, safely resume, or explicitly prove a
  completed private v6 idempotent-create receipt returns its original result ID. Recovery reports
  whether the exact result was freshly completed or replayed from the interrupted POST.

## Projects and tasks

- `project list [--include-archived]`
- `project show PROJECT`
- `project users PROJECT`: list observed project-user IDs and the names visible to the caller.
- `project create NAME [--description ... --color ... --customer ... --rate ... --budget ...]`
- `project edit PROJECT --changes JSON [--dry-run | --yes]`
- `project archive PROJECT [--dry-run | --yes]`
- `project restore PROJECT [--dry-run | --yes]`
- `project delete PROJECT --expect-name NAME [--if-match ETAG] [--dry-run | --yes]`: delete
  only that named empty, owner-controlled project using a fresh revision.
- `project recovery inspect PROJECT`: owner/administrator-only read of bounded v6 stale-fence
  classifications and their strong recovery ETag.
- `project recovery recover PROJECT --type TYPE --recovery-id ID [--dry-run | --yes]`: clear
  exactly one writer or task-delete target only when a fresh server preview classifies it
  recoverable. An uncertain response must be followed by `inspect`, never a blind retry.
- `task list PROJECT`
- `task create PROJECT NAME --start YYYY-MM-DD --end YYYY-MM-DD [--custom-fields JSON]`
- `task show TASK_ID`
- `task edit TASK_ID --changes JSON [--dry-run | --yes]`
- `task delete TASK_ID --expect-project-id PROJECT_ID --expect-name NAME [--if-match ETAG]
  [--acknowledge-recorded-entries] [--dry-run | --yes]`
- `task stats PROJECT [--task EXACT_NAME]`: planned versus actual time and variance.

Project references can be exact IDs, unique ID prefixes, or unique case-insensitive names.
Ambiguous names never select a project automatically.

## Records

- `record list`/`time list`: current month by default; supports explicit range, today, week,
  current month, or `--calendar-month YYYY-MM`.
- `record show ID`: raw owned record plus its v6 revision ETag when available.
- `record create`: accepts exactly one of `--duration` or `--hours`, plus optional `--rate` and
  `--custom-fields JSON`; `--dry-run` previews.
- `record delete ID --expect-project-id PROJECT_ID --expect-task TEXT [--if-match ETAG]`:
  checks the intended project, exact Task text, optional prior revision, and authenticated owner
  against a fresh snapshot, writes a private recovery receipt, then deletes only if unchanged.
- `record edit-task ID --task TEXT [--expect-task OLD] [--if-match ETAG] [--dry-run | --yes]`:
  change only the exact Task text after checking the server capability, owner, old name and
  revision. A successful change increments the revision but preserves every other record field.
- `record reconcile-task-edit RECEIPT_ID`: read-only comparison of a saved edit receipt with
  the current record. Never retries a write or changes the receipt.
- `record edit-details ID --changes JSON [--accept-legacy-conversion] [--dry-run | --yes]`:
  guarded changes to only `projectId`, `dateOnly`, `startTime`, and `hours`.

For a previously reviewed preview, supply **both** `--expect-task` and `--if-match` when applying.
Without these optional pins, each invocation previews the latest record independently. Task
editing requires the newer task-edit API extension, not just v5. See `task-editing.md` for
examples, limits, receipt states and uncertain-outcome recovery. The interactive Time records
menu opens the same guarded workflow.

Team record listing requires `--team` and at least one accessible `--project`. Repeated
`--project` and `--user` filters are supported.

## Personal suggestions

- `suggestion list [--page-size 1..500]`
- `suggestion show SUGGESTION_ID`
- `suggestion delete SUGGESTION_ID --expect-name NAME [--if-match ETAG]
  [--acknowledge-referenced-records] [--dry-run | --yes]`

Suggestions belong only to the authenticated user. Deleting one never rewrites historical time
records; acknowledgement is required when the preview reports existing references.

## Timers and drafts

- `track`: foreground live display; Enter stops capture and opens the finalization wizard.
- `timer start/status/recover-start/adopt/pause/resume/stop/cancel`: detached workflow backed by
  Titra's timer. `recover-start --yes` reconciles or exactly replays the journaled v6 start.
  `timer stop` resolves any requested project and reads/previews the exact current timer before
  confirmation; noninteractive use requires `--yes`. It automatically carries the reviewed v6
  timer ID into the guarded stop, while optional `--expect-timer-id` also pins a caller's prior
  observation. `timer cancel --yes` always requires that explicit ID (`null` for a legacy timer)
  and also carries the previewed start timestamp to prevent replacement/ABA races.
- `draft list/show/finalize/submit/verify-replay/recover-stop/reconcile/retry/discard`: durable recovery
  workflow. `recover-stop DRAFT_ID --yes` is only for a v6 stop whose exact request was journaled.

Pauses are local adjustments while the server timer continues. On v6, start intent is persisted
before POST with its operation ID, immutable user ID, and metadata. `status` adopts a matching late
commit; `recover-start --yes` checks for that commit and otherwise replays the exact saved operation
only when the server advertises its consumed-ID ledger contract. The server guarantees 604800
seconds and the CLI stops replay at age 604200, leaving a 600-second margin. A stopped/consumed
operation ID conflicts instead of starting a second timer. A different active timer cannot consume
or erase that intent. `timer adopt` previews and pins the
current timer. Noninteractive adoption requires `--expect-timer-id` (literal `null` is supported)
or `--expect-start-time`; see `usage.md#timed-work` for the complete state transitions.

The CLI confirms an exact timer-stop preview before changing the server. If record details were
requested, it resolves the project before that confirmation. Once approved, stopping is journaled
before the server request. On v6, the timer ID and revision are persisted before POST;
`draft recover-stop` replays only that exact CAS, and the server's bounded receipt returns the
original duration after a lost response. A successful stop is saved as a draft before a separate
record-submission preview. A hard interruption after dispatch leaves the fully journaled
`pending_stop` draft recoverable too. Fresh stop responses must say Boolean `changed=true`; a
replayed `changed=false` receipt is accepted only by `recover-stop`, so concurrent callers cannot
each prepare the same interval. A lost create response changes the draft to `outcome_unknown`. On
v6, a later `submit` reuses the same durable key and the server returns the original result or
completes the one reserved resource, but only before the CLI's age-604200 cutoff, which leaves a
600-second margin inside the advertised 604800-second retention boundary. All
finalize, submit, recovery, reconciliation, retry, and discard paths validate the saved profile,
server, and immutable owner before mutation. They also hold one non-expiring, process-owned lock
across each complete draft operation and reload state after acquiring it, so concurrent or stale
finalize/submit processes cannot overwrite each other or issue duplicate POSTs. On an older
server, `submit` still refuses until the operator
runs `reconcile`; `retry` is an explicit assertion that reconciliation found no server record.

Timers crossing midnight prompt in interactive mode. Detached mode splits only with
`--split-midnight`; otherwise one record is assigned to the configured start calendar date.

## Reports

- `report summary`: totals, count, average, billable value where a rate is available, and legacy
  counts. `--group-by` accepts user, project, task, day, week, or month and may be repeated or
  comma-separated.
- `report timesheet`: latest-first detailed rows.
- `report calendar`: totals per calendar day.

V6 range endpoints are drained with stable `(date, ID)` cursors and explicit completeness.
Older arrays are fetched in bounded date chunks and marked completeness-unverified. `record
list --limit` is applied only after fetching; JSON metadata distinguishes matched, returned and
truncated rows. Legacy rows are conspicuously labelled.

## Verification runner

`python scripts/run-tests.py` (or the installed `titra-cli-test` entry point) runs the complete
local unit/static suite. `--live-url URL` adds read-only v5 contract checks. A token is accepted
only from the variable named by `--token-env` or a hidden prompt. `--project PROJECT` enables the
project-user check, and `--record-id ID` selects an owned record for the read endpoint.

`--allow-write-tests` requires both a live URL and an explicit project. It creates one uniquely
labelled one-minute record, verifies it, and immediately performs guarded deletion. See
`live-v5-testing.md` before using it against any persistent server.

For the complete v6 contract and isolated lifecycle suite, use the v6 mode documented in
`live-v6-testing.md`. It can read an existing private credential file/profile, is read-only by
default, and requires explicit mutation and timer opt-ins.

For v7, use `scripts/test-live-v7.py` or `titra-cli-test --live-api-version v7`. The read-only
gate first requires `capabilities check --require-v7`; disposable writes and the user-global
timer still need distinct explicit opt-ins. See `v7-api-and-testing.md`.

## Signed webhook diagnostics

- `webhook prepare --endpoint-id ID --event-id EVENT --file event.json --secret-env NAME`
- `webhook send ... --yes`
- `webhook list`
- `webhook show RECEIPT_ID`
- `webhook retry RECEIPT_ID --secret-env NAME --yes`

The webhook uses a separate HMAC secret, never the API token. The preview omits the body and
redacts the signature. Every send is journaled before the POST; list/show reveal only redacted
receipt metadata, and retry preserves the exact endpoint/event/body identity until the CLI's
age-604200 cutoff, leaving 600 seconds inside the v6 604800-second retention window. The same actions are under Connection and API in interactive
mode. See `webhooks.md` for replay and uncertain-outcome handling.

For an endpoint-by-endpoint map with both dashboard paths and scriptable examples, see
`v6-endpoint-guide.md`.
