import { createHash } from 'node:crypto'
import { check, Match } from 'meteor/check'
import { EJSON } from 'meteor/ejson'
import { Meteor } from 'meteor/meteor'
import { ValidatedMethod } from 'meteor/mdg:validated-method'
import Timecards from '../../timecards/timecards.js'
import {
  MIGRATION_LOCK_ID,
  TimecardDateMigrationBackups,
  TimecardDateMigrationLocks,
  TimecardDateMigrationRuns,
} from '../timecarddatemigrations.js'
import { adminAuthenticationMixin } from '../../../utils/server_method_helpers.js'
import {
  MIGRATION_MODES,
  START_TIME_POLICIES,
  classifyTimecardDate,
  equalTimecardDateFields,
  isValidIanaTimeZone,
  previewTimecardDateMigration,
  snapshotTimecardDateFields,
  timecardDateFingerprintPayload,
} from '../../../utils/timecardDateMigration.js'
import { buildPreviewSort } from '../../../utils/timecardDateMigrationPaging.js'
import {
  MAX_MIGRATION_STREAM_BATCH_SIZE,
  forEachKeysetBatch,
  keysetSelector,
} from './migrationStreaming.js'

/* eslint-disable no-await-in-loop, no-use-before-define, no-continue */

const LEASE_DURATION_MS = 5 * 60 * 1000
const FREEZE_STALE_AFTER_MS = 30 * 60 * 1000
const MAX_BATCH_SIZE = 500
const MAX_PAGE_SIZE = 200
const OPTION_PREVIEW_SIZE = 5
const DATE_FIELDS = ['date', 'dateOnly', 'startTime']
const DATE_REVISION_FIELD = 'dateRevision'
const APPLY_STATUSES = ['ready', 'applying']
const RESTORE_PREVIEW_STATUSES = [
  'applied', 'applied-with-conflicts', 'completed', 'verified', 'restore-ready', 'restoring',
  'paused',
  'restored', 'restored-with-conflicts',
]
const RESTORE_BATCH_STATUSES = [
  'applied', 'applied-with-conflicts', 'completed', 'verified', 'restore-ready', 'restoring',
]

function serverLeaseUntilExpression(durationMs = LEASE_DURATION_MS) {
  return {
    $dateAdd: {
      startDate: '$$NOW',
      unit: 'millisecond',
      amount: durationMs,
    },
  }
}

function liveWritersExpression() {
  return {
    $filter: {
      input: { $ifNull: ['$activeWriters', []] },
      as: 'writer',
      cond: { $gt: ['$$writer.leaseUntil', '$$NOW'] },
    },
  }
}

function noLiveWritersExpression() {
  return { $eq: [{ $size: liveWritersExpression() }, 0] }
}

function leaseExpiredExpression() {
  return { $lte: [{ $ifNull: ['$leaseUntil', new Date(0)] }, '$$NOW'] }
}

function migrationError(code, message) {
  return new Meteor.Error(`timecard-date-migration-${code}`, message)
}

function checksum(value) {
  return createHash('sha256')
    .update(EJSON.stringify(value, { canonical: true }))
    .digest('hex')
}

function dateFieldsChecksum(timecard) {
  return createHash('sha256')
    .update(timecardDateFingerprintPayload(timecard))
    .digest('hex')
}

function backupDigestLine(backup) {
  return [
    String(backup.timecardId),
    backup.originalChecksum,
    backup.sourceDateChecksum,
    backup.proposedDateChecksum || 'excluded',
    backup.classification,
    backup.migratable ? 'migratable' : 'excluded',
  ].join(':')
}

function createBackupDigestAccumulator(options) {
  const digest = createHash('sha256')
  digest.update(EJSON.stringify({
    mode: options.mode,
    timeZone: options.timeZone,
    startTimePolicy: options.startTimePolicy,
  }, { canonical: true }))
  let finished = false
  return {
    update(backups) {
      if (finished || !Array.isArray(backups)) {
        throw new TypeError('Invalid backup digest update')
      }
      backups.forEach((backup) => digest.update(`\n${backupDigestLine(backup)}`))
    },
    digest() {
      if (finished) throw new TypeError('Backup digest was already finalized')
      finished = true
      return digest.digest('hex')
    },
  }
}

function backupRecordIntegrityIsValid(backup) {
  const proposedDateChecksum = backup.preview.proposed
    ? dateFieldsChecksum(backup.preview.proposed)
    : null
  return checksum(backup.original) === backup.originalChecksum
    && dateFieldsChecksum(backup.original) === backup.sourceDateChecksum
    && proposedDateChecksum === backup.proposedDateChecksum
}

function boundedInteger(value, fallback, maximum) {
  if (value == null) {
    return fallback
  }
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw migrationError('invalid-limit', `Expected an integer between 1 and ${maximum}`)
  }
  return value
}

function previewSort(sortField = 'date', sortDirection = 'desc') {
  try {
    return buildPreviewSort(sortField, sortDirection)
  } catch (error) {
    throw migrationError('invalid-sort', error.message)
  }
}

function publicRun(run) {
  if (!run) {
    return null
  }
  const {
    _id,
    status,
    mode,
    timeZone,
    startTimePolicy,
    createdAt,
    createdBy,
    frozenAt,
    preparedAt,
    updatedAt,
    completedAt,
    applyStartedAt,
    restoreStartedAt,
    verifiedAt,
    restoredAt,
    cancelledAt,
    candidateCount,
    migratableCount,
    excludedCount,
    classificationCounts,
    sourceTotalHours,
    snapshotDigest,
    backupVerifiedAt,
    backupIntegrity,
    applyStats,
    restoreStats,
    verification,
    pausedPhase,
    pauseRequestedAt,
    lastError,
  } = run
  return {
    _id,
    status,
    mode,
    timeZone,
    startTimePolicy,
    createdAt,
    createdBy,
    frozenAt,
    preparedAt,
    updatedAt,
    completedAt,
    applyStartedAt,
    restoreStartedAt,
    verifiedAt,
    restoredAt,
    cancelledAt,
    candidateCount,
    migratableCount,
    excludedCount,
    classificationCounts,
    sourceTotalHours,
    snapshotDigest,
    backupVerifiedAt,
    backupIntegrity,
    applyStats,
    restoreStats,
    verification,
    pausedPhase,
    pauseRequestedAt,
    lastError,
  }
}

async function findRun(runId) {
  const run = await TimecardDateMigrationRuns.findOneAsync(runId)
  if (!run) {
    throw migrationError('run-not-found', 'The migration run no longer exists')
  }
  return run
}

function exactRunStateSelector(run) {
  return {
    _id: run._id,
    status: run.status,
    leaseFence: Object.prototype.hasOwnProperty.call(run, 'leaseFence')
      ? run.leaseFence
      : { $exists: false },
  }
}

function assertRunStatus(run, allowedStatuses) {
  if (!allowedStatuses.includes(run.status)) {
    throw migrationError(
      'invalid-state',
      `Migration ${run._id} is ${run.status}; expected ${allowedStatuses.join(', ')}`,
    )
  }
}

function validateOptions({ mode, timeZone, startTimePolicy }) {
  if (!Object.values(MIGRATION_MODES).includes(mode)) {
    throw migrationError('invalid-mode', 'Choose a supported legacy date interpretation')
  }
  if (!Object.values(START_TIME_POLICIES).includes(startTimePolicy)) {
    throw migrationError('invalid-start-time-policy', 'Choose a supported start-time policy')
  }
  if (timeZone != null && !isValidIanaTimeZone(timeZone)) {
    throw migrationError('invalid-time-zone', 'Choose a valid IANA company timezone')
  }
  if ([MIGRATION_MODES.INSTANT_IN_ZONE, MIGRATION_MODES.LEGACY_DISPLAY_IN_ZONE].includes(mode)
    && !isValidIanaTimeZone(timeZone)) {
    throw migrationError('time-zone-required', 'The selected conversion requires an IANA timezone')
  }
  if (mode === MIGRATION_MODES.DATE_ONLY && startTimePolicy !== START_TIME_POLICIES.OMIT) {
    throw migrationError('invalid-start-time-policy', 'Date-only migration cannot extract a time')
  }
}

function hasDateRevision(timecard) {
  return Boolean(timecard && Object.prototype.hasOwnProperty.call(
    timecard,
    DATE_REVISION_FIELD,
  ))
}

function nextDateRevision(timecard) {
  if (!hasDateRevision(timecard)) {
    return 1
  }
  if (!Number.isSafeInteger(timecard.dateRevision)
    || timecard.dateRevision < 0
    || timecard.dateRevision >= Number.MAX_SAFE_INTEGER) {
    throw migrationError(
      'invalid-date-revision',
      `Timecard ${timecard._id || ''} has an invalid date revision`,
    )
  }
  return timecard.dateRevision + 1
}

function appliedRevisionForBackup(backup) {
  const expectedDateRevision = nextDateRevision(backup.original)
  if (!Object.prototype.hasOwnProperty.call(backup, 'appliedDateRevision')) {
    return expectedDateRevision
  }
  if (backup.appliedDateRevision !== expectedDateRevision) {
    throw migrationError(
      'backup-corrupt',
      `Backup ${backup._id || ''} has an inconsistent applied date revision`,
    )
  }
  return expectedDateRevision
}

function restoredRevisionForBackup(backup) {
  const appliedDateRevision = appliedRevisionForBackup(backup)
  if (appliedDateRevision >= Number.MAX_SAFE_INTEGER) {
    throw migrationError(
      'invalid-date-revision',
      `Backup ${backup._id || ''} cannot allocate a restore revision`,
    )
  }
  const expectedDateRevision = appliedDateRevision + 1
  if (Object.prototype.hasOwnProperty.call(backup, 'restoredDateRevision')
    && backup.restoredDateRevision !== expectedDateRevision) {
    throw migrationError(
      'backup-corrupt',
      `Backup ${backup._id || ''} has an inconsistent restored date revision`,
    )
  }
  return expectedDateRevision
}

