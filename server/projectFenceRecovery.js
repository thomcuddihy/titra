import { createHash } from 'node:crypto'

import {
  inspectProjectChildWriterRecoveries,
  MINIMUM_FENCE_RECOVERY_AGE_MS,
  recoverProjectChildWriter,
} from '../imports/api/projects/server/projectChildFence.js'
import {
  previewTaskGraphLockRecovery,
  recoverTaskGraphLock,
} from '../imports/api/tasks/server/taskGraphFence.js'

class ProjectFenceRecoveryError extends Error {
  constructor(code, reason) {
    super(reason)
    this.error = code
    this.reason = reason
  }
}

const recoveryError = (code, reason) => new ProjectFenceRecoveryError(code, reason)
const PROJECT_FENCE_RECOVERY_MODE_ENV = 'TITRA_FENCE_RECOVERY_MODE'
const PROJECT_FENCE_RECOVERY_SINGLE_INSTANCE_MODE = 'single-instance'

function projectFenceRecoveryDeploymentEnabled(environment = process.env) {
  return environment?.[PROJECT_FENCE_RECOVERY_MODE_ENV]
    === PROJECT_FENCE_RECOVERY_SINGLE_INSTANCE_MODE
}

function assertProjectFenceRecoveryDeploymentEnabled(dependencies) {
  if (!projectFenceRecoveryDeploymentEnabled(dependencies.environment || process.env)) {
    throw recoveryError(
      'project-recovery-disabled',
      'Project fence recovery is disabled for this deployment.',
    )
  }
}

function projectRecoverySelector(projectId, userId) {
  return { _id: projectId, $or: [{ userId }, { admins: userId }] }
}

function canonical(value, seen = new WeakSet()) {
  if (value === null) return ['null']
  if (typeof value === 'string' || typeof value === 'boolean') {
    return [typeof value, value]
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw recoveryError('project-recovery-state-invalid', 'Invalid recovery state.')
    }
    return ['number', Object.is(value, -0) ? '-0' : String(value)]
  }
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) {
      throw recoveryError('project-recovery-state-invalid', 'Invalid recovery state.')
    }
    return ['date', value.toISOString()]
  }
  if (!value || typeof value !== 'object' || seen.has(value)) {
    throw recoveryError('project-recovery-state-invalid', 'Invalid recovery state.')
  }
  seen.add(value)
  let result
  if (Array.isArray(value)) {
    result = ['array', value.map((entry) => canonical(entry, seen))]
  } else {
    const prototype = Object.getPrototypeOf(value)
    if (![Object.prototype, null].includes(prototype)) {
      throw recoveryError('project-recovery-state-invalid', 'Invalid recovery state.')
    }
    result = ['object', Object.keys(value).sort()
      .map((key) => [key, canonical(value[key], seen)])]
  }
  seen.delete(value)
  return result
}

function stablePreview(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || value instanceof Date) return value
  if (seen.has(value)) {
    throw recoveryError('project-recovery-state-invalid', 'Invalid recovery state.')
  }
  seen.add(value)
  const result = Array.isArray(value)
    ? value.map((entry) => stablePreview(entry, seen))
    : Object.fromEntries(Object.keys(value)
      .filter((key) => key !== 'ageMs')
      .map((key) => [key, stablePreview(value[key], seen)]))
  seen.delete(value)
  return result
}

function exactFenceField(project, field) {
  return Object.prototype.hasOwnProperty.call(project, field)
    ? { present: true, value: project[field] }
    : { present: false }
}

function projectRecoveryETag(projectId, project, payload) {
  const validatorState = {
    projectId,
    fence: {
      lifecycleLock: exactFenceField(project, 'lifecycleLock'),
      lifecycleWriters: exactFenceField(project, 'lifecycleWriters'),
      lifecycleWriterMetadata: exactFenceField(project, 'lifecycleWriterMetadata'),
      taskGraphLock: exactFenceField(project, 'taskGraphLock'),
    },
    preview: stablePreview(payload),
  }
  const digest = createHash('sha256')
    .update(JSON.stringify(canonical(validatorState)))
    .digest('hex')
  return `"titra-project-recovery-${digest}"`
}

