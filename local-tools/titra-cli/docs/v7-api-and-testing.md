# V7 API and post-deployment verification

Titra v7 deliberately keeps the v6 HTTP resource surface and v2 envelope compatible while
raising `capabilitiesVersion` to 3 for explicit security-policy discovery.
Every endpoint in [the v6 endpoint map](v6-endpoint-guide.md) therefore remains available in both
the interactive dashboard and noninteractive commands. The CLI 0.3 additions cover the v7
security behavior around that surface:

- `capabilities check --require-v7` requires the exact reviewed capabilitiesVersion 3
  `security-v7` contract and the v7 response-header profile. `doctor` reports that non-secret
  contract and its typed deployment flags, including whether OAuth token encryption is configured;
- `security check` independently checks `no-store`, `no-cache`, opener isolation, permissions,
  referrer, MIME-sniffing, and DNS-prefetch headers on an authenticated API response;
- `security check --require-hsts` additionally requires `Strict-Transport-Security:
  max-age=31536000`; use it only when Titra is served exclusively through HTTPS and the v7
  deployment has intentionally enabled HSTS;
- an overdue account action-verification deadline is reported distinctly from a bad API token;
  both safely exit 3; and
- HTTP 429 responses expose only a validated retry delay and exit 5. The CLI does not
  automatically replay reads or writes. The live harness proactively spaces CLI process starts
  and every HTTP request, including requests made while draining a paginated command.

## Read-only live check

A private credential file can be used without copying its token into the command line:

```bash
cd local-tools/titra-cli
python scripts/test-live-v7.py \
  --credentials ~/.titra-cli.toml --profile production \
  --expected-user-id EXACT_ID \
  --project TEST_PROJECT_ID \
  --min-command-spacing 1 --min-request-spacing 0.5
```

This runs the local pytest/coverage, Ruff, format, and mypy gates first. Add `--skip-local` only
when those exact sources have already passed. The live phase checks v7 security headers, exact v2
capabilities/security policy, token identity, projects, suggestions, timer state, and complete
cursor paging.
Supplying `--project` adds project details, user privacy, predefined-task, and task-statistics
reads. `--record-id` can add one exact owned-record read. No real API payload is printed by the
runner or written to its report.

The live defaults are one second between CLI process starts and 0.5 seconds between HTTP request
starts inside each process. The latter also covers multi-page project, suggestion, and time-entry
reads. Both delays are measured between starts, accept finite values from 0 through 60 seconds,
and never retry a failed request. Keep the recommended values above unless an operator has
reviewed a different server and reverse-proxy rate policy.

To use a supplied test URL and token without a profile, place the token in an environment variable
rather than a process argument:

```bash
read -rsp 'Temporary Titra API token: ' TITRA_V7_API_TOKEN; export TITRA_V7_API_TOKEN; echo
python scripts/test-live-v7.py \
  --live-url https://titra.example.org --token-env TITRA_V7_API_TOKEN --skip-local
unset TITRA_V7_API_TOKEN
```

HTTPS certificate verification is mandatory by default. `--insecure` is for an explicitly chosen
test system, never routine production use. Reports can be written atomically to a pre-existing
private directory with `--report-json PATH`; they include check names and recovery status, never
the URL, token, credential path, or API payloads.

## Full disposable lifecycle

Use an approved maintenance/test window and first obtain the immutable user ID:

```bash
titra --credentials ~/.titra-cli.toml --profile production \
  --output json auth check
```

Then opt into disposable resources separately:

```bash
python scripts/test-live-v7.py \
  --credentials ~/.titra-cli.toml --profile production \
  --expected-user-id EXACT_ID --allow-mutations \
  --min-command-spacing 1 --min-request-spacing 0.5
```

The mutation suite uses a globally unique marker and an entirely new project. It exercises and
cleans up project, predefined task, two time records, task suggestion, lifecycle edits,
idempotency replay, paging, and guarded deletion. It never edits a pre-existing project or record.
An interruption retains a private `v6-recovery.json` manifest because v7 intentionally uses the
same API lifecycle/recovery contract. Read the printed recovery location before manual action;
never delete a resource whose ID and marker no longer match.

The server timer is user-global and excluded unless `--allow-timer` is also supplied. That check
aborts without mutation if a timer is already running, then starts and stops only one marked timer
without submitting an extra record. The general harness never submits a webhook or clears a
project fence, since those require installation-specific secrets or operator evidence.

## Resume a retained cleanup safely

If a mutation run fails during cleanup (including a definite HTTP 429), wait at least the
validated `Retry-After` delay printed by the CLI. Then use the retained path and exact marker from
that run; do not start another mutation suite:

```bash
python scripts/test-live-v7.py \
  --credentials ~/.titra-cli.toml --profile production \
  --expected-user-id EXACT_ID \
  --resume-cleanup /private/run-directory/v6-recovery.json \
  --expected-recovery-marker '__titra-cli-v7-test_YYYYMMDDTHHMMSSZ_RANDOM__' \
  --min-command-spacing 1 --min-request-spacing 0.5 --skip-local
```

`--resume-cleanup` is itself the explicit delete authorization and cannot be combined with
`--allow-mutations`, timer flags, a new namespace, or project/record inspection options. Before
any live operation, the runner requires the exact `v6-recovery.json` filename, a regular
single-link file, private user ownership/modes, the expected schema and bounded groups, the
profile's normalized server, immutable owner ID, operator-supplied marker, and only resource names
that can be derived from that marker. It rejects unresolved idempotency-replay or timer state and
never sends a create, replay, fence-recovery, or timer-stop command.

Every delete is still preceded by a fresh ID/project/name/marker/revision check. Completion also
requires every known manifest ID to be absent, no marker project in the active plus archived
project list, no marker suggestion, and empty pending/resource groups. A failed check or another
429 leaves the manifest at `recovery-required`; wait for the reported delay and run the same
command again. Successful recovery retains the private manifest as an auditable
`cleanup-completed-after-failure` receipt rather than deleting its directory.

## Direct installed-runner equivalent

The wrapper delegates to the installed runner. Its equivalent flags are:

```bash
titra-cli-test --live-api-version v7 --credentials FILE --profile NAME \
  --expected-user-id EXACT_ID --allow-v7-mutation-tests --allow-v7-timer-tests \
  --min-command-spacing 1 --min-request-spacing 0.5
```

Omit the two `--allow-*` flags for read-only verification. V5 and v6 modes and flags remain
available for compatibility testing.
