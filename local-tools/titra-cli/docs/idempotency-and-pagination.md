# Durable creation and complete paging

The v6 API extension adds two independent, explicitly advertised contracts. Older servers and
clients remain usable: all existing routes keep their array payloads, and creation without an
`Idempotency-Key` keeps its previous behavior.

## Duplicate-safe creation

The capability document advertises `features.idempotentCreate=true` and a version 1
`idempotency` block. Supported operations are `timeentry.create`, `project.create`, and
`project-task.create`.

A supporting client sends an `Idempotency-Key` containing 16–128 visible ASCII characters.
The CLI generates 32 hexadecimal characters and persists the key before its first POST. The
server scopes it by authenticated user and operation, hashes it, and never stores the raw key.

- The first request reserves one final resource ID and creates that exact ID.
- The same key and same normalized payload returns the original result.
- The same key with a different payload returns a conflict and creates nothing.
- If the process or response fails after insertion, a retry with the same key recovers the
  preallocated resource instead of creating another.
- Exact completed results and exact preallocated resources are recovered before consulting
  mutable project access, time-entry rules, migration state, administrator status, or task
  dependencies. This keeps a committed write recoverable after those settings change. If another
  request observes a reserved operation whose target is absent, it fails outcome-unknown and never
  creates: absence cannot distinguish a write that has not landed from a committed resource that
  was deliberately deleted. Only the request that first inserted the reservation may begin the
  create. A brand-new request denied by access, rule, administrator, or dependency checks creates
  no receipt row.
- Completed results are replayable for exactly 604800 seconds (seven days), and the public
  `Idempotency-Expires-At` header retains that exact deadline. Mongo keeps the private tombstone
  for an additional 24-hour TTL safety grace so asynchronous deletion cannot recreate a resource
  near the boundary; the grace is not an additional supported replay window. A reserved operation
  is retained longer so an interrupted create can recover its exact resource if that resource
  appears, while an absent resource remains a fail-closed tombstone rather than being recreated.

Titra's common Docker recipe runs standalone MongoDB, not a replica set. The implementation
therefore does not claim a cross-collection transaction. A unique durable reservation chooses
the resource ID, and the single target-document insert is the visibility/commit point. Every
later step is recoverable from those two facts. This gives duplicate-safe creation without a
replica-set migration.

Time-record drafts keep one key per payload. On v6, resubmitting an interrupted draft reuses
those keys. On an older server, the CLI retains the conservative reconciliation-first behavior.
Only an explicit `404 Not Found` from capability discovery is treated as an older server. A
network, proxy, or server failure while reading capabilities aborts the command instead of
silently downgrading a create to an unprotected request.
Project and predefined-task creates write a private creation receipt before posting. Inspect
them with:

```bash
titra creation list
titra creation show RECEIPT_ID
titra creation retry RECEIPT_ID --yes
titra creation verify-replay RECEIPT_ID --expect-result-id RESULT_ID --yes
titra draft verify-replay DRAFT_ID --expect-result-id RECORD_ID --yes
```

`show` redacts the key. `retry` is accepted only when the same server advertises the matching
idempotency operation and the authenticated user's immutable ID matches the owner saved before
the original POST; it always sends the original payload and key. A normal first create accepts
only exact `Idempotency-Replayed: false`. Recovery accepts exactly `false` (the saved POST never
established a server reservation, so this request was the server's first accepted attempt and
created the reserved resource) or `true` (the saved POST committed and
the server returned that same result), and reports which occurred together with the validated
expiry. Any other/missing header or malformed result remains outcome-unknown. Multi-record drafts
use recovery semantics only for the first unjournaled request; after its result ID is durably
saved, later payloads are fresh creates. Legacy receipts without owner binding remain inspectable
but cannot be submitted.

`verify-replay` is deliberately separate from recovery. It accepts only a completed creation
receipt or fully submitted record draft, requires each stored result ID again on the command
line, and journals `replay_verifying` before sending the original byte-equivalent JSON and key.
Success requires the same result ID plus exact `Idempotency-Replayed: true` and a valid future
expiry header. It does not mint a key or replace the original status, payload, key, owner, or
result. A lost or contradictory replay response is recorded as uncertain while the original
completion evidence remains intact. Repeat `--expect-result-id` in draft order for a multi-record
draft.

Before every resumed creation or record-draft submission, the CLI checks the immutable owner,
profile, exact server, first-submission timestamp, and advertised retention contract. The server
guarantees 604800 seconds; the CLI refuses replay during the final 600 seconds, beginning at age
604200 seconds, so confirmation and transport cannot overrun that guarantee. It refuses before
changing the receipt or making an API request. The same fail-closed rule applies to old attempted
drafts that predate the explicit first-submission field, using their creation timestamp as the
conservative boundary. Reconcile the server and recover manually; a reused key is no longer
guaranteed to suppress a duplicate.

Do not copy a key to an unrelated request or delete a receipt whose status is `submitting` or
`outcome_unknown`.

## Stable, complete paging

The v6 capability document advertises `features.timeEntryPagination=true` and a version 1
`timeEntryPagination` block. The CLI then uses:

- `GET /timeentry/daterange-page/:from/:to`
- `GET /project/timeentriesfordaterange-page/:projectId/:from/:to`

`limit` is 1–500 (the CLI requests 200). `cursor` is an opaque token bound to the caller or
project and exact date range. Entries are ordered by stored `date`, then `_id`, so records with
the same timestamp cannot be skipped at a page boundary. A response payload has this shape:

```json
{
  "items": [],
  "page": {
    "version": 1,
    "limit": 200,
    "returned": 0,
    "complete": true,
    "nextCursor": null,
    "consistency": "live-keyset"
  }
}
```

The client drains pages until `complete` is true. It rejects malformed metadata, missing or
repeated cursors, and records without IDs. Duplicate IDs caused by a record moving while a live
query is running are retained once and reported in metadata.

`live-keyset` is stable when non-sort fields such as Task change. Standalone MongoDB cannot
provide one snapshot across multiple HTTP requests: inserts or date edits during traversal can
change membership. Run audit-grade exports during a quiet/maintenance interval. The API never
silently truncates a page, and CLI report/list metadata says whether completeness was proven.

Old servers continue to use the legacy date-range arrays in 90-day chunks. They did not publish
server-side completeness metadata, so CLI output marks those results
`legacy-array-unverified` rather than making an unsupported completeness claim.

`record list --limit` is a display limit only. The CLI first fetches the complete dataset for
the selected range, then reports `matched`, `returned`, and `truncated`. Summary, timesheet, and
calendar reports always consume every page.
