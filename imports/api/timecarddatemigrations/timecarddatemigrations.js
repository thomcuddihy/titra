import { Meteor } from 'meteor/meteor'
import { Mongo } from 'meteor/mongo'
import { Random } from 'meteor/random'

const TimecardDateMigrationRuns = new Mongo.Collection('timecardDateMigrationRuns')
const TimecardDateMigrationBackups = new Mongo.Collection('timecardDateMigrationBackups')
const TimecardDateMigrationLocks = new Mongo.Collection('timecardDateMigrationLocks')

const MIGRATION_LOCK_ID = 'timecard-date-migration'
const WRITER_LEASE_DURATION_MS = 5 * 60 * 1000
const WRITER_HEARTBEAT_INTERVAL_MS = Math.floor(WRITER_LEASE_DURATION_MS / 3)

function serverLeaseUntilExpression(durationMs) {
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

function migrationLeaseIsAvailableExpression() {
  return {
    $or: [
      { $eq: [{ $type: '$ownerRunId' }, 'missing'] },
      { $eq: ['$ownerRunId', null] },
      { $lte: [{ $ifNull: ['$leaseUntil', new Date(0)] }, '$$NOW'] },
    ],
  }
}

async function acquireTimecardDateWriteLease() {
  const token = Random.id()
  const rawLocks = TimecardDateMigrationLocks.rawCollection()
  await rawLocks.updateOne(
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
  const result = await rawLocks.findOneAndUpdate(
    {
      _id: MIGRATION_LOCK_ID,
      $expr: migrationLeaseIsAvailableExpression(),
    },
    [
      {
        $set: {
          fence: { $add: [{ $ifNull: ['$fence', 0] }, 1] },
          activeWriters: {
            $concatArrays: [
              liveWritersExpression(),
              [{
                token,
                acquiredAt: '$$NOW',
                leaseUntil: serverLeaseUntilExpression(WRITER_LEASE_DURATION_MS),
              }],
            ],
          },
        },
      },
    ],
    { returnDocument: 'after' },
  )
  const lock = result?.value || result
  if (!lock?.activeWriters?.some((writer) => writer.token === token)) {
    throw new Meteor.Error(
      'notifications.timecard_migration_locked',
      'Time entries are temporarily locked while a date migration batch is running',
    )
  }
  return token
}

async function releaseTimecardDateWriteLease(token) {
  await TimecardDateMigrationLocks.rawCollection().updateOne(
    { _id: MIGRATION_LOCK_ID },
    { $pull: { activeWriters: { token } } },
  )
}

async function renewTimecardDateWriteLease(token) {
  const result = await TimecardDateMigrationLocks.rawCollection().updateOne(
    {
      _id: MIGRATION_LOCK_ID,
      $expr: {
        $and: [
          migrationLeaseIsAvailableExpression(),
          {
            $gt: [
              {
                $size: {
                  $filter: {
                    input: liveWritersExpression(),
                    as: 'writer',
                    cond: { $eq: ['$$writer.token', token] },
                  },
                },
              },
              0,
            ],
          },
        ],
      },
    },
    [
      {
        $set: {
          activeWriters: {
            $map: {
              input: liveWritersExpression(),
              as: 'writer',
              in: {
                $cond: [
                  { $eq: ['$$writer.token', token] },
                  {
                    $mergeObjects: [
                      '$$writer',
                      { leaseUntil: serverLeaseUntilExpression(WRITER_LEASE_DURATION_MS) },
                    ],
                  },
                  '$$writer',
                ],
              },
            },
          },
        },
      },
    ],
  )
  if (result.matchedCount !== 1) {
    throw new Meteor.Error(
      'notifications.timecard_migration_locked',
      'The time-entry writer lease expired or was fenced by a date migration',
    )
  }
}

async function withTimecardDateWriteLease(callback) {
  const token = await acquireTimecardDateWriteLease()
  let callbackFailed = false
  let callbackError
  let heartbeatError
  let heartbeatPromise = Promise.resolve()
  let result
  const queueHeartbeat = () => {
    heartbeatPromise = heartbeatPromise.then(async () => {
      try {
        await renewTimecardDateWriteLease(token)
        heartbeatError = undefined
      } catch (error) {
        heartbeatError = error
      }
    })
    return heartbeatPromise
  }
  const assertWriterLease = async () => {
    await queueHeartbeat()
    if (heartbeatError) {
      throw heartbeatError
    }
  }
  const heartbeatTimer = setInterval(queueHeartbeat, WRITER_HEARTBEAT_INTERVAL_MS)
  try {
    await assertWriterLease()
    result = await callback(assertWriterLease)
  } catch (error) {
    callbackFailed = true
    callbackError = error
  } finally {
    clearInterval(heartbeatTimer)
    await heartbeatPromise
    try {
      await releaseTimecardDateWriteLease(token)
    } catch (error) {
      // Never turn a successful timecard mutation into an apparent failure that
      // a client may retry. The writer intent expires automatically if cleanup
      // is temporarily unavailable.
      console.error('Unable to release timecard date writer lease', error)
    }
  }
  if (!callbackFailed && heartbeatError) {
    // The mutation already succeeded, so reporting failure could trigger a
    // duplicate client retry. Surface the lease problem operationally instead.
    console.error(
      'Timecard date writer heartbeat failed during a completed mutation',
      heartbeatError,
    )
  }
  if (callbackFailed) {
    throw callbackError
  }
  return result
}

/**
 * Prevents ordinary timecard writes while a migration owns the global lease.
 * The lease expires automatically after a crashed or abandoned batch, but the
 * lock document itself is intentionally retained for its fencing counter.
 */
async function assertTimecardDateMigrationUnlocked() {
  const activeLock = await TimecardDateMigrationLocks.rawCollection().findOne({
    _id: MIGRATION_LOCK_ID,
    operation: { $in: ['freeze', 'apply', 'restore'] },
    $expr: { $gt: [{ $ifNull: ['$leaseUntil', new Date(0)] }, '$$NOW'] },
  }, {
    projection: { _id: 1 },
  })
  if (activeLock) {
    throw new Meteor.Error(
      'notifications.timecard_migration_locked',
      'Time entries are temporarily locked while a date migration batch is running',
    )
  }
}

export {
  MIGRATION_LOCK_ID,
  TimecardDateMigrationBackups,
  TimecardDateMigrationLocks,
  TimecardDateMigrationRuns,
  acquireTimecardDateWriteLease,
  assertTimecardDateMigrationUnlocked,
  releaseTimecardDateWriteLease,
  renewTimecardDateWriteLease,
  withTimecardDateWriteLease,
}