function equalDateRevision(left, right) {
  const leftHasRevision = hasDateRevision(left)
  const rightHasRevision = hasDateRevision(right)
  return leftHasRevision === rightHasRevision
    && (!leftHasRevision || left.dateRevision === right.dateRevision)
}

function matchesDateState(timecard, dateFields, dateRevision) {
  return Boolean(timecard)
    && equalTimecardDateFields(snapshotTimecardDateFields(timecard), dateFields)
    && timecard.dateRevision === dateRevision
}

function sourceSelector(timecard) {
  const selector = { _id: timecard._id }
  DATE_FIELDS.forEach((field) => {
    if (Object.prototype.hasOwnProperty.call(timecard, field)) {
      selector[field] = timecard[field]
    } else {
      selector[field] = { $exists: false }
    }
  })
  selector.dateRevision = hasDateRevision(timecard)
    ? timecard.dateRevision
    : { $exists: false }
  return selector
}

function dateFieldsUpdate(fields) {
  const set = {}
  const unset = {}
  DATE_FIELDS.forEach((field) => {
    if (Object.prototype.hasOwnProperty.call(fields, field) && fields[field] !== undefined) {
      set[field] = fields[field]
    } else {
      unset[field] = ''
    }
  })
  const update = {}
  if (Object.keys(set).length) {
    update.$set = set
  }
  if (Object.keys(unset).length) {
    update.$unset = unset
  }
  update.$inc = { dateRevision: 1 }
  return update
}

function safeClassification(timecard) {
  try {
    const classification = classifyTimecardDate(timecard)
    if (hasDateRevision(timecard)
      && (!Number.isSafeInteger(timecard.dateRevision)
        || timecard.dateRevision < 0
        || timecard.dateRevision >= Number.MAX_SAFE_INTEGER - 1)) {
      return {
        ...classification,
        classification: 'quarantined',
        migratable: false,
        reasons: [...(classification.reasons || []), 'invalid-date-revision'],
        warnings: [
          ...(classification.warnings || []),
          'The date revision cannot be safely advanced for migration and restore',
        ],
      }
    }
    return classification
  } catch (error) {
    return {
      classification: 'quarantined',
      migratable: false,
      reasons: ['classification-error'],
      warnings: [error.message],
    }
  }
}

function safePreview(timecard, options) {
  try {
    return previewTimecardDateMigration(timecard, options)
  } catch (error) {
    return {
      ...safeClassification(timecard),
      source: snapshotTimecardDateFields(timecard),
      proposed: null,
      warnings: [error.message],
      previewError: true,
    }
  }
}

function previewAlternative(timecard, mode, run) {
  const startTimePolicy = mode === MIGRATION_MODES.DATE_ONLY
    ? START_TIME_POLICIES.OMIT
    : run.startTimePolicy
  if ([MIGRATION_MODES.INSTANT_IN_ZONE, MIGRATION_MODES.LEGACY_DISPLAY_IN_ZONE].includes(mode)
    && !isValidIanaTimeZone(run.timeZone)) {
    return null
  }
  const preview = safePreview(timecard, {
    mode,
    timeZone: run.timeZone,
    startTimePolicy,
  })
  const {
    classification,
    migratable,
    reasons,
    warnings,
    proposed,
    dayShift,
    zonedDayShift,
    precisionLoss,
    previewError,
  } = preview
  return {
    classification,
    migratable,
    reasons,
    warnings,
    proposed,
    dayShift,
    zonedDayShift,
    precisionLoss,
    available: !previewError && Boolean(proposed),
  }
}

function previewItem(backup, run, current) {
  const { original } = backup
  const rawDateIso = original.date instanceof Date && !Number.isNaN(original.date.getTime())
    ? original.date.toISOString()
    : null
  const selected = backup.preview
  return {
    backupId: backup._id,
    timecardId: backup.timecardId,
    classification: backup.classification,
    migratable: backup.migratable,
    reasons: backup.reasons,
    warnings: backup.warnings,
    userId: original.userId,
    projectId: original.projectId,
    task: original.task,
    hours: original.hours,
    rawDateIso,
    source: selected.source,
    proposed: selected.proposed,
    dayShift: selected.dayShift,
    zonedDayShift: selected.zonedDayShift,
    precisionLoss: selected.precisionLoss,
    status: backup.status,
    applyError: backup.applyError,
    current: current ? snapshotTimecardDateFields(current) : null,
    changedSinceSnapshot: !current
      || !equalTimecardDateFields(snapshotTimecardDateFields(current), selected.source)
      || !equalDateRevision(current, original),
    alternatives: {
      utcWallClock: previewAlternative(original, MIGRATION_MODES.UTC_WALL_CLOCK, run),
      instantInZone: previewAlternative(original, MIGRATION_MODES.INSTANT_IN_ZONE, run),
      legacyDisplayInZone: previewAlternative(
        original,
        MIGRATION_MODES.LEGACY_DISPLAY_IN_ZONE,
        run,
      ),
      dateOnly: previewAlternative(original, MIGRATION_MODES.DATE_ONLY, run),
    },
  }
}

async function streamTimecardBatches({
  selector = {}, fields, onBatch, renew = async () => {},
}) {
  return forEachKeysetBatch({
    batchSize: MAX_MIGRATION_STREAM_BATCH_SIZE,
    renew,
    fetchBatch: ({ afterValue, limit }) => Timecards.find(
      keysetSelector(selector, '_id', afterValue),
      {
        ...(fields ? { fields } : {}),
        sort: { _id: 1 },
        limit,
      },
    ).fetchAsync(),
    onBatch,
  })
}

async function streamBackupBatches({
  selector, fields, onBatch, renew = async () => {},
}) {
  return forEachKeysetBatch({
    batchSize: MAX_MIGRATION_STREAM_BATCH_SIZE,
    cursorValue: (backup) => backup.timecardId,
    renew,
    fetchBatch: ({ afterValue, limit }) => TimecardDateMigrationBackups.find(
      keysetSelector(selector, 'timecardId', afterValue),
      {
        ...(fields ? { fields } : {}),
        sort: { timecardId: 1 },
        limit,
      },
    ).fetchAsync(),
    onBatch,
  })
}

async function currentDocumentsById(backups) {
  const current = new Map()
  for (let offset = 0; offset < backups.length; offset += MAX_MIGRATION_STREAM_BATCH_SIZE) {
    const ids = backups.slice(offset, offset + MAX_MIGRATION_STREAM_BATCH_SIZE)
      .map((backup) => backup.timecardId)
    if (!ids.length) continue
    const documents = await Timecards.find({ _id: { $in: ids } }, {
      fields: {
        _id: 1,
        date: 1,
        dateOnly: 1,
        startTime: 1,
        dateRevision: 1,
        hours: 1,
      },
    }).fetchAsync()
    documents.forEach((document) => current.set(document._id, document))
  }
  return current
}

async function liveClassificationSummary({ renew = async () => {} } = {}) {
  const counts = {
    total: 0,
    canonical: 0,
    legacy: 0,
    ambiguous: 0,
    quarantined: 0,
    migratable: 0,
  }
  let candidateHours = 0
  await streamTimecardBatches({
    fields: {
      date: 1, dateOnly: 1, startTime: 1, dateRevision: 1, hours: 1,
    },
    renew,
    onBatch: async (timecards) => {
      counts.total += timecards.length
      timecards.forEach((timecard) => {
        const classification = safeClassification(timecard)
        counts[classification.classification] += 1
        if (classification.migratable) {
          counts.migratable += 1
          const hours = Number(timecard.hours)
          if (Number.isFinite(hours)) candidateHours += hours
        }
      })
    },
  })
  return { counts, candidateHours }
}

async function liveClassificationCounts(options) {
  return (await liveClassificationSummary(options)).counts
}

async function calculateBackupIntegrity(run, { renew = async () => {} } = {}) {
  const digest = createBackupDigestAccumulator(run)
  const invalidBackupIds = []
  let invalidCount = 0
  let backupCount = 0
  await streamBackupBatches({
    selector: { runId: run._id },
    fields: {
      timecardId: 1,
      original: 1,
      originalChecksum: 1,
      sourceDateChecksum: 1,
      proposedDateChecksum: 1,
      classification: 1,
      migratable: 1,
      'preview.proposed': 1,
    },
    renew,
    onBatch: async (backups) => {
      backupCount += backups.length
      backups.forEach((backup) => {
        if (!backupRecordIntegrityIsValid(backup)) {
          invalidCount += 1
          if (invalidBackupIds.length < 20) invalidBackupIds.push(backup._id)
        }
      })
      digest.update(backups)
    },
  })
  const actualDigest = digest.digest()
  const result = {
    ok: backupCount === run.candidateCount
      && invalidCount === 0
      && actualDigest === run.snapshotDigest,
    expectedCount: run.candidateCount,
    backupCount,
    validCount: backupCount - invalidCount,
    invalidCount,
    digestMatches: actualDigest === run.snapshotDigest,
    invalidBackupIds,
    checkedAt: new Date(),
  }
  return result
}

async function ensureLockDocument() {
  await TimecardDateMigrationLocks.rawCollection().updateOne(
    { _id: MIGRATION_LOCK_ID },
    {
      $setOnInsert: {
        fence: 0,
        leaseUntil: new Date(0),
        activeWriters: [],
        createdAt: new Date(),
      },
    },
    { upsert: true },
  )
}

