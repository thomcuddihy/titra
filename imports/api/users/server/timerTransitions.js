import {
  matchesResourceRevision,
  resourceRevisionETag,
} from '../../../utils/resourceRevision.js'

class TimerTransitionError extends Error {
  constructor(code, reason) {
    super(reason)
    this.error = code
    this.reason = reason
  }
}

const timerError = (code, reason) => new TimerTransitionError(code, reason)

const TIMER_START_REPLAY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000
// Keep consumed operation IDs beyond the public recovery window so clock skew
// and a delayed retry at the boundary cannot create a second timer.  Clients
// still stop retries before the advertised seven-day cutoff.
const TIMER_START_HISTORY_GRACE_MS = 24 * 60 * 60 * 1000
const MAX_TIMER_START_HISTORY = 4096

function validateOperationId(value) {
  if (typeof value !== 'string' || value.length < 8 || value.length > 128
    || !/^[A-Za-z0-9._:-]+$/.test(value)) {
    throw timerError('timer-invalid', 'operationId must be 8-128 safe ASCII characters.')
  }
}

function activeTimer(user) {
  const timer = user?.profile?.timer
  return timer instanceof Date && !Number.isNaN(timer.getTime())
}

function timerSnapshotSelector(user) {
  const selector = { _id: user._id }
  for (const field of ['profile.timer', 'profile.timerId', 'profile.timerRevision']) {
    const key = field.slice('profile.'.length)
    selector[field] = Object.prototype.hasOwnProperty.call(user.profile || {}, key)
      ? { $eq: user.profile[key], $exists: true } : { $exists: false }
  }
  return selector
}

function timerStartSnapshotSelector(user, operationId, instant) {
  const selector = timerSnapshotSelector(user)
  selector['profile.timerStartHistory'] = Object.prototype.hasOwnProperty.call(
    user.profile || {}, 'timerStartHistory',
  ) ? { $eq: user.profile.timerStartHistory, $exists: true } : { $exists: false }
  // The exact history snapshot is already a CAS boundary.  This additional
  // database predicate makes the consumed-ID rule explicit at the write
  // boundary as defense in depth.
  selector.$nor = [{
    'profile.timerStartHistory': {
      $elemMatch: { operationId, expiresAt: { $gt: instant } },
    },
  }]
  return selector
}

function retainedTimerStartHistory(user, instant) {
  if (!(instant instanceof Date) || Number.isNaN(instant.getTime())) {
    throw timerError('timer-write-conflict', 'Timer start clock is invalid.')
  }
  const profile = user?.profile || {}
  if (!Object.prototype.hasOwnProperty.call(profile, 'timerStartHistory')) return []
  if (!Array.isArray(profile.timerStartHistory)) {
    throw timerError('timer-write-conflict', 'Timer start history is invalid.')
  }
  if (profile.timerStartHistory.length > MAX_TIMER_START_HISTORY) {
    throw timerError('timer-write-conflict', 'Timer start history exceeds its safe bound.')
  }
  return profile.timerStartHistory.filter((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)
      || Object.keys(entry).length !== 2
      || !Object.prototype.hasOwnProperty.call(entry, 'operationId')
      || !Object.prototype.hasOwnProperty.call(entry, 'expiresAt')
      || typeof entry.operationId !== 'string'
      || !(entry.expiresAt instanceof Date)
      || Number.isNaN(entry.expiresAt.getTime())) {
      throw timerError('timer-write-conflict', 'Timer start history is invalid.')
    }
    try { validateOperationId(entry.operationId) } catch {
      throw timerError('timer-write-conflict', 'Timer start history is invalid.')
    }
    return entry.expiresAt > instant
  })
}

