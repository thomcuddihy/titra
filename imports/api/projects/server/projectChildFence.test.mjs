import assert from 'node:assert/strict'
import test from 'node:test'
import { isDeepStrictEqual } from 'node:util'

import {
  MAX_PROJECT_CHILD_WRITERS,
  MINIMUM_FENCE_RECOVERY_AGE_MS,
  createProjectChildWithFence,
  definiteProjectChildNoWrite,
  deleteEmptyProjectWithFence,
  inspectProjectChildWriterRecoveries,
  previewProjectChildWriterRecovery,
  recoverProjectChildWriter,
  runWithProjectChildWriter,
} from './projectChildFence.js'

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
    project: { _id: 'p1', userId: 'owner', projectRevision: 1 },
    children: new Map(),
    now: new Date('2026-09-01T12:00:00.000Z'),
    bootId: 'boot:current-process',
  }
  const deps = {
    now: () => new Date(state.now),
    bootId: state.bootId,
    allowStaleFenceRecovery: true,
    findOneAndUpdate: async (selector, modifier) => {
      if (!state.project || !matches(state.project, selector)) return null
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
      if (modifier.$set) Object.assign(state.project, modifier.$set)
      return structuredClone(state.project)
    },
    findOne: async (selector) => state.project && matches(state.project, selector)
      ? structuredClone(state.project) : null,
    updateOne: async (selector, modifier) => {
      if (!state.project || !matches(state.project, selector)) return { matchedCount: 0 }
      if (modifier.$pull) {
        for (const [field, condition] of Object.entries(modifier.$pull)) {
          state.project[field] = (state.project[field] || [])
            .filter((value) => !pullMatches(value, condition))
        }
      }
      if (modifier.$unset) Object.keys(modifier.$unset).forEach((key) => delete state.project[key])
      return { matchedCount: 1 }
    },
    findProject: async (selector) => state.project && matches(state.project, selector)
      ? structuredClone(state.project) : null,
    findTimecard: async (selector) => {
      const child = state.children.get(selector._id)
      return child?.kind === 'timecard' ? structuredClone(child) : null
    },
    findTask: async (selector) => {
      const child = state.children.get(selector._id)
      return child?.kind === 'task' ? structuredClone(child) : null
    },
    countTimecards: async () => [...state.children.values()].filter((c) => c.kind === 'timecard').length,
    countProjectTasks: async () => [...state.children.values()].filter((c) => c.kind === 'task').length,
    deleteOne: async (selector) => {
      if (!state.project || !matches(state.project, selector)) return { deletedCount: 0 }
      state.project = null
      return { deletedCount: 1 }
    },
  }
  return { state, deps }
}

function seedWriter(f, {
  reservationId = 'writer:stale123',
  kind = 'timecard-create',
  resourceId = 'timecard-stale',
  acquiredAt = new Date(
    f.state.now.getTime() - MINIMUM_FENCE_RECOVERY_AGE_MS - 1,
  ),
  bootId = 'boot:previous-process',
} = {}) {
  const metadata = {
    reservationId, kind, resourceId, acquiredAt, bootId,
  }
  f.state.project.lifecycleWriters = [reservationId]
  f.state.project.lifecycleWriterMetadata = [structuredClone(metadata)]
  return metadata
}

test('creator reservation blocks a simultaneous project delete', async () => {
  const f = fixture()
  let releaseCreate
  const creating = createProjectChildWithFence({
    selector: { _id: 'p1', userId: 'owner' },
    projectId: 'p1',
    reservationId: 'writer:12345678',
    kind: 'timecard-create',
    resourceId: 'c1',
    createChild: async () => new Promise((resolve) => { releaseCreate = resolve }),
    removeCreatedChild: async (id) => f.state.children.delete(id),
  }, f.deps)
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(await deleteEmptyProjectWithFence({
    selector: { _id: 'p1', userId: 'owner' }, lockId: 'delete:12345678',
  }, f.deps), { status: 'conflict' })
  f.state.children.set('c1', {
    _id: 'c1', projectId: 'p1', kind: 'timecard',
  })
  releaseCreate({ resourceId: 'c1', created: true })
  await creating
  assert.deepEqual(f.state.project.lifecycleWriters, [])
  assert.deepEqual(f.state.project.lifecycleWriterMetadata, [])
})

