import assert from 'node:assert/strict'
import test from 'node:test'
import { isDeepStrictEqual } from 'node:util'

import {
  MINIMUM_FENCE_RECOVERY_AGE_MS,
  acquireProjectChildWriter,
  releaseProjectChildWriter,
} from '../../projects/server/projectChildFence.js'
import {
  deleteProjectTaskWithFence,
  previewTaskGraphLockRecovery,
  recoverTaskGraphLock,
  taskRecoveryFingerprint,
} from './taskGraphFence.js'

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
    if (condition?.$ne !== undefined) {
      return Array.isArray(value) ? !value.includes(condition.$ne) : value !== condition.$ne
    }
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
    project: { _id: 'p1', userId: 'owner' },
    task: { _id: 't1', projectId: 'p1', name: 'Review' },
    records: [],
    dependents: [],
    now: new Date('2026-09-01T12:00:00.000Z'),
    bootId: 'boot:current-process',
  }
  const deps = {
    now: () => new Date(state.now),
    bootId: state.bootId,
    allowStaleFenceRecovery: true,
    findOneAndUpdate: async (selector, modifier) => {
      if (!matches(state.project, selector)) return null
      if (modifier.$addToSet) {
        state.project.lifecycleWriters = [...new Set([
          ...(state.project.lifecycleWriters || []), modifier.$addToSet.lifecycleWriters,
        ])]
      }
      if (modifier.$push?.lifecycleWriterMetadata) {
        state.project.lifecycleWriterMetadata = [
          ...(state.project.lifecycleWriterMetadata || []),
          structuredClone(modifier.$push.lifecycleWriterMetadata),
        ]
      }
      if (modifier.$set) Object.assign(state.project, structuredClone(modifier.$set))
      return structuredClone(state.project)
    },
    findOne: async (selector) => (matches(state.project, selector)
      ? structuredClone(state.project) : null),
    updateOne: async (selector, modifier) => {
      if (!matches(state.project, selector)) return { matchedCount: 0 }
      if (modifier.$pull) {
        for (const [field, condition] of Object.entries(modifier.$pull)) {
          state.project[field] = (state.project[field] || [])
            .filter((value) => !pullMatches(value, condition))
        }
      }
      Object.keys(modifier.$unset || {}).forEach((field) => delete state.project[field])
      return { matchedCount: 1 }
    },
    findProject: async (selector) => (matches(state.project, selector)
      ? structuredClone(state.project) : null),
    findTask: async (selector) => (matches(state.task, selector)
      ? structuredClone(state.task) : null),
  }
  const deleteOptions = (overrides = {}) => ({
    projectSelector: { _id: 'p1', userId: 'owner' },
    projectId: 'p1', taskId: 't1', taskName: 'Review', lockId: 'task-delete:1234',
    taskFingerprint: taskRecoveryFingerprint(state.task),
    acknowledgeRecordedEntries: false,
    inspectLockedState: async () => ({
      isDefault: false,
      dependentTaskCount: state.dependents.length,
      recordCount: state.records.length,
    }),
    deleteTask: async () => {
      if (!state.task) return { deletedCount: 0 }
      state.task = null
      return { deletedCount: 1 }
    },
    ...overrides,
  })
  return { state, deps, deleteOptions }
}

async function retainTaskDeleteLock(f, { removeTask = false } = {}) {
  await assert.rejects(deleteProjectTaskWithFence(f.deleteOptions({
    acknowledgeRecordedEntries: true,
    deleteTask: async () => {
      if (removeTask) f.state.task = null
      throw new Error('task delete outcome unknown')
    },
  }), f.deps), /task delete outcome unknown/)
  return f.state.project.taskGraphLock
}

function ageTaskDeleteLock(f, ageMs = MINIMUM_FENCE_RECOVERY_AGE_MS + 1) {
  f.state.project.taskGraphLock.bootId = 'boot:previous-process'
  f.state.project.taskGraphLock.acquiredAt = new Date(f.state.now.getTime() - ageMs)
}

