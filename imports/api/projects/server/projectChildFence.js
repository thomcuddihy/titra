import { randomUUID } from 'node:crypto'

class ProjectChildFenceError extends Error {
  constructor(code, reason) {
    super(reason)
    this.error = code
    this.reason = reason
  }
}

class ProjectChildNoWriteError extends Error {
  constructor(cause) {
    super('Project child creation failed before any child write began.', { cause })
    this.name = 'ProjectChildNoWriteError'
  }
}

const fenceError = (code, reason) => new ProjectChildFenceError(code, reason)
const definiteProjectChildNoWrite = (cause) => new ProjectChildNoWriteError(cause)

const MAX_PROJECT_CHILD_WRITERS = 64
const MINIMUM_FENCE_RECOVERY_AGE_MS = 15 * 60 * 1000
const projectChildFenceBootId = `boot:${randomUUID()}`
const projectChildResourceKinds = Object.freeze({
  'project-default-task': 'task',
  'project-task-create': 'task',
  'project-task-recover': 'task',
  'project-task-update': 'task',
  'timecard-create': 'timecard',
  'timecard-details-move': 'timecard',
  'timecard-recover': 'timecard',
  'timecard-task-edit': 'timecard',
  'timecard-update': 'timecard',
  'timecard-week-upsert': 'timecard',
})

function validateFenceId(value, label) {
  if (typeof value !== 'string' || value.length < 8 || value.length > 128
    || !/^[A-Za-z0-9._:-]+$/.test(value)) {
    throw fenceError('project-child-fence-invalid', `${label} is invalid.`)
  }
}

function validateResourceId(value) {
  if (typeof value !== 'string' || !value || value.length > 128
    || !/^[A-Za-z0-9._:-]+$/.test(value)) {
    throw fenceError('project-child-fence-invalid', 'resourceId is invalid.')
  }
}

function validateWriterKind(kind) {
  if (!Object.prototype.hasOwnProperty.call(projectChildResourceKinds, kind)) {
    throw fenceError('project-child-fence-invalid', 'Project writer kind is invalid.')
  }
}

function currentDate(dependencies) {
  const value = dependencies.now ? dependencies.now() : new Date()
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw fenceError('project-child-fence-invalid', 'Project writer time is invalid.')
  }
  return value
}

function currentBootId(dependencies) {
  const value = dependencies.bootId || projectChildFenceBootId
  validateFenceId(value, 'bootId')
  return value
}

function writerMetadata({ reservationId, kind, resourceId }, dependencies) {
  validateFenceId(reservationId, 'reservationId')
  validateWriterKind(kind)
  validateResourceId(resourceId)
  return {
    reservationId,
    kind,
    resourceId,
    acquiredAt: currentDate(dependencies),
    bootId: currentBootId(dependencies),
  }
}

function exactWriterMetadata(metadata) {
  return {
    reservationId: metadata.reservationId,
    kind: metadata.kind,
    resourceId: metadata.resourceId,
    acquiredAt: metadata.acquiredAt,
    bootId: metadata.bootId,
  }
}

function validStoredWriterMetadata(metadata) {
  try {
    validateFenceId(metadata?.reservationId, 'reservationId')
    validateWriterKind(metadata?.kind)
    validateResourceId(metadata?.resourceId)
    validateFenceId(metadata?.bootId, 'bootId')
    return metadata.acquiredAt instanceof Date && Number.isFinite(metadata.acquiredAt.getTime())
  } catch (error) {
    return false
  }
}

function returnedDocument(result) {
  return result?.value || result || null
}

function affected(result) {
  return result?.matchedCount ?? result?.deletedCount ?? result
}

function hasOwn(document, field) {
  return Object.prototype.hasOwnProperty.call(document || {}, field)
}

/**
 * Reserve a project for one child creator. Because the reservation and the
 * delete lock live on the same Mongo document, one of them wins atomically on
 * standalone Mongo; a delete can never pass an in-flight creator.
 */
async function acquireProjectChildWriter({
  selector, reservationId, kind, resourceId,
}, dependencies) {
  const metadata = writerMetadata({ reservationId, kind, resourceId }, dependencies)
  const { findOneAndUpdate } = dependencies
  const result = await findOneAndUpdate({
    ...selector,
    lifecycleLock: { $exists: false },
    taskGraphLock: { $exists: false },
    lifecycleWriters: { $ne: reservationId },
    [`lifecycleWriterMetadata.${MAX_PROJECT_CHILD_WRITERS - 1}`]: { $exists: false },
  }, {
    $addToSet: { lifecycleWriters: reservationId },
    $push: { lifecycleWriterMetadata: metadata },
  }, { returnDocument: 'after' })
  const project = returnedDocument(result)
  const tracked = project?.lifecycleWriterMetadata?.filter(
    (entry) => entry?.reservationId === reservationId,
  ) || []
  if (!project || !project.lifecycleWriters?.includes(reservationId)
    || tracked.length !== 1 || tracked[0]?.bootId !== metadata.bootId) {
    throw fenceError('project-child-write-blocked', 'Project cannot accept new records.')
  }
  return { project, metadata }
}