async function acquireLease(runId, operation) {
  await ensureLockDocument()
  const previousLock = await TimecardDateMigrationLocks.findOneAsync(MIGRATION_LOCK_ID)
  const result = await TimecardDateMigrationLocks.rawCollection().findOneAndUpdate(
    {
      _id: MIGRATION_LOCK_ID,
      $expr: {
        $and: [
          noLiveWritersExpression(),
          {
            $or: [
              leaseExpiredExpression(),
              {
                $and: [
                  { $eq: ['$ownerRunId', runId] },
                  { $eq: ['$busy', false] },
                ],
              },
            ],
          },
        ],
      },
    },
    [
      {
        $set: {
          activeWriters: [],
          ownerRunId: runId,
          operation,
          busy: true,
          acquiredAt: '$$NOW',
          leaseUntil: serverLeaseUntilExpression(),
          fence: { $add: [{ $ifNull: ['$fence', 0] }, 1] },
        },
      },
    ],
    { returnDocument: 'after' },
  )
  const lock = result?.value || result
  if (!lock || lock.ownerRunId !== runId) {
    throw migrationError('locked', 'Another migration or restore currently owns the data lease')
  }
  const acquiredAt = lock.acquiredAt || new Date()
  await TimecardDateMigrationRuns.updateAsync(runId, {
    $set: { leaseFence: lock.fence, updatedAt: acquiredAt },
  })
  lock.recoveredBusyLease = Boolean(
    previousLock?.busy
      && previousLock?.ownerRunId === runId,
  )
  return lock
}

async function renewLease(runId, fence, operation) {
  const result = await TimecardDateMigrationLocks.rawCollection().updateOne(
    {
      _id: MIGRATION_LOCK_ID,
      ownerRunId: runId,
      fence,
      operation,
      busy: true,
      $expr: { $gt: [{ $ifNull: ['$leaseUntil', new Date(0)] }, '$$NOW'] },
    },
    [{ $set: { leaseUntil: serverLeaseUntilExpression() } }],
  )
  if (result.matchedCount !== 1) {
    throw migrationError('lease-lost', 'The migration lease expired or was fenced by another run')
  }
}

async function claimPauseLease(runId, operation, expectedFence) {
  await ensureLockDocument()
  const selector = {
    _id: MIGRATION_LOCK_ID,
  }
  if (expectedFence == null) {
    selector.$expr = {
      $and: [
        noLiveWritersExpression(),
        {
          $or: [
            {
              $and: [
                { $eq: ['$ownerRunId', runId] },
                { $eq: ['$operation', operation] },
                { $eq: ['$busy', false] },
              ],
            },
            leaseExpiredExpression(),
          ],
        },
      ],
    }
  } else {
    selector.ownerRunId = runId
    selector.operation = operation
    selector.busy = false
    selector.fence = expectedFence
    selector.$expr = noLiveWritersExpression()
  }
  const result = await TimecardDateMigrationLocks.rawCollection().findOneAndUpdate(
    selector,
    [
      {
        $set: {
          activeWriters: [],
          ownerRunId: runId,
          operation,
          busy: true,
          acquiredAt: '$$NOW',
          leaseUntil: serverLeaseUntilExpression(),
          fence: { $add: [{ $ifNull: ['$fence', 0] }, 1] },
        },
      },
    ],
    { returnDocument: 'after' },
  )
  const lock = result?.value || result
  if (lock?.ownerRunId !== runId) {
    return null
  }
  const expectedStatus = operation === 'restore' ? 'restoring' : 'applying'
  const runResult = await TimecardDateMigrationRuns.rawCollection().updateOne(
    {
      _id: runId,
      status: { $in: [expectedStatus, 'paused'] },
    },
    { $set: { leaseFence: lock.fence } },
  )
  if (runResult.matchedCount !== 1) {
    await releaseLease(runId, lock.fence)
    return null
  }
  return lock
}

async function finalizePauseWithLease(runId, phase, lock) {
  const expectedStatus = phase === 'restore' ? 'restoring' : 'applying'
  const result = await TimecardDateMigrationRuns.rawCollection().updateOne(
    {
      _id: runId,
      status: { $in: [expectedStatus, 'paused'] },
      leaseFence: lock.fence,
    },
    {
      $set: {
        status: 'paused',
        pausedPhase: phase,
        updatedAt: new Date(),
      },
      $unset: { pauseRequestedAt: '' },
    },
  )
  if (result.matchedCount === 0) {
    await TimecardDateMigrationRuns.updateAsync({
      _id: runId,
      leaseFence: lock.fence,
    }, {
      $unset: { pauseRequestedAt: '' },
    })
  }
  await releaseLease(runId, lock.fence)
  return result.matchedCount === 1
}

async function parkLease(runId, fence, operation) {
  const result = await TimecardDateMigrationLocks.rawCollection().updateOne(
    {
      _id: MIGRATION_LOCK_ID,
      ownerRunId: runId,
      fence,
      busy: true,
      $expr: { $gt: [{ $ifNull: ['$leaseUntil', new Date(0)] }, '$$NOW'] },
    },
    [
      {
        $set: {
          busy: false,
          leaseUntil: serverLeaseUntilExpression(),
        },
      },
    ],
  )
  if (result.matchedCount !== 1) {
    throw migrationError('lease-lost', 'The migration batch was fenced before it could park')
  }
  const run = await findRun(runId)
  if (run.pauseRequestedAt) {
    const pauseLock = await claimPauseLease(runId, operation, fence)
    if (pauseLock) {
      await finalizePauseWithLease(runId, operation, pauseLock)
      return true
    }
    return (await findRun(runId)).status === 'paused'
  }
  return false
}

async function releaseLease(runId, fence) {
  await TimecardDateMigrationLocks.rawCollection().updateOne(
    {
      _id: MIGRATION_LOCK_ID,
      ownerRunId: runId,
      fence,
    },
    {
      $set: {
        busy: false,
        leaseUntil: new Date(0),
        releasedAt: new Date(),
      },
      $unset: { ownerRunId: '', operation: '' },
    },
  )
}

async function acknowledgePauseRequest(runId, phase, lock) {
  const run = await findRun(runId)
  if (!run.pauseRequestedAt) {
    if (run.status === 'paused') {
      await releaseLease(runId, lock.fence)
      return true
    }
    return false
  }
  await finalizePauseWithLease(runId, phase, lock)
  return true
}

async function buildProgress(runId) {
  const run = await findRun(runId)
  const rawBackups = TimecardDateMigrationBackups.rawCollection()
  const [applied, conflicts, failed, remaining] = await Promise.all([
    rawBackups.countDocuments({
      runId,
      status: {
        $in: ['applied', 'restoring-record', 'restored', 'restore-conflict', 'restore-failed'],
      },
    }),
    rawBackups.countDocuments({ runId, status: 'conflict' }),
    rawBackups.countDocuments({ runId, status: 'failed' }),
    rawBackups.countDocuments({ runId, status: { $in: ['pending', 'applying-record', 'failed'] } }),
  ])
  const progress = {
    total: run.migratableCount,
    processed: applied + conflicts,
    applied,
    conflicts,
    failed,
    remaining,
  }
  await TimecardDateMigrationRuns.updateAsync(runId, {
    $set: {
      applyStats: {
        processed: progress.processed,
        applied: progress.applied,
        conflicts: progress.conflicts,
        failed: progress.failed,
      },
    },
  })
  return progress
}

async function buildRestoreProgress(runId) {
  const applyProgress = await buildProgress(runId)
  const rawBackups = TimecardDateMigrationBackups.rawCollection()
  const [restored, conflicts, failed, remaining] = await Promise.all([
    rawBackups.countDocuments({ runId, status: 'restored' }),
    rawBackups.countDocuments({ runId, status: 'restore-conflict' }),
    rawBackups.countDocuments({ runId, status: 'restore-failed' }),
    rawBackups.countDocuments({
      runId,
      status: { $in: ['applied', 'restoring-record', 'restore-failed'] },
    }),
  ])
  const progress = {
    total: applyProgress.applied,
    processed: restored + conflicts,
    restored,
    conflicts,
    failed,
    remaining,
  }
  await TimecardDateMigrationRuns.updateAsync(runId, {
    $set: {
      restoreStats: {
        processed: progress.processed,
        restored: progress.restored,
        conflicts: progress.conflicts,
        failed: progress.failed,
      },
    },
  })
  return progress
}

async function initializeIndexes() {
  await Promise.all([
    Timecards.rawCollection().createIndex(
      { dateOnly: 1, date: -1, _id: 1 },
      { name: 'timecard_date_migration_option_preview' },
    ),
    TimecardDateMigrationRuns.rawCollection().createIndex({ createdAt: -1 }),
    TimecardDateMigrationRuns.rawCollection().createIndex({ status: 1, updatedAt: -1 }),
    TimecardDateMigrationBackups.rawCollection().createIndex(
      { runId: 1, timecardId: 1 },
      { unique: true },
    ),
    TimecardDateMigrationBackups.rawCollection().createIndex(
      { runId: 1, status: 1, timecardId: 1 },
    ),
    TimecardDateMigrationBackups.rawCollection().createIndex(
      { runId: 1, classification: 1, timecardId: 1 },
    ),
    TimecardDateMigrationBackups.rawCollection().createIndex(
      { runId: 1, 'original.date': -1, timecardId: 1 },
    ),
    TimecardDateMigrationBackups.rawCollection().createIndex(
      {
        runId: 1,
        'original.userId': 1,
        'original.projectId': 1,
        'original.task': 1,
        timecardId: 1,
      },
      { name: 'timecard_date_migration_preview_context' },
    ),
    TimecardDateMigrationBackups.rawCollection().createIndex(
      {
        runId: 1, classification: 1, 'original.date': 1, timecardId: 1,
      },
      { name: 'timecard_date_migration_preview_classification' },
    ),
    TimecardDateMigrationBackups.rawCollection().createIndex(
      {
        runId: 1, 'preview.dayShift': 1, 'original.date': 1, timecardId: 1,
      },
      { name: 'timecard_date_migration_preview_day_shift' },
    ),
  ])
  await ensureLockDocument()
  await recoverStaleRuns()
}

