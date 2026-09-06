# Automated local and v5 testing

`scripts/run-tests.py` is the canonical test runner. The installed
`titra-cli-test` command invokes the same code. It has two intentionally separate jobs:

1. run the complete local unit, contract, lint, formatting, and type-check suite; and
2. optionally exercise a specifically supplied v5 server through the real CLI.

The local tests use mocks and temporary directories. They never need an API token. Live checks
are opt-in and are read-only unless `--allow-write-tests` is also supplied.

This v5 interface remains the default for compatibility. For exact v6 discovery and the
separately gated disposable-project lifecycle, see `live-v6-testing.md`.

## Local checks

From the CLI directory and its development environment:

```bash
python scripts/run-tests.py
```

This runs, in order:

- pytest with branch coverage;
- Ruff lint;
- Ruff formatting verification; and
- strict mypy checking.

The runner stops at the first failure and returns a nonzero status. Individual development
commands remain documented in `development.md`. Local checks need the source checkout; run the
installed entry point from that directory or supply `--source-root /path/to/titra-cli`.

Coverage data is written under a new private temporary directory for each invocation and removed
on both success and failure. The runner never reads, combines, truncates, or removes a
pre-existing `.coverage` or `.coverage.*` file in the source checkout. This isolation also avoids
SQLite failures caused by stale or corrupt coverage data on Windows-backed WSL mounts.

## Supplying a live token safely

The runner has deliberately **no API-token command-line option**. Command arguments can be
recorded in shell history and exposed in process listings. Choose one of these methods:

- Leave `TITRA_V5_API_TOKEN` unset and run from a terminal. The runner asks through a hidden
  prompt.
- Inject the token through a secret environment variable. `--token-env NAME` selects another
  variable name for a CI secret.

An interactive Bash example that avoids shell history is:

```bash
read -rsp 'Titra v5 API token: ' TITRA_V5_API_TOKEN
echo
export TITRA_V5_API_TOKEN
python scripts/run-tests.py \
  --live-url https://titra-v5.example.org \
  --expected-username 'CLI test account' \
  --skip-local \
  --no-token-prompt
unset TITRA_V5_API_TOKEN
```

The token is passed to child CLI processes through an isolated environment. It is never put in
an argument, written to the temporary state directory, or included in the runner's output.
Diagnostics redact the complete token plus recognizable bearer and API-key forms.

## Read-only v5 check

```bash
python scripts/run-tests.py \
  --live-url https://titra-v5.example.org \
  --expected-username 'CLI test account' \
  --project PROJECT_ID \
  --skip-local
```

This checks authentication, `GET /user/me`, capabilities, project listing, the selected
project, `GET /project/users/:projectId`, owned-record listing, and—when a record exists today—
`GET /timeentry/get/:id`. Supply an owned `--record-id` if inspection of that endpoint must not
depend on there being a record today.

The selected project must be owned by the token user or include the user as an administrator or
team member. `--project` may be an exact ID or an unambiguous name. No returned user, project, or
record content is printed; only check names and counts are reported.

## Full v5 endpoint check with cleanup

Use a dedicated test account and project whenever possible:

```bash
python scripts/run-tests.py \
  --live-url https://titra-v5.example.org \
  --expected-username 'CLI test account' \
  --project PROJECT_ID \
  --allow-write-tests \
  --skip-local
```

The explicit write flag creates exactly one one-minute record with a unique task label such as
`__titra-cli-v5-test_20260830T010203Z_a1b2c3d4e5__`. It then:

1. verifies the returned record ID, project ID, owner access, and exact synthetic label;
2. exercises summary reporting;
3. retrieves a fresh ETag;
4. deletes that exact ID through the guarded v5 endpoint; and
5. verifies that the ID is absent.

Only a record proven to have this run's exact project and unique label is eligible for cleanup.
The runner never creates a project or predefined task because the API has no corresponding safe
delete endpoints. Project creation is covered by mocked unit/contract tests instead.

An uncertain create response is reconciled by searching for the unique label; it is never
retried blindly. An uncertain delete is reconciled with a read and is not submitted a second
time. `Ctrl+C` also enters the cleanup path. A force kill or total loss of connectivity can
prevent cleanup; search Titra for the marker printed at the start of the write check.

Normal runs remove their private temporary CLI state. When a write run fails or is interrupted,
the runner retains that private state directory and prints its path so deletion receipts remain
available for diagnosis. It contains synthetic record details but never the API token. Remove it
after reconciliation.

## CI example

Store `TITRA_V5_API_TOKEN` in the CI system's masked secret store, then run:

```bash
python scripts/run-tests.py \
  --live-url "$TITRA_V5_URL" \
  --project "$TITRA_V5_PROJECT_ID" \
  --expected-username "$TITRA_V5_USERNAME" \
  --allow-write-tests \
  --no-token-prompt
```

Omit `--allow-write-tests` for a read-only scheduled health check. Do not enable concurrent write
runs against the same account unless each run can tolerate its own independent synthetic record.

## Transport and exit behavior

HTTPS certificate verification is the default. Loopback HTTP is allowed for a disposable local
server. Remote HTTP and self-signed HTTPS require the conspicuous `--insecure` option and should
not be used with a production credential.

The runner returns `0` only when every requested check passed, `1` for a check or configuration
failure, and `130` when interrupted. A live check has a per-command 30-second timeout by default;
change it with `--timeout SECONDS`.

Use `python scripts/run-tests.py --help` for the complete option list.

When only the wheel is installed and the source tests are not present, use
`titra-cli-test --skip-local --live-url ...` for live checks. A wheel intentionally does not
embed the repository's test tree.
