import assert from 'node:assert/strict'
import test from 'node:test'
import { isDeepStrictEqual } from 'node:util'

import { MINIMUM_FENCE_RECOVERY_AGE_MS } from '../imports/api/projects/server/projectChildFence.js'
import { taskRecoveryFingerprint } from '../imports/api/tasks/server/taskGraphFence.js'
import {
  PROJECT_FENCE_RECOVERY_MODE_ENV,
  previewProjectFenceRecovery,
  projectFenceRecoveryDeploymentEnabled,
  projectRecoveryETag,
  recoverProjectFence,
  validateRecoveryTarget,
} from './projectFenceRecovery.js'

function getPath(value, dotted) {
  return dotted.split('.').reduce((current, key) => current?.[key], value)
}

function matches(document, selector) {
  return Boolean(document) && Object.entries(selector).every(([field, condition]) => {
    if (field === '$and') return condition.every((part) => matches(document, part))
    if (field === '$or') return condition.some((part) => matches(document, part))
    const value = getPath(document, field)
    if (condition?.$exists != null) return (value !== undefined) === condition.$exists
    if (condition?.$size != null) return Array.isArray(value) && value.length === condition.$size
    if (condition?.$elemMatch) {
      return Array.isArray(value) && value.some((entry) => matches(entry, condition.$elemMatch))
    }
    return Array.isArray(value) && !Array.isArray(condition)
      ? value.includes(condition) : isDeepStrictEqual(value, condition)
  })
}

function pullMatches(value, condition) {
  if (condition && typeof condition === 'object' && !(condition instanceof Date)) {
    return matches(value, condition)
  }
  return isDeepStrictEqual(value, condition)
}

function fixture() {
  const state = {
    now: new Date('2026-09-01T12:00:00.000Z'),
    project: {
      _id: 'project-1', userId: 'owner-1', admins: ['admin-1'],
    },
    timecards: new Map(),
    tasks: new Map(),
    updates: 0,
  }
  const dependencies = {
    environment: { TITRA_FENCE_RECOVERY_MODE: 'single-instance' },
    bootId: 'boot:current-process',
    now: () => new Date(state.now),
    findProject: async (selector) => (matches(state.project, selector)
      ? structuredClone(state.project) : null),
    findTimecard: async (selector) => {
      const timecard = state.timecards.get(selector._id)
      return timecard ? structuredClone(timecard) : null
    },
    findTask: async (selector) => {
      const task = state.tasks.get(selector._id)
      return task ? structuredClone(task) : null
    },
    updateOne: async (selector, modifier) => {
      if (!matches(state.project, selector)) return { matchedCount: 0 }
      state.updates += 1
      for (const [field, condition] of Object.entries(modifier.$pull || {})) {
        state.project[field] = (state.project[field] || [])
          .filter((value) => !pullMatches(value, condition))
      }
      Object.keys(modifier.$unset || {}).forEach((field) => delete state.project[field])
      return { matchedCount: 1 }
    },
  }
  return { state, dependencies }
}

function seedWriter(f, overrides = {}) {
  const metadata = {
    reservationId: 'writer:stale-resource',
    kind: 'timecard-create',
    resourceId: 'timecard-stale',
    acquiredAt: new Date(
      f.state.now.getTime() - MINIMUM_FENCE_RECOVERY_AGE_MS - 1000,
    ),
    bootId: 'boot:previous-process',
    ...overrides,
  }
  f.state.project.lifecycleWriters = [metadata.reservationId]
  f.state.project.lifecycleWriterMetadata = [structuredClone(metadata)]
  return metadata
}

function seedTaskLock(f, task = null) {
  const target = task || { _id: 'task-1', projectId: 'project-1', name: 'Review' }
  if (task) f.state.tasks.set(task._id, structuredClone(task))
  const lock = {
    kind: 'delete-task',
    lockId: 'task-delete:task-1:stale',
    taskId: target._id,
    taskName: target.name,
    taskFingerprint: taskRecoveryFingerprint(target),
    acquiredAt: new Date(
      f.state.now.getTime() - MINIMUM_FENCE_RECOVERY_AGE_MS - 1000,
    ),
    bootId: 'boot:previous-process',
  }
  f.state.project.taskGraphLock = structuredClone(lock)
  return lock
}