async function releaseProjectChildWriter({ projectId, metadata, requireMatch = true }, {
  updateOne,
}) {
  if (!validStoredWriterMetadata(metadata)) {
    throw fenceError('project-child-fence-invalid', 'Project writer metadata is invalid.')
  }
  const result = await updateOne({
    _id: projectId,
    lifecycleWriters: metadata.reservationId,
    lifecycleWriterMetadata: { $elemMatch: exactWriterMetadata(metadata) },
  }, {
    $pull: {
      lifecycleWriters: metadata.reservationId,
      lifecycleWriterMetadata: exactWriterMetadata(metadata),
    },
  })
  if (requireMatch && affected(result) !== 1) {
    throw fenceError(
      'project-child-write-outcome-unknown',
      'Project writer reservation could not be released exactly.',
    )
  }
  return affected(result) === 1
}

async function verifyProjectChildWriter({ projectId, metadata }, { findOne }) {
  if (!validStoredWriterMetadata(metadata)) return false
  return Boolean(await findOne({
    _id: projectId,
    lifecycleLock: { $exists: false },
    lifecycleWriters: metadata.reservationId,
    lifecycleWriterMetadata: { $elemMatch: exactWriterMetadata(metadata) },
  }))
}

/**
 * Hold the same project-side writer reservation around an operation that
 * moves an existing child into a project. The operation must return its raw
 * write result instead of throwing for a conclusive zero-match/CAS failure;
 * callers can classify that result after this helper safely releases the
 * reservation. If the write itself throws, its outcome may be unknown and the
 * reservation intentionally remains so project deletion fails closed.
 */
async function runWithProjectChildWriter({
  selector, projectId, reservationId, kind, resourceId, operation,
}, dependencies) {
  const reservation = await acquireProjectChildWriter({
    selector, reservationId, kind, resourceId,
  }, dependencies)
  let releaseReservation = false
  try {
    let result
    try {
      result = await operation()
    } catch (error) {
      if (error instanceof ProjectChildNoWriteError) {
        releaseReservation = true
        throw error.cause || error
      }
      throw error
    }
    if (!await verifyProjectChildWriter({
      projectId, metadata: reservation.metadata,
    }, dependencies)) {
      throw fenceError(
        'project-child-write-outcome-unknown',
        'Project writer reservation changed while updating a child.',
      )
    }
    releaseReservation = true
    return result
  } finally {
    if (releaseReservation) {
      await releaseProjectChildWriter({ projectId, metadata: reservation.metadata }, dependencies)
    }
  }
}

/**
 * Run a child create while holding a reservation. createChild must return an
 * object with `created` and `resourceId` (or a newly-created string ID). Only a
 * child positively known to have been created by this attempt is removed when
 * the post-insert project check fails. A recovered idempotent child is never
 * removed.
 */
async function createProjectChildWithFence({
  selector,
  projectId,
  reservationId,
  kind,
  resourceId,
  createChild,
  removeCreatedChild,
}, dependencies) {
  const reservation = await acquireProjectChildWriter({
    selector, reservationId, kind, resourceId,
  }, dependencies)
  let result
  let releaseReservation = false
  let releaseMustMatch = true
  try {
    // A rejected insert promise is not proof that Mongo did not apply the
    // insert. Keep the reservation in that outcome-unknown state so an
    // empty-project delete cannot race past a child that may be visible. A
    // later, resource-ID-aware recovery (or operator inspection) can prove
    // the outcome and clear the deliberately stale reservation.
    try {
      result = await createChild()
    } catch (error) {
      if (error instanceof ProjectChildNoWriteError) {
        // This marker is intentionally narrow and internal: callers may use
        // it only around validation completed before the first child-store
        // write. Release the reservation, then preserve the real validation
        // error for existing API/DDP error handling.
        releaseReservation = true
        throw error.cause || error
      }
      throw error
    }
    if (!await verifyProjectChildWriter({
      projectId, metadata: reservation.metadata,
    }, dependencies)) {
      const created = typeof result === 'string' || result?.created === true
      const createdResourceId = typeof result === 'string' ? result : result?.resourceId
      if (created && typeof createdResourceId === 'string') {
        await removeCreatedChild(createdResourceId)
      }
      releaseReservation = true
      releaseMustMatch = false
      throw fenceError('project-child-write-blocked', 'Project was deleted while creating the record.')
    }
    releaseReservation = true
    return result
  } finally {
    if (releaseReservation) {
      await releaseProjectChildWriter({
        projectId,
        metadata: reservation.metadata,
        requireMatch: releaseMustMatch,
      }, dependencies)
    }
  }
}