test('failed post-insert check removes only newly-created children', async () => {
  const f = fixture()
  const removed = []
  await assert.rejects(createProjectChildWithFence({
    selector: { _id: 'p1' }, projectId: 'p1', reservationId: 'writer:abcdefgh',
    kind: 'project-task-create', resourceId: 'new',
    createChild: async () => {
      f.state.children.set('new', {
        _id: 'new', projectId: 'p1', kind: 'task',
      })
      delete f.state.project
      return { resourceId: 'new', created: true }
    },
    removeCreatedChild: async (id) => { removed.push(id); f.state.children.delete(id) },
  }, f.deps), { error: 'project-child-write-blocked' })
  assert.deepEqual(removed, ['new'])

  const recovered = fixture()
  recovered.state.children.set('old', {
    _id: 'old', projectId: 'p1', kind: 'task',
  })
  const recoveredRemoved = []
  await assert.rejects(createProjectChildWithFence({
    selector: { _id: 'p1' }, projectId: 'p1', reservationId: 'writer:ijklmnop',
    kind: 'project-task-recover', resourceId: 'old',
    createChild: async () => {
      delete recovered.state.project
      return { resourceId: 'old', created: false }
    },
    removeCreatedChild: async (id) => recoveredRemoved.push(id),
  }, recovered.deps), { error: 'project-child-write-blocked' })
  assert.deepEqual(recoveredRemoved, [])
})

test('outcome-unknown create keeps its reservation and blocks project deletion', async () => {
  const f = fixture()
  await assert.rejects(createProjectChildWithFence({
    selector: { _id: 'p1' }, projectId: 'p1', reservationId: 'writer:unknown1',
    kind: 'timecard-create', resourceId: 'maybe-created',
    createChild: async () => {
      // Model the important Mongo failure mode: the write is visible, but the
      // driver cannot confirm it to the caller (for example, a lost reply).
      f.state.children.set('maybe-created', {
        _id: 'maybe-created', projectId: 'p1', kind: 'timecard',
      })
      throw new Error('insert outcome unknown')
    },
    removeCreatedChild: async () => {
      throw new Error('must not compensate an unconfirmed create')
    },
  }, f.deps), /insert outcome unknown/)

  assert.deepEqual(f.state.project.lifecycleWriters, ['writer:unknown1'])
  assert.equal(f.state.project.lifecycleWriterMetadata.length, 1)
  assert.deepEqual(await deleteEmptyProjectWithFence({
    selector: { _id: 'p1' }, lockId: 'delete:unknown1',
  }, f.deps), { status: 'conflict' })
  assert.equal(f.state.children.has('maybe-created'), true)
})

test('explicit pre-write validation failure releases its reservation only', async () => {
  const f = fixture()
  const validation = Object.assign(new Error('dependency does not exist'), {
    error: 'project-task-invalid',
  })
  await assert.rejects(createProjectChildWithFence({
    selector: { _id: 'p1' }, projectId: 'p1', reservationId: 'writer:prewrite1',
    kind: 'project-task-create', resourceId: 'candidate-task',
    createChild: async () => { throw definiteProjectChildNoWrite(validation) },
    removeCreatedChild: async () => { throw new Error('must not run') },
  }, f.deps), (error) => error === validation)

  assert.deepEqual(f.state.project.lifecycleWriters, [])
  assert.deepEqual(f.state.project.lifecycleWriterMetadata, [])
  assert.deepEqual(await deleteEmptyProjectWithFence({
    selector: { _id: 'p1' }, lockId: 'delete:prewrite1',
  }, f.deps), { status: 'deleted' })
})