async function recoverStaleRuns() {
  const lockSnapshots = await TimecardDateMigrationLocks.rawCollection().aggregate([
    { $match: { _id: MIGRATION_LOCK_ID } },
    { $set: { databaseNow: '$$NOW' } },
    { $limit: 1 },
  ]).toArray()
  const lock = lockSnapshots[0]
  const now = lock?.databaseNow || new Date()
  let lockIsActive = lock?.ownerRunId && lock.leaseUntil > now
  let activeOwnerRunId = lockIsActive ? lock.ownerRunId : null
  if (lockIsActive && !lock.busy) {
    const ownerRun = await TimecardDateMigrationRuns.findOneAsync(lock.ownerRunId)
    if (ownerRun?.pauseRequestedAt) {
      const pausedPhase = ownerRun.status === 'restoring' ? 'restore' : 'apply'
      const pauseLock = await claimPauseLease(ownerRun._id, pausedPhase, lock.fence)
      if (pauseLock) {
        await finalizePauseWithLease(ownerRun._id, pausedPhase, pauseLock)
        lockIsActive = false
        activeOwnerRunId = null
      }
    }
  }
  if (lock && !lockIsActive) {
    await TimecardDateMigrationLocks.rawCollection().updateOne(
      {
        _id: MIGRATION_LOCK_ID,
        $expr: leaseExpiredExpression(),
      },
      {
        $set: { busy: false, releasedAt: now },
        $unset: { ownerRunId: '', operation: '' },
      },
    )
  }
  const withoutActiveOwner = activeOwnerRunId ? { _id: { $ne: activeOwnerRunId } } : {}
  await TimecardDateMigrationRuns.updateAsync({
    status: 'applying',
    ...withoutActiveOwner,
  }, {
    $set: {
      status: 'paused',
      pausedPhase: 'apply',
      integrityRecheckRequired: true,
      lastError: 'Migration worker lease expired; resume is safe',
      updatedAt: now,
    },
  }, { multi: true })
  await TimecardDateMigrationRuns.updateAsync({
    status: 'restoring',
    ...withoutActiveOwner,
  }, {
    $set: {
      status: 'paused',
      pausedPhase: 'restore',
      integrityRecheckRequired: true,
      lastError: 'Restore worker lease expired; resume is safe',
      updatedAt: now,
    },
  }, { multi: true })
  await TimecardDateMigrationRuns.updateAsync({
    status: 'freezing',
    freezeHeartbeatAt: { $lte: new Date(now.getTime() - FREEZE_STALE_AFTER_MS) },
    ...withoutActiveOwner,
  }, {
    $set: {
      status: 'failed',
      lastError: 'Preview freeze was interrupted; partial backups were retained for audit',
      updatedAt: now,
    },
  }, { multi: true })
}

Meteor.startup(async () => {
  // Migration integrity and recovery rely on these indexes. Propagate failure
  // so the application cannot report readiness with weaker guarantees.
  await initializeIndexes()
})

const scan = new ValidatedMethod({
  name: 'timecardDateMigration.scan',
  validate(args) {
    check(args, {})
  },
  mixins: [adminAuthenticationMixin],
  async run() {
    await recoverStaleRuns()
    const { counts, candidateHours } = await liveClassificationSummary()
    const lock = await TimecardDateMigrationLocks.rawCollection().findOne({
      _id: MIGRATION_LOCK_ID,
      $expr: { $gt: [{ $ifNull: ['$leaseUntil', new Date(0)] }, '$$NOW'] },
    }, {
      projection: { ownerRunId: 1, operation: 1, leaseUntil: 1 },
    })
    const activeRunDocument = lock?.ownerRunId
      ? await TimecardDateMigrationRuns.findOneAsync(lock.ownerRunId)
      : await TimecardDateMigrationRuns.findOneAsync({
        status: {
          $in: [
            'freezing', 'preview', 'ready', 'backup-invalid', 'applying',
            'paused', 'restore-ready', 'restoring',
          ],
        },
      }, { sort: { createdAt: -1 } })
    const attentionCount = counts.legacy + counts.ambiguous + counts.quarantined
    return {
      counts,
      totalHours: candidateHours,
      legacyDetected: counts.legacy + counts.ambiguous > 0,
      quarantinedDetected: counts.quarantined > 0,
      needsAttention: attentionCount > 0,
      attentionRequired: attentionCount > 0,
      attentionCount,
      activeRun: publicRun(activeRunDocument),
      lease: lock ? { operation: lock.operation, leaseUntil: lock.leaseUntil } : null,
      scannedAt: new Date(),
    }
  },
})

const optionPreview = new ValidatedMethod({
  name: 'timecardDateMigration.optionPreview',
  validate(args) {
    check(args, {
      mode: String,
      timeZone: Match.Optional(String),
      startTimePolicy: String,
    })
  },
  mixins: [adminAuthenticationMixin],
  async run({ mode, timeZone, startTimePolicy }) {
    validateOptions({ mode, timeZone, startTimePolicy })
    const runOptions = { mode, timeZone, startTimePolicy }
    const documents = await Timecards.find({
      date: { $type: 'date' },
      dateOnly: null,
    }, {
      sort: { date: -1, _id: 1 },
      limit: 100,
    }).fetchAsync()
    const items = []
    for (const timecard of documents) {
      const classification = safeClassification(timecard)
      if (!classification.migratable) {
        continue
      }
      const selectedPreview = safePreview(timecard, runOptions)
      if (!selectedPreview.proposed) {
        continue
      }
      items.push(previewItem({
        _id: `option-preview:${String(timecard._id)}`,
        timecardId: timecard._id,
        original: timecard,
        classification: classification.classification,
        migratable: true,
        reasons: selectedPreview.reasons || classification.reasons || [],
        warnings: selectedPreview.warnings || classification.warnings || [],
        preview: selectedPreview,
        status: 'sample',
      }, runOptions, timecard))
      if (items.length === OPTION_PREVIEW_SIZE) {
        break
      }
    }
    return {
      items,
      mode,
      timeZone,
      startTimePolicy,
      generatedAt: new Date(),
    }
  },
})

const createPreviewRun = new ValidatedMethod({
  name: 'timecardDateMigration.createPreviewRun',
  validate(args) {
    check(args, {
      mode: String,
      timeZone: Match.Optional(String),
      startTimePolicy: String,
    })
  },
  mixins: [adminAuthenticationMixin],
  async run({ mode, timeZone, startTimePolicy }) {
    validateOptions({ mode, timeZone, startTimePolicy })
    const now = new Date()
    const runId = await TimecardDateMigrationRuns.insertAsync({
      status: 'freezing',
      mode,
      timeZone,
      startTimePolicy,
      createdAt: now,
      createdBy: this.userId,
      freezeHeartbeatAt: now,
      updatedAt: now,
      candidateCount: 0,
      migratableCount: 0,
      excludedCount: 0,
      classificationCounts: {
        legacy: 0,
        ambiguous: 0,
        quarantined: 0,
      },
      sourceTotalHours: 0,
      applyStats: {
        processed: 0,
        applied: 0,
        conflicts: 0,
        failed: 0,
      },
      restoreStats: {
        processed: 0,
        restored: 0,
        conflicts: 0,
        failed: 0,
      },
    })
    let freezeLock
    try {
      freezeLock = await acquireLease(runId, 'freeze')
      const digest = createBackupDigestAccumulator({ mode, timeZone, startTimePolicy })
      const classificationCounts = {
        legacy: 0,
        ambiguous: 0,
        quarantined: 0,
      }
      let candidateCount = 0
      let migratableCount = 0
      let sourceTotalHours = 0
      await streamTimecardBatches({
        renew: () => renewLease(runId, freezeLock.fence, 'freeze'),
        onBatch: async (timecards) => {
          const backups = []
          timecards.forEach((timecard) => {
            const classification = safeClassification(timecard)
            if (classification.classification === 'canonical') return
            classificationCounts[classification.classification] += 1
            const preview = classification.migratable
              ? safePreview(timecard, { mode, timeZone, startTimePolicy })
              : {
                ...classification,
                source: snapshotTimecardDateFields(timecard),
                proposed: null,
              }
            const migratable = classification.migratable && Boolean(preview.proposed)
            if (migratable) {
              migratableCount += 1
              const hours = Number(timecard.hours)
              if (Number.isFinite(hours)) sourceTotalHours += hours
            }
            backups.push({
              _id: `${runId}:${String(timecard._id)}`,
              runId,
              timecardId: timecard._id,
              original: timecard,
              originalChecksum: checksum(timecard),
              sourceDateChecksum: dateFieldsChecksum(timecard),
              proposedDateChecksum: preview.proposed
                ? dateFieldsChecksum(preview.proposed)
                : null,
              classification: classification.classification,
              migratable,
              reasons: preview.reasons || classification.reasons || [],
              warnings: preview.warnings || classification.warnings || [],
              warningCount: (preview.warnings || classification.warnings || []).length
                + (preview.reasons || classification.reasons || []).length,
              preview,
              status: migratable ? 'pending' : 'excluded',
              frozenAt: now,
            })
          })
          if (backups.length) {
            digest.update(backups)
            candidateCount += backups.length
            await TimecardDateMigrationBackups.rawCollection().insertMany(
              backups,
              { ordered: true },
            )
          }
          const heartbeatAt = new Date()
          const heartbeatResult = await TimecardDateMigrationRuns.rawCollection().updateOne(
            { _id: runId, status: 'freezing', leaseFence: freezeLock.fence },
            { $set: { freezeHeartbeatAt: heartbeatAt, updatedAt: heartbeatAt } },
          )
          if (heartbeatResult.matchedCount !== 1) {
            throw migrationError(
              'state-changed',
              'The preview run changed while its backup was being frozen',
            )
          }
        },
      })
      const frozenAt = new Date()
      const snapshotDigest = digest.digest()
      await renewLease(runId, freezeLock.fence, 'freeze')
      const result = await TimecardDateMigrationRuns.rawCollection().updateOne(
        { _id: runId, status: 'freezing', leaseFence: freezeLock.fence },
        {
          $set: {
            status: 'preview',
            frozenAt,
            updatedAt: frozenAt,
            candidateCount,
            migratableCount,
            excludedCount: candidateCount - migratableCount,
            classificationCounts,
            sourceTotalHours,
            snapshotDigest,
          },
          $unset: { freezeHeartbeatAt: '' },
        },
      )
      if (result.matchedCount !== 1) {
        throw migrationError('state-changed', 'The preview run changed before freeze completed')
      }
      await releaseLease(runId, freezeLock.fence)
      return publicRun(await findRun(runId))
    } catch (error) {
      const failureSelector = { _id: runId, status: 'freezing' }
      if (freezeLock) {
        failureSelector.leaseFence = freezeLock.fence
      }
      await TimecardDateMigrationRuns.rawCollection().updateOne(
        failureSelector,
        {
          $set: {
            status: 'failed',
            updatedAt: new Date(),
            lastError: error.message,
          },
        },
      )
      if (freezeLock) {
        await releaseLease(runId, freezeLock.fence)
      }
      throw error
    }
  },
})

