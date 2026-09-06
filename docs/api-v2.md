# Titra HTTP API

This document describes the expanded HTTP API and the compatibility and safety
contracts exposed by `/capabilities` and `/capabilities/v2`. The existing routes
continue to use the legacy `{ message, payload }` response envelope. The v2
capability and signed-webhook routes use versioned success or
`application/problem+json` error envelopes.

## Authentication

Send an API token in the `Authorization` header:

```http
Authorization: Bearer <token>
```

`Token <token>` remains accepted for compatibility. Tokens are write-only in the
settings page and are stored as a domain-separated SHA-256 digest. A valid legacy
plaintext token is migrated to the digest form on first use with an atomic,
same-user guard; ambiguous or conflicting migrations fail closed. Inactive users
cannot authenticate.

Clients that persist an account identity should also send
`X-Titra-Expected-User-Id`. A token resolving to a different user is rejected with
HTTP 412 before the endpoint performs work. `/user/me` returns the stable user ID
and display name needed to establish this pin.

All API responses are non-cacheable and advertise the supported CORS headers.
Authentication and authorization errors do not reflect tokens, database errors,
or private resource details.

## Discovery

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/capabilities` | Compatibility capability document in the legacy envelope. |
| `GET` | `/capabilities/v2` | Versioned feature, limit, precondition, error, and deployment contract. |
| `GET` | `/user/me` | Minimal authenticated identity (`_id` and display name). |

Clients should feature-detect rather than infer behavior from the application
version. `/capabilities/v2` is authenticated and reports whether optional project
fence recovery and the signed action-verification receiver are enabled.

## Projects

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/project/list` | Accessible projects; legacy array with a fixed maximum. |
| `POST` | `/project/create` | Create a project; accepts optional `Idempotency-Key`. |
| `GET` | `/project/get/:projectId` | Narrow preview and a strong `ETag`. Public previews omit membership and financial fields. |
| `PATCH` | `/project/details/:projectId` | Edit allowed details; requires JSON and `If-Match`. |
| `PATCH` | `/project/archive/:projectId` | Archive or restore; requires JSON and `If-Match`. |
| `DELETE` | `/project/delete/:projectId` | Owner-only hard delete of an empty project; requires JSON, `If-Match`, and the expected name. |
| `GET`, `POST` | `/project/recovery/:projectId` | Preview and explicitly recover a stale lifecycle fence. Disabled by default. |
| `GET` | `/project/users/:projectId` | Bounded users with recorded time; public callers receive pseudonymous IDs. |
| `GET` | `/project/tasks/:projectId` | Bounded project-task list. |
| `GET` | `/project/task/stats/:projectId` | Bounded planned-versus-recorded task totals. |

Project and task writes use revisions and compare-and-swap updates. Child creation,
moves, default-task changes, and deletion are fenced so a concurrent project
delete cannot orphan data. Stale fences can be inspected and recovered only by a
project administrator, after the minimum age, with an exact preview `ETag` and an
explicit acknowledgement. Recovery must additionally be enabled with
`TITRA_FENCE_RECOVERY_MODE=single-instance`; it is intentionally unsuitable for a
multi-instance deployment without external coordination.

## Project tasks and personal task suggestions

| Method | Path | Notes |
| --- | --- | --- |
| `POST` | `/project/task/create` | Administrator-only create; accepts optional `Idempotency-Key`. |
| `GET` | `/project/task/get/:taskId` | Preview, references, and strong `ETag`. |
| `PATCH` | `/project/task/details/:taskId` | Conditional detail edit. |
| `DELETE` | `/project/task/delete/:taskId` | Conditional delete with dependency/default/history acknowledgements where required. |
| `GET` | `/task-suggestions?limit=&cursor=` | Stable, owner-scoped keyset page. |
| `GET` | `/task-suggestions/get/:suggestionId` | Owner-only preview and `ETag`. |
| `DELETE` | `/task-suggestions/delete/:suggestionId` | Conditional owner-only delete. |

Project-task timestamps must be canonical UTC RFC 3339 values with milliseconds,
for example `2026-09-01T02:03:04.005Z`. Dependencies must exist in the same project.
Personal suggestions are separated from predefined project tasks and never carry
time-entry custom fields.

## Time entries

