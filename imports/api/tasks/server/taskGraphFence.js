import { createHash } from 'node:crypto'

import {
  MINIMUM_FENCE_RECOVERY_AGE_MS,
  projectChildFenceBootId,
} from '../../projects/server/projectChildFence.js'

class TaskGraphFenceError extends Error {
  constructor(code, reason) {
    super(reason)
    this.error = code
    this.reason = reason
  }
}

const taskGraphError = (code, reason) => new TaskGraphFenceError(code, reason)

function validateTaskGraphLockId(value) {
  if (typeof value !== 'string' || value.length < 8 || value.length > 128
    || !/^[A-Za-z0-9._:-]+$/.test(value)) {
    throw taskGraphError('project-task-invalid', 'Invalid task graph lock ID.')
  }
}

function validateTaskResourceId(value) {
  if (typeof value !== 'string' || !value || value.length > 128
    || !/^[A-Za-z0-9._:-]+$/.test(value)) {
    throw taskGraphError('project-task-invalid', 'Invalid task resource ID.')
  }
}

function returnedDocument(result) {
  return result?.value || result || null
}

function affected(result) {
  return result?.deletedCount ?? result?.matchedCount ?? result
}

function hasOwn(document, field) {
  return Object.prototype.hasOwnProperty.call(document || {}, field)
}

function currentDate(dependencies) {
  const value = dependencies.now ? dependencies.now() : new Date()
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw taskGraphError('project-task-invalid', 'Invalid task graph time.')
  }
  return value
}

function currentBootId(dependencies) {
  const value = dependencies.bootId || projectChildFenceBootId
  validateTaskGraphLockId(value)
  return value
}

function canonicalTaskValue(value, seen = new WeakSet()) {
  if (value === null) return ['null']
  if (value === undefined) return ['undefined']
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) throw taskGraphError('project-task-invalid', 'Invalid task snapshot.')
    return ['date', value.toISOString()]
  }
  if (typeof value === 'string' || typeof value === 'boolean') return [typeof value, value]
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw taskGraphError('project-task-invalid', 'Invalid task snapshot.')
    return ['number', Object.is(value, -0) ? '-0' : String(value)]
  }
  if (typeof value !== 'object' || seen.has(value)) {
    throw taskGraphError('project-task-invalid', 'Invalid task snapshot.')
  }
  seen.add(value)
  let encoded
  if (Array.isArray(value)) {
    encoded = ['array', value.map((entry) => canonicalTaskValue(entry, seen))]
  } else {
    const prototype = Object.getPrototypeOf(value)
    if (![Object.prototype, null].includes(prototype)) {
      throw taskGraphError('project-task-invalid', 'Invalid task snapshot.')
    }
    encoded = ['object', Object.keys(value).sort().map(
      (key) => [key, canonicalTaskValue(value[key], seen)],
    )]
  }
  seen.delete(value)
  return encoded
}

function taskRecoveryFingerprint(task) {
  if (!task || typeof task !== 'object' || Array.isArray(task)) {
    throw taskGraphError('project-task-invalid', 'Invalid task snapshot.')
  }
  return createHash('sha256').update(JSON.stringify(canonicalTaskValue(task))).digest('hex')
}

function validFingerprint(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
}

/**
 * Serialize one project-task deletion against every project child writer.
 * Timecard creates/moves/renames and task/dependency writers participate via
 * the project's lifecycleWriters array. New writers require taskGraphLock to
 * be absent; deletion acquires taskGraphLock only while that writer array is
 * absent/empty. This provides a single-document linearization point on
 * standalone MongoDB.
 */
