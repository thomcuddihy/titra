import assert from 'node:assert/strict'
import test from 'node:test'
import { isDeepStrictEqual } from 'node:util'

import {
  deleteProjectTask,
  deleteTaskSuggestion,
  editProjectTask,
  getProjectTaskPreview,
  getTaskSuggestionPreview,
  validateProjectTaskDetailsBody,
} from '../imports/api/tasks/server/taskLifecycle.js'
import {
  createProjectTaskDeleteHandler,
  createProjectTaskDetailsHandler,
  createProjectTaskGetHandler,
  createTaskSuggestionDeleteHandler,
  createTaskSuggestionGetHandler,
  createTaskSuggestionListHandler,
} from './taskLifecycleRoutes.js'

const failsWith = (code) => (error) => error.error === code

function matches(record, selector) {
  return Boolean(record) && Object.entries(selector).every(([field, condition]) => {
    if (condition && typeof condition === 'object' && !(condition instanceof Date)) {
      const exists = Object.prototype.hasOwnProperty.call(record, field)
      if ('$exists' in condition && exists !== condition.$exists) return false
      return !('$eq' in condition) || isDeepStrictEqual(record[field], condition.$eq)
    }
    if (condition === null) return record[field] == null
    return isDeepStrictEqual(record[field], condition)
  })
}

function taskFixture(overrides = {}) {
  const state = {
    task: {
      _id: 't1', projectId: 'p1', name: 'Plan', start: new Date('2026-09-01T00:00:00Z'),
      end: new Date('2026-09-30T00:00:00Z'), estimatedHours: 10, dependencies: ['t0'],
      projectTaskRevision: 2, custom: 'preserved', ...overrides,
    },
    project: { _id: 'p1', userId: 'owner', admins: ['admin'], team: ['member'], public: true },
    references: { recordCount: 3, dependentTaskCount: 0 },
  }
  const calls = { writes: [], deletes: [], validated: [], projectWriters: [] }
  const deps = {
    findTask: async (selector) => (matches(state.task, selector) ? structuredClone(state.task) : undefined),
    findProject: async (selector) => (matches(state.project, selector) ? structuredClone(state.project) : undefined),
    inspectReferences: async () => structuredClone(state.references),
    validateDependencies: async (...args) => calls.validated.push(args),
    updateOne: async (selector, modifier) => {
      calls.writes.push(structuredClone({ selector, modifier }))
      if (!matches(state.task, selector)) return { matchedCount: 0 }
      Object.assign(state.task, modifier.$set)
      Object.keys(modifier.$unset || {}).forEach((field) => delete state.task[field])
      state.task.projectTaskRevision = (state.task.projectTaskRevision ?? 0) + 1
      return { matchedCount: 1 }
    },
    deleteOne: async (selector) => {
      calls.deletes.push(structuredClone(selector))
      if (!matches(state.task, selector)) return { deletedCount: 0 }
      state.task = null; return { deletedCount: 1 }
    },
  }
  deps.withProjectWriter = async (options, operation) => {
    calls.projectWriters.push(structuredClone(options))
    return operation()
  }
  deps.deleteTaskWithFence = async ({
    task, project, acknowledgeRecordedEntries, expectedTaskSelector,
  }) => {
    const lockedState = {
      ...structuredClone(state.references),
      isDefault: task.isDefaultTask === true || project.defaultTask === task.name,
    }
    if (lockedState.isDefault) return { status: 'default', state: lockedState }
    if (lockedState.dependentTaskCount > 0) return { status: 'dependent', state: lockedState }
    if (lockedState.recordCount > 0 && acknowledgeRecordedEntries !== true) {
      return { status: 'recorded', state: lockedState }
    }
    const result = await deps.deleteOne(expectedTaskSelector)
    return { status: result.deletedCount === 1 ? 'deleted' : 'conflict', state: lockedState }
  }
  return { state, calls, deps }
}

