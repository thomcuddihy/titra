import {
  matchesTimecardDateRevision,
  timecardDateRevisionETag,
} from '../../../utils/timecardRevision.js'

class TimecardTaskEditError extends Error {
  constructor(code, reason) {
    super(reason)
    this.error = code
    this.reason = reason
  }
}

function validateTimecardTaskEditBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(body))
    || Object.keys(body).length !== 2
    || !Object.prototype.hasOwnProperty.call(body, 'task')
    || !Object.prototype.hasOwnProperty.call(body, 'expectedTask')
    || typeof body.task !== 'string'
    || typeof body.expectedTask !== 'string'
    || !body.task.isWellFormed()
    || !body.expectedTask.isWellFormed()
    || !body.task.trim()
    || [...body.task].length > 1000) {
    throw new TimecardTaskEditError(
      'timecard-task-invalid',
      'Supply only task (1–1000 Unicode code points, not blank) and expectedTask (string), both well-formed Unicode.',
    )
  }
}

function writeConflict(reason = 'The time entry changed after it was previewed. Reload and confirm it again.') {
  return new TimecardTaskEditError('timecard-write-conflict', reason)
}

// Include rule inputs and date fields, not only the revision: older writers may
// still change a field (for example billing state) without incrementing it.
function taskEditSnapshotSelector(timecard) {
  const selector = { _id: timecard._id }
  const fields = [
    'userId', 'projectId', 'task', 'date', 'dateOnly', 'startTime',
    'dateRevision', 'hours', 'state', 'taskRate',
  ]
  fields.forEach((field) => {
    selector[field] = Object.prototype.hasOwnProperty.call(timecard, field)
      ? { $eq: timecard[field], $exists: true }
      : { $exists: false }
  })
  return selector
}

/**
 * A deliberately narrow write operation. Dependencies are supplied by the Meteor
 * wrapper so this exact production implementation can be tested without Meteor.
 */
async function editOwnedTimecardTask({
  timecardId, userId, task, expectedTask, expectedDateRevision,
}, {
  findTimecard, canAccessProject, checkRule, assertUnlocked, withWriteLease,
  withProjectWriter, updateOne,
}) {
  validateTimecardTaskEditBody({ task, expectedTask })
  if (typeof timecardId !== 'string' || !timecardId || timecardId.length > 128
    || typeof userId !== 'string' || !userId
    || (expectedDateRevision !== null
      && (!Number.isSafeInteger(expectedDateRevision) || expectedDateRevision < 0))) {
    throw new TimecardTaskEditError('timecard-task-invalid', 'Invalid time entry edit preconditions.')
  }
  await assertUnlocked()
  const timecard = await findTimecard({ _id: timecardId, userId })
  // Defend the ownership boundary here as well as in the database selector.
  if (!timecard || timecard._id !== timecardId || timecard.userId !== userId) {
    throw new TimecardTaskEditError('not-authorized', 'Time entry not found.')
  }
  if (!matchesTimecardDateRevision(timecard, expectedDateRevision)
    || timecard.task !== expectedTask) {
    throw writeConflict()
  }
  if (!await canAccessProject(timecard.projectId, userId)) {
    throw new TimecardTaskEditError('not-authorized', 'Time entry not found.')
  }
  const changed = task !== timecard.task
  if (changed && timecard.dateRevision === Number.MAX_SAFE_INTEGER) {
    throw writeConflict('The time entry revision cannot be safely incremented.')
  }
  const revision = changed ? (timecard.dateRevision ?? 0) + 1 : timecard.dateRevision
  const etag = timecardDateRevisionETag(
    changed ? { dateRevision: revision } : timecard,
  )
  try {
    await checkRule({ ...timecard, task })
  } catch (error) {
    if (error?.error !== 'timecard-rule-blocked') throw error
    throw new TimecardTaskEditError(
      'timecard-rule-blocked',
      'The configured time entry rule prevented this task change.',
    )
  }
  await assertUnlocked()
  return withWriteLease(async (assertWriterLease) => {
    // Recheck project authorization under the lease and renew immediately before
    // the operation, after any asynchronous rule/project checks have completed.
    if (!await canAccessProject(timecard.projectId, userId)) {
      throw new TimecardTaskEditError('not-authorized', 'Time entry not found.')
    }
    await assertWriterLease()
    const selector = taskEditSnapshotSelector(timecard)
    if (changed) {
      const result = await withProjectWriter({
        projectId: timecard.projectId, userId,
      }, () => updateOne(selector, {
        $set: { task }, $inc: { dateRevision: 1 },
      }))
      if (result?.matchedCount !== 1) {
        throw writeConflict()
      }
    } else if (!await findTimecard(selector)) {
      // A no-op checks the same guarded snapshot without writing or changing its
      // revision. It must not acknowledge a stale old-name preview as success.
      throw writeConflict()
    }
    return {
      payload: {
        timecardId, task, previousTask: expectedTask, changed,
      },
      etag,
    }
  })
}

export {
  editOwnedTimecardTask,
  taskEditSnapshotSelector,
  validateTimecardTaskEditBody,
}