const previewPage = new ValidatedMethod({
  name: 'timecardDateMigration.previewPage',
  validate(args) {
    check(args, {
      runId: String,
      page: Match.Optional(Number),
      pageSize: Match.Optional(Number),
      classification: Match.Optional(String),
      status: Match.Optional(String),
      warningsOnly: Match.Optional(Boolean),
      sortField: Match.Optional(String),
      sortDirection: Match.Optional(String),
    })
  },
  mixins: [adminAuthenticationMixin],
  async run({
    runId, page, pageSize, classification, status, warningsOnly, sortField, sortDirection,
  }) {
    const run = await findRun(runId)
    const normalizedPage = boundedInteger(page, 1, Number.MAX_SAFE_INTEGER)
    const normalizedPageSize = boundedInteger(pageSize, 50, MAX_PAGE_SIZE)
    const normalizedSort = previewSort(sortField, sortDirection)
    const selector = { runId }
    if (classification) {
      selector.classification = classification
    }
    if (status) {
      const allowedStatuses = [
        'pending', 'applying-record', 'applied', 'conflict', 'failed', 'excluded',
        'restoring-record', 'restored', 'restore-conflict', 'restore-failed',
      ]
      if (!allowedStatuses.includes(status)) {
        throw migrationError('invalid-status', 'Choose a supported backup record status')
      }
      selector.status = status
    }
    if (warningsOnly) {
      selector.$or = [
        { 'warnings.0': { $exists: true } },
        { 'reasons.0': { $exists: true } },
      ]
    }
    const total = await TimecardDateMigrationBackups.find(selector).countAsync()
    const backups = await TimecardDateMigrationBackups.find(selector, {
      sort: normalizedSort.mongo,
      skip: (normalizedPage - 1) * normalizedPageSize,
      limit: normalizedPageSize,
    }).fetchAsync()
    const current = await currentDocumentsById(backups)
    return {
      run: publicRun(run),
      items: backups.map((backup) => previewItem(
        backup,
        run,
        current.get(backup.timecardId),
      )),
      total,
      page: normalizedPage,
      pageSize: normalizedPageSize,
      sortField: normalizedSort.field,
      sortDirection: normalizedSort.direction,
    }
  },
})

const verifyBackup = new ValidatedMethod({
  name: 'timecardDateMigration.verifyBackup',
  validate(args) {
    check(args, { runId: String })
  },
  mixins: [adminAuthenticationMixin],
  async run({ runId }) {
    const run = await findRun(runId)
    const integrity = await calculateBackupIntegrity(run)
    await TimecardDateMigrationRuns.updateAsync(runId, {
      $set: {
        backupIntegrity: integrity,
        backupVerifiedAt: integrity.checkedAt,
        updatedAt: new Date(),
      },
    })
    return integrity
  },
})

const prepareBackup = new ValidatedMethod({
  name: 'timecardDateMigration.prepareBackup',
  validate(args) {
    check(args, { runId: String })
  },
  mixins: [adminAuthenticationMixin],
  async run({ runId }) {
    const run = await findRun(runId)
    assertRunStatus(run, ['preview', 'ready', 'backup-invalid'])
    const integrity = await calculateBackupIntegrity(run)
    const preparedAt = new Date()
    const result = await TimecardDateMigrationRuns.rawCollection().updateOne(
      exactRunStateSelector(run),
      {
        $set: {
          status: integrity.ok ? 'ready' : 'backup-invalid',
          backupIntegrity: integrity,
          backupVerifiedAt: integrity.checkedAt,
          preparedAt: integrity.ok ? preparedAt : run.preparedAt,
          updatedAt: preparedAt,
        },
      },
    )
    if (result.matchedCount !== 1) {
      throw migrationError('state-changed', 'The migration run changed during backup preparation')
    }
    return {
      run: publicRun(await findRun(runId)),
      integrity,
    }
  },
})