test('project task preview permits project visibility but changes require administrator', async () => {
  const f = taskFixture()
  const preview = await getProjectTaskPreview({ taskId: 't1', userId: 'member' }, f.deps)
  assert.equal(preview.etag, '"titra-project-task-revision-2"')
  assert.equal(preview.payload.references.recordCount, 3)
  for (const userId of ['member', 'viewer']) {
    await assert.rejects(editProjectTask({
      taskId: 't1', userId, expectedRevision: 2,
      body: { expected: { name: 'Plan' }, changes: { name: 'New' } },
    }, f.deps), failsWith('not-authorized'))
  }
})

test('project task body is narrow and dependencies are validated in-project', async () => {
  validateProjectTaskDetailsBody({
    expected: { dependencies: ['t0'] }, changes: { dependencies: ['t0', 't2'] },
  })
  for (const body of [
    { expected: { projectId: 'p1' }, changes: { projectId: 'p2' } },
    { expected: { isDefaultTask: false }, changes: { isDefaultTask: true } },
    { expected: { dependencies: [] }, changes: { dependencies: ['t1'] } },
    { expected: { start: '2026-09-01' }, changes: { start: 'bad' } },
  ]) {
    if (body.changes.dependencies?.includes('t1')) continue
    assert.throws(() => validateProjectTaskDetailsBody(body), failsWith('project-task-invalid'))
  }
  const f = taskFixture()
  const result = await editProjectTask({
    taskId: 't1', userId: 'admin', expectedRevision: 2,
    body: {
      expected: { start: '2026-09-01', estimatedHours: 10, dependencies: ['t0'] },
      changes: { start: '2026-09-02', estimatedHours: null, dependencies: ['t2'] },
    },
  }, f.deps)
  assert.equal(result.etag, '"titra-project-task-revision-3"')
  assert.deepEqual(f.calls.validated, [['p1', ['t2'], 't1']])
  assert.deepEqual(f.calls.projectWriters, [{ projectId: 'p1', userId: 'admin', taskId: 't1' }])
  assert.equal(f.state.task.custom, 'preserved')
  assert.equal(Object.hasOwn(f.state.task, 'estimatedHours'), false)
})

test('known task validation and zero-match CAS resolve inside the project writer fence', async () => {
  for (const phase of ['dependencies', 'cas']) {
    const f = taskFixture()
    let operationRejected = false
    f.deps.withProjectWriter = async (_options, operation) => {
      try {
        return await operation()
      } catch (error) {
        operationRejected = true
        throw error
      }
    }
    if (phase === 'dependencies') {
      f.deps.validateDependencies = async () => {
        throw Object.assign(new Error('missing dependency'), { error: 'project-task-invalid' })
      }
    } else {
      f.deps.updateOne = async () => ({ matchedCount: 0 })
    }
    await assert.rejects(editProjectTask({
      taskId: 't1', userId: 'admin', expectedRevision: 2,
      body: { expected: { name: 'Plan' }, changes: { name: 'Changed' } },
    }, f.deps), failsWith(phase === 'dependencies'
      ? 'project-task-invalid' : 'project-task-write-conflict'))
    assert.equal(operationRejected, false)
  }
})

test('modern and legacy default-task representations block rename but allow a name no-op', async () => {
  for (const representation of ['task-flag', 'project-name']) {
    const f = taskFixture()
    if (representation === 'task-flag') f.state.task.isDefaultTask = true
    else f.state.project.defaultTask = f.state.task.name
    await assert.rejects(editProjectTask({
      taskId: 't1', userId: 'admin', expectedRevision: 2,
      body: { expected: { name: 'Plan' }, changes: { name: 'Renamed' } },
    }, f.deps), failsWith('project-task-default'))
    assert.equal(f.calls.writes.length, 0)

    const noOp = await editProjectTask({
      taskId: 't1', userId: 'admin', expectedRevision: 2,
      body: { expected: { name: 'Plan' }, changes: { name: 'Plan' } },
    }, f.deps)
    assert.equal(noOp.payload.changed, false)
    assert.equal(f.calls.writes.length, 0)
  }
})

