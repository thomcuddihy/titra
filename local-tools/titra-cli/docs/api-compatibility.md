# Titra API compatibility

The CLI uses Titra's token API and negotiates these optional compatibility endpoints:

- `GET /timeentry/get/:id` — owned record plus a strong revision ETag.
- `DELETE /timeentry/delete/:id` — owner-only, requires the ETag through `If-Match`.
- `GET /user/me` — `_id` and display `name` only.
- `GET /project/users/:projectId` — IDs/names referenced by records on a project where the
  caller is an owner, administrator, or team member.

Deletion reuses Titra's time-entry rule, migration lock, writer lease, ownership check, and
compare-and-swap behavior. A stale preview returns a conflict instead of deleting changed data.

Servers without these additions can still list and create projects and records and use the timer,
but `doctor` reports missing capabilities. Safe record deletion and named team reporting require
the corresponding advertised endpoints.

## Task-edit extension

Task editing is available only when the server provides both endpoints and advertises the exact
contract. Installing or upgrading the CLI does not add server support.

- `GET /capabilities/`: authenticated, versioned discovery. Task editing requires
  `features.timeEntryTaskUpdate=true` and the advertised task-only/precondition contract.
- `PATCH /timeentry/task/:id`: owner-only Task update, requiring an exact `expectedTask` and
  the preview's strong `If-Match` ETag. No other body fields are accepted.

The CLI never infers PATCH support from `/user/me` or a version string, and never probes a
write to discover support. An old server returning an HTML application page for capabilities
is treated as unsupported. Authentication errors remain authentication errors.

GET snapshots support both numbered revisions and the legacy
`"titra-date-revision-legacy"` ETag. An actual legacy task change adds revision 1 without
converting its date fields. A no-op preserves the legacy shape and ETag. Readback checks all
record fields, not only the new Task. See `task-editing.md` for the complete API contract.

Related changes in this source version enforce inactive-account rejection, explicit
Bearer/Token authentication, POST-only creation, terminal malformed-JSON errors, API record
creation rules, and OPTIONS support for guarded routes. Browser CORS now includes PATCH and
exposes ETags. Deployments depending on formerly accepted arbitrary authorization schemes or
non-POST creation calls must update those clients.

Known behavior on older/stock servers handled by the client:

- `/timer/start` may return an empty start timestamp; the client immediately reads `/timer/get`.
  Newer compatible servers return the authoritative timestamp directly.
- Some validation/conflict responses use HTTP 500.
- Create operations have no idempotency key; ambiguous responses are never blindly retried.
- Result sets are not paginated; the CLI chunks date ranges and requires project filters for
  team-wide reads.
- Titra returns raw schemaless records, so unknown fields are tolerated.

## V6 discovery and compatibility boundary

V6 exposes two authenticated discovery documents for different purposes:

- `GET /capabilities/` remains the frozen `apiVersion: 1` document used by
  task-edit-era clients. It continues to advertise the compatible task-edit,
  idempotent-create and paging additions.
- `GET /capabilities/v2/` returns a v2 envelope whose payload has
  `apiVersion: 2` and `capabilitiesVersion: 2`. This is the normative contract
  for project/task lifecycle operations, time-entry detail editing, personal
  suggestions, atomic timers, project-user privacy, fence recovery and the
  signed webhook receiver.

The CLI tries v2 first and falls back to v1 only when the v2 endpoint is
definitely absent (HTTP 404 or an old Meteor HTML fallback at HTTP 200). An
authentication error, server failure, or malformed v2 document is never
silently downgraded. `titra capabilities show` displays the negotiated document
and `titra capabilities check --require-v6` verifies the complete v6 shape
without probing a mutation.

Most bearer-token routes intentionally retain the legacy v1 response envelope.
The capability document labels that boundary as `legacy-v1-envelope`. The v2
discovery route and signed webhook use sanitized
`application/problem+json` errors with request ID, outcome and retry metadata.

## V6 creation and paging extensions

Duplicate-safe creation and stable cursor paging are advertised by both the
appropriate compatibility document and the normative v2 contract; clients
must not infer either feature from an image/version label.

`Idempotency-Key` is optional for compatibility. Supporting clients persist one key before
posting and reuse it only for the exact same authenticated-user/operation/payload tuple. Results
are durable for the advertised retention period. Existing unkeyed clients keep their previous
semantics.

The two `*-page` date-range endpoints return `{items,page}`. Existing range routes retain their
array payloads; v6 does not silently change an old response shape based on a server upgrade.
See `idempotency-and-pagination.md` for paths, metadata, recovery and concurrency limits.

