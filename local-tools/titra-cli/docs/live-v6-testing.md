# Secure live v6 verification

`titra-cli-test` can verify a deployed v6 API without exposing its token or printing real
projects, users, records, suggestions, or timer contents. The v5 runner remains available; see
`live-v5-testing.md` for its compatibility flow.

The endpoint-by-endpoint interactive and scriptable map is in the
[V6 endpoint and CLI guide](v6-endpoint-guide.md).

## Credentials

Prefer the same private TOML file and profile used by the CLI:

```bash
titra-cli-test --skip-local --live-api-version v6 \
  --credentials /home/tester/.titra-cli.toml --profile v6-test \
  --expected-username 'Dedicated CLI test account'
```

When `--credentials` is omitted, `--profile` uses the usual current-directory then home
`.titra-cli.toml` discovery. The profile's server and API key are loaded as one atomic source. If
`--live-url` is also supplied, it must exactly match the profile server. The runner removes all
ambient `TITRA_*` variables and the selected token variable before resolving a file, so a server
and token cannot be accidentally combined from different sources.

The older hidden-prompt/environment form also works:

```bash
titra-cli-test --skip-local --live-api-version v6 \
  --live-url https://titra-v6.example.org --token-env TITRA_V6_API_TOKEN
```

Never put an API key on this runner's command line. Credentials are passed only in an isolated
child environment, captured output is not echoed, and diagnostics redact known token forms.
HTTPS validation remains enabled unless `--insecure` is explicitly selected for a test system.

## Read-only run

The commands above are read-only. The runner requires discovery to report source
`/capabilities/v2/` and compares the entire returned document with the reviewed v6 contract.
Only the two deployment feature flags may vary between `true` and `false`; missing, additional,
reordered-operation, or changed contract fields fail closed before mutation can be authorized.

It then runs the CLI's own `capabilities check --require-v6`, checks current-user identity,
projects, personal task suggestions, the current timer, and stable paginated owned records. The
record page size is forced to one so two disposable records prove cursor traversal rather than
only exercising a single response. An absent timer or record is a reported skip, not a failure.
Optional IDs add bounded reads without displaying their data:

```bash
titra-cli-test --skip-local --live-api-version v6 \
  --profile v6-test --project DISPOSABLE_OR_TEST_PROJECT_ID --record-id OWNED_RECORD_ID
```

Supplying a project also checks its resource snapshot, caller-visible user list,
predefined-task list, and task statistics. No dry-run mutation command is needed for this
read-only suite.

## Disposable full mutation run

Use a dedicated test account on a non-production v6 instance. This is a separate, conspicuous
opt-in and does not use an existing project:

```bash
titra-cli-test --skip-local --live-api-version v6 \
  --credentials /home/tester/.titra-cli.toml --profile v6-test \
  --expected-username 'Dedicated CLI test account' \
  --expected-user-id EXACT_USER_ID_FROM_AUTH_CHECK \
  --allow-v6-mutation-tests
```

After the exact contract and read-only gates pass, one globally unique marker is used to:

1. create, idempotently replay, read, edit, archive, and restore a disposable project, including
   its caller-visible user list;
2. create, idempotently replay, read, edit, list, and inspect statistics for one predefined task
   with a known nonzero estimate and matching nonzero recorded time;
3. create and read two records, idempotently replay the first record create, edit one Task, edit
   the other's hours, and prove that a paginated day/project read includes both IDs;
4. require, show, identity-check, and delete at least one marker-owned personal suggestion created
   by those records; and
5. clean up records, marker-matched suggestions, task, and finally the empty project.

When discovery says `projectFenceRecoveryEnabled=true`, the suite also reads recovery state for
that new disposable project. It never submits a recovery POST or manufactures a stale fence. A
disabled deployment flag is reported as a skip.

Every cleanup delete is preceded by a fresh read that must match the exact stored ID, project,
and unique marker. A lost create response is reconciled by marker lookup and is never blindly
submitted again. A lost edit or delete response is reconciled by a read and is not blindly
retried.

The runner writes `v6-recovery.json` in its private temporary state directory as soon as the
marker is chosen. Before each project, task, or record POST it atomically journals the intended
identity; after a confirmed response or bounded marker lookup, it atomically replaces that intent
with the created ID and expected marker. Cleanup derives IDs from this manifest when an
interruption prevented the caller from receiving them. It refuses dependent deletes and can
never mark cleanup complete while any create intent or resource remains unresolved. The manifest
contains no API key, but does bind the run to the normalized server and immutable `/user/me` ID.
The runner pins every child request with the expected user ID and rechecks it before every write
and cleanup mutation. The v6 server rejects a token that has rotated to another account before
even an absence read can affect cleanup, so a matching display name cannot bypass the guard.
`--expected-user-id` is therefore required for the mutation suite; obtain it first with
`titra --output json auth check`. Successful runs remove the whole temporary directory. A failed
or interrupted mutation run retains the directory and prints its path; inspect the manifest and
server state before any manual cleanup, and never delete an object that no longer matches the
manifest identity.

The successful cleanup claim applies to API-visible test resources, not all internal database
metadata. A full mutation run leaves four hashed create-idempotency receipts: they are publicly
replayable for seven days and have roughly one additional day of private TTL grace. With timer
testing enabled, the start operation remains in the user's bounded history for eight days and is
pruned by a later start; the latest stop recovery receipt is bounded and replaced by a later stop
but has no automatic expiry cleanup. These records are part of replay/recovery safety and contain
no API token. Do not opt in to a production mutation run unless that bounded residue is acceptable.

## Deliberately omitted live writes

The general disposable flow does not start or stop timers. A timer is user-global rather than
project-contained, so touching it could interfere with work already in progress. On a dedicated
test account, add the independent `--allow-v6-timer-tests` flag alongside
`--allow-v6-mutation-tests` to test one atomic start/status/stop transition. A fresh preflight
aborts before any mutation when a timer is already active. The created timer is bound to the
disposable project and unique task marker, stopped to a local draft without creating another
record, and confirmed absent; an uncertain stop is never blindly retried.

Webhook delivery and project safety-fence recovery remain excluded because they need
installation-specific secrets or an operator-confirmed stale fence. Project-user privacy and
webhook/fence behavior remain covered by the local contract/server tests and disposable Docker
harness. Use their dedicated operator workflows when those endpoints specifically need a live
test.

The runner exits `0` only if all requested checks and cleanup complete, `1` on a safe failure, and
`130` on interruption. Use `--timeout SECONDS` to change the per-command limit and
`--namespace SAFE_NAME` only when a recognizable custom test namespace is useful.

Live runs default to `--min-command-spacing 1` between CLI process starts and
`--min-request-spacing 0.5` between every HTTP request start, including pagination within one
process. Both accept finite values from 0 through 60 and never cause an automatic retry. V6 and
v7 can resume an exact retained cleanup with `--resume-cleanup PRIVATE/v6-recovery.json`, the
original `--expected-user-id`, and mandatory `--expected-recovery-marker`. This cleanup-only mode
validates the private file, server, owner, marker, resource vocabulary and live identities; it is
mutually exclusive with new mutation/timer flags and refuses pending replay or timer state.

For automation, `--report-json /existing/private/path/report.json` atomically writes a private
summary (mode `0600` on POSIX) of check names/statuses, overall outcome, and cleanup/recovery
status. It never includes the server URL, token, credential path or contents, API response
payloads, or real resource data. The destination's parent directory must already exist, and a
symlink target is refused.