test('default, dependency, history acknowledgments and CAS guard project task delete', async () => {
  for (const condition of ['default', 'dependent', 'recorded', 'cas']) {
    const f = taskFixture()
    if (condition === 'default') f.state.task.isDefaultTask = true
    if (condition === 'dependent') f.state.references.dependentTaskCount = 1
    if (condition === 'cas') f.deps.deleteOne = async () => ({ deletedCount: 0 })
    const expectedCode = condition === 'default' ? 'project-task-default'
      : condition === 'dependent' ? 'project-task-dependent'
        : condition === 'recorded' ? 'project-task-recorded' : 'project-task-write-conflict'
    await assert.rejects(deleteProjectTask({
      taskId: 't1', userId: 'owner', expectedName: 'Plan', expectedRevision: 2,
      acknowledgeRecordedEntries: condition !== 'recorded',
    }, f.deps), failsWith(expectedCode))
    assert.equal(f.calls.deletes.length, 0)
  }
  const f = taskFixture()
  const result = await deleteProjectTask({
    taskId: 't1', userId: 'owner', expectedName: 'Plan', expectedRevision: 2,
    acknowledgeRecordedEntries: true,
  }, f.deps)
  assert.equal(result.deleted, true)
})

function suggestionFixture(overrides = {}) {
  const state = {
    suggestion: {
      _id: 's1', userId: 'owner', name: 'Historical name',
      lastUsed: new Date('2026-09-01T01:02:03Z'), taskSuggestionRevision: 4,
      privateCustom: 'not serialized', ...overrides,
    },
    usage: { recordCount: 2, totalHours: 3.5, lastRecordedAt: '2026-08-01', projectCount: 2 },
  }
  const calls = { deletes: [] }
  const deps = {
    findSuggestion: async (selector) => (matches(state.suggestion, selector)
      ? structuredClone(state.suggestion) : undefined),
    getUsage: async () => structuredClone(state.usage),
    deleteOne: async (selector) => {
      calls.deletes.push(structuredClone(selector))
      if (!matches(state.suggestion, selector)) return { deletedCount: 0 }
      state.suggestion = null; return { deletedCount: 1 }
    },
  }
  return { state, calls, deps }
}

test('personal suggestion lifecycle accepts an explicit-null legacy projectId', async () => {
  const f = suggestionFixture({ projectId: null })
  const preview = await getTaskSuggestionPreview({ suggestionId: 's1', userId: 'owner' }, f.deps)
  assert.equal(preview.payload._id, 's1')
  const result = await deleteTaskSuggestion({
    suggestionId: 's1', userId: 'owner', expectedName: 'Historical name', expectedRevision: 4,
    acknowledgeReferencedRecords: true,
  }, f.deps)
  assert.equal(result.deleted, true)
})

test('personal suggestions are owner-only, narrow, referenced-name guarded and never touch records', async () => {
  const f = suggestionFixture()
  const preview = await getTaskSuggestionPreview({ suggestionId: 's1', userId: 'owner' }, f.deps)
  assert.equal(preview.etag, '"titra-task-suggestion-revision-4"')
  assert.equal(Object.hasOwn(preview.payload, 'privateCustom'), false)
  await assert.rejects(
    getTaskSuggestionPreview({ suggestionId: 's1', userId: 'other' }, f.deps),
    failsWith('not-authorized'),
  )
  await assert.rejects(deleteTaskSuggestion({
    suggestionId: 's1', userId: 'owner', expectedName: 'Historical name', expectedRevision: 4,
    acknowledgeReferencedRecords: false,
  }, f.deps), failsWith('task-suggestion-referenced'))
  const result = await deleteTaskSuggestion({
    suggestionId: 's1', userId: 'owner', expectedName: 'Historical name', expectedRevision: 4,
    acknowledgeReferencedRecords: true,
  }, f.deps)
  assert.equal(result.deleted, true)
  assert.equal(result.usage.recordCount, 2)
  assert.equal(f.calls.deletes.length, 1)
})

function httpFixture(path, method = 'GET') {
  const responses = []
  const req = {
    method, url: path, _parsedUrl: { pathname: path.split('?')[0] },
    headers: { 'content-type': 'application/json', 'if-match': '"titra-project-task-revision-2"' },
  }
  const res = { headers: {}, setHeader(key, value) { this.headers[key] = value } }
  const common = {
    authorize: async () => ({ _id: 'owner' }), readJson: async () => ({}),
    sendResponse: (_res, status, message, payload) => responses.push({ status, message, payload }),
  }
  return { req, res, common, responses }
}