const applyBatch = new ValidatedMethod({
  name: 'timecardDateMigration.applyBatch',
  validate(args) {
    check(args, {
      runId: String,
      batchSize: Match.Optional(Number),
    })
  },
  mixins: [adminAuthenticationMixin],
  async run({ runId, batchSize }) {
    const normalizedBatchSize = boundedInteger(batchSize, 100, MAX_BATCH_SIZE)
    const run = await findRun(runId)
    assertRunStatus(run, APPLY_STATUSES)
    if (!run.backupIntegrity?.ok) {
      throw migrationError(
        'backup-not-verified',
        'Verify the frozen backup before applying changes',
      )
    }
    const lock = await acquireLease(runId, 'apply')
    try {
      const shouldRecheckIntegrity = !run.applyStartedAt
        || run.integrityRecheckRequired
        || lock.recoveredBusyLease
      const integrity = shouldRecheckIntegrity
        ? await calculateBackupIntegrity(run, {
          renew: () => renewLease(runId, lock.fence, 'apply'),
        })
        : run.backupIntegrity
      if (!integrity.ok) {
        throw migrationError('backup-corrupt', 'Backup integrity changed after preparation')
      }
      const startedAt = run.applyStartedAt || new Date()
      await renewLease(runId, lock.fence, 'apply')
      const transitionResult = await TimecardDateMigrationRuns.rawCollection().updateOne(
        { _id: runId, status: run.status, leaseFence: lock.fence },
        {
          $set: {
            status: 'applying',
            backupIntegrity: integrity,
            applyStartedAt: startedAt,
            updatedAt: new Date(),
          },
          $unset: { integrityRecheckRequired: '' },
        },
      )
      if (transitionResult.matchedCount !== 1) {
        throw migrationError('state-changed', 'The migration run changed before apply started')
      }
      const backups = await TimecardDateMigrationBackups.find({
        runId,
        migratable: true,
        status: { $in: ['pending', 'applying-record'] },
      }, {
        sort: { timecardId: 1 },
        limit: normalizedBatchSize,
      }).fetchAsync()
      for (const backup of backups) {
        if (await acknowledgePauseRequest(runId, 'apply', lock)) {
          const progress = await buildProgress(runId)
          return {
            run: publicRun(await findRun(runId)),
            progress,
            done: false,
          }
        }
        await renewLease(runId, lock.fence, 'apply')
        const intentResult = await TimecardDateMigrationBackups.rawCollection().findOneAndUpdate(
          {
            _id: backup._id,
            $or: [
              { status: 'pending' },
              {
                status: 'applying-record',
                $or: [
                  { applyFence: { $exists: false } },
                  { applyFence: { $lt: lock.fence } },
                ],
              },
            ],
          },
          {
            $set: {
              status: 'applying-record',
              applyIntentAt: new Date(),
              applyFence: lock.fence,
            },
          },
          { returnDocument: 'before' },
        )
        const claimedBackup = Object.prototype.hasOwnProperty.call(intentResult || {}, 'value')
          ? intentResult.value
          : intentResult
        if (!claimedBackup?._id) {
          continue
        }
        const wasRecoveringIntent = claimedBackup.status === 'applying-record'
        let status = 'failed'
        let errorMessage
        let appliedDateRevision
        let timecardWriteAttempted = false
        let preserveIntent = false
        try {
          if (!backupRecordIntegrityIsValid(claimedBackup)) {
            throw migrationError(
              'backup-corrupt',
              `Backup ${claimedBackup._id} failed its checksum`,
            )
          }
          appliedDateRevision = nextDateRevision(claimedBackup.original)
          const current = await Timecards.findOneAsync(claimedBackup.timecardId)
          if (wasRecoveringIntent
            && matchesDateState(
              current,
              claimedBackup.preview.proposed,
              appliedDateRevision,
            )) {
            status = 'applied'
          } else if (!current
            || !equalTimecardDateFields(
              snapshotTimecardDateFields(current),
              snapshotTimecardDateFields(claimedBackup.original),
            )
            || !equalDateRevision(current, claimedBackup.original)) {
            status = 'conflict'
            errorMessage = current ? 'date-fields-changed' : 'timecard-deleted'
          } else {
            await renewLease(runId, lock.fence, 'apply')
            timecardWriteAttempted = true
            const result = await Timecards.rawCollection().updateOne(
              sourceSelector(claimedBackup.original),
              dateFieldsUpdate(claimedBackup.preview.proposed),
            )
            if (result.matchedCount === 1) {
              status = 'applied'
            } else {
              const afterUpdate = await Timecards.findOneAsync(claimedBackup.timecardId)
              if (matchesDateState(
                afterUpdate,
                claimedBackup.preview.proposed,
                appliedDateRevision,
              )) {
                status = 'applied'
              } else {
                status = 'conflict'
                errorMessage = 'changed-during-apply'
              }
            }
          }
        } catch (error) {
          errorMessage = error.message
          if (timecardWriteAttempted && appliedDateRevision != null) {
            try {
              const afterError = await Timecards.findOneAsync(claimedBackup.timecardId)
              if (matchesDateState(
                afterError,
                claimedBackup.preview.proposed,
                appliedDateRevision,
              )) {
                status = 'applied'
              } else {
                preserveIntent = true
              }
            } catch (reconciliationError) {
              preserveIntent = true
              console.error(
                `Unable to reconcile uncertain apply for ${claimedBackup._id}`,
                reconciliationError,
              )
            }
          }
        }
        if (preserveIntent) {
          await TimecardDateMigrationBackups.rawCollection().updateOne(
            {
              _id: claimedBackup._id,
              status: 'applying-record',
              applyFence: lock.fence,
            },
            {
              $set: {
                applyError: errorMessage,
                applyUncertainAt: new Date(),
              },
            },
          )
          continue
        }
        const appliedAt = new Date()
        const backupUpdate = {
          $set: {
            status,
            applyProcessedAt: appliedAt,
            applyFence: lock.fence,
          },
        }
        if (status === 'applied') {
          backupUpdate.$set.appliedAt = appliedAt
          backupUpdate.$set.appliedDateRevision = appliedDateRevision
          backupUpdate.$unset = { applyError: '' }
        } else {
          backupUpdate.$set.applyError = errorMessage
          backupUpdate.$unset = { appliedDateRevision: '' }
        }
        const journalResult = await TimecardDateMigrationBackups.rawCollection().updateOne(
          {
            _id: claimedBackup._id,
            status: 'applying-record',
            applyFence: lock.fence,
          },
          backupUpdate,
        )
        if (journalResult.matchedCount === 1) {
          await TimecardDateMigrationRuns.updateAsync(runId, {
            $set: { updatedAt: appliedAt },
          })
        }
      }
      if (await acknowledgePauseRequest(runId, 'apply', lock)) {
        const progress = await buildProgress(runId)
        return {
          run: publicRun(await findRun(runId)),
          progress,
          done: false,
        }
      }
      let progress = await buildProgress(runId)
      if (progress.processed + progress.remaining !== progress.total) {
        throw migrationError('journal-incomplete', 'Backup journal count no longer matches the run')
      }
      const done = progress.remaining === 0 && progress.processed === progress.total
      if (done) {
        const terminalIntegrity = await calculateBackupIntegrity(await findRun(runId), {
          renew: () => renewLease(runId, lock.fence, 'apply'),
        })
        if (!terminalIntegrity.ok) {
          throw migrationError('backup-corrupt', 'Backup integrity failed at completion')
        }
        await renewLease(runId, lock.fence, 'apply')
        const completedAt = new Date()
        const status = progress.conflicts > 0 ? 'applied-with-conflicts' : 'applied'
        const result = await TimecardDateMigrationRuns.rawCollection().updateOne(
          { _id: runId, status: 'applying', leaseFence: lock.fence },
          {
            $set: {
              status,
              backupIntegrity: terminalIntegrity,
              completedAt,
              updatedAt: completedAt,
            },
            $unset: { pauseRequestedAt: '', pausedPhase: '', lastError: '' },
          },
        )
        if (result.matchedCount !== 1) {
          throw migrationError('state-changed', 'The migration run changed before completion')
        }
        await releaseLease(runId, lock.fence)
      } else if (backups.length === 0 && progress.failed > 0) {
        await renewLease(runId, lock.fence, 'apply')
        const result = await TimecardDateMigrationRuns.rawCollection().updateOne(
          { _id: runId, status: 'applying', leaseFence: lock.fence },
          {
            $set: {
              status: 'paused',
              pausedPhase: 'apply',
              updatedAt: new Date(),
            },
          },
        )
        if (result.matchedCount !== 1) {
          throw migrationError('state-changed', 'The migration run changed before pausing')
        }
        await releaseLease(runId, lock.fence)
      } else {
        await parkLease(runId, lock.fence, 'apply')
      }
      progress = await buildProgress(runId)
      return {
        run: publicRun(await findRun(runId)),
        progress,
        done: progress.remaining === 0,
      }
    } catch (error) {
      await TimecardDateMigrationRuns.rawCollection().updateOne(
        {
          _id: runId,
          status: { $in: [run.status, 'applying'] },
          leaseFence: lock.fence,
        },
        {
          $set: {
            status: 'paused',
            pausedPhase: 'apply',
            lastError: error.message,
            updatedAt: new Date(),
          },
        },
      )
      await releaseLease(runId, lock.fence)
      throw error
    }
  },
})

const pause = new ValidatedMethod({
  name: 'timecardDateMigration.pause',
  validate(args) {
    check(args, { runId: String })
  },
  mixins: [adminAuthenticationMixin],
  async run({ runId }) {
    const run = await findRun(runId)
    assertRunStatus(run, ['applying', 'restoring'])
    const pausedPhase = run.status === 'restoring' ? 'restore' : 'apply'
    const requestedAt = new Date()
    const requestResult = await TimecardDateMigrationRuns.rawCollection().updateOne(
      { _id: runId, status: run.status },
      { $set: { pauseRequestedAt: requestedAt, updatedAt: requestedAt } },
    )
    if (requestResult.matchedCount !== 1) {
      return publicRun(await findRun(runId))
    }
    const pauseLock = await claimPauseLease(runId, pausedPhase)
    if (pauseLock) {
      await finalizePauseWithLease(runId, pausedPhase, pauseLock)
    }
    return publicRun(await findRun(runId))
  },
})

const resume = new ValidatedMethod({
  name: 'timecardDateMigration.resume',
  validate(args) {
    check(args, { runId: String })
  },
  mixins: [adminAuthenticationMixin],
  async run({ runId }) {
    const initialRun = await findRun(runId)
    assertRunStatus(initialRun, ['paused'])
    const lock = await acquireLease(runId, 'resume')
    try {
      const run = await findRun(runId)
      assertRunStatus(run, ['paused'])
      const restoring = run.pausedPhase === 'restore'
      const failedStatus = restoring ? 'restore-failed' : 'failed'
      const retryStatus = restoring ? 'applied' : 'pending'
      const failedCount = await TimecardDateMigrationBackups.find({
        runId,
        status: failedStatus,
      }).countAsync()
      if (failedCount) {
        await TimecardDateMigrationBackups.updateAsync(
          { runId, status: failedStatus },
          { $set: { status: retryStatus }, $unset: { applyError: '', restoreError: '' } },
          { multi: true },
        )
      }
      if (restoring) {
        await buildRestoreProgress(runId)
      } else {
        await buildProgress(runId)
      }
      await renewLease(runId, lock.fence, 'resume')
      const resumedAt = new Date()
      const result = await TimecardDateMigrationRuns.rawCollection().updateOne(
        { _id: runId, status: 'paused', leaseFence: lock.fence },
        {
          $set: {
            status: restoring ? 'restore-ready' : 'ready',
            integrityRecheckRequired: true,
            updatedAt: resumedAt,
          },
          $unset: { pausedPhase: '', pauseRequestedAt: '', lastError: '' },
        },
      )
      if (result.matchedCount !== 1) {
        throw migrationError('state-changed', 'The migration run changed before it could resume')
      }
      return publicRun(await findRun(runId))
    } finally {
      await releaseLease(runId, lock.fence)
    }
  },
})

const cancel = new ValidatedMethod({
  name: 'timecardDateMigration.cancel',
  validate(args) {
    check(args, { runId: String })
  },
  mixins: [adminAuthenticationMixin],
  async run({ runId }) {
    const allowedStatuses = ['preview', 'ready', 'backup-invalid', 'paused']
    const initialRun = await findRun(runId)
    assertRunStatus(initialRun, allowedStatuses)
    const lock = await acquireLease(runId, 'cancel')
    try {
      const run = await findRun(runId)
      assertRunStatus(run, allowedStatuses)
      const progress = await buildProgress(runId)
      const uncertainIntents = await TimecardDateMigrationBackups.find({
        runId,
        status: { $in: ['applying-record', 'restoring-record'] },
      }).countAsync()
      if (progress.applied > 0 || uncertainIntents > 0) {
        throw migrationError(
          'cannot-cancel-applied',
          'Restore the applied records instead of cancelling',
        )
      }
      await renewLease(runId, lock.fence, 'cancel')
      const cancelledAt = new Date()
      const result = await TimecardDateMigrationRuns.rawCollection().updateOne(
        { _id: runId, status: run.status, leaseFence: lock.fence },
        { $set: { status: 'cancelled', cancelledAt, updatedAt: cancelledAt } },
      )
      if (result.matchedCount !== 1) {
        throw migrationError('state-changed', 'The migration run changed before cancellation')
      }
      return publicRun(await findRun(runId))
    } finally {
      await releaseLease(runId, lock.fence)
    }
  },
})