function publicWriterRecoveryState(status, metadata, ageMs, resourceStatus) {
  const state = { status }
  if (metadata) {
    state.reservation = {
      reservationId: metadata.reservationId,
      kind: metadata.kind,
      resourceId: metadata.resourceId,
      acquiredAt: metadata.acquiredAt,
      ageMs,
    }
  }
  if (resourceStatus) state.resourceStatus = resourceStatus
  return state
}

async function analyzeProjectChildWriterRecovery({
  selector, projectId, reservationId,
}, dependencies) {
  validateFenceId(reservationId, 'reservationId')
  const project = await dependencies.findProject({ ...selector, _id: projectId })
  if (!project) return { public: publicWriterRecoveryState('not-authorized') }
  const writers = Array.isArray(project.lifecycleWriters) ? project.lifecycleWriters : []
  const writerOccurrences = writers.filter((entry) => entry === reservationId).length
  const tracked = Array.isArray(project.lifecycleWriterMetadata)
    ? project.lifecycleWriterMetadata.filter((entry) => entry?.reservationId === reservationId)
    : []
  if (writerOccurrences === 0 && tracked.length === 0
    && (!hasOwn(project, 'lifecycleWriters') || Array.isArray(project.lifecycleWriters))
    && (!hasOwn(project, 'lifecycleWriterMetadata')
      || Array.isArray(project.lifecycleWriterMetadata))) {
    return { public: publicWriterRecoveryState('not-found') }
  }
  if (!Array.isArray(project.lifecycleWriters)
    || !Array.isArray(project.lifecycleWriterMetadata)
    || writerOccurrences !== 1
    || tracked.length !== 1
    || !validStoredWriterMetadata(tracked[0])
    || hasOwn(project, 'lifecycleLock') || hasOwn(project, 'taskGraphLock')) {
    return { public: publicWriterRecoveryState('untracked') }
  }
  const metadata = tracked[0]
  const now = currentDate(dependencies)
  const ageMs = now.getTime() - metadata.acquiredAt.getTime()
  if (dependencies.allowStaleFenceRecovery !== true) {
    return {
      metadata,
      public: publicWriterRecoveryState('deployment-disabled', metadata, ageMs),
    }
  }
  if (metadata.bootId === currentBootId(dependencies)) {
    return {
      metadata,
      public: publicWriterRecoveryState('active-process', metadata, ageMs),
    }
  }
  if (!Number.isSafeInteger(ageMs) || ageMs < MINIMUM_FENCE_RECOVERY_AGE_MS) {
    return {
      metadata,
      public: publicWriterRecoveryState('too-young', metadata, ageMs),
    }
  }
  const resourceType = projectChildResourceKinds[metadata.kind]
  const findResource = resourceType === 'timecard'
    ? dependencies.findTimecard : dependencies.findTask
  if (typeof findResource !== 'function') {
    return {
      metadata,
      public: publicWriterRecoveryState('unsupported', metadata, ageMs),
    }
  }
  const resource = await findResource({ _id: metadata.resourceId })
  let resourceStatus = 'absent'
  if (resource) {
    resourceStatus = resource._id === metadata.resourceId && resource.projectId === projectId
      ? 'present-in-project' : 'unexpected'
  }
  const status = resourceStatus === 'unexpected' ? 'resource-unexpected' : 'recoverable'
  return {
    metadata,
    public: publicWriterRecoveryState(status, metadata, ageMs, resourceStatus),
  }
}

/**
 * Return only bounded, non-payload recovery facts. Same-process reservations,
 * recent reservations, legacy/untracked entries and unexpected resource state
 * deliberately remain blocked.
 */
async function previewProjectChildWriterRecovery(options, dependencies) {
  return (await analyzeProjectChildWriterRecovery(options, dependencies)).public
}

/**
 * Discover the bounded set of recoverable writer reservations on one visible
 * project. Malformed, oversized or mixed legacy state is reported but never
 * normalized or cleared. Each returned reservation is independently previewed
 * from a fresh exact read so the result remains fail-closed during races.
 */