function timerPayload(user, now) {
  if (!activeTimer(user)) throw timerError('timer-not-found', 'No running timer found.')
  const startTime = user.profile.timer
  return {
    timerId: typeof user.profile.timerId === 'string' ? user.profile.timerId : null,
    startTime,
    duration: Math.max(0, now.getTime() - startTime.getTime()),
    revision: Object.prototype.hasOwnProperty.call(user.profile, 'timerRevision')
      ? user.profile.timerRevision : null,
    legacy: typeof user.profile.timerId !== 'string'
      || !Object.prototype.hasOwnProperty.call(user.profile, 'timerRevision'),
  }
}

function stoppedTimerReceipt(user, timerId, expectedRevision) {
  const receipt = user?.profile?.timerStopReceipt
  if (!receipt || typeof receipt !== 'object'
    || (receipt.timerId ?? null) !== timerId
    || (receipt.expectedRevision ?? null) !== expectedRevision
    || !Number.isSafeInteger(receipt.stoppedRevision) || receipt.stoppedRevision < 0
    || !receipt.payload || typeof receipt.payload !== 'object'
    || !(receipt.payload.startTime instanceof Date)
    || !(receipt.payload.stoppedAt instanceof Date)
    || typeof receipt.payload.duration !== 'number'
    || !Number.isFinite(receipt.payload.duration) || receipt.payload.duration < 0) return null
  return {
    payload: { ...receipt.payload, changed: false },
    etag: resourceRevisionETag('timer', { timerRevision: receipt.stoppedRevision }),
  }
}

function timerMetadataModifier(metadata = {}) {
  const set = {}
  const unset = {}
  const values = [
    ['project', 'profile.timer_project'],
    ['task', 'profile.timer_task'],
    ['startTime', 'profile.timer_start_time'],
  ]
  values.forEach(([key, field]) => {
    if (typeof metadata[key] === 'string' && metadata[key]) set[field] = metadata[key]
    else unset[field] = ''
  })
  if (Array.isArray(metadata.customFields)) {
    set['profile.timer_custom_fields'] = metadata.customFields
  } else {
    unset['profile.timer_custom_fields'] = ''
  }
  return { set, unset }
}

async function getTimerState({ userId }, { findUser, now = () => new Date() }) {
  const user = await findUser({ _id: userId })
  if (!user || !activeTimer(user)) throw timerError('timer-not-found', 'No running timer found.')
  return { payload: timerPayload(user, now()), etag: resourceRevisionETag('timer', user.profile) }
}

async function startTimerAtomic({ userId, operationId, metadata = {} }, {
  findUser, updateOne, now = () => new Date(),
}) {
  validateOperationId(operationId)
  const user = await findUser({ _id: userId })
  if (!user) throw timerError('not-authorized', 'User not found.')
  if (activeTimer(user)) {
    if (user.profile.timerId === operationId) {
      return {
        payload: { ...timerPayload(user, now()), changed: false },
        etag: resourceRevisionETag('timer', user.profile),
      }
    }
    throw timerError('timer-write-conflict', 'A different timer is already running.')
  }
  if (user.profile?.timerRevision === Number.MAX_SAFE_INTEGER) {
    throw timerError('timer-write-conflict', 'Timer revision cannot advance.')
  }
  const startTime = now()
  if (!(startTime instanceof Date) || Number.isNaN(startTime.getTime())) {
    throw timerError('timer-write-conflict', 'Timer start clock is invalid.')
  }
  const retainedHistory = retainedTimerStartHistory(user, startTime)
  if (retainedHistory.some((entry) => entry.operationId === operationId)) {
    throw timerError('timer-operation-consumed', 'Timer start operation was already consumed.')
  }
  if (retainedHistory.length >= MAX_TIMER_START_HISTORY) {
    throw timerError('timer-write-conflict', 'Timer start history reached its safe bound.')
  }
  const timerStartHistory = [
    ...retainedHistory,
    {
      operationId,
      expiresAt: new Date(
        startTime.getTime() + TIMER_START_REPLAY_RETENTION_MS + TIMER_START_HISTORY_GRACE_MS,
      ),
    },
  ]
  const timerMetadata = timerMetadataModifier(metadata)
  const result = await updateOne(timerStartSnapshotSelector(user, operationId, startTime), {
    $set: {
      'profile.timer': startTime,
      'profile.timerId': operationId,
      // Prune only entries whose physical grace has elapsed, and append this
      // operation in the same compare-and-swap that starts the timer.
      'profile.timerStartHistory': timerStartHistory,
      ...timerMetadata.set,
    },
    $unset: timerMetadata.unset,
    $inc: { 'profile.timerRevision': 1 },
  })
  if (result?.matchedCount !== 1) {
    const current = await findUser({ _id: userId })
    if (current?.profile?.timerId === operationId && activeTimer(current)) {
      return {
        payload: { ...timerPayload(current, now()), changed: false },
        etag: resourceRevisionETag('timer', current.profile),
      }
    }
    if (current && retainedTimerStartHistory(current, startTime)
      .some((entry) => entry.operationId === operationId)) {
      throw timerError('timer-operation-consumed', 'Timer start operation was already consumed.')
    }
    throw timerError('timer-write-conflict', 'A different timer was started concurrently.')
  }
  const revision = (user.profile?.timerRevision ?? 0) + 1
  const started = {
    ...user,
    profile: {
      ...user.profile,
      timer: startTime,
      timerId: operationId,
      timerRevision: revision,
      timerStartHistory,
    },
  }
  return {
    payload: { ...timerPayload(started, startTime), changed: true },
    etag: resourceRevisionETag('timer', started.profile),
  }
}

