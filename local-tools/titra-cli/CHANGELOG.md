# Changelog

## Unreleased

- Pace live verification both between CLI processes and between every HTTP request, including
  pagination, without automatically retrying a rate-limited read or mutation.
- Add an exact server/owner/marker/resource-bound cleanup-only recovery mode for a retained private
  `v6-recovery.json`, with no synthetic creation or idempotency replay and a final absence sweep.

## 0.3.0 — 2026-09-03

- Retain complete interactive and noninteractive support for every v6 endpoint on the compatible
  v7 API.
- Add `capabilities check --require-v7` and `security check` so a live client can require the v7
  API response-header profile; HSTS remains a separate deployment opt-in.
- Expose both the normal and HSTS-required v7 security-header checks in the interactive dashboard.
- Distinguish an overdue action-verification gate from an invalid credential and expose a
  validated rate-limit retry delay without automatically replaying requests.
- Add a v7 live verification mode with separate read-only, disposable mutation, and timer gates,
  while preserving the v5 and v6 runners.
- Add a supplied-profile/URL v7 automation wrapper and post-deployment runbook.

## 0.2.0 — 2026-09-03

- Discover and strictly validate the complete API contract at
  `/capabilities/v2/`, while retaining the frozen `/capabilities/` v1
  compatibility path for older deployments.
- Expose capability inspection/checking, project lifecycle snapshots and users,
  predefined-task lifecycle/statistics, time-entry detail edits, personal task
  suggestions, atomic timer behavior, and the signed action-verification
  webhook contract.
- Parse sanitized v2 problem responses and classify ambiguous write outcomes as
  requiring reconciliation.
- Expand the interactive terminal UI to cover the same v6 workflows available
  to scripts.
- Add a credential-file-aware, production-safe v6 verification mode with
  explicit mutation gates and isolated synthetic cleanup.

## 0.1.0 — 2026-08-30

- Initial interactive and scriptable Titra client, including credential
  profiles, time capture, reports, v5 endpoint checks, and private local
  recovery state.