test('move reservation prevents target deletion until its CAS finishes', async () => {
  const f = fixture()
  let finishMove
  const moving = runWithProjectChildWriter({
    selector: { _id: 'p1', userId: 'owner' },
    projectId: 'p1',
    reservationId: 'move:record123',
    kind: 'timecard-details-move',
    resourceId: 'record123',
    operation: async () => new Promise((resolve) => { finishMove = resolve }),
  }, f.deps)
  await new Promise((resolve) => setImmediate(resolve))

  assert.deepEqual(await deleteEmptyProjectWithFence({
    selector: { _id: 'p1', userId: 'owner' }, lockId: 'delete:move123',
  }, f.deps), { status: 'conflict' })
  finishMove({ matchedCount: 1 })
  assert.deepEqual(await moving, { matchedCount: 1 })
  assert.deepEqual(f.state.project.lifecycleWriters, [])
  assert.deepEqual(f.state.project.lifecycleWriterMetadata, [])
})

test('unknown move outcome retains its target reservation', async () => {
  const f = fixture()
  await assert.rejects(runWithProjectChildWriter({
    selector: { _id: 'p1' }, projectId: 'p1', reservationId: 'move:unknown12',
    kind: 'timecard-details-move', resourceId: 'moved-record',
    operation: async () => {
      f.state.children.set('moved-record', {
        _id: 'moved-record', projectId: 'p1', kind: 'timecard',
      })
      throw new Error('move outcome unknown')
    },
  }, f.deps), /move outcome unknown/)
  assert.deepEqual(f.state.project.lifecycleWriters, ['move:unknown12'])
  assert.deepEqual(await deleteEmptyProjectWithFence({
    selector: { _id: 'p1' }, lockId: 'delete:unknown2',
  }, f.deps), { status: 'conflict' })
})

test('explicit pre-write move failure releases its reservation and preserves the cause', async () => {
  const f = fixture()
  const validation = Object.assign(new Error('target task does not exist'), {
    error: 'project-task-invalid',
  })
  await assert.rejects(runWithProjectChildWriter({
    selector: { _id: 'p1' }, projectId: 'p1', reservationId: 'move:prewrite12',
    kind: 'timecard-details-move', resourceId: 'record-prewrite',
    operation: async () => { throw definiteProjectChildNoWrite(validation) },
  }, f.deps), (error) => error === validation)
  assert.deepEqual(f.state.project.lifecycleWriters, [])
})

test('locked delete rejects nonempty projects and removes an empty project', async () => {
  const nonempty = fixture()
  nonempty.state.children.set('t1', { kind: 'timecard' })
  assert.deepEqual(await deleteEmptyProjectWithFence({
    selector: { _id: 'p1' }, lockId: 'delete:abcdefgh',
  }, nonempty.deps), {
    status: 'not-empty', counts: { timecards: 1, projectTasks: 0 },
  })
  assert.equal(nonempty.state.project.lifecycleLock, undefined)

  const empty = fixture()
  assert.deepEqual(await deleteEmptyProjectWithFence({
    selector: { _id: 'p1' }, lockId: 'delete:ijklmnop',
  }, empty.deps), { status: 'deleted' })
  assert.equal(empty.state.project, null)
})

test('writer metadata is bounded and orphan metadata blocks project deletion', async () => {
  const bounded = fixture()
  bounded.state.project.lifecycleWriters = []
  bounded.state.project.lifecycleWriterMetadata = Array.from(
    { length: MAX_PROJECT_CHILD_WRITERS },
    (_, index) => ({
      reservationId: `writer:bounded${index}`,
      kind: 'timecard-create',
      resourceId: `resource${index}`,
      acquiredAt: new Date(bounded.state.now),
      bootId: 'boot:previous-process',
    }),
  )
  await assert.rejects(createProjectChildWithFence({
    selector: { _id: 'p1' },
    projectId: 'p1',
    reservationId: 'writer:overflow1',
    kind: 'timecard-create',
    resourceId: 'overflow-resource',
    createChild: async () => assert.fail('bounded reservation must not write'),
    removeCreatedChild: async () => assert.fail('bounded reservation must not clean up'),
  }, bounded.deps), { error: 'project-child-write-blocked' })

  const orphan = fixture()
  orphan.state.project.lifecycleWriterMetadata = [{
    reservationId: 'writer:orphan12',
    kind: 'timecard-create',
    resourceId: 'orphan-resource',
    acquiredAt: new Date(orphan.state.now),
    bootId: 'boot:previous-process',
  }]
  assert.deepEqual(await deleteEmptyProjectWithFence({
    selector: { _id: 'p1' }, lockId: 'delete:orphan12',
  }, orphan.deps), { status: 'conflict' })
})