async function inspectProjectChildWriterRecoveries({ selector, projectId }, dependencies) {
  const project = await dependencies.findProject({ ...selector, _id: projectId })
  if (!project) return { status: 'not-authorized' }

  const writers = hasOwn(project, 'lifecycleWriters') ? project.lifecycleWriters : []
  const metadata = hasOwn(project, 'lifecycleWriterMetadata')
    ? project.lifecycleWriterMetadata : []
  const validShape = Array.isArray(writers)
    && Array.isArray(metadata)
    && writers.length <= MAX_PROJECT_CHILD_WRITERS
    && metadata.length <= MAX_PROJECT_CHILD_WRITERS
    && writers.every((reservationId) => {
      try {
        validateFenceId(reservationId, 'reservationId')
        return true
      } catch (error) {
        return false
      }
    })
    && metadata.every(validStoredWriterMetadata)
  if (!validShape || hasOwn(project, 'lifecycleLock') || hasOwn(project, 'taskGraphLock')) {
    return {
      status: 'untracked',
      writerCount: Array.isArray(writers) ? writers.length : null,
      metadataCount: Array.isArray(metadata) ? metadata.length : null,
    }
  }

  const reservationIds = [...new Set([
    ...writers,
    ...metadata.map((entry) => entry.reservationId),
  ])].sort()
  const reservations = []
  for (const reservationId of reservationIds) {
    reservations.push(await previewProjectChildWriterRecovery({
      selector, projectId, reservationId,
    }, dependencies))
  }
  return {
    status: 'inspected',
    writerCount: writers.length,
    metadataCount: metadata.length,
    reservations,
  }
}

/**
 * Clear one old-boot reservation only after the exact metadata and target
 * resource state have been verified. A concurrent project change makes the
 * compare-and-swap fail without clearing any other writer.
 */
async function recoverProjectChildWriter(options, dependencies) {
  const analysis = await analyzeProjectChildWriterRecovery(options, dependencies)
  if (analysis.public.status !== 'recoverable') return analysis.public
  const { metadata } = analysis
  const result = await dependencies.updateOne({
    ...options.selector,
    _id: options.projectId,
    lifecycleLock: { $exists: false },
    taskGraphLock: { $exists: false },
    lifecycleWriters: metadata.reservationId,
    lifecycleWriterMetadata: { $elemMatch: exactWriterMetadata(metadata) },
  }, {
    $pull: {
      lifecycleWriters: metadata.reservationId,
      lifecycleWriterMetadata: exactWriterMetadata(metadata),
    },
  })
  return {
    ...analysis.public,
    status: affected(result) === 1 ? 'cleared' : 'conflict',
  }
}

/**
 * Empty-project deletion for standalone Mongo. All child creators must use the
 * reservation protocol above. A stale/crashed reservation deliberately blocks
 * deletion and requires operator inspection; it never permits an orphan.
 */
async function deleteEmptyProjectWithFence({ selector, lockId }, {
  findOneAndUpdate,
  countTimecards,
  countProjectTasks,
  deleteOne,
  updateOne,
}) {
  validateFenceId(lockId, 'lockId')
  const lockResult = await findOneAndUpdate({
    ...selector,
    lifecycleLock: { $exists: false },
    taskGraphLock: { $exists: false },
    $and: [
      ...(selector.$and || []),
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
    $set: { lifecycleLock: { kind: 'delete', lockId, acquiredAt: new Date() } },
  }, { returnDocument: 'after' })
  const locked = returnedDocument(lockResult)
  if (locked?.lifecycleLock?.lockId !== lockId) return { status: 'conflict' }

  const lockSelector = {
    _id: locked._id,
    'lifecycleLock.kind': 'delete',
    'lifecycleLock.lockId': lockId,
  }
  let keepLock = false
  try {
    const [timecards, projectTasks] = await Promise.all([
      countTimecards(locked._id), countProjectTasks(locked._id),
    ])
    if (timecards !== 0 || projectTasks !== 0) {
      return { status: 'not-empty', counts: { timecards, projectTasks } }
    }
    const removed = await deleteOne(lockSelector)
    if (affected(removed) !== 1) {
      keepLock = true
      return { status: 'conflict' }
    }
    return { status: 'deleted' }
  } catch (error) {
    keepLock = true
    throw error
  } finally {
    if (!keepLock) {
      await updateOne(lockSelector, { $unset: { lifecycleLock: '' } })
    }
  }
}

export {
  MAX_PROJECT_CHILD_WRITERS,
  MINIMUM_FENCE_RECOVERY_AGE_MS,
  ProjectChildFenceError,
  ProjectChildNoWriteError,
  acquireProjectChildWriter,
  createProjectChildWithFence,
  definiteProjectChildNoWrite,
  deleteEmptyProjectWithFence,
  inspectProjectChildWriterRecoveries,
  previewProjectChildWriterRecovery,
  projectChildFenceBootId,
  recoverProjectChildWriter,
  releaseProjectChildWriter,
  runWithProjectChildWriter,
  validateFenceId,
  verifyProjectChildWriter,
}
