# Titra maintenance release package

This directory is the source template for a host-bound, offline Titra
maintenance package. It provides an attended console, isolated rehearsal lab,
database backup and verification, immutable image loading, supported application
transitions, and receipt-bound full rollback of both application and database.

Do not install this source tree directly. `deployment/build-v7-release.sh`
renders the site and image admission values, copies the reviewed archives,
generates exhaustive checksums, executes the static test suite, and emits a
four-file release directory. Only that generated release should be staged on a
server.

Safety properties include:

- exact hostname, Compose-file digest/size, service, container, database, and
  image identity checks before production access;
- offline `docker image load` only (`pull_policy: never` at cutover);
- a global operator lock shared by backup, lab, deployment, and rollback;
- verified `mongodump --archive --gzip` backups with count/index/UUID metadata;
- continuous application stop across the authoritative pre-deployment backup;
- immutable deployment receipts binding source, target, database backup, and
  runtime configuration;
- fail-closed post-switch behavior; and
- full rollback that first takes a current-state safety backup, then restores
  the receipt-bound pre-deployment database and exact source image.

The repository intentionally contains no Docker archives, rendered manifests,
release bundles, receipts, logs, credentials, or site-specific values. See
`operator/README.md` for preparation and operation.