## V6 project fence recovery

The v2 capability document must advertise `features.projects.fenceRecovery=1`,
`contracts.projectFenceRecovery=1`, and
`deployment.projectFenceRecoveryEnabled=true`. The CLI will not probe the mutation on older or
deployment-disabled servers.
The feature is implemented but default-disabled. It may be advertised only when the deployment
sets exact `TITRA_FENCE_RECOVERY_MODE=single-instance`; absence, spelling/case variants, or any
other value must leave it disabled. Multi-process deployments must not use this mode because a
different boot ID does not prove another live process has stopped.

- `GET /project/recovery/:projectId` is owner/administrator-only and returns bounded public
  classifications plus a strong ETag. The ETag excludes elapsed `ageMs` but binds the exact raw
  fence fields—including hidden boot IDs and task fingerprints—and the stable classification.
- `POST /project/recovery/:projectId` requires that ETag and exactly
  `{type,recoveryId,acknowledgeStaleFence:true}`. Type is `writer` or `task-delete`.

The server re-previews and then performs a live exact compare-and-swap. It never blindly clears
legacy/untracked, same-process, recent, malformed, mixed, changed, or unexpected-resource state.
A transport, 5xx, malformed-success, or missing-result-ETag response is outcome-unknown; clients
must inspect current state before considering another explicit attempt.

## V6 endpoint coverage in Titra CLI 0.2

The CLI directly exposes the bounded API surface as follows:

| Server function | CLI surface |
|---|---|
| Identity and discovery | `auth check`, `doctor`, `capabilities show/check` |
| Project list/create/read/users | `project list/create/show/users` |
| Project edit/archive/restore/empty delete | `project edit/archive/restore/delete` |
| Project fence inspection/recovery | `project recovery inspect/recover` |
| Predefined task list/create/read/edit/delete/stats | `task list/create/show/edit/delete/stats` |
| Time entry create/read/delete/task edit/details edit/ranges | `record create/show/delete/edit-task/edit-details/list` |
| Personal task suggestions | `suggestion list/show/delete` |
| Atomic server timers | `timer start/status/stop` and local pause/resume/draft recovery |
| Signed action-verification receiver | `webhook prepare/send` with a separate HMAC secret |

The old unbounded project-time-entry and single-day list routes are not exposed
as separate commands: bounded range retrieval subsumes them and allows the CLI
to use v6 cursor paging. Webhook configuration is administered in Titra, not
through the token API; the CLI only constructs and optionally sends a signed
event. See `webhooks.md`. The complete route-to-command map, including an interactive dashboard
path and noninteractive example for every v6 endpoint, is in `v6-endpoint-guide.md`.

## V7 read-availability limits

V7 applies a 500-record ceiling to legacy array-returning project, user, task, task-statistics,
and time-entry reads. The server queries one additional sentinel record and returns HTTP 413
when the ceiling is exceeded; it never returns an apparently complete, silently truncated array.
The legacy time-entry error directs clients to the corresponding cursor-paginated range route.

Both legacy and cursor-paginated time-entry ranges accept at most 366 inclusive calendar days.
The CLI already splits requested ranges into 90-day windows, so this protection does not reduce
the date spans users can request through the CLI. Project-user and task-statistics aggregation
uses a five-second database execution deadline with disk spilling disabled. Task statistics are
calculated with one grouped query instead of one query for each task.

## V7 security discovery and CLI 0.3

V7 keeps the endpoint paths, `apiVersion: 2`, v2 response envelope, and resource lifecycle
contracts above. Its `/capabilities/v2/` payload raises `capabilitiesVersion` to 3 and adds the
exact `security-v7` policy contract plus typed deployment booleans. The CLI accepts both reviewed
v6 and v7 documents for normal compatible operations. `capabilities check --require-v7` is stricter:
it requires the exact v7 policy document and the independently observed HTTP response-header
profile before declaring a v7 deployment ready.

The reported deployment policy includes `oauthEncryptionConfigured`. It reveals only whether the
server has an encryption key, never the key, ciphertext, OAuth tokens, or integration credentials.

Hashed API-token migration, inactive-user rejection, verification-deadline suspension, OIDC
identity behavior, server-side integration proxying, public-project disablement, legacy-script
policy, and HSTS enablement are security policy rather than new bearer-token resource endpoints.
The document exposes those properties without probing a mutation or revealing a secret. An
overdue verification gate and a rate-limit rejection have distinct client handling, while v5/v6
servers retain their established behavior.
