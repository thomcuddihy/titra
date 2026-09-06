# V6 endpoint and CLI guide

This page maps every bearer-authenticated endpoint in the reviewed v6 API surface, plus the
separately authenticated webhook receiver, to both an interactive workflow and a scriptable
command. The CLI deliberately owns revision, identity, paging, and idempotency details; do not
re-create its raw HTTP writes with `curl` for routine operation.

The examples use these placeholders:

- `PROFILE` — a configured CLI profile;
- `PROJECT`, `TASK_ID`, `RECORD_ID`, and `SUGGESTION_ID` — exact IDs or, where the command permits,
  an unambiguous project name;
- `CURRENT_TIMER_ID` — the exact ID returned by `timer status`; and
- `RECOVERY_ID` — an exact recoverable ID returned by `project recovery inspect`.

Start the dashboard with `titra --profile PROFILE interactive`. In the tables, an interactive
path beginning with a command means to run that command in a terminal without `--yes`; it shows
the same preview and confirmation used by the dashboard. Scriptable mutation examples include
`--yes` and therefore perform a write. Use only synthetic resources until the workflow has been
reviewed.

## Discovery and identity

| Method and endpoint | Interactive example | Noninteractive example |
|---|---|---|
| `GET /capabilities/v2` | Connection, capabilities, and webhooks → Require complete v6 capabilities | `titra --profile PROFILE --output json capabilities check --require-v6` |
| `GET /user/me` | Connection, capabilities, and webhooks → Authentication check | `titra --profile PROFILE --output json auth check` |

`doctor` also reads the negotiated discovery and identity endpoints and summarizes the usable
surface: `titra --profile PROFILE --output json doctor`.

Before an attended or automated session, read `/user/me`, retain its exact `_id`, and
pass it globally as `--expect-user-id USER_ID`. The CLI then sends
`X-Titra-Expected-User-Id: USER_ID` on every authenticated request. The
server advertises this optional compatibility contract as `contracts.expectedUserId` version 1;
its scope is `authenticatedRequests`, and a mismatch returns a definite HTTP 412 precondition
rejection before route work begins. Mutation routes retain their legacy response envelope, while
the v2 discovery route returns `PRECONDITION_FAILED`. Stop and inspect
credentials if that happens—do not silently rebind the operation to the newly authenticated user.

## Projects and project reads

| Method and endpoint | Interactive example | Noninteractive example |
|---|---|---|
| `GET /project/list` | Projects and recovery → List active | `titra --profile PROFILE --output json project list` |
| `GET /project/get/:projectId` | Projects and recovery → Show | `titra --profile PROFILE --output json project show PROJECT` |
| `POST /project/create` | Projects and recovery → Create | `titra --profile PROFILE --output json project create 'Synthetic API check' --description 'Disposable test' --yes` |
| `PATCH /project/details/:projectId` | Projects and recovery → Edit details | `titra --profile PROFILE --output json project edit PROJECT --changes '{"description":"Reviewed description"}' --yes` |
| `PATCH /project/archive/:projectId` (archive) | Projects and recovery → Archive | `titra --profile PROFILE --output json project archive PROJECT --yes` |
| `PATCH /project/archive/:projectId` (restore) | Projects and recovery → Restore | `titra --profile PROFILE --output json project restore PROJECT --yes` |
| `DELETE /project/delete/:projectId` | Projects and recovery → Delete an empty project | `titra --profile PROFILE --output json project delete PROJECT --expect-name 'Synthetic API check' --if-match '"titra-project-revision-REV"' --yes` |
| `GET /project/users/:projectId` | Projects and recovery → Observed users | `titra --profile PROFILE --output json project users PROJECT` |
| `GET /project/tasks/:projectId` | Predefined tasks and statistics → List | `titra --profile PROFILE --output json task list PROJECT` |
| `GET /project/task/stats/:projectId` | Predefined tasks and statistics → Planned versus actual statistics | `titra --profile PROFILE --output json task stats PROJECT` |
| `GET /project/recovery/:projectId` | Projects and recovery → Safety-fence recovery → Inspect | `titra --profile PROFILE --output json project recovery inspect PROJECT` |
| `POST /project/recovery/:projectId` | Projects and recovery → Safety-fence recovery → Clear one server-verified stale fence | `titra --profile PROFILE --output json project recovery recover PROJECT --type writer --recovery-id RECOVERY_ID --yes` |