async function deleteProjectTaskWithFence({
  projectSelector,
  projectId,
  taskId,
  taskName,
  taskFingerprint,
  lockId,
  acknowledgeRecordedEntries,
  inspectLockedState,
  deleteTask,
}, dependencies) {
  const { findOneAndUpdate, updateOne } = dependencies
  validateTaskGraphLockId(lockId)
  validateTaskResourceId(taskId)
  if (typeof taskName !== 'string' || taskName.length < 1 || taskName.length > 1000) {
    throw taskGraphError('project-task-invalid', 'Invalid task name.')
  }
  if (!validFingerprint(taskFingerprint)) {
    throw taskGraphError('project-task-invalid', 'Invalid task recovery fingerprint.')
  }
  const acquiredAt = currentDate(dependencies)
  const bootId = currentBootId(dependencies)
  const lockResult = await findOneAndUpdate({
    ...projectSelector,
    lifecycleLock: { $exists: false },
    taskGraphLock: { $exists: false },
    $and: [
      ...(projectSelector.$and || []),
      {
        $or: [
          { lifecycleWriters: { $exists: false } },
          { lifecycleWriters: { $size: 0 } },
        ],
      },
      {
        $or: [
          { lifecycleWriterMetadata: { $exists: false } },
          { lifecycleWriterMetadata: { $size: 0 } },
        ],
      },
    ],
  }, {
    $set: {
      taskGraphLock: {
        kind: 'delete-task',
        lockId,
        taskId,
        taskName,
        taskFingerprint,
        acquiredAt,
        bootId,
      },
    },
  }, { returnDocument: 'after' })
  const locked = returnedDocument(lockResult)
  if (locked?._id !== projectId || locked?.taskGraphLock?.lockId !== lockId) {
    return { status: 'conflict' }
  }

  const lockSelector = {
    _id: projectId,
    'taskGraphLock.kind': 'delete-task',
    'taskGraphLock.lockId': lockId,
    'taskGraphLock.taskId': taskId,
    'taskGraphLock.taskName': taskName,
    'taskGraphLock.taskFingerprint': taskFingerprint,
    'taskGraphLock.acquiredAt': acquiredAt,
    'taskGraphLock.bootId': bootId,
  }
  let releaseLock = false
  try {
    const state = await inspectLockedState()
    if (state?.conflict === true) {
      releaseLock = true
      return { status: 'conflict', state }
    }
    if (state?.isDefault === true) {
      releaseLock = true
      return { status: 'default', state }
    }
    if ((state?.dependentTaskCount ?? 0) > 0) {
      releaseLock = true
      return { status: 'dependent', state }
    }
    if ((state?.recordCount ?? 0) > 0 && acknowledgeRecordedEntries !== true) {
      releaseLock = true
      return { status: 'recorded', state }
    }
    const removed = await deleteTask()
    releaseLock = true
    return affected(removed) === 1
      ? { status: 'deleted', state }
      : { status: 'conflict', state }
  } finally {
    // Any thrown read/write has an uncertain relationship to the task delete;
    // deliberately leave the bounded project lock for operator inspection.
    if (releaseLock) {
      await updateOne(lockSelector, { $unset: { taskGraphLock: '' } })
    }
  }
}

function publicTaskLockState(status, lock, ageMs, taskStatus) {
  const state = { status }
  if (lock) {
    state.lock = {
      lockId: lock.lockId,
      taskId: lock.taskId,
      acquiredAt: lock.acquiredAt,
      ageMs,
    }
  }
  if (taskStatus) state.taskStatus = taskStatus
  return state
}

function validStoredTaskLock(lock) {
  try {
    validateTaskGraphLockId(lock?.lockId)
    validateTaskResourceId(lock?.taskId)
    validateTaskGraphLockId(lock?.bootId)
    return lock.kind === 'delete-task'
      && typeof lock.taskName === 'string'
      && lock.taskName.length > 0
      && lock.taskName.length <= 1000
      && validFingerprint(lock.taskFingerprint)
      && lock.acquiredAt instanceof Date
      && Number.isFinite(lock.acquiredAt.getTime())
  } catch (error) {
    return false
  }
}