| Method | Path | Notes |
| --- | --- | --- |
| `POST` | `/timeentry/create` | Create after project and configured-rule checks; accepts optional `Idempotency-Key`. |
| `GET` | `/timeentry/get/:timecardId` | Owner-only record plus date-revision `ETag`. |
| `DELETE` | `/timeentry/delete/:timecardId` | Owner-only conditional delete using `If-Match`. |
| `PATCH` | `/timeentry/task/:timecardId` | Conditional task rename with exact expected old task. |
| `PATCH` | `/timeentry/details/:timecardId` | Conditional hours/project/calendar edit; legacy date conversion requires acknowledgement. |
| `GET` | `/timeentry/list/:date` | Bounded records for one owner calendar day. |
| `GET` | `/timeentry/daterange/:from/:to` | Bounded owner range, at most 366 inclusive days. |
| `GET` | `/timeentry/daterange-page/:from/:to?limit=&cursor=` | Stable owner keyset page. |
| `GET` | `/project/timeentries/:projectId` | Bounded accessible-project records. |
| `GET` | `/project/timeentriesfordaterange/:projectId/:from/:to` | Bounded accessible-project range, at most 366 days. |
| `GET` | `/project/timeentriesfordaterange-page/:projectId/:from/:to?limit=&cursor=` | Stable project keyset page. |

Calendar dates use `YYYY-MM-DD`; optional start times use `HH:mm`. Explicitly zoned
RFC 3339 timestamps remain accepted for legacy create compatibility. Paginated
ranges sort by date then ID, bind the opaque cursor to the complete query scope,
default to 200 rows, and permit at most 500. Legacy array endpoints use a sentinel
read and return an explicit error instead of silently truncating.

All time-entry writes participate in the date-migration writer lease. If a
migration owns the lease, writes return a temporary-unavailable response rather
than racing the migration. This branch provides only the lock/lease foundation;
the migration wizard and its history, backup, apply, and restore features are a
separate component.

## Atomic timer

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/timer/get` | Current timer state and strong `ETag`. |
| `POST` | `/timer/start` | Atomic start; an optional operation ID provides replay protection. |
| `POST` | `/timer/stop` | Atomic conditional stop; requires timer ID and `If-Match`. |

Concurrent starts have one winner. Operation receipts and revisions let clients
reconcile lost responses without starting or stopping the wrong timer.

## Idempotent creates and conditional writes

`/timeentry/create`, `/project/create`, and `/project/task/create` accept an
`Idempotency-Key` containing 16 to 128 safe characters. The key is hashed and
scoped to the authenticated user and operation. Replaying the exact request
returns the original result; reusing it for a different request is a conflict.
Receipts are retained for seven days. If a create may have succeeded but its result
cannot be confirmed, retry only with the same key.

Preview/read endpoints return strong Titra `ETag` values. Send that exact value in
`If-Match` for conditional writes. Missing preconditions return HTTP 428 on v2
routes or the equivalent legacy error; stale preconditions return HTTP 412/409 as
documented by `/capabilities/v2`.

## Signed action-verification webhook

Administrators create an inactive webhook mapping in the administration page.
The application generates a 32-hex-character endpoint ID and displays the required
environment variable name:

```text
TITRA_WEBHOOK_SECRET_<UPPERCASE_ENDPOINT_ID>
```

Set it to a canonical 32-byte base64url secret, restart the application, then
activate the mapping. Secrets are never submitted to or stored by Titra. Mapping
rules are bounded declarative JSON using RFC 6901 pointers; legacy executable
scripts and sender-domain trust are not used.

Send the exact JSON bytes to:

```http
POST /user/action-verification/webhook/<endpointId>
Content-Type: application/json
X-Titra-Webhook-Timestamp: <Unix seconds>
X-Titra-Webhook-Event-Id: <stable unique event ID>
X-Titra-Webhook-Signature: v1=<hex HMAC-SHA256>
```

The signature input is `<timestamp>.` followed by the exact request body bytes.
Timestamps may differ from server time by at most five minutes. Event receipts are
configuration-bound, replay-protected for seven days, processed with a fenced
lease, and preserve the original action time across a freshly signed retry. The
receiver is enabled only when the `enableUserActionVerification` global setting is
true.

## Resource and rate limits

Bodies, route parameters, strings, aggregation results, date ranges, and cursors
have fixed bounds. Aggregations disallow disk spill and have execution ceilings.
The in-process token buckets default to 300 unauthenticated requests per minute per
transport peer and 1,200 authenticated requests per minute per user. Operators can
set bounded integer overrides with:

- `TITRA_API_UNAUTHENTICATED_RATE_PER_MINUTE`
- `TITRA_API_AUTHENTICATED_RATE_PER_MINUTE`

Forwarded address headers are deliberately ignored by the limiter; the transport
peer address is used directly. Deployments behind a shared reverse proxy should
choose limits with that topology in mind.

## Development checks

Run the focused, dependency-free test suite with a supported Node.js runtime:

```sh
node --test
```

The tests cover authentication, token migration, limits, cursor stability,
idempotent recovery, resource revisions, lifecycle fences, atomic timers, signed
webhook verification, response contracts, and route wiring. A Meteor production
build remains the final integration check because the unit tests replace Meteor
imports with explicit fixtures.
