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

### Updating an already deployed v7

Supply all three previous-v7 image identity arguments to the release builder.
This adds only the exact pinned previous-v7 to v7 transition; arbitrary v7
images and same-image redeployments remain rejected. Use a new immutable release
ID, a separate install directory and console directory, and the existing
protected state, backup, and lock roots. The old console/package and its image
admission receipts are retained. New image-load receipts are release-specific;
operation journals remain shared so unfinished older operations still block.

The existing root-only runtime configuration is mandatory for these packages.
Installation refuses a missing configuration instead of generating a new OAuth
key, and deployment checks that the running previous-v7 key, private hosts, and
single-instance recovery setting match it exactly. Do not rotate the key or
change private-host configuration during this update. The deployment receipt
binds a protected copy of this configuration, a verified stopped database
snapshot, and an archive of the exact previous-v7 application image.

The compatibility gate remains read-only and count-only. For an exact admitted
previous-v7 image, it accepts a sealed integration credential only when its
strict Meteor envelope is authenticated with the retained original key and the
decrypted value satisfies the bounded string contract. The key travels only
through anonymous standard input and decrypted values are never printed or
saved. The blocking credential_object_fields count includes every object for
legacy sources, or objects that fail these checks for previous-v7; this does not
relax any other migration, index, configuration, or security checks.

Use the new console's receipt-bound full rollback if necessary. It restores the
previous-v7 image and its predeployment database with the same security runtime
settings. Like every full rollback, this restores the snapshot's point in time:
newer records are not retained in the active database. A safety backup of the
current database is taken before restore. Keep users and automation quiesced
until acceptance tests pass, and use the console matching the deployment receipt.

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