async function analyzeTaskGraphLockRecovery({
  selector, projectId, lockId,
}, dependencies) {
  if (lockId != null) validateTaskGraphLockId(lockId)
  const project = await dependencies.findProject({ ...selector, _id: projectId })
  if (!project) return { public: publicTaskLockState('not-authorized') }
  const lock = project.taskGraphLock
  if (!lock || (lockId != null && lock.lockId !== lockId)) {
    return { public: publicTaskLockState('not-found') }
  }
  const writers = hasOwn(project, 'lifecycleWriters') ? project.lifecycleWriters : []
  const metadata = hasOwn(project, 'lifecycleWriterMetadata')
    ? project.lifecycleWriterMetadata : []
  if (!validStoredTaskLock(lock) || hasOwn(project, 'lifecycleLock')
    || !Array.isArray(writers) || writers.length > 0
    || !Array.isArray(metadata) || metadata.length > 0) {
    return { public: publicTaskLockState('untracked') }
  }
  const now = currentDate(dependencies)
  const ageMs = now.getTime() - lock.acquiredAt.getTime()
  if (dependencies.allowStaleFenceRecovery !== true) {
    return {
      lock,
      public: publicTaskLockState('deployment-disabled', lock, ageMs),
    }
  }
  if (lock.bootId === currentBootId(dependencies)) {
    return { lock, public: publicTaskLockState('active-process', lock, ageMs) }
  }
  if (!Number.isSafeInteger(ageMs) || ageMs < MINIMUM_FENCE_RECOVERY_AGE_MS) {
    return { lock, public: publicTaskLockState('too-young', lock, ageMs) }
  }
  const task = await dependencies.findTask({ _id: lock.taskId })
  let taskStatus
  if (!task) taskStatus = 'absent'
  else {
    let fingerprint
    try {
      fingerprint = taskRecoveryFingerprint(task)
    } catch (error) {
      fingerprint = null
    }
    taskStatus = task._id === lock.taskId
      && task.projectId === projectId
      && task.name === lock.taskName
      && fingerprint === lock.taskFingerprint
      ? 'unchanged' : 'unexpected'
  }
  return {
    lock,
    public: publicTaskLockState(
      taskStatus === 'unexpected' ? 'task-unexpected' : 'recoverable',
      lock,
      ageMs,
      taskStatus,
    ),
  }
}

async function previewTaskGraphLockRecovery(options, dependencies) {
  return (await analyzeTaskGraphLockRecovery(options, dependencies)).public
}

async function recoverTaskGraphLock(options, dependencies) {
  const analysis = await analyzeTaskGraphLockRecovery(options, dependencies)
  if (analysis.public.status !== 'recoverable') return analysis.public
  const { lock } = analysis
  const result = await dependencies.updateOne({
    ...options.selector,
    _id: options.projectId,
    lifecycleLock: { $exists: false },
    $and: [
      ...(options.selector.$and || []),
      {
        $or: [
          { lifecycleWriters: { $exists: false } },
          { lifecycleWriters: { $size: 0 } },
        ],
      },
      {
        $or: [
          { lifecycleWriterMetadata: { $exists: false } },
          { lifecycleWriterMetadata: { $size: 0 } },
        ],
      },
    ],
    'taskGraphLock.kind': 'delete-task',
    'taskGraphLock.lockId': lock.lockId,
    'taskGraphLock.taskId': lock.taskId,
    'taskGraphLock.taskName': lock.taskName,
    'taskGraphLock.taskFingerprint': lock.taskFingerprint,
    'taskGraphLock.acquiredAt': lock.acquiredAt,
    'taskGraphLock.bootId': lock.bootId,
  }, { $unset: { taskGraphLock: '' } })
  return {
    ...analysis.public,
    status: affected(result) === 1 ? 'cleared' : 'conflict',
  }
}

export {
  TaskGraphFenceError,
  deleteProjectTaskWithFence,
  previewTaskGraphLockRecovery,
  recoverTaskGraphLock,
  taskRecoveryFingerprint,
  validateTaskGraphLockId,
}