test('an in-flight reference writer blocks task deletion', async () => {
  const f = fixture()
  const reservation = await acquireProjectChildWriter({
    selector: { _id: 'p1' },
    reservationId: 'timecard:writer1',
    kind: 'timecard-create',
    resourceId: 'timecard-writer1',
  }, f.deps)
  assert.deepEqual(await deleteProjectTaskWithFence(f.deleteOptions(), f.deps), {
    status: 'conflict',
  })
  await releaseProjectChildWriter({
    projectId: 'p1', metadata: reservation.metadata,
  }, f.deps)
})

test('task delete lock rejects a same-name timecard writer during reference recheck', async () => {
  const f = fixture()
  const result = await deleteProjectTaskWithFence(f.deleteOptions({
    acknowledgeRecordedEntries: true,
    inspectLockedState: async () => {
      await assert.rejects(acquireProjectChildWriter({
        selector: { _id: 'p1' },
        reservationId: 'timecard:newref1',
        kind: 'timecard-create',
        resourceId: 'timecard-newref1',
      }, f.deps), { error: 'project-child-write-blocked' })
      // This models the timecard create/rename refusing before it can add a
      // same-name record between the reference count and delete.
      assert.equal(f.state.records.length, 0)
      return { isDefault: false, dependentTaskCount: 0, recordCount: 0 }
    },
  }), f.deps)
  assert.equal(result.status, 'deleted')
  assert.equal(f.state.project.taskGraphLock, undefined)
})

test('dependency and record guards are rechecked under lock and then released', async () => {
  for (const kind of ['dependent', 'recorded']) {
    const f = fixture()
    if (kind === 'dependent') f.state.dependents.push('t2')
    else f.state.records.push('r1')
    const result = await deleteProjectTaskWithFence(f.deleteOptions(), f.deps)
    assert.equal(result.status, kind)
    assert.equal(f.state.task?._id, 't1')
    assert.equal(f.state.project.taskGraphLock, undefined)
  }
})

test('unknown task deletion outcome retains the graph lock', async () => {
  const f = fixture()
  await assert.rejects(deleteProjectTaskWithFence(f.deleteOptions({
    acknowledgeRecordedEntries: true,
    deleteTask: async () => {
      f.state.task = null
      throw new Error('delete response lost')
    },
  }), f.deps), /delete response lost/)
  assert.equal(f.state.project.taskGraphLock.taskId, 't1')
  await assert.rejects(acquireProjectChildWriter({
    selector: { _id: 'p1' },
    reservationId: 'dependency:new1',
    kind: 'project-task-update',
    resourceId: 'dependency-new1',
  }, f.deps), { error: 'project-child-write-blocked' })
})

test('task recovery fingerprint is canonical, complete, and the lock stores no task payload', async () => {
  const first = {
    _id: 't1', projectId: 'p1', name: 'Review',
    nested: { z: 2, a: ['x', new Date('2026-01-01T00:00:00.000Z')] },
  }
  const reordered = {
    nested: { a: ['x', new Date('2026-01-01T00:00:00.000Z')], z: 2 },
    name: 'Review', projectId: 'p1', _id: 't1',
  }
  assert.equal(taskRecoveryFingerprint(first), taskRecoveryFingerprint(reordered))
  assert.notEqual(
    taskRecoveryFingerprint(first),
    taskRecoveryFingerprint({ ...first, description: 'changed' }),
  )

  const f = fixture()
  await retainTaskDeleteLock(f)
  assert.deepEqual(Object.keys(f.state.project.taskGraphLock).sort(), [
    'acquiredAt', 'bootId', 'kind', 'lockId', 'taskFingerprint', 'taskId', 'taskName',
  ])
})