test('legacy and same-process writer reservations remain blocked', async () => {
  const legacy = fixture()
  legacy.state.project.lifecycleWriters = ['writer:legacy12']
  assert.deepEqual(await previewProjectChildWriterRecovery({
    selector: { userId: 'owner' }, projectId: 'p1', reservationId: 'writer:legacy12',
  }, legacy.deps), { status: 'untracked' })
  assert.deepEqual(await recoverProjectChildWriter({
    selector: { userId: 'owner' }, projectId: 'p1', reservationId: 'writer:legacy12',
  }, legacy.deps), { status: 'untracked' })
  assert.deepEqual(legacy.state.project.lifecycleWriters, ['writer:legacy12'])
  const inspected = await inspectProjectChildWriterRecoveries({
    selector: { userId: 'owner' }, projectId: 'p1',
  }, legacy.deps)
  assert.equal(inspected.status, 'inspected')
  assert.equal(inspected.reservations[0].status, 'untracked')

  const active = fixture()
  seedWriter(active, {
    reservationId: 'writer:active12',
    resourceId: 'active-resource',
    bootId: active.state.bootId,
  })
  const activePreview = await previewProjectChildWriterRecovery({
    selector: { userId: 'owner' }, projectId: 'p1', reservationId: 'writer:active12',
  }, active.deps)
  assert.equal(activePreview.status, 'active-process')
  assert.equal('bootId' in activePreview.reservation, false)
  assert.equal((await recoverProjectChildWriter({
    selector: { userId: 'owner' }, projectId: 'p1', reservationId: 'writer:active12',
  }, active.deps)).status, 'active-process')

  const duplicate = fixture()
  const duplicateMetadata = seedWriter(duplicate, {
    reservationId: 'writer:duplicate1', resourceId: 'duplicate-resource',
  })
  duplicate.state.project.lifecycleWriters.push(duplicateMetadata.reservationId)
  assert.equal((await recoverProjectChildWriter({
    selector: { userId: 'owner' },
    projectId: 'p1',
    reservationId: duplicateMetadata.reservationId,
  }, duplicate.deps)).status, 'untracked')
  assert.equal(duplicate.state.project.lifecycleWriters.length, 2)
})

test('recent old-process writers cannot be recovered before the minimum age', async () => {
  const f = fixture()
  seedWriter(f, {
    acquiredAt: new Date(f.state.now.getTime() - MINIMUM_FENCE_RECOVERY_AGE_MS + 1),
  })
  const preview = await previewProjectChildWriterRecovery({
    selector: { userId: 'owner' }, projectId: 'p1', reservationId: 'writer:stale123',
  }, f.deps)
  assert.equal(preview.status, 'too-young')
  assert.equal((await recoverProjectChildWriter({
    selector: { userId: 'owner' }, projectId: 'p1', reservationId: 'writer:stale123',
  }, f.deps)).status, 'too-young')
  assert.deepEqual(f.state.project.lifecycleWriters, ['writer:stale123'])
})

test('cross-boot recovery remains disabled without an explicit deployment gate', async () => {
  const f = fixture()
  const metadata = seedWriter(f)
  delete f.deps.allowStaleFenceRecovery
  const options = {
    selector: { userId: 'owner' },
    projectId: 'p1',
    reservationId: metadata.reservationId,
  }
  assert.equal(
    (await previewProjectChildWriterRecovery(options, f.deps)).status,
    'deployment-disabled',
  )
  assert.equal(
    (await recoverProjectChildWriter(options, f.deps)).status,
    'deployment-disabled',
  )
  assert.deepEqual(f.state.project.lifecycleWriters, [metadata.reservationId])
})