Fence recovery is deployment-gated and is not a routine repair command. First inspect, confirm
the reported candidate is recoverable, and use the exact type and ID from that fresh response.
Never guess a recovery ID or retry an outcome-unknown recovery POST without inspecting again.

## Predefined project tasks

| Method and endpoint | Interactive example | Noninteractive example |
|---|---|---|
| `POST /project/task/create` | Predefined tasks and statistics → Create | `titra --profile PROFILE --output json task create PROJECT 'Synthetic task' --start 2026-09-03 --end 2026-09-03 --estimated-hours 0.05 --custom-fields '{"testRun":"RUN_ID"}' --yes` |
| `GET /project/task/get/:taskId` | Predefined tasks and statistics → Show | `titra --profile PROFILE --output json task show TASK_ID` |
| `PATCH /project/task/details/:taskId` | Predefined tasks and statistics → Edit | `titra --profile PROFILE --output json task edit TASK_ID --changes '{"estimatedHours":0.1}' --yes` |
| `DELETE /project/task/delete/:taskId` | Predefined tasks and statistics → Delete | `titra --profile PROFILE --output json task delete TASK_ID --expect-project-id PROJECT --expect-name 'Synthetic task' --if-match '"titra-project-task-revision-REV"' --acknowledge-recorded-entries --yes` |

The delete acknowledgement does not alter historical records. It only confirms that those
records may continue to contain the deleted task's text.

## Time entries and bounded paging

| Method and endpoint | Interactive example | Noninteractive example |
|---|---|---|
| `POST /timeentry/create` | Time records → Create | `titra --profile PROFILE --output json record create --project PROJECT --task 'Synthetic work' --date 2026-09-03 --hours 0.017 --rate 100.125 --custom-fields '{"testRun":"RUN_ID"}' --yes` |
| `GET /timeentry/get/:timecardId` | Time records → Show | `titra --profile PROFILE --output json record show RECORD_ID` |
| `PATCH /timeentry/task/:timecardId` | Time records → Edit Task | `titra --profile PROFILE --output json record edit-task RECORD_ID --task 'Reviewed task' --yes` |
| `PATCH /timeentry/details/:timecardId` | Time records → Edit date, duration, start, or project | `titra --profile PROFILE --output json record edit-details RECORD_ID --changes '{"hours":0.033}' --yes` |
| `DELETE /timeentry/delete/:timecardId` | Time records → Delete | `titra --profile PROFILE --output json record delete RECORD_ID --expect-project-id PROJECT --expect-task 'Synthetic work' --if-match '"titra-date-revision-REV"' --yes` |
| `GET /timeentry/daterange-page/:fromDate/:toDate` | Time records → List, then choose dates and no project | `titra --profile PROFILE --output json record list --from 2026-09-01 --to 2026-09-30 --api-page-size 100 --raw` |
| `GET /project/timeentriesfordaterange-page/:projectId/:fromDate/:toDate` | Time records → List, choose the project and include its team | `titra --profile PROFILE --output json record list --from 2026-09-01 --to 2026-09-30 --project PROJECT --team --api-page-size 100 --raw` |

On v6, the CLI always drains the stable cursor pages, rejects malformed or repeated cursors,
deduplicates IDs observed during a live scan, and reports completion metadata. `--limit` limits
display only; `--api-page-size` controls each server page.

The server also retains four array-style compatibility reads. Each user workflow remains
available, but the v6 CLI intentionally fulfils it through a bounded page endpoint:

| Compatibility endpoint | Interactive equivalent | Scriptable equivalent on v6 |
|---|---|---|
| `GET /timeentry/list/:date` | Time records → List → choose one date | `titra --profile PROFILE --output json record list --from 2026-09-03 --to 2026-09-03 --raw` |
| `GET /timeentry/daterange/:fromDate/:toDate` | Time records → List → choose a date range | `titra --profile PROFILE --output json record list --from 2026-09-01 --to 2026-09-30 --raw` |
| `GET /project/timeentries/:projectId` | Time records → List → choose a project, its team, and a bounded period | `titra --profile PROFILE --output json record list --project PROJECT --team --calendar-month 2026-09 --raw` |
| `GET /project/timeentriesfordaterange/:projectId/:fromDate/:toDate` | Time records → List → choose a project, its team, and a date range | `titra --profile PROFILE --output json record list --project PROJECT --team --from 2026-09-01 --to 2026-09-30 --raw` |