const verify = new ValidatedMethod({
  name: 'timecardDateMigration.verify',
  validate(args) {
    check(args, { runId: String })
  },
  mixins: [adminAuthenticationMixin],
  async run({ runId }) {
    const allowedStatuses = [
      'applied', 'applied-with-conflicts', 'completed', 'verified',
      'restored', 'restored-with-conflicts',
    ]
    const initialRun = await findRun(runId)
    assertRunStatus(initialRun, allowedStatuses)
    const lock = await acquireLease(runId, 'verify')
    try {
      const run = await findRun(runId)
      assertRunStatus(run, allowedStatuses)
      const renewVerificationLease = () => renewLease(runId, lock.fence, 'verify')
      const integrity = await calculateBackupIntegrity(run, {
        renew: renewVerificationLease,
      })
      const applyProgress = await buildProgress(runId)
      const restoreProgress = await buildRestoreProgress(runId)
      const restoring = ['restored', 'restored-with-conflicts'].includes(run.status)
      let correctDateFields = 0
      let sourceHours = 0
      let currentHours = 0
      let expectedDateFieldRecords = 0
      let checkedRecords = 0
      let currentRecordCount = 0
      await streamBackupBatches({
        selector: { runId, migratable: true },
        renew: renewVerificationLease,
        onBatch: async (backups) => {
          const current = await currentDocumentsById(backups)
          checkedRecords += backups.length
          currentRecordCount += current.size
          backups.forEach((backup) => {
            const document = current.get(backup.timecardId)
            sourceHours += Number(backup.original.hours) || 0
            currentHours += Number(document?.hours) || 0
            let expected
            let expectedDateRevision
            if (restoring && backup.status === 'restored') {
              expected = snapshotTimecardDateFields(backup.original)
              expectedDateRevision = restoredRevisionForBackup(backup)
            } else if (!restoring && backup.status === 'applied') {
              expected = backup.preview.proposed
              expectedDateRevision = appliedRevisionForBackup(backup)
            }
            if (expected) {
              expectedDateFieldRecords += 1
              if (matchesDateState(document, expected, expectedDateRevision)) {
                correctDateFields += 1
              }
            }
          })
        },
      })
      const residualCounts = await liveClassificationCounts({
        renew: renewVerificationLease,
      })
      const scopeCountUnchanged = currentRecordCount === checkedRecords
      const hoursUnchanged = sourceHours === currentHours
      const applyComplete = applyProgress.applied === run.migratableCount
        && applyProgress.processed === run.migratableCount
        && applyProgress.remaining === 0
        && applyProgress.conflicts === 0
        && applyProgress.failed === 0
      const restoreComplete = restoreProgress.processed === restoreProgress.total
        && restoreProgress.remaining === 0
        && restoreProgress.conflicts === 0
        && restoreProgress.failed === 0
        && restoreProgress.restored === restoreProgress.total
      const dateFieldsCorrect = correctDateFields === expectedDateFieldRecords
        && expectedDateFieldRecords === (restoring ? restoreProgress.total : run.migratableCount)
      const report = {
        ok: integrity.ok && scopeCountUnchanged && hoursUnchanged && dateFieldsCorrect
          && (restoring
            ? restoreComplete
            : applyComplete && residualCounts.legacy === 0 && residualCounts.ambiguous === 0),
        phase: restoring ? 'restore' : 'apply',
        backupIntegrity: integrity,
        checkedRecords,
        expectedRecords: run.migratableCount,
        correctDateFields,
        expectedDateFieldRecords,
        missingOrChangedDateFields: expectedDateFieldRecords - correctDateFields,
        sourceHours,
        currentHours,
        hoursUnchanged,
        scopeCountUnchanged,
        applyProgress,
        restoreProgress,
        residualCounts,
        residualMigratable: residualCounts.legacy + residualCounts.ambiguous,
        quarantinedRequireAttention: residualCounts.quarantined,
        checkedAt: new Date(),
      }
      let nextStatus = run.status
      if (report.ok && !restoring) {
        nextStatus = 'verified'
      } else if (!report.ok && run.status === 'verified') {
        nextStatus = applyProgress.conflicts > 0 ? 'applied-with-conflicts' : 'applied'
      } else if (!report.ok && restoring) {
        nextStatus = 'restored-with-conflicts'
      }
      await renewLease(runId, lock.fence, 'verify')
      const result = await TimecardDateMigrationRuns.rawCollection().updateOne(
        { _id: runId, status: run.status, leaseFence: lock.fence },
        {
          $set: {
            status: nextStatus,
            verification: report,
            verifiedAt: report.checkedAt,
            updatedAt: report.checkedAt,
          },
        },
      )
      if (result.matchedCount !== 1) {
        throw migrationError('state-changed', 'The migration run changed during verification')
      }
      return { run: publicRun(await findRun(runId)), report }
    } finally {
      await releaseLease(runId, lock.fence)
    }
  },
})

const history = new ValidatedMethod({
  name: 'timecardDateMigration.history',
  validate(args) {
    check(args, {
      page: Match.Optional(Number),
      pageSize: Match.Optional(Number),
    })
  },
  mixins: [adminAuthenticationMixin],
  async run({ page, pageSize }) {
    await recoverStaleRuns()
    const normalizedPage = boundedInteger(page, 1, Number.MAX_SAFE_INTEGER)
    const normalizedPageSize = boundedInteger(pageSize, 20, 100)
    const total = await TimecardDateMigrationRuns.find().countAsync()
    const runs = await TimecardDateMigrationRuns.find({}, {
      sort: { createdAt: -1 },
      skip: (normalizedPage - 1) * normalizedPageSize,
      limit: normalizedPageSize,
    }).fetchAsync()
    return {
      items: runs.map(publicRun),
      total,
      page: normalizedPage,
      pageSize: normalizedPageSize,
    }
  },
})

const getRun = new ValidatedMethod({
  name: 'timecardDateMigration.getRun',
  validate(args) {
    check(args, { runId: String })
  },
  mixins: [adminAuthenticationMixin],
  async run({ runId }) {
    return publicRun(await findRun(runId))
  },
})

const exportBackupPage = new ValidatedMethod({
  name: 'timecardDateMigration.exportBackupPage',
  validate(args) {
    check(args, {
      runId: String,
      page: Match.Optional(Number),
      pageSize: Match.Optional(Number),
    })
  },
  mixins: [adminAuthenticationMixin],
  async run({ runId, page, pageSize }) {
    const run = await findRun(runId)
    const normalizedPage = boundedInteger(page, 1, Number.MAX_SAFE_INTEGER)
    const normalizedPageSize = boundedInteger(pageSize, 50, 100)
    const selector = { runId }
    const total = await TimecardDateMigrationBackups.find(selector).countAsync()
    const backups = await TimecardDateMigrationBackups.find(selector, {
      sort: { 'original.date': -1, timecardId: 1 },
      skip: (normalizedPage - 1) * normalizedPageSize,
      limit: normalizedPageSize,
      fields: {
        timecardId: 1,
        original: 1,
        originalChecksum: 1,
        frozenAt: 1,
      },
    }).fetchAsync()
    return {
      run: publicRun(run),
      items: backups.map((backup) => ({
        backupId: backup._id,
        timecardId: backup.timecardId,
        original: backup.original,
        originalChecksum: backup.originalChecksum,
        frozenAt: backup.frozenAt,
      })),
      total,
      page: normalizedPage,
      pageSize: normalizedPageSize,
    }
  },
})

const restorePreviewPage = new ValidatedMethod({
  name: 'timecardDateMigration.restorePreviewPage',
  validate(args) {
    check(args, {
      runId: String,
      page: Match.Optional(Number),
      pageSize: Match.Optional(Number),
    })
  },
  mixins: [adminAuthenticationMixin],
  async run({ runId, page, pageSize }) {
    const run = await findRun(runId)
    assertRunStatus(run, RESTORE_PREVIEW_STATUSES)
    if (run.status === 'paused' && run.pausedPhase !== 'restore') {
      throw migrationError('invalid-run-status', 'Only a paused restore has a restore preview')
    }
    const normalizedPage = boundedInteger(page, 1, Number.MAX_SAFE_INTEGER)
    const normalizedPageSize = boundedInteger(pageSize, 50, MAX_PAGE_SIZE)
    const selector = {
      runId,
      status: {
        $in: [
          'applied', 'restoring-record', 'restore-failed', 'restore-conflict', 'restored',
        ],
      },
    }
    const total = await TimecardDateMigrationBackups.find(selector).countAsync()
    const backups = await TimecardDateMigrationBackups.find(selector, {
      sort: { timecardId: 1 },
      skip: (normalizedPage - 1) * normalizedPageSize,
      limit: normalizedPageSize,
    }).fetchAsync()
    const current = await currentDocumentsById(backups)
    const items = backups.map((backup) => {
      const document = current.get(backup.timecardId)
      const currentFields = document ? snapshotTimecardDateFields(document) : null
      const appliedDateRevision = appliedRevisionForBackup(backup)
      const restoredDateRevision = restoredRevisionForBackup(backup)
      const alreadyOriginal = matchesDateState(
        document,
        snapshotTimecardDateFields(backup.original),
        restoredDateRevision,
      )
      const currentlyMigrated = matchesDateState(
        document,
        backup.preview.proposed,
        appliedDateRevision,
      )
      const conflict = backup.status === 'restored'
        ? !alreadyOriginal
        : !currentlyMigrated
      return {
        backupId: backup._id,
        timecardId: backup.timecardId,
        userId: backup.original.userId,
        projectId: backup.original.projectId,
        task: backup.original.task,
        hours: backup.original.hours,
        original: snapshotTimecardDateFields(backup.original),
        migrated: backup.preview.proposed,
        current: currentFields,
        currentDateRevision: document?.dateRevision,
        appliedDateRevision,
        restoredDateRevision,
        status: backup.status,
        conflict,
      }
    })
    return {
      run: publicRun(run),
      items,
      total,
      page: normalizedPage,
      pageSize: normalizedPageSize,
      summary: await buildRestoreProgress(runId),
    }
  },
})

