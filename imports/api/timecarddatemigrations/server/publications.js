import { check, Match } from 'meteor/check'
import { Meteor } from 'meteor/meteor'
import { checkAdminAuthentication } from '../../../utils/server_method_helpers.js'
import { publishAdminCollection } from '../../../utils/adminCollectionPublication.js'
import { TimecardDateMigrationRuns } from '../timecarddatemigrations.js'

const TIMECARD_DATE_MIGRATION_ADMIN_FIELDS = Object.freeze({
  status: 1,
  mode: 1,
  timeZone: 1,
  startTimePolicy: 1,
  createdAt: 1,
  createdBy: 1,
  frozenAt: 1,
  preparedAt: 1,
  updatedAt: 1,
  completedAt: 1,
  applyStartedAt: 1,
  restoreStartedAt: 1,
  verifiedAt: 1,
  restoredAt: 1,
  cancelledAt: 1,
  candidateCount: 1,
  migratableCount: 1,
  excludedCount: 1,
  classificationCounts: 1,
  sourceTotalHours: 1,
  snapshotDigest: 1,
  backupVerifiedAt: 1,
  backupIntegrity: 1,
  applyStats: 1,
  restoreStats: 1,
  verification: 1,
  pausedPhase: 1,
  pauseRequestedAt: 1,
  lastError: 1,
})

Meteor.publish('timecardDateMigrationRuns', async function timecardDateMigrationRunsPublication(
  options = {},
) {
  try {
    await checkAdminAuthentication(this)
  } catch {
    return this.ready()
  }
  check(options, {
    limit: Match.Optional(Number),
  })
  const limit = Number.isInteger(options.limit)
    ? Math.min(Math.max(options.limit, 1), 100)
    : 25
  return publishAdminCollection(this, {
    users: Meteor.users,
    collection: TimecardDateMigrationRuns,
    collectionName: 'timecardDateMigrationRuns',
    fields: TIMECARD_DATE_MIGRATION_ADMIN_FIELDS,
    cursorOptions: { sort: { createdAt: -1 }, limit },
  })
})

export { TIMECARD_DATE_MIGRATION_ADMIN_FIELDS }
