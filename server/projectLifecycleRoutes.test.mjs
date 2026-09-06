import assert from 'node:assert/strict'
import test from 'node:test'
import { isDeepStrictEqual } from 'node:util'

import {
  deleteEmptyOwnedProject,
  editProjectDetails,
  getProjectLifecyclePreview,
  projectSnapshotSelector,
  serializeProjectForCaller,
  setProjectArchived,
  validateProjectDetailsBody,
} from '../imports/api/projects/server/projectLifecycle.js'
import {
  createProjectArchiveHandler,
  createProjectDeleteHandler,
  createProjectDetailsHandler,
  createProjectGetHandler,
} from './projectLifecycleRoutes.js'

const failsWith = (code) => (error) => error.error === code

function matches(record, selector) {
  return Boolean(record) && Object.entries(selector).every(([field, condition]) => {
    if (condition && typeof condition === 'object' && !(condition instanceof Date)) {
      const exists = Object.prototype.hasOwnProperty.call(record, field)
      if ('$exists' in condition && exists !== condition.$exists) return false
      return !('$eq' in condition) || isDeepStrictEqual(record[field], condition.$eq)
    }
    return isDeepStrictEqual(record[field], condition)
  })
}

function fixture(overrides = {}) {
  const state = { project: {
    _id: 'p1', userId: 'owner', admins: ['admin'], team: ['member'], name: 'Alpha',
    desc: 'Old', color: '#009688', customer: 'ACME', rate: 100, budget: 40,
    startDate: new Date('2026-01-01T00:00:00Z'), endDate: new Date('2026-12-31T00:00:00Z'),
    public: true, notbillable: false, archived: false, projectRevision: 3,
    rates: { member: 90 }, secretIntegrationToken: 'never-return', ...overrides,
  } }
  const calls = { writes: [], deletes: [] }
  const deps = {
    findProject: async (selector) => (matches(state.project, selector)
      ? structuredClone(state.project) : undefined),
    updateOne: async (selector, modifier) => {
      calls.writes.push({ selector: structuredClone(selector), modifier: structuredClone(modifier) })
      if (!matches(state.project, selector)) return { matchedCount: 0 }
      Object.assign(state.project, modifier.$set)
      Object.keys(modifier.$unset || {}).forEach((field) => delete state.project[field])
      state.project.projectRevision = (state.project.projectRevision ?? 0) + 1
      return { matchedCount: 1 }
    },
    deleteEmptyProject: async (selector) => {
      calls.deletes.push(structuredClone(selector))
      if (!matches(state.project, selector)) return { status: 'conflict' }
      state.project = null
      return { status: 'deleted' }
    },
  }
  return { state, calls, deps }
}

test('public preview is deliberately narrow while members receive access metadata', async () => {
  const f = fixture()
  const publicView = serializeProjectForCaller(f.state.project, 'viewer')
  assert.equal(Object.hasOwn(publicView, 'role'), false)
  for (const hidden of [
    'userId', 'team', 'admins', 'rate', 'rates', 'customer', 'budget', 'secretIntegrationToken',
  ]) {
    assert.equal(Object.hasOwn(publicView, hidden), false)
  }
  const member = await getProjectLifecyclePreview(
    { projectId: 'p1', userId: 'member' }, f.deps,
  )
  assert.deepEqual(member.payload.team, ['member'])
  assert.equal(member.etag, '"titra-project-revision-3"')
  const privateProject = fixture({ public: false })
  await assert.rejects(
    getProjectLifecyclePreview({ projectId: 'p1', userId: 'viewer' }, privateProject.deps),
    failsWith('not-authorized'),
  )
})

test('legacy Quill descriptions serialize as editable plain text', async () => {
  const legacy = fixture({
    desc: { ops: [{ insert: 'First\n' }, { insert: { image: 'ignored' } }, { insert: 'Second' }] },
  })
  const preview = await getProjectLifecyclePreview(
    { projectId: 'p1', userId: 'owner' }, legacy.deps,
  )
  assert.equal(preview.payload.description, 'First\nSecond')
  const result = await editProjectDetails({
    projectId: 'p1', userId: 'owner', expectedRevision: 3,
    body: {
      expected: { description: 'First\nSecond' },
      changes: { description: 'Updated' },
    },
  }, legacy.deps)
  assert.equal(result.payload.current.description, 'Updated')
  assert.equal(legacy.state.project.desc, 'Updated')
  assert.equal(legacy.state.project.description, 'Updated')
})

test('project details schema rejects arbitrary privilege and integration fields', () => {
  validateProjectDetailsBody({ expected: { rate: 100 }, changes: { rate: null } })
  for (const field of ['userId', 'admins', 'team', 'rates', 'defaultTask', 'priority', 'token', '$set']) {
    assert.throws(() => validateProjectDetailsBody({
      expected: { [field]: null }, changes: { [field]: 'attacker' },
    }), failsWith('project-invalid'))
  }
  assert.throws(() => validateProjectDetailsBody({
    expected: { name: 'Alpha' }, changes: { name: ' ' },
  }), failsWith('project-invalid'))
})

