# Legacy time-entry date migration

The administration page includes a **Date migration** wizard for installations
that have time entries created before explicit `dateOnly` and `startTime` fields
were introduced. Migration is opt-in: titra continues to display legacy records
compatibly until an administrator completes a reviewed migration.

## Before starting

Take a normal external MongoDB backup and schedule a maintenance window. The
wizard keeps an application-level copy of every selected source record, but that
copy complements rather than replaces an operational database backup.

Only one date migration, restore, or freeze operation can own the global migration
lease. Date-bearing time-entry writes acquire short writer leases. A migration
waits for active writers to drain, and ordinary writers are rejected while the
migration lease is active. Expiring leases and fencing counters allow safe recovery
after an interrupted process.

## Workflow

1. **Scan** classifies records as canonical, legacy, ambiguous, or quarantined.
   Scanning is read-only.
2. **Choose** one interpretation and an explicit IANA comparison timezone. A live
   sample of real records refreshes whenever the method, timezone, or start-time
   policy changes.
3. **Preview** reviews an immutable candidate snapshot. The table is sortable,
   defaults to newest records first, and uses bounded pages.
4. **Backup** freezes the candidate set, checks counts and cryptographic digests,
   and lets the administrator inspect or download each bounded EJSON backup page.
5. **Apply** requires the exact confirmation word `MIGRATE`. Work is performed in
   small resumable batches using revision-aware compare-and-swap updates.
6. **Verify and restore** checks counts, total hours, date fields, checksums, and
   conflicts. A restore preview shows exactly what would change; restoring requires
   the exact word `RESTORE` and will not overwrite records changed since migration.

The history table retains completed, cancelled, interrupted, and restored runs for
inspection. Backup records are intentionally retained for audit and recovery.

## Interpretation modes

- **UTC wall clock** keeps the timestamp's UTC calendar and clock components.
- **UTC instant converted to company timezone** treats the stored value as an
  instant and converts it to the selected timezone, including day shifts and DST.
- **Preserve legacy display in company timezone** keeps the UTC calendar date but
  derives the clock users historically saw in the selected company timezone.
- **Date only** keeps the UTC calendar date and intentionally omits a start time.

The live comparison is the decision aid. In particular, deployments whose users
historically treated UTC-backed values as local wall-clock data should not choose
instant conversion merely because the BSON values carry a UTC marker.

## Interruption and recovery

Apply and restore journals are idempotent and resumable. An administrator can pause
between batches and resume later. Each write verifies the captured date revision
and fields; changed records are reported as conflicts instead of overwritten.
Quarantined records are never modified automatically.

If a browser closes, reopen **Administration → Date migration** and inspect the run
in history. Do not manually delete migration lock, run, or backup collections; an
expired lease is recovered by the wizard while those records preserve its audit
trail.