These equivalents use the bounded page routes whenever stable v6 paging is advertised. The CLI
uses an array endpoint automatically only as a compatibility fallback for an older server. A
finite explicit date range is required instead of offering an unbounded all-history query.

## Personal task suggestions

| Method and endpoint | Interactive example | Noninteractive example |
|---|---|---|
| `GET /task-suggestions` | Personal task suggestions → List | `titra --profile PROFILE --output json suggestion list --page-size 100` |
| `GET /task-suggestions/get/:suggestionId` | Personal task suggestions → Show | `titra --profile PROFILE --output json suggestion show SUGGESTION_ID` |
| `DELETE /task-suggestions/delete/:suggestionId` | Personal task suggestions → Delete | `titra --profile PROFILE --output json suggestion delete SUGGESTION_ID --expect-name 'Synthetic work' --if-match '"titra-task-suggestion-revision-REV"' --acknowledge-referenced-records --yes` |

Deleting a suggestion never renames or deletes existing time entries.

## Atomic timers

| Method and endpoint | Interactive example | Noninteractive example |
|---|---|---|
| `POST /timer/start` | Timer → Start detached timer | `titra --profile PROFILE --output json timer start --project PROJECT --task 'Synthetic work' --operation-id operator-check-0001` |
| `GET /timer/get` | Timer → Status | `titra --profile PROFILE --output json timer status` |
| `POST /timer/stop` | Timer → Stop and finalize | `titra --profile PROFILE --output json timer stop --expect-timer-id CURRENT_TIMER_ID --draft-only --yes` |

`timer cancel --expect-timer-id CURRENT_TIMER_ID --yes` also uses the guarded stop endpoint but
records locally that the stopped timer was intentionally discarded. The exact ID is mandatory for
noninteractive cancellation. See [Timed work](usage.md#timed-work) for durable pending
start, adoption, stop-receipt, and record-submission recovery.

Timer transition contract v2 binds each caller-supplied start operation ID to one user. Replaying
it while that timer is active returns the existing timer; replaying it after the timer was stopped
is a conflict with code `timer-operation-consumed` and never starts a second timer. This
protection is guaranteed for 604800 seconds.
Recovery stops 600 seconds before that boundary. The server retains at most 4096 unexpired IDs and
privately keeps each for one additional day as a clock-skew and cleanup margin; that extra day is
not a supported retry window, and retained IDs are never evicted merely to make room.

## Signed action-verification webhook

| Method and endpoint | Interactive example | Noninteractive example |
|---|---|---|
| `POST /user/action-verification/webhook/:endpointId` | Connection, capabilities, and webhooks → Send signed webhook | `titra --profile PROFILE --output json webhook send --endpoint-id 0123456789abcdef0123456789abcdef --event-id synthetic-event-0001 --file ./event.json --secret-file /private/webhook-secret --yes` |

The webhook uses its own 32-byte HMAC secret and never sends the Titra API token. Use Prepare
signed webhook in the same interactive menu, or replace `send` with `prepare`, to validate and
preview the exact destination, IDs, headers, byte count, and body digest without sending. The
strict destination and accepted-response rules are documented in [Signed action-verification
webhooks](webhooks.md).

Every send first creates a private durable receipt. The same interactive menu provides List
webhook receipts, Show webhook receipt, and Retry journaled webhook. Scripted equivalents are
`webhook list`, `webhook show RECEIPT_ID`, and
`webhook retry RECEIPT_ID --secret-file /private/webhook-secret --yes`. Retry reuses the exact
endpoint, event ID, and body bytes and creates a fresh request ID and authentication timestamp.
Receiver v3 retains the first accepted timestamp for action ordering, so a retry cannot
masquerade as a newer event. An unfinished receipt is also bound to the interface configuration
revision that first claimed it; a changed mapping returns a conflict instead of remapping the old
body. Completed same-body receipts remain generically accepted. The CLI uses the contract's
600-second safety margin and refuses retry before the advertised 604800-second replay deadline.

## V1 discovery compatibility

`GET /capabilities` is the frozen v1 discovery endpoint, not the normative v6 endpoint. It
remains available for older clients. Inspect it explicitly with
`titra --profile PROFILE --output json capabilities show --version 1`; the interactive dashboard
normally negotiates v2 automatically and fails closed on a malformed or unauthorized v2 response.