test('recovery is default-disabled and only the exact single-instance mode enables it', async () => {
  assert.equal(projectFenceRecoveryDeploymentEnabled({}), false)
  assert.equal(projectFenceRecoveryDeploymentEnabled({
    [PROJECT_FENCE_RECOVERY_MODE_ENV]: 'single-instance ',
  }), false)
  assert.equal(projectFenceRecoveryDeploymentEnabled({
    [PROJECT_FENCE_RECOVERY_MODE_ENV]: 'SINGLE-INSTANCE',
  }), false)
  assert.equal(projectFenceRecoveryDeploymentEnabled({
    [PROJECT_FENCE_RECOVERY_MODE_ENV]: 'single-instance',
  }), true)

  const f = fixture()
  f.dependencies.environment = {}
  let projectRead = false
  f.dependencies.findProject = async () => { projectRead = true; return f.state.project }
  await assert.rejects(previewProjectFenceRecovery({
    projectId: 'project-1', userId: 'owner-1',
  }, f.dependencies), { error: 'project-recovery-disabled' })
  assert.equal(projectRead, false)
  assert.equal(f.state.updates, 0)
})

test('preview is owner/admin only and conceals an inaccessible project', async () => {
  const f = fixture()
  seedWriter(f)
  for (const userId of ['owner-1', 'admin-1']) {
    const preview = await previewProjectFenceRecovery({
      projectId: 'project-1', userId,
    }, f.dependencies)
    assert.equal(preview.payload.writerRecoveries.reservations[0].status, 'recoverable')
  }
  await assert.rejects(previewProjectFenceRecovery({
    projectId: 'project-1', userId: 'member-1',
  }, f.dependencies), { error: 'not-authorized' })
})

test('recovery ETag ignores age drift but includes exact hidden fence state', async () => {
  const f = fixture()
  seedWriter(f)
  const first = await previewProjectFenceRecovery({
    projectId: 'project-1', userId: 'owner-1',
  }, f.dependencies)
  f.state.now = new Date(f.state.now.getTime() + 1234)
  const elapsed = await previewProjectFenceRecovery({
    projectId: 'project-1', userId: 'owner-1',
  }, f.dependencies)
  assert.notEqual(
    first.payload.writerRecoveries.reservations[0].reservation.ageMs,
    elapsed.payload.writerRecoveries.reservations[0].reservation.ageMs,
  )
  assert.equal(first.etag, elapsed.etag)

  f.state.project.lifecycleWriterMetadata[0].bootId = 'boot:replacement-process'
  const replaced = await previewProjectFenceRecovery({
    projectId: 'project-1', userId: 'owner-1',
  }, f.dependencies)
  assert.deepEqual(replaced.payload, elapsed.payload)
  assert.notEqual(replaced.etag, elapsed.etag)

  f.state.project.lifecycleWriterMetadata[0].ageMs = 123
  const rawExtraChanged = await previewProjectFenceRecovery({
    projectId: 'project-1', userId: 'owner-1',
  }, f.dependencies)
  assert.deepEqual(rawExtraChanged.payload, replaced.payload)
  assert.notEqual(rawExtraChanged.etag, replaced.etag)
})

test('ETag distinguishes absent and empty raw fence fields with identical previews', async () => {
  const f = fixture()
  const absent = await previewProjectFenceRecovery({
    projectId: 'project-1', userId: 'owner-1',
  }, f.dependencies)
  f.state.project.lifecycleWriters = []
  f.state.project.lifecycleWriterMetadata = []
  const empty = await previewProjectFenceRecovery({
    projectId: 'project-1', userId: 'owner-1',
  }, f.dependencies)
  assert.deepEqual(absent.payload, empty.payload)
  assert.notEqual(absent.etag, empty.etag)
})

