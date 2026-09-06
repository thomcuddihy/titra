# Safe Task-only editing

## Availability and boundaries

The CLI now has `record edit-task` (also `time edit-task`) and
`record reconcile-task-edit`. The server needs the **new task-edit extension developed after
v5**. Installing this CLI does not update the server. `doctor` reports `record_task_edit`;
the editing command also checks authenticated capabilities before sending any PATCH.

This feature changes the Task text of **one owned record** in place. It does not change dates,
start times, precise decimal hours, projects, users, rates, billing state or custom fields.
Only the revision metadata advances. It does not migrate legacy dates, rename predefined
tasks, or create/remove personal autocomplete suggestions. It is not a batch editor.

The July/August naming proposal retains `[TEST ONLY 2026-JUL-AUG v2]`. Implementing this feature
does not deploy it or authorize applying that proposal to the 85 live records.

## Preview and apply

Use the usual private credential profile. Global options precede the command:

```bash
titra --profile production --output json record edit-task RECORD_ID \
  --task '[TEST ONLY 2026-JUL-AUG v2] Client meetings' --dry-run
```

The preview shows the old/new Task, project, date, precise hours and strong ETag. Dry-run sends
no PATCH and creates no state directory or receipt. The server/account/record must still be
readable and support the feature.

For an exact previously approved preview, pin both its original name and its ETag:

```bash
titra --profile production record edit-task RECORD_ID \
  --task '[TEST ONLY 2026-JUL-AUG v2] Client meetings' \
  --expect-task 'EXACT OLD TASK FROM PREVIEW' \
  --if-match '"titra-date-revision-3"' --yes
```

Use the actual preview values, not the illustrative revision 3. Each invocation fetches a new
snapshot: omitting the optional pins means approving the **current** snapshot, not reusing an
earlier dry-run. Both names are exact and case-sensitive. Whitespace is preserved; no emoji
shortcode expansion is performed. The new name must be nonblank, valid Unicode and at most
1,000 Unicode code points (an emoji may use multiple code points). The old name may be empty.

In a terminal, omit `--yes` for a preview and confirmation, or use interactive menu option 7.
Without a terminal, applying requires `--yes`. The usual human/JSON/JSONL/CSV/TSV/ID/silent
outputs work; `--output none` emits no success data. No bulk rename, wildcard or fuzzy-ID
selection is provided.

An identical old/new Task is a guarded no-op. It does not increment the revision. A legacy
record with no revision uses `"titra-date-revision-legacy"`; an actual edit adds revision 1
while leaving all legacy date fields untouched. No-op legacy records remain legacy.

## Safeguards

1. Check explicit server capability, fresh account identity and record ownership.
2. Fetch the raw record and matching strong ETag; check optional old-name/revision pins.
3. Display the exact change and obtain confirmation.
4. Save a private receipt before issuing **one** PATCH.
5. Server rechecks owner/project access, original name, revision, configured time-entry rule,
   migration lock and writer lease. The atomic database update also matches the server's
   freshly read date, hours, state and rate snapshot to detect changes during that operation
   from older writers that do not advance the revision. An unrevisioned change before that
   server read is detected by the CLI's full readback, not by this server-side comparison.
6. Fetch the record again. Require exact preservation of the entire JSON snapshot except Task
   and the expected revision before reporting verified success.

The database modifier never replaces the full record; it sets Task and increments revision
only. A simultaneous custom-field edit cannot be overwritten by this modifier; readback can
still detect it and report an uncertain verification outcome. Authorization, rules and leases
are enforced by the server, not entrusted to the CLI.

## Receipts and uncertain outcomes

Receipts are stored under `STATE/task-edit-receipts/<receipt-id>.json`, using the configured
private state directory. They include server/profile identity, record/owner ID, the before
snapshot and ETag, proposed payload, timestamps, and verified result where available. They
contain confidential record data but not the API token. Use a private Linux path in WSL.

Possible receipt states:

| State | Meaning |
|---|---|
| `pending` | Receipt saved before the request boundary. |
| `submitting` | Request may have been sent; inspect before doing anything else. |
| `verifying` | A response was received; complete readback is not yet durably verified. |
| `verified` | Exact task-only change and new revision were read back. |
| `verified_noop` | Existing Task and unchanged revision were verified. |
| `rejected` | Server definitively rejected the request; no automatic retry occurred. |
| `outcome_unknown` | Connection, response, verification or receipt-save failure; do not retry. |

Power loss can leave `submitting` or `verifying` instead of `outcome_unknown`. Treat either as
uncertain. A receipt is not a database backup, and removing one does not undo a server edit.

For an interrupted or ambiguous edit, keep the receipt and use the same profile/state directory:

```bash
titra --profile production --output json record reconcile-task-edit RECEIPT_ID
```

Reconciliation is GET-only and leaves the original receipt unchanged:

| Result | Interpretation |
|---|---|
| `matches_proposed_change` | Current full record and ETag match the intended edit. |
| `matches_noop` | Current record matches the intended no-op. |
| `matches_before_snapshot` | Current record still matches the saved original. |
| `diverged` | Something differs; inspect before authorizing further action. |
| `record_unavailable` | Record is missing or no longer visible to this account. |

These are observations, not proof of who performed a change. `retry_safe` is always false.
There is no automatic edit retry or replay command. If another edit is needed, review current
state and authorize a new pinned edit. Never delete/recreate a record to work around a conflict.

The normal exit contract applies: 0 success; 2 invalid input/unsupported capability;
3 authentication; 4 conflict/not found/precondition; 5 remote error; 6 uncertain write outcome.
A server error after submission is treated conservatively as uncertain, even if it may have
occurred before a write. An unexpected response is not proof that nothing changed.

## API contract

`GET /capabilities/` is authenticated and returns the normal Titra envelope with this payload:

```json
{
  "apiVersion": 1,
  "features": {"timeEntryTaskUpdate": true},
  "taskUpdate": {
    "requiresIfMatch": true,
    "requiresExpectedTask": true,
    "maxTaskLength": 1000,
    "preservesOtherFields": true
  }
}
```

`PATCH /timeentry/task/:timecardId` requires `Content-Type: application/json`, authentication,
and one strong `If-Match` from `GET /timeentry/get/:timecardId`. The body is exactly:

```json
{"task":"Exact new Task", "expectedTask":"Exact old Task"}
```

Additional properties, malformed JSON, invalid Unicode, weak/list/wildcard ETags and non-string
names are rejected. Request bodies are bounded to 64 KiB. The success payload contains
`timecardId`, `task`, `previousTask`, `changed`, with the resulting ETag in the response header.
Changing a Task advances the revision by one; no-op does not. Revisions cannot exceed
JavaScript's safe integer limit.

Status codes: 400 malformed request, 401 failed authentication, 404 not found/not authorized,
405 wrong method, 409 stale Task/revision or concurrent change, 422 rule blocked, 428 missing
If-Match, 503 migration lock, and sanitized 500 for unexpected failures. Capabilities and edit
routes, as well as guarded preview routes, support OPTIONS preflight. CORS permits PATCH and
exposes ETag.

This documentation is not a claim that a particular server supports editing. Recheck the
advertised capability after every server deployment or upgrade.