test('task route handlers expose preview/list and enforce guarded writes', async () => {
  const get = httpFixture('/project/task/get/t1')
  await createProjectTaskGetHandler({
    ...get.common, previewTask: async () => ({ payload: { _id: 't1' }, etag: '"titra-project-task-revision-2"' }),
  })(get.req, get.res)
  assert.equal(get.responses[0].status, 200)

  const edit = httpFixture('/project/task/details/t1', 'PATCH')
  edit.common.readJson = async () => ({ expected: { name: 'Plan' }, changes: { name: 'New' } })
  await createProjectTaskDetailsHandler({
    ...edit.common, editTask: async () => ({ payload: { changed: true }, etag: '"titra-project-task-revision-3"' }),
  })(edit.req, edit.res)
  assert.equal(edit.responses[0].status, 200)

  const del = httpFixture('/project/task/delete/t1', 'DELETE')
  del.common.readJson = async () => ({ expectedName: 'Plan', acknowledgeRecordedEntries: true })
  await createProjectTaskDeleteHandler({
    ...del.common, deleteTask: async () => ({ taskId: 't1', deleted: true }),
  })(del.req, del.res)
  assert.equal(del.responses[0].status, 200)

  const list = httpFixture('/task-suggestions/?limit=25')
  await createTaskSuggestionListHandler({
    ...list.common,
    listSuggestions: async (args) => ({ items: [], complete: true, received: args }),
  })(list.req, list.res)
  assert.equal(list.responses[0].payload.received.limit, 25)

  for (const path of [
    '/task-suggestions/extra',
    '/task-suggestions/?unknown=1',
    '/task-suggestions/?limit=1&limit=2',
    `/task-suggestions/?cursor=${'x'.repeat(513)}`,
  ]) {
    const invalid = httpFixture(path)
    await createTaskSuggestionListHandler({
      ...invalid.common, listSuggestions: async () => ({ items: [] }),
    })(invalid.req, invalid.res)
    assert.ok([400, 404].includes(invalid.responses[0].status))
  }

  const failedList = httpFixture('/task-suggestions/?limit=25')
  await createTaskSuggestionListHandler({
    ...failedList.common,
    listSuggestions: async () => { throw new Error('database address and credentials') },
  })(failedList.req, failedList.res)
  assert.equal(failedList.responses[0].status, 500)
  assert.equal(failedList.responses[0].message.includes('credentials'), false)

  const malformedCursor = httpFixture('/task-suggestions/?cursor=not-a-real-cursor')
  await createTaskSuggestionListHandler({
    ...malformedCursor.common,
    listSuggestions: async () => {
      throw Object.assign(new Error('decoder internals'), { error: 'task-suggestion-invalid' })
    },
  })(malformedCursor.req, malformedCursor.res)
  assert.equal(malformedCursor.responses[0].status, 400)
  assert.equal(malformedCursor.responses[0].message, 'Invalid task suggestion request.')

  const sg = httpFixture('/task-suggestions/get/s1')
  await createTaskSuggestionGetHandler({
    ...sg.common, previewSuggestion: async () => ({ payload: { _id: 's1' }, etag: '"titra-task-suggestion-revision-4"' }),
  })(sg.req, sg.res)
  assert.equal(sg.responses[0].status, 200)

  const sd = httpFixture('/task-suggestions/delete/s1', 'DELETE')
  sd.req.headers['if-match'] = '"titra-task-suggestion-revision-4"'
  sd.common.readJson = async () => ({ expectedName: 'Name', acknowledgeReferencedRecords: false })
  await createTaskSuggestionDeleteHandler({
    ...sd.common, deleteSuggestion: async () => { throw Object.assign(new Error('secret'), { error: 'task-suggestion-referenced' }) },
  })(sd.req, sd.res)
  assert.equal(sd.responses[0].status, 409)
  assert.equal(sd.responses[0].message.includes('secret'), false)
})