test('legacy, same-process, and recent task locks remain blocked', async () => {
  const legacy = fixture()
  legacy.state.project.taskGraphLock = {
    kind: 'delete-task', lockId: 'task-delete:legacy', taskId: 't1', taskName: 'Review',
  }
  assert.deepEqual(await recoverTaskGraphLock({
    selector: { userId: 'owner' }, projectId: 'p1', lockId: 'task-delete:legacy',
  }, legacy.deps), { status: 'untracked' })
  assert.ok(legacy.state.project.taskGraphLock)

  const active = fixture()
  const activeLock = await retainTaskDeleteLock(active)
  const activePreview = await previewTaskGraphLockRecovery({
    selector: { userId: 'owner' }, projectId: 'p1', lockId: activeLock.lockId,
  }, active.deps)
  assert.equal(activePreview.status, 'active-process')
  assert.equal('bootId' in activePreview.lock, false)
  assert.equal((await recoverTaskGraphLock({
    selector: { userId: 'owner' }, projectId: 'p1', lockId: activeLock.lockId,
  }, active.deps)).status, 'active-process')

  const recent = fixture()
  const recentLock = await retainTaskDeleteLock(recent)
  ageTaskDeleteLock(recent, MINIMUM_FENCE_RECOVERY_AGE_MS - 1)
  assert.equal((await recoverTaskGraphLock({
    selector: { userId: 'owner' }, projectId: 'p1', lockId: recentLock.lockId,
  }, recent.deps)).status, 'too-young')
  assert.ok(recent.state.project.taskGraphLock)
})

test('cross-boot task-lock recovery is disabled without the deployment gate', async () => {
  const f = fixture()
  const lock = await retainTaskDeleteLock(f)
  ageTaskDeleteLock(f)
  delete f.deps.allowStaleFenceRecovery
  const options = {
    selector: { userId: 'owner' }, projectId: 'p1', lockId: lock.lockId,
  }
  assert.equal(
    (await previewTaskGraphLockRecovery(options, f.deps)).status,
    'deployment-disabled',
  )
  assert.equal(
    (await recoverTaskGraphLock(options, f.deps)).status,
    'deployment-disabled',
  )
  assert.ok(f.state.project.taskGraphLock)
})

test('old task locks recover only when the task is absent or exactly unchanged', async () => {
  for (const removeTask of [true, false]) {
    const f = fixture()
    const lock = await retainTaskDeleteLock(f, { removeTask })
    ageTaskDeleteLock(f)
    const preview = await previewTaskGraphLockRecovery({
      selector: { userId: 'owner' }, projectId: 'p1', lockId: lock.lockId,
    }, f.deps)
    assert.equal(preview.status, 'recoverable')
    assert.equal(preview.taskStatus, removeTask ? 'absent' : 'unchanged')
    const recovered = await recoverTaskGraphLock({
      selector: { userId: 'owner' }, projectId: 'p1', lockId: lock.lockId,
    }, f.deps)
    assert.equal(recovered.status, 'cleared')
    assert.equal(f.state.project.taskGraphLock, undefined)
  }
})

test('changed task state and an exact-CAS race leave the task lock in place', async () => {
  const changed = fixture()
  const changedLock = await retainTaskDeleteLock(changed)
  ageTaskDeleteLock(changed)
  changed.state.task.description = 'changed after the failed delete'
  const changedResult = await recoverTaskGraphLock({
    selector: { userId: 'owner' }, projectId: 'p1', lockId: changedLock.lockId,
  }, changed.deps)
  assert.equal(changedResult.status, 'task-unexpected')
  assert.equal(changedResult.taskStatus, 'unexpected')
  assert.ok(changed.state.project.taskGraphLock)

  const raced = fixture()
  const racedLock = await retainTaskDeleteLock(raced)
  ageTaskDeleteLock(raced)
  const normalFindTask = raced.deps.findTask
  raced.deps.findTask = async (selector) => {
    const task = await normalFindTask(selector)
    raced.state.project.taskGraphLock.acquiredAt = new Date(
      raced.state.project.taskGraphLock.acquiredAt.getTime() + 1,
    )
    return task
  }
  const racedResult = await recoverTaskGraphLock({
    selector: { userId: 'owner' }, projectId: 'p1', lockId: racedLock.lockId,
  }, raced.deps)
  assert.equal(racedResult.status, 'conflict')
  assert.ok(raced.state.project.taskGraphLock)
})

test('mixed task lock and writer state is untracked and never cleared', async () => {
  const f = fixture()
  const lock = await retainTaskDeleteLock(f)
  ageTaskDeleteLock(f)
  f.state.project.lifecycleWriters = ['writer:legacy12']
  const result = await recoverTaskGraphLock({
    selector: { userId: 'owner' }, projectId: 'p1', lockId: lock.lockId,
  }, f.deps)
  assert.equal(result.status, 'untracked')
  assert.ok(f.state.project.taskGraphLock)
})
