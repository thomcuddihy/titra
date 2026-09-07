import { dateOnlyToUTCDate, isDateOnly, isStartTime } from '../../../utils/timecardDate.js'
import {
  matchesTimecardDateRevision,
  timecardDateRevisionETag,
} from '../../../utils/timecardRevision.js'
import { taskEditSnapshotSelector } from './taskEdit.js'

const DETAIL_FIELDS = new Set(['projectId', 'hours', 'dateOnly', 'startTime'])

class TimecardDetailsEditError extends Error {
  constructor(code, reason) {
    super(reason)
    this.error = code
    this.reason = reason
  }
}

function invalid(reason = 'Invalid time entry details edit request.') {
  throw new TimecardDetailsEditError('timecard-details-invalid', reason)
}

function conflict(reason = 'The time entry changed after it was previewed.') {
  return new TimecardDetailsEditError('timecard-write-conflict', reason)
}

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value))
}

function validateField(field, value, { expected = false } = {}) {
  if (field === 'projectId') {
    if (typeof value !== 'string' || !value || value.length > 128 || !value.isWellFormed()) invalid()
  } else if (field === 'hours') {
    if (typeof value !== 'number' || !Number.isFinite(value)) invalid()
  } else if (field === 'dateOnly') {
    if (!(expected && value === null) && !isDateOnly(value)) invalid()
  } else if (field === 'startTime') {
    if (value !== null && !isStartTime(value)) invalid()
  } else {
    invalid()
  }
}

function validateTimecardDetailsEditBody(body) {
  if (!plainObject(body)) invalid()
  const bodyKeys = Object.keys(body).sort()
  if (!bodyKeys.every((key) => ['acceptLegacyConversion', 'changes', 'expected'].includes(key))
    || !bodyKeys.includes('changes') || !bodyKeys.includes('expected')
    || (Object.prototype.hasOwnProperty.call(body, 'acceptLegacyConversion')
      && typeof body.acceptLegacyConversion !== 'boolean')
    || !plainObject(body.expected) || !plainObject(body.changes)) invalid()
  const expectedKeys = Object.keys(body.expected).sort()
  const changedKeys = Object.keys(body.changes).sort()
  if (!changedKeys.length || changedKeys.length > DETAIL_FIELDS.size
    || changedKeys.some((key) => !DETAIL_FIELDS.has(key))
    || expectedKeys.length !== changedKeys.length
    || expectedKeys.some((key, index) => key !== changedKeys[index])) invalid()
  changedKeys.forEach((field) => {
    validateField(field, body.expected[field], { expected: true })
    validateField(field, body.changes[field])
  })
  return changedKeys
}

function exposedValue(timecard, field) {
  return Object.prototype.hasOwnProperty.call(timecard, field) ? timecard[field] : null
}

function valuesEqual(left, right) {
  if (left instanceof Date && right instanceof Date) return left.getTime() === right.getTime()
  return Object.is(left, right)
}

function buildCandidate(timecard, changes) {
  const candidate = { ...timecard }
  if (Object.prototype.hasOwnProperty.call(changes, 'projectId')) {
    candidate.projectId = changes.projectId
  }
  if (Object.prototype.hasOwnProperty.call(changes, 'hours')) candidate.hours = changes.hours
  if (Object.prototype.hasOwnProperty.call(changes, 'dateOnly')) {
    candidate.dateOnly = changes.dateOnly
    candidate.date = dateOnlyToUTCDate(changes.dateOnly)
  }
  if (Object.prototype.hasOwnProperty.call(changes, 'startTime')) {
    if (changes.startTime === null) delete candidate.startTime
    else candidate.startTime = changes.startTime
  }
  return candidate
}