test('administrator can atomically edit allowed fields with dates and null unsets', async () => {
  const f = fixture()
  const result = await editProjectDetails({
    projectId: 'p1', userId: 'admin', expectedRevision: 3,
    body: {
      expected: { name: 'Alpha', description: 'Old', rate: 100, startDate: '2026-01-01' },
      changes: { name: 'Beta', description: null, rate: null, startDate: '2026-02-01' },
    },
  }, f.deps)
  assert.equal(f.state.project.name, 'Beta')
  assert.equal(Object.hasOwn(f.state.project, 'desc'), false)
  assert.equal(Object.hasOwn(f.state.project, 'rate'), false)
  assert.equal(f.state.project.startDate.toISOString(), '2026-02-01T00:00:00.000Z')
  assert.equal(f.state.project.projectRevision, 4)
  assert.equal(result.etag, '"titra-project-revision-4"')
  assert.equal(f.state.project.secretIntegrationToken, 'never-return')
})

test('team/public users cannot mutate; expected fields, revisions and CAS are enforced', async () => {
  for (const userId of ['member', 'viewer']) {
    const f = fixture()
    await assert.rejects(editProjectDetails({
      projectId: 'p1', userId, expectedRevision: 3,
      body: { expected: { name: 'Alpha' }, changes: { name: 'Beta' } },
    }, f.deps), failsWith('not-authorized'))
  }
  for (const stale of ['revision', 'value', 'cas']) {
    const f = fixture()
    if (stale === 'cas') f.deps.updateOne = async () => ({ matchedCount: 0 })
    await assert.rejects(editProjectDetails({
      projectId: 'p1', userId: 'owner', expectedRevision: stale === 'revision' ? 2 : 3,
      body: { expected: { name: stale === 'value' ? 'Wrong' : 'Alpha' }, changes: { name: 'Beta' } },
    }, f.deps), failsWith('project-write-conflict'))
  }
})

test('archive is admin-reversible and conditional', async () => {
  const f = fixture()
  const archived = await setProjectArchived({
    projectId: 'p1', userId: 'admin', archived: true, expectedArchived: false, expectedRevision: 3,
  }, f.deps)
  assert.equal(archived.payload.archived, true)
  assert.equal(archived.etag, '"titra-project-revision-4"')
  await assert.rejects(setProjectArchived({
    projectId: 'p1', userId: 'admin', archived: false, expectedArchived: true, expectedRevision: 3,
  }, f.deps), failsWith('project-write-conflict'))
})

test('hard delete is owner-only, exact-name/revision guarded, and delegates fenced empty check', async () => {
  const f = fixture()
  await assert.rejects(deleteEmptyOwnedProject({
    projectId: 'p1', userId: 'admin', expectedName: 'Alpha', expectedRevision: 3,
  }, f.deps), failsWith('not-authorized'))
  f.deps.deleteEmptyProject = async () => ({ status: 'not-empty' })
  await assert.rejects(deleteEmptyOwnedProject({
    projectId: 'p1', userId: 'owner', expectedName: 'Alpha', expectedRevision: 3,
  }, f.deps), failsWith('project-not-empty'))
  const ok = fixture()
  assert.deepEqual(await deleteEmptyOwnedProject({
    projectId: 'p1', userId: 'owner', expectedName: 'Alpha', expectedRevision: 3,
  }, ok.deps), { projectId: 'p1', deleted: true, counts: { timecards: 0, projectTasks: 0 } })
  assert.equal(ok.calls.deletes.length, 1)
  assert.deepEqual(ok.calls.deletes[0], projectSnapshotSelector(fixture().state.project))
})

function httpFixture() {
  const responses = []
  const req = {
    method: 'PATCH', _parsedUrl: { pathname: '/project/details/p1/' },
    headers: { 'if-match': '"titra-project-revision-3"', 'content-type': 'application/json' },
  }
  const res = { headers: {}, setHeader(key, value) { this.headers[key] = value } }
  const common = {
    authorize: async () => ({ _id: 'owner' }),
    readJson: async () => ({ expected: { name: 'Alpha' }, changes: { name: 'Beta' } }),
    sendResponse: (_res, status, message, payload) => responses.push({ status, message, payload }),
  }
  return { req, res, responses, common }
}

test('project route handlers enforce methods/preconditions and keep errors sanitized', async () => {
  const details = httpFixture()
  await createProjectDetailsHandler({
    ...details.common,
    editProject: async () => ({ payload: { changed: true }, etag: '"titra-project-revision-4"' }),
  })(details.req, details.res)
  assert.equal(details.responses[0].status, 200)
  assert.equal(details.res.headers.ETag, '"titra-project-revision-4"')

  const get = httpFixture(); get.req.method = 'GET'; get.req._parsedUrl.pathname = '/project/get/p1/'
  await createProjectGetHandler({
    ...get.common, previewProject: async () => ({ payload: { _id: 'p1' }, etag: '"titra-project-revision-3"' }),
  })(get.req, get.res)
  assert.equal(get.responses[0].status, 200)

  const archive = httpFixture(); archive.req._parsedUrl.pathname = '/project/archive/p1/'
  archive.common.readJson = async () => ({ archived: true, expectedArchived: false })
  await createProjectArchiveHandler({
    ...archive.common,
    archiveProject: async () => { throw Object.assign(new Error('secret'), { error: 'project-write-conflict' }) },
  })(archive.req, archive.res)
  assert.equal(archive.responses[0].status, 409)
  assert.equal(archive.responses[0].message.includes('secret'), false)

  const deletion = httpFixture(); deletion.req.method = 'DELETE'; deletion.req._parsedUrl.pathname = '/project/delete/p1/'
  deletion.common.readJson = async () => ({ expectedName: 'Alpha' })
  await createProjectDeleteHandler({
    ...deletion.common, deleteProject: async () => ({ projectId: 'p1', deleted: true }),
  })(deletion.req, deletion.res)
  assert.equal(deletion.responses[0].status, 200)
})