function validateRecoveryTarget(type, recoveryId) {
  if (!['writer', 'task-delete'].includes(type)
    || typeof recoveryId !== 'string' || recoveryId.length < 8 || recoveryId.length > 128
    || !/^[A-Za-z0-9._:-]+$/.test(recoveryId)) {
    throw recoveryError('project-recovery-invalid', 'Invalid recovery target.')
  }
}

async function previewProjectFenceRecovery({ projectId, userId }, dependencies) {
  assertProjectFenceRecoveryDeploymentEnabled(dependencies)
  const selector = projectRecoverySelector(projectId, userId)
  const project = await dependencies.findProject(selector)
  if (!project) throw recoveryError('not-authorized', 'Project not found.')
  const snapshotDependencies = {
    ...dependencies,
    // Both core previews must classify the same authorized project fence
    // snapshot. Resource reads remain live and are reflected in the ETag's
    // stable public classification.
    findProject: async () => project,
    allowStaleFenceRecovery: true,
  }
  const [writers, taskGraph] = await Promise.all([
    inspectProjectChildWriterRecoveries({ selector, projectId }, snapshotDependencies),
    previewTaskGraphLockRecovery({ selector, projectId }, snapshotDependencies),
  ])
  const payload = {
    projectId,
    minimumAgeSeconds: MINIMUM_FENCE_RECOVERY_AGE_MS / 1000,
    writerRecoveries: writers,
    taskGraphRecovery: taskGraph,
  }
  return { payload, etag: projectRecoveryETag(projectId, project, payload) }
}

async function recoverProjectFence({
  projectId, userId, expectedETag, type, recoveryId,
}, dependencies) {
  assertProjectFenceRecoveryDeploymentEnabled(dependencies)
  validateRecoveryTarget(type, recoveryId)
  const preview = await previewProjectFenceRecovery({ projectId, userId }, dependencies)
  if (expectedETag !== preview.etag) {
    throw recoveryError('project-recovery-conflict', 'Recovery state changed after preview.')
  }
  const selector = projectRecoverySelector(projectId, userId)
  const recoveryDependencies = { ...dependencies, allowStaleFenceRecovery: true }
  let result
  if (type === 'writer') {
    const candidate = preview.payload.writerRecoveries.reservations?.find(
      (entry) => entry.status === 'recoverable'
        && entry.reservation?.reservationId === recoveryId,
    )
    if (!candidate) {
      throw recoveryError('project-recovery-conflict', 'Writer is not safely recoverable.')
    }
    result = await recoverProjectChildWriter({
      selector, projectId, reservationId: recoveryId,
    }, recoveryDependencies)
  } else {
    const candidate = preview.payload.taskGraphRecovery
    if (candidate.status !== 'recoverable' || candidate.lock?.lockId !== recoveryId) {
      throw recoveryError('project-recovery-conflict', 'Task lock is not safely recoverable.')
    }
    result = await recoverTaskGraphLock({
      selector, projectId, lockId: recoveryId,
    }, recoveryDependencies)
  }
  if (result.status !== 'cleared') {
    throw recoveryError('project-recovery-conflict', 'Recovery state changed while clearing.')
  }
  const current = await previewProjectFenceRecovery({ projectId, userId }, dependencies)
  return {
    payload: { cleared: { type, recoveryId }, current: current.payload },
    etag: current.etag,
  }
}

export {
  ProjectFenceRecoveryError,
  PROJECT_FENCE_RECOVERY_MODE_ENV,
  PROJECT_FENCE_RECOVERY_SINGLE_INSTANCE_MODE,
  assertProjectFenceRecoveryDeploymentEnabled,
  previewProjectFenceRecovery,
  projectFenceRecoveryDeploymentEnabled,
  projectRecoveryETag,
  recoverProjectFence,
  validateRecoveryTarget,
}