async function stopTimerAtomic({ userId, timerId, expectedRevision }, {
  findUser, updateOne, now = () => new Date(),
}) {
  if (timerId !== null) validateOperationId(timerId)
  const user = await findUser({ _id: userId })
  if (!user) throw timerError('timer-not-found', 'No running timer found.')
  if (!activeTimer(user)) {
    const recovered = stoppedTimerReceipt(user, timerId, expectedRevision)
    if (recovered) return recovered
    throw timerError('timer-not-found', 'No running timer found.')
  }
  if (!matchesResourceRevision('timer', user.profile, expectedRevision)
    || (user.profile.timerId ?? null) !== timerId) {
    throw timerError('timer-write-conflict', 'The running timer changed after preview.')
  }
  if (user.profile.timerRevision === Number.MAX_SAFE_INTEGER) {
    throw timerError('timer-write-conflict', 'Timer revision cannot advance.')
  }
  const stoppedAt = now()
  const payload = {
    ...timerPayload(user, stoppedAt), stoppedAt, changed: true,
  }
  const stoppedRevision = (user.profile.timerRevision ?? 0) + 1
  const result = await updateOne(timerSnapshotSelector(user), {
    $set: {
      // One bounded receipt replaces the previous receipt. It is written in
      // the same CAS that clears the active timer, so an exact retry after a
      // lost response can recover the original duration without guessing.
      'profile.timerStopReceipt': {
        timerId,
        expectedRevision,
        stoppedRevision,
        payload,
      },
    },
    $unset: {
      'profile.timer': '', 'profile.timerId': '', 'profile.timer_project': '',
      'profile.timer_task': '', 'profile.timer_custom_fields': '', 'profile.timer_start_time': '',
    },
    $inc: { 'profile.timerRevision': 1 },
  })
  if (result?.matchedCount !== 1) {
    throw timerError('timer-write-conflict', 'The running timer changed after preview.')
  }
  return {
    payload,
    etag: resourceRevisionETag('timer', {
      timerRevision: stoppedRevision,
    }),
  }
}

export {
  MAX_TIMER_START_HISTORY,
  TIMER_START_HISTORY_GRACE_MS,
  TIMER_START_REPLAY_RETENTION_MS,
  TimerTransitionError,
  activeTimer,
  getTimerState,
  retainedTimerStartHistory,
  startTimerAtomic,
  stopTimerAtomic,
  timerMetadataModifier,
  timerPayload,
  timerStartSnapshotSelector,
  timerSnapshotSelector,
  stoppedTimerReceipt,
  validateOperationId,
}
