# Security model

## Credentials

Precedence is command flags, environment, explicit credential file, current-directory file,
then home file. Server/token pairs are atomic: the client never combines a token from one file
with a server from another. Flags/environment must provide both values together.

Supported variables are `TITRA_PROFILE`, `TITRA_SERVER`/`TITRA_URL`,
`TITRA_API_KEY`/`TITRA_API_TOKEN`, `TITRA_USERNAME`, and `TITRA_TIMEZONE`.

Credential files must be regular, non-symlink files. POSIX files must be owned by the current
user and inaccessible to group/other users. Reads use `O_NOFOLLOW` where available. Writes use a
private temporary file, `fsync`, and atomic replacement. API tokens are never written to local
drafts, receipts, output, or logs and are always completely redacted.

Passing a token as `--api-key` remains supported because it was requested, but may expose it in
shell history and process listings. Files or environment injection are safer.

## Transport

HTTPS certificate verification is enabled by default. Non-loopback HTTP is rejected unless
`--insecure` is supplied. Redirect following is disabled so an Authorization header cannot be
forwarded to a redirected origin.

## Mutations

Automated mutations require `--yes`. On v6, project/task/time creation is journaled before the
POST and may be resumed only with the exact original idempotency key and payload. The server
stores only a user/operation-scoped hash of the key. The CLI records the first attempt and stops
replay 600 seconds before the v6 contract's 604800-second retention boundary (at age 604200);
expired state remains available for reconciliation but is not modified or posted. Older servers are never retried blindly and
still require reconciliation after an ambiguous time-record response. Deletion is exact-ID
only, owner-only, ETag-guarded, and preceded by a private JSON recovery receipt. CSV/TSV exports
prefix formula-like text cells to prevent spreadsheet formula execution.

The authenticated user, operation, key hash, and exact request fingerprint bind every server
receipt. An exact completed receipt or exact already-written reserved resource can therefore be
returned even if mutable project access, rules, migration state, administrator status, or task
dependencies changed after the original commit. This recovery performs no derived task-suggestion
write. If another request observes a reserved receipt with no exact resource, it fails closed and
does not create: the server cannot distinguish an in-flight write from a resource deliberately
deleted after a lost completion response. Only the request that inserted a new reservation may
begin creation. A brand-new key rejected by access, rule, administrator, or dependency checks is
denied before a receipt is reserved.

Task edits are also exact-ID and owner-only. They require both the old Task and revision,
respect project access, migration locks and the time-entry rule, and modify only Task plus
revision metadata. A private edit receipt must be durable before the single PATCH request.
Afterwards the CLI reads the complete record back and checks every other field. No edit is
automatically retried, including a timeout or malformed response. Reconciliation is GET-only
and never grants permission to retry. See `task-editing.md` for recovery states.

Project safety-fence recovery is a separate, deliberately narrow v6 maintenance mutation. It is
available only to the project owner or an administrator, requires explicit advertised support,
a fresh strong ETag, an exact target ID, a minimum stale age, a different process boot, and an
explicit `acknowledgeStaleFence=true`. The server binds the ETag to hidden exact fence metadata
without returning that metadata. The CLI submits only targets marked recoverable by its fresh
preview. An uncertain response is never automatically retried; inspect current state first.

Recovery is disabled by default. It is enabled only when the server has the exact setting
`TITRA_FENCE_RECOVERY_MODE=single-instance` and advertises
`deployment.projectFenceRecoveryEnabled=true`. This setting is an operator assertion that only
one application process can be live; a different boot ID alone does not prove that another
process has stopped. Never enable recovery in a horizontally scaled or multi-process deployment.

An edit receipt is an audit/recovery reference, **not** a database backup or automatic restore
instruction. Restoring an old Task is a new guarded edit against the current revision and needs
the operator's approval. Task editing does not add/remove autocomplete or predefined tasks.

## Local state