async function editOwnedTimecardDetails({
  timecardId, userId, body, expectedDateRevision,
}, {
  findTimecard, canAccessProject, checkRule, assertUnlocked, withWriteLease,
  moveToProjectWithFence, updateOne,
  withStatsInvalidation = (_projectIds, operation) => operation(),
}) {
  const fields = validateTimecardDetailsEditBody(body)
  if (typeof timecardId !== 'string' || !timecardId || timecardId.length > 128
    || typeof userId !== 'string' || !userId
    || (expectedDateRevision !== null
      && (!Number.isSafeInteger(expectedDateRevision) || expectedDateRevision < 0))) invalid()
  await assertUnlocked()
  const timecard = await findTimecard({ _id: timecardId, userId })
  if (!timecard || timecard._id !== timecardId || timecard.userId !== userId) {
    throw new TimecardDetailsEditError('not-authorized', 'Time entry not found.')
  }
  if (!matchesTimecardDateRevision(timecard, expectedDateRevision)
    || fields.some((field) => !valuesEqual(exposedValue(timecard, field), body.expected[field]))) {
    throw conflict()
  }
  const changesCalendar = fields.includes('dateOnly') || fields.includes('startTime')
  const legacy = !isDateOnly(timecard.dateOnly)
  if (legacy && changesCalendar
    && (body.acceptLegacyConversion !== true || !fields.includes('dateOnly'))) {
    throw new TimecardDetailsEditError(
      'timecard-legacy-conversion-required',
      'Changing a legacy calendar value requires an explicit modern date conversion.',
    )
  }
  const candidate = buildCandidate(timecard, body.changes)
  const changedFields = fields.filter(
    (field) => !valuesEqual(exposedValue(timecard, field), exposedValue(candidate, field)),
  )
  if (changedFields.length && timecard.dateRevision === Number.MAX_SAFE_INTEGER) {
    throw conflict('The time entry revision cannot be safely incremented.')
  }
  if (!await canAccessProject(timecard.projectId, userId)
    || !await canAccessProject(candidate.projectId, userId)) {
    throw new TimecardDetailsEditError('not-authorized', 'Time entry not found.')
  }
  try {
    await checkRule(candidate)
  } catch (error) {
    if (error?.error !== 'timecard-rule-blocked') throw error
    throw new TimecardDetailsEditError(
      'timecard-rule-blocked',
      'The configured time entry rule prevented this details change.',
    )
  }
  await assertUnlocked()
  const performWrite = () => withWriteLease(async (assertWriterLease) => {
    if (!await canAccessProject(timecard.projectId, userId)
      || !await canAccessProject(candidate.projectId, userId)) {
      throw new TimecardDetailsEditError('not-authorized', 'Time entry not found.')
    }
    await assertWriterLease()
    const selector = taskEditSnapshotSelector(timecard)
    if (changedFields.length) {
      const set = {}
      const unset = {}
      changedFields.forEach((field) => {
        if (field === 'dateOnly') {
          set.dateOnly = candidate.dateOnly
          set.date = candidate.date
        } else if (field === 'startTime' && !Object.prototype.hasOwnProperty.call(candidate, field)) {
          unset.startTime = ''
        } else {
          set[field] = candidate[field]
        }
      })
      const modifier = { $set: set, $inc: { dateRevision: 1 } }
      if (Object.keys(unset).length) modifier.$unset = unset
      const write = () => updateOne(selector, modifier)
      let result
      try {
        result = changedFields.includes('projectId')
          ? await moveToProjectWithFence({
            projectId: candidate.projectId,
            userId,
            write,
          })
          : await write()
      } catch (error) {
        // Losing the target-project lock before the CAS is a normal access
        // race. A post-write/driver uncertainty has a distinct fence code and
        // deliberately propagates as an unknown server outcome.
        if (error?.error === 'project-child-write-blocked') {
          throw new TimecardDetailsEditError('not-authorized', 'Time entry not found.')
        }
        throw error
      }
      if (result?.matchedCount !== 1) throw conflict()
    } else if (!await findTimecard(selector)) {
      throw conflict()
    }
    const nextRevision = changedFields.length
      ? (timecard.dateRevision ?? 0) + 1
      : timecard.dateRevision
    return {
      payload: {
        timecardId,
        changed: changedFields.length > 0,
        changedFields,
        previous: Object.fromEntries(fields.map((field) => [field, exposedValue(timecard, field)])),
        current: Object.fromEntries(fields.map((field) => [field, exposedValue(candidate, field)])),
      },
      etag: timecardDateRevisionETag(
        changedFields.length ? { dateRevision: nextRevision } : timecard,
      ),
    }
  })
  const affectsStats = changedFields.some(
    (field) => ['projectId', 'hours', 'dateOnly'].includes(field),
  )
  return affectsStats
    ? withStatsInvalidation([timecard.projectId, candidate.projectId], performWrite)
    : performWrite()
}

export {
  TimecardDetailsEditError,
  editOwnedTimecardDetails,
  validateTimecardDetailsEditBody,
}