test('old-process writer recovery classifies exact present and absent resources', async () => {
  for (const resourcePresent of [false, true]) {
    const f = fixture()
    const metadata = seedWriter(f)
    if (resourcePresent) {
      f.state.children.set(metadata.resourceId, {
        _id: metadata.resourceId,
        projectId: 'p1',
        kind: 'timecard',
      })
    }
    const preview = await previewProjectChildWriterRecovery({
      selector: { userId: 'owner' }, projectId: 'p1', reservationId: metadata.reservationId,
    }, f.deps)
    assert.equal(preview.status, 'recoverable')
    assert.equal(
      preview.resourceStatus,
      resourcePresent ? 'present-in-project' : 'absent',
    )
    const recovered = await recoverProjectChildWriter({
      selector: { userId: 'owner' }, projectId: 'p1', reservationId: metadata.reservationId,
    }, f.deps)
    assert.equal(recovered.status, 'cleared')
    assert.deepEqual(f.state.project.lifecycleWriters, [])
    assert.deepEqual(f.state.project.lifecycleWriterMetadata, [])
  }
})

test('unexpected writer resource state and a recovery CAS race remain blocked', async () => {
  const unexpected = fixture()
  const metadata = seedWriter(unexpected)
  unexpected.state.children.set(metadata.resourceId, {
    _id: metadata.resourceId,
    projectId: 'another-project',
    kind: 'timecard',
  })
  const unexpectedResult = await recoverProjectChildWriter({
    selector: { userId: 'owner' }, projectId: 'p1', reservationId: metadata.reservationId,
  }, unexpected.deps)
  assert.equal(unexpectedResult.status, 'resource-unexpected')
  assert.deepEqual(unexpected.state.project.lifecycleWriters, [metadata.reservationId])

  const raced = fixture()
  const racedMetadata = seedWriter(raced)
  raced.state.children.set(racedMetadata.resourceId, {
    _id: racedMetadata.resourceId,
    projectId: 'p1',
    kind: 'timecard',
  })
  const normalFindTimecard = raced.deps.findTimecard
  raced.deps.findTimecard = async (selector) => {
    const result = await normalFindTimecard(selector)
    raced.state.project.lifecycleWriterMetadata[0].acquiredAt = new Date(
      raced.state.project.lifecycleWriterMetadata[0].acquiredAt.getTime() + 1,
    )
    return result
  }
  const racedResult = await recoverProjectChildWriter({
    selector: { userId: 'owner' }, projectId: 'p1', reservationId: racedMetadata.reservationId,
  }, raced.deps)
  assert.equal(racedResult.status, 'conflict')
  assert.deepEqual(raced.state.project.lifecycleWriters, [racedMetadata.reservationId])
})

test('recovery removes only its exact reservation and preserves other writers', async () => {
  const f = fixture()
  const target = seedWriter(f, {
    reservationId: 'writer:target12', resourceId: 'target-resource',
  })
  const other = {
    reservationId: 'writer:other123',
    kind: 'project-task-create',
    resourceId: 'other-resource',
    acquiredAt: new Date(target.acquiredAt),
    bootId: 'boot:another-process',
  }
  f.state.project.lifecycleWriters.push(other.reservationId)
  f.state.project.lifecycleWriterMetadata.push(structuredClone(other))
  const result = await recoverProjectChildWriter({
    selector: { userId: 'owner' }, projectId: 'p1', reservationId: target.reservationId,
  }, f.deps)
  assert.equal(result.status, 'cleared')
  assert.deepEqual(f.state.project.lifecycleWriters, [other.reservationId])
  assert.deepEqual(f.state.project.lifecycleWriterMetadata, [other])
})