test('elapsed GET to POST writer recovery clears only the previewed exact fence', async () => {
  const f = fixture()
  const writer = seedWriter(f)
  const preview = await previewProjectFenceRecovery({
    projectId: 'project-1', userId: 'admin-1',
  }, f.dependencies)
  f.state.now = new Date(f.state.now.getTime() + 2000)
  const recovered = await recoverProjectFence({
    projectId: 'project-1',
    userId: 'admin-1',
    expectedETag: preview.etag,
    type: 'writer',
    recoveryId: writer.reservationId,
  }, f.dependencies)
  assert.deepEqual(recovered.payload.cleared, {
    type: 'writer', recoveryId: writer.reservationId,
  })
  assert.deepEqual(f.state.project.lifecycleWriters, [])
  assert.deepEqual(f.state.project.lifecycleWriterMetadata, [])
  assert.equal(recovered.payload.current.writerRecoveries.writerCount, 0)
  assert.equal(f.state.updates, 1)
})

test('hidden replacement and unsafe writer state reject recovery without a write', async () => {
  const replaced = fixture()
  const writer = seedWriter(replaced)
  const preview = await previewProjectFenceRecovery({
    projectId: 'project-1', userId: 'owner-1',
  }, replaced.dependencies)
  replaced.state.project.lifecycleWriterMetadata[0].bootId = 'boot:replacement-process'
  await assert.rejects(recoverProjectFence({
    projectId: 'project-1',
    userId: 'owner-1',
    expectedETag: preview.etag,
    type: 'writer',
    recoveryId: writer.reservationId,
  }, replaced.dependencies), { error: 'project-recovery-conflict' })
  assert.equal(replaced.state.updates, 0)

  const legacy = fixture()
  legacy.state.project.lifecycleWriters = ['writer:legacy-resource']
  const legacyPreview = await previewProjectFenceRecovery({
    projectId: 'project-1', userId: 'owner-1',
  }, legacy.dependencies)
  await assert.rejects(recoverProjectFence({
    projectId: 'project-1',
    userId: 'owner-1',
    expectedETag: legacyPreview.etag,
    type: 'writer',
    recoveryId: 'writer:legacy-resource',
  }, legacy.dependencies), { error: 'project-recovery-conflict' })
  assert.equal(legacy.state.updates, 0)
})

test('task lock recovery supports absent and exact tasks but rejects changed tasks', async () => {
  for (const present of [false, true]) {
    const f = fixture()
    const task = { _id: 'task-1', projectId: 'project-1', name: 'Review' }
    const lock = seedTaskLock(f, present ? task : null)
    const preview = await previewProjectFenceRecovery({
      projectId: 'project-1', userId: 'owner-1',
    }, f.dependencies)
    assert.equal(preview.payload.taskGraphRecovery.taskStatus, present ? 'unchanged' : 'absent')
    const recovered = await recoverProjectFence({
      projectId: 'project-1',
      userId: 'owner-1',
      expectedETag: preview.etag,
      type: 'task-delete',
      recoveryId: lock.lockId,
    }, f.dependencies)
    assert.equal(recovered.payload.cleared.type, 'task-delete')
    assert.equal(f.state.project.taskGraphLock, undefined)
  }

  const changed = fixture()
  const task = { _id: 'task-1', projectId: 'project-1', name: 'Review' }
  const lock = seedTaskLock(changed, task)
  changed.state.tasks.get(task._id).description = 'changed'
  const preview = await previewProjectFenceRecovery({
    projectId: 'project-1', userId: 'owner-1',
  }, changed.dependencies)
  assert.equal(preview.payload.taskGraphRecovery.status, 'task-unexpected')
  await assert.rejects(recoverProjectFence({
    projectId: 'project-1',
    userId: 'owner-1',
    expectedETag: preview.etag,
    type: 'task-delete',
    recoveryId: lock.lockId,
  }, changed.dependencies), { error: 'project-recovery-conflict' })
  assert.ok(changed.state.project.taskGraphLock)
})

test('target validation and invalid internal validator state remain distinguishable', () => {
  for (const [type, recoveryId] of [
    ['other', 'writer:valid-id'],
    ['writer', 'short'],
    ['task-delete', 'unsafe/value'],
  ]) {
    assert.throws(() => validateRecoveryTarget(type, recoveryId), {
      error: 'project-recovery-invalid',
    })
  }
  assert.throws(() => projectRecoveryETag('project-1', {
    lifecycleWriters: [undefined],
  }, {}), { error: 'project-recovery-state-invalid' })
})