const restoreBatch = new ValidatedMethod({
  name: 'timecardDateMigration.restoreBatch',
  validate(args) {
    check(args, {
      runId: String,
      batchSize: Match.Optional(Number),
    })
  },
  mixins: [adminAuthenticationMixin],
  async run({ runId, batchSize }) {
    const normalizedBatchSize = boundedInteger(batchSize, 100, MAX_BATCH_SIZE)
    const run = await findRun(runId)
    assertRunStatus(run, RESTORE_BATCH_STATUSES)
    const lock = await acquireLease(runId, 'restore')
    try {
      const shouldRecheckIntegrity = !run.restoreStartedAt
        || run.integrityRecheckRequired
        || lock.recoveredBusyLease
      const integrity = shouldRecheckIntegrity
        ? await calculateBackupIntegrity(run, {
          renew: () => renewLease(runId, lock.fence, 'restore'),
        })
        : run.backupIntegrity
      if (!integrity.ok) {
        throw migrationError('backup-corrupt', 'Restore stopped because backup integrity failed')
      }
      const startedAt = run.restoreStartedAt || new Date()
      await renewLease(runId, lock.fence, 'restore')
      const transitionResult = await TimecardDateMigrationRuns.rawCollection().updateOne(
        { _id: runId, status: run.status, leaseFence: lock.fence },
        {
          $set: {
            status: 'restoring',
            backupIntegrity: integrity,
            restoreStartedAt: startedAt,
            updatedAt: new Date(),
          },
          $unset: { integrityRecheckRequired: '' },
        },
      )
      if (transitionResult.matchedCount !== 1) {
        throw migrationError('state-changed', 'The migration run changed before restore started')
      }
      const backups = await TimecardDateMigrationBackups.find({
        runId,
        status: { $in: ['applied', 'restoring-record'] },
      }, {
        sort: { timecardId: 1 },
        limit: normalizedBatchSize,
      }).fetchAsync()
      for (const backup of backups) {
        if (await acknowledgePauseRequest(runId, 'restore', lock)) {
          const progress = await buildRestoreProgress(runId)
          return {
            run: publicRun(await findRun(runId)),
            progress,
            done: false,
          }
        }
        await renewLease(runId, lock.fence, 'restore')
        const intentResult = await TimecardDateMigrationBackups.rawCollection().findOneAndUpdate(
          {
            _id: backup._id,
            $or: [
              { status: 'applied' },
              {
                status: 'restoring-record',
                $or: [
                  { restoreFence: { $exists: false } },
                  { restoreFence: { $lt: lock.fence } },
                ],
              },
            ],
          },
          {
            $set: {
              status: 'restoring-record',
              restoreIntentAt: new Date(),
              restoreFence: lock.fence,
            },
          },
          { returnDocument: 'before' },
        )
        const claimedBackup = Object.prototype.hasOwnProperty.call(intentResult || {}, 'value')
          ? intentResult.value
          : intentResult
        if (!claimedBackup?._id) {
          continue
        }
        const wasRecoveringIntent = claimedBackup.status === 'restoring-record'
        let status = 'restore-failed'
        let errorMessage
        let restoredDateRevision
        let timecardWriteAttempted = false
        let preserveIntent = false
        try {
          if (!backupRecordIntegrityIsValid(claimedBackup)) {
            throw migrationError(
              'backup-corrupt',
              `Backup ${claimedBackup._id} failed its checksum`,
            )
          }
          const appliedDateRevision = appliedRevisionForBackup(claimedBackup)
          restoredDateRevision = restoredRevisionForBackup(claimedBackup)
          const current = await Timecards.findOneAsync(claimedBackup.timecardId)
          const originalFields = snapshotTimecardDateFields(claimedBackup.original)
          if (wasRecoveringIntent && matchesDateState(
            current,
            originalFields,
            restoredDateRevision,
          )) {
            status = 'restored'
          } else if (!matchesDateState(
            current,
            claimedBackup.preview.proposed,
            appliedDateRevision,
          )) {
            status = 'restore-conflict'
            errorMessage = current ? 'date-fields-changed-after-migration' : 'timecard-deleted'
          } else {
            await renewLease(runId, lock.fence, 'restore')
            timecardWriteAttempted = true
            const result = await Timecards.rawCollection().updateOne(
              sourceSelector({
                ...claimedBackup.preview.proposed,
                _id: claimedBackup.timecardId,
                dateRevision: appliedDateRevision,
              }),
              dateFieldsUpdate(originalFields),
            )
            if (result.matchedCount === 1) {
              status = 'restored'
            } else {
              const afterUpdate = await Timecards.findOneAsync(claimedBackup.timecardId)
              if (matchesDateState(afterUpdate, originalFields, restoredDateRevision)) {
                status = 'restored'
              } else {
                status = 'restore-conflict'
                errorMessage = 'changed-during-restore'
              }
            }
          }
        } catch (error) {
          errorMessage = error.message
          if (timecardWriteAttempted && restoredDateRevision != null) {
            try {
              const afterError = await Timecards.findOneAsync(claimedBackup.timecardId)
              const originalFields = snapshotTimecardDateFields(claimedBackup.original)
              if (matchesDateState(afterError, originalFields, restoredDateRevision)) {
                status = 'restored'
              } else {
                preserveIntent = true
              }
            } catch (reconciliationError) {
              preserveIntent = true
              console.error(
                `Unable to reconcile uncertain restore for ${claimedBackup._id}`,
                reconciliationError,
              )
            }
          }
        }
        if (preserveIntent) {
          await TimecardDateMigrationBackups.rawCollection().updateOne(
            {
              _id: claimedBackup._id,
              status: 'restoring-record',
              restoreFence: lock.fence,
            },
            {
              $set: {
                restoreError: errorMessage,
                restoreUncertainAt: new Date(),
              },
            },
          )
          continue
        }
        const restoredAt = new Date()
        const backupUpdate = {
          $set: {
            status,
            restoreProcessedAt: restoredAt,
            restoreFence: lock.fence,
          },
        }
        if (status === 'restored') {
          backupUpdate.$set.restoredAt = restoredAt
          backupUpdate.$set.restoredDateRevision = restoredDateRevision
          backupUpdate.$unset = { restoreError: '' }
        } else {
          backupUpdate.$set.restoreError = errorMessage
          backupUpdate.$unset = { restoredDateRevision: '' }
        }
        const journalResult = await TimecardDateMigrationBackups.rawCollection().updateOne(
          {
            _id: claimedBackup._id,
            status: 'restoring-record',
            restoreFence: lock.fence,
          },
          backupUpdate,
        )
        if (journalResult.matchedCount === 1) {
          await TimecardDateMigrationRuns.updateAsync(runId, {
            $set: { updatedAt: restoredAt },
          })
        }
      }
      if (await acknowledgePauseRequest(runId, 'restore', lock)) {
        const progress = await buildRestoreProgress(runId)
        return {
          run: publicRun(await findRun(runId)),
          progress,
          done: false,
        }
      }
      let progress = await buildRestoreProgress(runId)
      if (progress.processed + progress.remaining !== progress.total) {
        throw migrationError(
          'journal-incomplete',
          'Restore journal count no longer matches the run',
        )
      }
      const done = progress.remaining === 0 && progress.processed === progress.total
      if (done) {
        const terminalIntegrity = await calculateBackupIntegrity(await findRun(runId), {
          renew: () => renewLease(runId, lock.fence, 'restore'),
        })
        if (!terminalIntegrity.ok) {
          throw migrationError('backup-corrupt', 'Backup integrity failed at restore completion')
        }
        await renewLease(runId, lock.fence, 'restore')
        const restoredAt = new Date()
        const status = progress.conflicts > 0 ? 'restored-with-conflicts' : 'restored'
        const result = await TimecardDateMigrationRuns.rawCollection().updateOne(
          { _id: runId, status: 'restoring', leaseFence: lock.fence },
          {
            $set: {
              status,
              backupIntegrity: terminalIntegrity,
              restoredAt,
              updatedAt: restoredAt,
            },
            $unset: { pauseRequestedAt: '', pausedPhase: '', lastError: '' },
          },
        )
        if (result.matchedCount !== 1) {
          throw migrationError('state-changed', 'The restore run changed before completion')
        }
        await releaseLease(runId, lock.fence)
      } else if (backups.length === 0 && progress.failed > 0) {
        await renewLease(runId, lock.fence, 'restore')
        const result = await TimecardDateMigrationRuns.rawCollection().updateOne(
          { _id: runId, status: 'restoring', leaseFence: lock.fence },
          {
            $set: {
              status: 'paused',
              pausedPhase: 'restore',
              updatedAt: new Date(),
            },
          },
        )
        if (result.matchedCount !== 1) {
          throw migrationError('state-changed', 'The restore run changed before pausing')
        }
        await releaseLease(runId, lock.fence)
      } else {
        await parkLease(runId, lock.fence, 'restore')
      }
      progress = await buildRestoreProgress(runId)
      return {
        run: publicRun(await findRun(runId)),
        progress,
        done: progress.remaining === 0,
      }
    } catch (error) {
      await TimecardDateMigrationRuns.rawCollection().updateOne(
        {
          _id: runId,
          status: { $in: [run.status, 'restoring'] },
          leaseFence: lock.fence,
        },
        {
          $set: {
            status: 'paused',
            pausedPhase: 'restore',
            lastError: error.message,
            updatedAt: new Date(),
          },
        },
      )
      await releaseLease(runId, lock.fence)
      throw error
    }
  },
})

export {
  applyBatch,
  cancel,
  createPreviewRun,
  exportBackupPage,
  getRun,
  history,
  optionPreview,
  pause,
  prepareBackup,
  previewPage,
  restoreBatch,
  restorePreviewPage,
  resume,
  scan,
  verify,
  verifyBackup,
}
