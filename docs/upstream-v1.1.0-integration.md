# Upstream v1.1.0 integration review

Reviewed on 2026-09-22. Upstream released
[v1.1.0](https://github.com/titraio/titra/releases/tag/v1.1.0) on
2026-09-17. The release is commit `8211747`, following our upstream base
`4c70bcd` (v1.0.12). This integration is based on the combined fork at `b924a66`.

## Scope and merge decisions

The update was reviewed in the existing `codex/integration-all` worktree and
approved for commit and release packaging on 2026-09-22. The merge records
upstream ancestry so future updates can be merged normally. Standalone PR
branches remain unchanged. Production installation is an attended operator
action, separate from preparing and uploading the release.

- Adopt Meteor 3.5.2, its package versions, Rspack integration 2.2.0, FullCalendar
  7.1.0, and the other compatible upstream dependency updates.
- Preserve the newer fork Rspack/rsdoctor minimum versions rather than lowering
  them to upstream's older constraints. Regenerate the npm lock with the existing
  security overrides intact. Disable automatic Meteor dependency installation;
  the build must use the reviewed lock.
- Keep the hardened, digest-pinned Node 24.20.0 multi-stage image, non-root
  runtime, locked email/server overlays, OAuth encryption, and deployment tools.
  Update the Meteor installer to 3.5.2 and verify its npm archive SHA-512.
- Remove the old bundled-`qs` deletion and audit exemption: meteor-node-stubs
  1.2.30 now contains the reviewed `qs` version itself.
- Adopt the shared sanitizer's array rejection and `prototype` protection, plus
  non-executing VM syntax checking and removal of filesystem access. These are
  defense in depth, not a sandbox security boundary. Unsafe legacy script
  execution remains disabled by default.
- Centralize task/time-entry reserved customfield names while retaining our
  `dateOnly`, `startTime`, `dateRevision`, and `projectTaskRevision` protections.
- Keep the fork's project mutation checks, expanded API, idempotency, civil-date
  storage, migration wizard, and reactive publication protections. Upstream's
  project methods call allowlist helpers without importing them; our stronger
  implementation does not use that broken path or relax ownership checks.
- Keep signed, replay-protected webhooks. Do not reinstate upstream's legacy
  domain-trusted webhook processor or the removed DDP entrypoint.
- Adopt the new Excel exporter, preserving precise numbers, literal text,
  frozen headers and column filters. Reject objects that could be interpreted
  as executable cell instructions. Large exports need blob workers; permit
  those only in `worker-src`, preserving all other existing CSP directives and
  any explicitly configured worker policy.

The upstream domain-normalization helper and project allowlist are retained
for ancestry compatibility, but are not used to replace the fork's stronger
authorization and mutation policies.

## Validation

- Install from the merged npm lock with `npm ci --ignore-scripts`.
- Run `npm test`, `npm run dependencies:check`, and the release ESLint config.
- Run `deployment/test.sh` on Linux/WSL (synthetic fixtures; no production access).
- Run the CLI unit suite using its existing development environment and this
  worktree's `local-tools/titra-cli/src` on `PYTHONPATH`.
- Compile the complete client/server application in Docker using Meteor 3.5.2.
- New regressions cover reserved fields, real API task creation, sanitizer/VM
  behavior, and actual generated XLSX ZIP/XML including large exports.

Results: all 754 Node tests and all 690 CLI unit tests passed. The complete
deployment operations suite, dependency policy, and release lint check passed
(lint has 40 existing inline-configuration warnings, no errors). The complete
Linux/amd64 runtime image built successfully, including client compilation,
native server dependencies and hardened runtime overlays. Image/archive
admission and source-context verification passed. These are local verification
artifacts, not a production release or upload.

An isolated cold-start smoke test also passed with an empty temporary MongoDB
7.0.40 replica set: non-root image, HTTP application page, actual response CSP
with worker-only blob permission, SockJS availability, and HTTP 401 on
unauthenticated capabilities access. No ports were published. Test containers,
temporary database storage and their internal network were removed afterward.
This verifies the runtime headers, not an interactive browser download; a large
XLSX download in supported browsers remains an acceptance-test item.

The tested image has source-context digest
`8b490211615b169d3fac785e09fd9a3236ddec0804f87237f06d1c9a9722730b`.
Its image archive SHA-256 is
`202b46dc45838658d5d86aaf43e71d5695c0056e9f17cf1a4f2a568d16dd9273`.
That initial review image was built before the merge commit; its source commit
label is the pre-merge integration commit and its context digest binds the
tested source. It is not the release image. Release packaging rebuilds from
the committed merge and subsequent pagination fix, with new provenance.

## Remaining limitations and follow-up

The 2026-09-22 application-lock runtime audit (`npm audit --omit=dev`) reports
zero known vulnerabilities. The full audit reports five moderate development
dependency findings through `@rspack/cli`, `@rspack/dev-server`,
`webpack-dev-server`, `sockjs`, and `uuid`. The suggested automatic fix moves to
Rspack CLI 2.x; that is not a safe automatic change to this Meteor/Rspack 1.x
integration. Development servers should not be exposed to untrusted networks.
This is not a fresh audit of every dependency bundled inside Meteor or the OS.

The installer also reports deprecated development dependencies (including
ESLint 9, uuid 8, and lodash.isequal); Sass imports/color helpers and existing
large asset/dynamic-require warnings remain. These need a separate build-tool
modernization review rather than an `npm audit fix --force` operation.

Upstream v1.1.0 itself does not fix the Details pagination error (an absent route
page value becoming `NaN`). A subsequent requested local fix now normalizes
page parameters across all four views and hardens pagination controls; see
[Details pagination and nginx repair](details-pagination-and-nginx.md).
The image digest recorded above predates that subsequent fix and must not be
deployed as the pagination-fixed image. The reverse proxy's WebSocket
configuration is independent. The operator subsequently updated and reloaded
nginx; a live read-only probe confirmed a valid HTTP 101 WebSocket upgrade.

No production data was read or changed during this integration. Use a newly
generated, verified image and the attended backup/deployment workflow. Complete
browser acceptance checks after operator installation before reopening service.
Do not reuse a previously issued v7 image manifest for this different source.
