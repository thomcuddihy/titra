# Root operator guide

The maintenance bundle is intentionally site-bound. A release engineer first
records the intended server identity, Compose path and checksum, Compose object
names, immutable source/candidate image IDs, archive paths, and protected
maintenance roots. It also selects the reviewed release profile used in the
candidate image tag; the generic default is `hardened`, and a different profile
must be supplied explicitly with `--release-profile`. Run
`deployment/build-v7-release.sh --help` for the complete
input contract and keep the resulting build invocation in a private change
record, not in this repository.

## Before a maintenance window

1. Inspect and hash the root-owned production Compose file without modifying it.
2. Record the running application and Mongo container IDs, image IDs, Compose
   labels, mount identity, and network identity.
3. On a controlled release workstation with registry access, run
   `build-v7-mongo-archive.sh` and retain its archive, checksum, and admission
   metadata together. Build and verify the candidate and predecessor archives.
4. Build the otherwise offline release from those reviewed inputs, then
   independently run `verify-v7-release.sh` against it.
5. Transfer only the generated console, bundle, and their two checksum sidecars
   to the configured incoming directory.
6. Keep a separate, tested host-level backup outside the maintenance roots.
7. Announce a maintenance window and quiesce users and automation.

## On the server

Install the generated console as root at the exact path supplied to the release
builder and execute it from an attended terminal. Use its status and preview
actions before every mutating action. Confirm prompts only after comparing the
previewed identities with the approved change record.

The recommended sequence is:

1. Verify/install the package.
2. Preview and load the pinned image archives.
3. Configure any exact private integration hosts.
4. Rehearse with the isolated lab and a sanitized database clone.
5. Preview the selected supported transition.
6. During the maintenance window, deploy. The deployment creates and verifies
   a fresh database backup before changing the application.
7. Test login, time-entry CRUD, projects, reports, administration, integrations,
   and restart behavior before ending the window.

If post-switch verification fails, leave the application stopped and use the
receipt-bound full rollback. There is deliberately no application-only rollback:
restoring old application code over a changed database is not considered safe.
Rollback first captures the current database, then restores the exact
pre-deployment database and source image named in the deployment receipt.

Share only sanitized `support.log` files by default. Diagnostic logs, Compose
snapshots, database manifests, runtime configuration, and receipts may reveal
infrastructure details and require explicit review before disclosure.

## Scope exclusions

This reusable source does not include historical release bundles, container
images, site receipts, production logs, emergency repair exceptions, credentials,
or remote-access/upload scripts. Operators must generate a new host-bound release
for every reviewed environment.
