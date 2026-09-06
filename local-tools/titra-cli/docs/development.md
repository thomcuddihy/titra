# Development and testing

## Environment

From `local-tools/titra-cli` in the Titra checkout:

```bash
conda env create -f environment.yml
conda run -n titra-cli-dev python scripts/run-tests.py
```

The runner executes pytest with branch coverage, Ruff lint, a Ruff formatting check, and strict
mypy. Its coverage database is isolated in a private temporary directory, so any existing
`.coverage*` files in the checkout are left untouched. To run an individual stage while
developing:

```bash
conda run -n titra-cli-dev pytest --cov=titra_cli --cov-branch
conda run -n titra-cli-dev ruff check src tests scripts
conda run -n titra-cli-dev ruff format --check src tests scripts
conda run -n titra-cli-dev mypy src
```

## Dependency reproducibility

`pyproject.toml` uses bounded compatible version ranges so the source package can be installed on
supported Python versions and operating systems without publishing a lock file for one specific
platform. Consequently, `pip install .` and `conda env create -f environment.yml` are not
hash-locked: installations resolved at different times can select different releases within those
bounds.

This is appropriate for normal library distribution, but it is not a reproducible unattended
deployment contract. For CI or a controlled installation, resolve the package for the target
platform from an approved package index, review it, and retain a platform-specific constraints file
or lock file with artifact hashes. Recreate that lock whenever the Python version or target platform
changes. A checksum of the Titra CLI wheel alone does not authenticate its transitive dependencies,
and private index credentials must never be written into a committed lock or configuration file.

The tests use injected clocks, temporary state and configuration directories, and HTTPX mock
transports. They do not require a real API token or a live Titra server. Focused runner tests,
including exact v6/v7 contract rejection, atomic profile resolution, read-only command selection,
recovery manifests, and disposable cleanup, are in `tests/test_selftest.py`,
`tests/test_selftest_v6.py`, and `tests/test_v7_harness.py`.

## Test priorities

- Credential source isolation, unsafe modes and symlinks, redaction, and environment aliases.
- HTTP envelopes, authentication failures, HTML or missing endpoints, and ambiguous writes.
- Duration and date parsing, leap years, DST transitions, legacy timestamps, and midnight splits.
- Atomic timer and draft transitions, including interruption after every mutation boundary.
- Project and user ambiguity, decimal report totals, and malformed or legacy partial results.
- Output purity for JSON, JSONL, CSV, TSV, ID-only, and silent modes.
- ETag deletion, receipt-before-delete ordering, and stale revisions.
- Task-edit capability discovery, owner/name/revision guards, field preservation, no-op behavior,
  receipt ordering, interrupted writes, and read-only reconciliation.
- Idempotency fingerprints, concurrent reservation, lost responses, deletion/replay retention,
  and raw-key non-persistence.
- Cursor query binding, equal-date ID boundaries, malformed or repeated cursors, complete final
  pages, legacy array compatibility, and display-truncation metadata.

## Optional live verification

The installed `titra-cli-test` and `scripts/test-live-v7.py` entry points can run read-only checks
against an explicitly selected server. Mutation suites require separate, conspicuous opt-ins and
create uniquely marked disposable resources. Use a dedicated test account and server whenever
possible, keep tokens in a private credential file or hidden environment variable, and review the
matching guide before enabling writes:

- [v5 testing](live-v5-testing.md)
- [v6 testing](live-v6-testing.md)
- [v7 API and testing](v7-api-and-testing.md)

The CLI repository intentionally keeps server implementation and cross-runtime integration
harnesses separate. Server-side route tests belong with the corresponding Titra API changes.