Timer journals, drafts, and receipts live in the platform state directory (or `--state-dir`) with
private permissions. Existing state roots, descendant directories, files, and locks are rejected
if they are symlinks, not owned by the current POSIX user, or grant group/other access; the CLI
does not silently repair them. Descriptor-relative, no-follow reads and atomic replacements keep
a directory-path swap from redirecting a journal. Atomic writes and lock files prevent concurrent
state damage.
Each finalize, submit, stop recovery, reconciliation, retry, or discard also takes a per-draft
operating-system lock for the complete operation, including network calls. This lock has no timed
lease that can expire during a slow request; another process fails closed, and process death makes
the lock available again. Once acquired, the operation reloads the draft rather than applying a
stale in-memory copy.
Active-timer and pending-start filenames use a digest of the complete profile name and canonical
server, so profiles with the same long display prefix cannot collide. Files created by the older
truncated-profile scheme are detected but never moved or overwritten automatically: ordinary
timer commands fail closed, while an exact snapshot-guarded `timer adopt` may establish a new
unambiguous binding and leaves the legacy file available for manual recovery.
Active timers, pending starts, and drafts persist the immutable authenticated `/user/me` ID. Every
project, task, record, suggestion, timer, or recovery mutation makes `/user/me` its first
authenticated request, then sends that immutable ID as a precondition on all subsequent reads and
writes. A concurrently reassigned token therefore fails instead of switching the reviewed
resource or account. Older ownerless state remains readable but fails closed; an exact snapshot-guarded
`timer adopt` is the deliberate migration path for an active timer, including a legacy null-ID
timer. Pending starts and drafts are never automatically rebound after credential rotation.
Recovering a pending v6 start also requires the exact per-user consumed-operation-ID contract. A
GET miss can replay only before age 604200 (600 seconds inside the advertised seven-day window),
and a previously stopped operation ID returns the exact `timer-operation-consumed` conflict. Only
that exact response conclusively clears the pending receipt; other conflicts preserve it.
Before a v6 timer stop, the CLI resolves requested record metadata, reads the current timer, and
requires an exact stop confirmation; noninteractive use requires `--yes`. It then stores only the
reviewed timer ID and fresh revision ETag (never the API token) before POST. `draft recover-stop`
can therefore retry the same server CAS and recover its bounded receipt without stopping a
replacement timer. An optional `--expect-timer-id` pins an earlier observation; noninteractive
cancellation requires that explicit ID. If interruption occurs after the stop request is journaled, even
`KeyboardInterrupt` or process death leaves the `pending_stop` draft recoverable. A fresh stop
accepts only a real Boolean `changed=true`; `changed=false` is consumed only by exact
`draft recover-stop`, preventing two clients from producing drafts for one interval.
Cancellation journals `discard_after_stop=true` before the stop request and changes the receipt
directly to `discarded` while still holding its operation lock. It is never briefly exposed as a
submittable draft, and exact recovery after a lost stop response preserves the discard intent.
Finalizing, reconciling, retrying, submitting, or discarding a draft first checks its saved
profile, server, and immutable owner. Discard is therefore authenticated, not an unaudited local
bypass.
The state contains task descriptions, record contents, and idempotency keys but never API
tokens; it should still be treated as confidential. Normal receipt display redacts idempotency
keys. Keep state receipts until their mutations are completed or deliberately reconciled.

`timer status` never adopts an unrelated server timer as a side effect. It reports that timer as
unbound; only an exact matching pending-start intent is promoted automatically. Use guarded
`timer adopt` (or an exact stop/cancel timer ID after reviewing the preview) before mutation.
Every authenticated mutation is also pinned to the immutable user ID read from `/user/me` via
the v6 expected-user header. Automation may supply the same pin explicitly with the global
`--expect-user-id` option so a token reassignment between processes fails before side effects.

## Automated live tests

The v5 test runner has no API-token argument. It obtains the token from a named environment
variable or hidden prompt, injects it into child CLI processes, captures rather than echoes real
API data, and redacts secrets from diagnostics. Live checks are read-only unless the operator
supplies `--allow-write-tests` and an explicit project.

The write check creates only a uniquely labelled one-minute record. Before cleanup it verifies
the exact returned ID, selected project, and unique label; it then uses the normal ETag-guarded
deletion command and confirms absence. It never creates projects or predefined tasks because
they have no matching safe delete endpoints. See `live-v5-testing.md` for recovery behavior.

The v6 runner additionally accepts a private credential file/profile as one atomic source. Its
read-only phase requires exact equality with the reviewed `/capabilities/v2/` contract before a
separate `--allow-v6-mutation-tests` opt-in can create anything. That mutation suite owns a
unique disposable project and records every created ID plus its marker in a private, secret-free
recovery manifest. Cleanup re-reads and identity-checks each record, suggestion, task, and
project before deletion. Failed or interrupted mutation runs preserve the manifest and CLI
receipts for manual reconciliation. Timer mutation requires the additional
`--allow-v6-timer-tests` opt-in and an empty-timer preflight; webhooks and safety fences are
never mutated by the general runner. See `live-v6-testing.md`.

Webhook sends use a private fsynced local receipt before dispatch. It retains the exact body only
as base64 plus public request metadata, never the HMAC secret, signature, or API token. Receipt
listing and inspection omit the encoded body. Retry is bound to the original profile, normalized
server, authentication mode and (when present) immutable API owner, holds a non-expiring OS lock
through dispatch, and fails closed at age 604200, leaving a 600-second safety margin inside the
v6 604800-second retention boundary. Bodies or receipt fields containing a configured API/HMAC
credential are rejected before persistence or delivery.
