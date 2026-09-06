import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { isDeepStrictEqual } from 'node:util'
import vm from 'node:vm'
import test from 'node:test'

import {
  IdempotencyError,
  executeIdempotentCreate,
  validateIdempotencyKey,
} from './apiIdempotency.js'

function moduleUrl(path, replacements = {}) {
  let source = readFileSync(new URL(path, import.meta.url), 'utf8')
  Object.entries(replacements).forEach(([specifier, replacement]) => {
    source = source.replaceAll(`'${specifier}'`, JSON.stringify(replacement))
  })
  return `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
}

const revisionUrl = moduleUrl('../imports/utils/timecardRevision.js')
const tokenSecurityUrl = new URL('./apiTokenSecurity.js', import.meta.url).href
const publicationAuthenticationUrl = new URL(
  '../imports/utils/publicationAuthentication.js', import.meta.url,
).href
const helperUrl = moduleUrl('./APIrouteHelpers.js', {
  './apiTokenSecurity.js': tokenSecurityUrl,
  '../imports/utils/publicationAuthentication.js': publicationAuthenticationUrl,
})
const editUrl = moduleUrl('../imports/api/timecards/server/taskEdit.js', {
  '../../../utils/timecardRevision.js': revisionUrl,
})
const routeUrl = moduleUrl('./timeentryTaskRoute.js', {
  './APIrouteHelpers.js': helperUrl,
  '../imports/utils/timecardRevision.js': revisionUrl,
  '../imports/api/timecards/server/taskEdit.js': editUrl,
})
const { editOwnedTimecardTask, validateTimecardTaskEditBody } = await import(editUrl)
const { createCapabilitiesHandler, createTimeentryTaskHandler } = await import(routeUrl)
const routeHelpers = await import(helperUrl)
const revisionHelpers = await import(revisionUrl)
const dateHelpers = await import(moduleUrl('../imports/utils/timecardDate.js'))

function matches(record, selector) {
  return Boolean(record) && Object.entries(selector).every(([field, condition]) => {
    if (condition && typeof condition === 'object' && !(condition instanceof Date)) {
      const exists = Object.prototype.hasOwnProperty.call(record, field)
      if (Object.prototype.hasOwnProperty.call(condition, '$exists')
        && exists !== condition.$exists) return false
      return !Object.prototype.hasOwnProperty.call(condition, '$eq')
        || isDeepStrictEqual(record[field], condition.$eq)
    }
    return isDeepStrictEqual(record[field], condition)
  })
}

function fixture(overrides = {}) {
  const record = {
    _id: 'entry-1',
    userId: 'owner-1',
    projectId: 'project-1',
    task: 'Old task',
    date: new Date('2026-07-02T00:00:00.000Z'),
    dateOnly: '2026-07-02',
    startTime: '09:13',
    dateRevision: 7,
    hours: 1.235,
    taskRate: 110,
    state: 'billed',
    arbitraryCustomfield: { nested: ['unchanged', 42] },
    createdAt: new Date('2026-08-31T10:00:00.000Z'),
    ...overrides,
  }
  const calls = {
    reads: [], writes: [], rules: [], unlocked: 0, leases: 0, renews: 0,
    projects: 0, projectWriters: 0,
  }
  const state = { record, access: true }
  const deps = {
    findTimecard: async (selector) => {
      calls.reads.push(structuredClone(selector))
      return matches(state.record, selector) ? structuredClone(state.record) : undefined
    },
    canAccessProject: async (projectId, userId) => {
      calls.projects += 1
      assert.equal(projectId, 'project-1')
      assert.equal(userId, 'owner-1')
      return state.access
    },
    checkRule: async (candidate) => {
      calls.rules.push(structuredClone(candidate))
      await state.ruleHook?.()
    },
    assertUnlocked: async () => {
      calls.unlocked += 1
      await state.unlockHook?.(calls.unlocked)
    },
    withWriteLease: async (callback) => {
      calls.leases += 1
      await state.leaseHook?.()
      return callback(async () => {
        calls.renews += 1
        await state.renewHook?.()
      })
    },
    withProjectWriter: async (_options, write) => {
      calls.projectWriters += 1
      return write()
    },
    updateOne: async (selector, modifier) => {
      calls.writes.push(structuredClone({ selector, modifier }))
      await state.updateHook?.()
      if (!matches(state.record, selector)) return { matchedCount: 0, modifiedCount: 0 }
      Object.assign(state.record, modifier.$set)
      state.record.dateRevision = (state.record.dateRevision ?? 0) + modifier.$inc.dateRevision
      return { matchedCount: 1, modifiedCount: 1 }
    },
  }
  const args = {
    timecardId: record._id,
    userId: record.userId,
    task: 'New task',
    expectedTask: record.task,
    expectedDateRevision: record.dateRevision,
  }
  return { state, calls, deps, args }
}

const failsWith = (code) => (error) => error.error === code

test('task body accepts exact Unicode strings and rejects missing/extra/unsafe fields', () => {
  for (const body of [
    null, undefined, false, 42, 'task', [], {}, { task: 'new' },
    { expectedTask: 'old' }, { task: 1, expectedTask: 'old' },
    { task: 'new', expectedTask: null }, { task: 'new', expectedTask: {} },
    { task: '', expectedTask: 'old' }, { task: ' \t\n\u2003', expectedTask: '' },
    { task: 'new', expectedTask: 'old', hours: 3 },
    { task: 'new', expectedTask: 'old', userId: 'other' },
    { task: 'new', expectedTask: 'old', $set: { hours: 3 } },
    { task: '\ud800', expectedTask: 'old' },
    { task: 'new', expectedTask: '\udfff' },
    { task: 'a\ud800b', expectedTask: 'old' },
    JSON.parse('{"task":"new","expectedTask":"old","__proto__":{}}'),
    Object.assign(Object.create({ inherited: true }), { task: 'new', expectedTask: 'old' }),
  ]) {
    assert.throws(() => validateTimecardTaskEditBody(body), failsWith('timecard-task-invalid'))
  }
  validateTimecardTaskEditBody({ task: '😀'.repeat(1000), expectedTask: '' })
  assert.throws(
    () => validateTimecardTaskEditBody({ task: '😀'.repeat(1001), expectedTask: '' }),
    failsWith('timecard-task-invalid'),
  )
  validateTimecardTaskEditBody({ task: '  :smile: e\u0301\n终  ', expectedTask: ' old ' })
})

test('modern edit writes only exact task and revision; preserves dates, rates, state and custom fields', async () => {
  const { state, calls, deps, args } = fixture()
  const before = structuredClone(state.record)
  args.task = '  :smile: 😀 e\u0301\n终  '
  const result = await editOwnedTimecardTask(args, deps)
  assert.deepEqual(state.record, { ...before, task: args.task, dateRevision: 8 })
  assert.deepEqual(result, {
    payload: { timecardId: 'entry-1', task: args.task, previousTask: 'Old task', changed: true },
    etag: '"titra-date-revision-8"',
  })
  assert.deepEqual(calls.rules, [{ ...before, task: args.task }])
  assert.deepEqual(calls.writes[0].modifier, { $set: { task: args.task }, $inc: { dateRevision: 1 } })
  assert.equal(calls.writes.length, 1)
  assert.equal(calls.leases, 1)
  assert.equal(calls.renews, 1)
  assert.equal(calls.projects, 2)
  assert.equal(calls.projectWriters, 1)
})

test('legacy edit leaves combined timestamp/date shape untouched and starts revision at one', async () => {
  const f = fixture({ date: new Date('2026-07-01T23:12:34.567Z') })
  delete f.state.record.dateOnly
  delete f.state.record.startTime
  delete f.state.record.dateRevision
  f.args.expectedDateRevision = null
  const before = structuredClone(f.state.record)
  const result = await editOwnedTimecardTask(f.args, f.deps)
  assert.deepEqual(f.state.record, { ...before, task: 'New task', dateRevision: 1 })
  assert.equal(result.etag, '"titra-date-revision-1"')
  assert.deepEqual(f.calls.writes[0].selector.dateRevision, { $exists: false })
  assert.deepEqual(f.calls.rules[0], { ...before, task: 'New task' })
})

test('modern and legacy no-ops check rules/leases/preconditions but perform no writes', async () => {
  for (const legacy of [false, true]) {
    const f = fixture()
    if (legacy) delete f.state.record.dateRevision
    f.args.expectedDateRevision = legacy ? null : 7
    f.args.task = f.args.expectedTask
    const before = structuredClone(f.state.record)
    const result = await editOwnedTimecardTask(f.args, f.deps)
    assert.equal(result.payload.changed, false)
    assert.equal(result.etag, legacy ? '"titra-date-revision-legacy"' : '"titra-date-revision-7"')
    assert.deepEqual(f.state.record, before)
    assert.equal(f.calls.writes.length, 0)
    assert.equal(f.calls.rules.length, 1)
    assert.equal(f.calls.leases, 1)
    assert.equal(f.calls.reads.length, 2)
  }
})

test('empty old task can be renamed, but missing task never masquerades as empty', async () => {
  const f = fixture({ task: '' })
  assert.equal((await editOwnedTimecardTask(f.args, f.deps)).payload.previousTask, '')
  const missing = fixture()
  delete missing.state.record.task
  missing.args.expectedTask = ''
  await assert.rejects(editOwnedTimecardTask(missing.args, missing.deps), failsWith('timecard-write-conflict'))
})

test('ownership and retained project access are mandatory before any write', async () => {
  for (const condition of ['missing', 'different-owner', 'project-access', 'revoked-under-lease']) {
    const f = fixture()
    if (condition === 'missing') f.state.record = null
    if (condition === 'different-owner') f.state.record.userId = 'different'
    if (condition === 'project-access') f.state.access = false
    if (condition === 'revoked-under-lease') f.state.leaseHook = () => { f.state.access = false }
    await assert.rejects(editOwnedTimecardTask(f.args, f.deps), failsWith('not-authorized'))
    assert.equal(f.calls.writes.length, 0)
  }
})

test('stale revision/old task fail even for a requested no-op; old strings compare exactly', async () => {
  for (const overrides of [
    { expectedDateRevision: 0 }, { expectedDateRevision: null },
    { expectedTask: 'old task' }, { expectedTask: 'Old task ' },
    { task: 'Old task', expectedDateRevision: 6 },
  ]) {
    const f = fixture()
    await assert.rejects(editOwnedTimecardTask({ ...f.args, ...overrides }, f.deps), failsWith('timecard-write-conflict'))
    assert.equal(f.calls.writes.length, 0)
    assert.equal(f.calls.rules.length, 0)
  }
})

test('invalid preconditions cannot bypass required revision or ID validation', async () => {
  for (const value of [undefined, -1, '7', NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    const f = fixture()
    await assert.rejects(editOwnedTimecardTask({ ...f.args, expectedDateRevision: value }, f.deps), failsWith('timecard-task-invalid'))
    assert.equal(f.calls.reads.length, 0)
  }
  for (const overrides of [{ userId: '' }, { timecardId: '' }, { timecardId: { $ne: '' } }]) {
    const f = fixture()
    await assert.rejects(editOwnedTimecardTask({ ...f.args, ...overrides }, f.deps), failsWith('timecard-task-invalid'))
  }
})

test('compare-and-swap rejects concurrent changes to rule inputs, ownership and legacy date shape', async () => {
  const changes = {
    userId: 'other', projectId: 'other', task: 'Concurrent', dateRevision: 8,
    date: new Date('2026-07-03T00:00:00Z'), dateOnly: '2026-07-03',
    startTime: '11:42', hours: 9, state: 'new', taskRate: 25,
  }
  for (const [field, value] of Object.entries(changes)) {
    const f = fixture()
    f.state.updateHook = () => { f.state.record[field] = value }
    await assert.rejects(editOwnedTimecardTask(f.args, f.deps), failsWith('timecard-write-conflict'))
    assert.equal(f.state.record.task, field === 'task' ? value : 'Old task')
  }
  const f = fixture()
  delete f.state.record.startTime
  f.state.updateHook = () => { f.state.record.startTime = null }
  await assert.rejects(editOwnedTimecardTask(f.args, f.deps), failsWith('timecard-write-conflict'))
})

test('concurrent custom-field changes are preserved, not replaced by the preview snapshot', async () => {
  const f = fixture()
  f.state.updateHook = () => { f.state.record.arbitraryCustomfield = { newer: true } }
  await editOwnedTimecardTask(f.args, f.deps)
  assert.deepEqual(f.state.record.arbitraryCustomfield, { newer: true })
})

test('concurrent edits cannot both succeed from the same snapshot', async () => {
  const f = fixture()
  const results = await Promise.allSettled([
    editOwnedTimecardTask(f.args, f.deps),
    editOwnedTimecardTask({ ...f.args, task: 'Competing rename' }, f.deps),
  ])
  assert.equal(results.filter((item) => item.status === 'fulfilled').length, 1)
  assert.equal(results.find((item) => item.status === 'rejected').reason.error, 'timecard-write-conflict')
  assert.equal(f.state.record.dateRevision, 8)
})

test('no-op snapshot check detects changes during rule evaluation', async () => {
  const f = fixture()
  f.args.task = f.args.expectedTask
  f.state.ruleHook = () => { f.state.record.hours = 4 }
  await assert.rejects(editOwnedTimecardTask(f.args, f.deps), failsWith('timecard-write-conflict'))
  assert.equal(f.calls.writes.length, 0)
})

test('rule failures block changed and unchanged tasks without any write', async () => {
  for (const noop of [false, true]) {
    const f = fixture()
    if (noop) f.args.task = f.args.expectedTask
    f.state.ruleHook = () => {
      throw Object.assign(new Error('private rule details'), { error: 'timecard-rule-blocked' })
    }
    await assert.rejects(editOwnedTimecardTask(f.args, f.deps), failsWith('timecard-rule-blocked'))
    assert.equal(f.calls.writes.length, 0)
    assert.equal(f.calls.leases, 0)
  }
})

test('migration preflight, post-rule lock, acquisition and lease renewal all fence writes', async () => {
  const locked = () => { throw Object.assign(new Error('locked'), { error: 'notifications.timecard_migration_locked' }) }
  for (const phase of ['initial', 'post-rule', 'acquire', 'renew']) {
    const f = fixture()
    if (phase === 'initial') f.state.unlockHook = locked
    if (phase === 'post-rule') f.state.unlockHook = (count) => { if (count === 2) locked() }
    if (phase === 'acquire') f.state.leaseHook = locked
    if (phase === 'renew') f.state.renewHook = locked
    await assert.rejects(editOwnedTimecardTask(f.args, f.deps), failsWith('notifications.timecard_migration_locked'))
    assert.equal(f.calls.writes.length, 0)
  }
})

test('revision overflow is refused, with a guarded no-op still allowed', async () => {
  const f = fixture({ dateRevision: Number.MAX_SAFE_INTEGER })
  await assert.rejects(editOwnedTimecardTask(f.args, f.deps), failsWith('timecard-write-conflict'))
  assert.equal(f.calls.writes.length, 0)
  f.args.task = f.args.expectedTask
  const result = await editOwnedTimecardTask(f.args, f.deps)
  assert.equal(result.etag, `"titra-date-revision-${Number.MAX_SAFE_INTEGER}"`)
  assert.equal(f.calls.writes.length, 0)
})

function httpFixture() {
  const calls = { auth: 0, reads: 0, edits: [], responses: [] }
  const req = {
    method: 'PATCH',
    _parsedUrl: { pathname: '/timeentry/task/entry-1/' },
    headers: { 'if-match': '"titra-date-revision-7"', 'content-type': 'application/json' },
    rawBody: '{"task":"New task","expectedTask":"Old task"}',
  }
  const res = { headers: {}, setHeader(key, value) { this.headers[key] = value } }
  const deps = {
    authorize: async () => { calls.auth += 1; return { _id: 'owner-1' } },
    readJson: async (request, options) => {
      calls.reads += 1
      assert.equal(options.limit, '64kb')
      return JSON.parse(request.rawBody)
    },
    editTask: async (...args) => {
      calls.edits.push(args)
      return {
        payload: { timecardId: args[0], task: args[2], previousTask: args[3], changed: true },
        etag: '"titra-date-revision-8"',
      }
    },
    sendResponse: (response, status, message, payload) => { calls.responses.push({ status, message, payload }) },
  }
  return { req, res, calls, deps }
}

test('PATCH handler forwards only parsed allowed fields and returns next ETag', async () => {
  const f = httpFixture()
  await createTimeentryTaskHandler(f.deps)(f.req, f.res)
  assert.deepEqual(f.calls.edits, [['entry-1', 'owner-1', 'New task', 'Old task', 7]])
  assert.equal(f.calls.responses.length, 1)
  assert.equal(f.calls.responses[0].status, 200)
  assert.equal(f.res.headers.ETag, '"titra-date-revision-8"')
})

test('PATCH preflight is unauthenticated and wrong methods cannot edit', async () => {
  for (const method of ['OPTIONS', 'GET', 'POST', 'PUT', 'DELETE', 'HEAD']) {
    const f = httpFixture()
    f.req.method = method
    await createTimeentryTaskHandler(f.deps)(f.req, f.res)
    assert.equal(f.calls.responses[0].status, method === 'OPTIONS' ? 204 : 405)
    assert.equal(f.res.headers.Allow, 'PATCH, OPTIONS')
    assert.equal(f.calls.auth, 0)
    assert.equal(f.calls.edits.length, 0)
  }
})

test('PATCH missing/bad preconditions, content types, paths and JSON terminate once without editing', async () => {
  const modifications = [
    [428, (f) => { delete f.req.headers['if-match'] }],
    [400, (f) => { f.req.headers['if-match'] = '*' }],
    [400, (f) => { f.req.headers['if-match'] = 'W/"titra-date-revision-7"' }],
    [400, (f) => { f.req.headers['if-match'] = ['"titra-date-revision-7"'] }],
    [415, (f) => { f.req.headers['content-type'] = 'text/plain' }],
    [415, (f) => { delete f.req.headers['content-type'] }],
    [400, (f) => { f.req._parsedUrl.pathname = '/timeentry/task/one/two' }],
    [400, (f) => { f.req._parsedUrl.pathname = '/timeentry/task/%E0%A4%A' }],
    [400, (f) => { f.req.rawBody = '{' }],
    [400, (f) => { f.req.rawBody = 'null' }],
    [400, (f) => { f.req.rawBody = '[]' }],
    [400, (f) => { f.req.rawBody = '{"task":"new","expectedTask":"old","hours":50}' }],
    [413, (f) => {
      f.deps.readJson = async () => {
        throw Object.assign(new Error('request entity too large'), { type: 'entity.too.large' })
      }
    }],
  ]
  for (const [status, modify] of modifications) {
    const f = httpFixture()
    modify(f)
    await createTimeentryTaskHandler(f.deps)(f.req, f.res)
    assert.equal(f.calls.responses.length, 1)
    assert.equal(f.calls.responses[0].status, status)
    assert.equal(f.calls.edits.length, 0)
  }
})

test('PATCH maps expected errors and conceals unknown internal failure details', async () => {
  for (const [code, status] of Object.entries({
    'timecard-task-invalid': 400, 'not-authorized': 404, 'timecard-write-conflict': 409,
    'notifications.timecard_migration_locked': 503, 'timecard-rule-blocked': 422,
    'unexpected-database-error': 500,
  })) {
    const f = httpFixture()
    f.deps.editTask = async () => { throw Object.assign(new Error('private Mongo connection secret'), { error: code }) }
    await createTimeentryTaskHandler(f.deps)(f.req, f.res)
    assert.equal(f.calls.responses.length, 1)
    assert.equal(f.calls.responses[0].status, status)
    assert.doesNotMatch(f.calls.responses[0].message, /private|secret|Mongo/)
    assert.equal(f.res.headers.ETag, undefined)
  }
})

test('PATCH no-op returns unchanged payload/ETag and denied auth stops before body access', async () => {
  const f = httpFixture()
  f.deps.editTask = async () => ({ payload: { changed: false }, etag: '"titra-date-revision-7"' })
  await createTimeentryTaskHandler(f.deps)(f.req, f.res)
  assert.equal(f.calls.responses[0].payload.changed, false)
  assert.equal(f.res.headers.ETag, '"titra-date-revision-7"')
  const denied = httpFixture()
  denied.deps.authorize = async () => false
  await createTimeentryTaskHandler(denied.deps)(denied.req, denied.res)
  assert.equal(denied.calls.reads, 0)
  assert.equal(denied.calls.edits.length, 0)
})

test('capabilities returns exact authenticated contract and strict route with working preflight', async () => {
  const f = httpFixture()
  f.req.method = 'GET'
  f.req._parsedUrl.pathname = '/capabilities/'
  await createCapabilitiesHandler(f.deps)(f.req, f.res)
  assert.equal(f.calls.auth, 1)
  assert.deepEqual(f.calls.responses[0].payload, {
    apiVersion: 1,
    features: {
      timeEntryTaskUpdate: true,
      idempotentCreate: true,
      timeEntryPagination: true,
    },
    taskUpdate: { requiresIfMatch: true, requiresExpectedTask: true, maxTaskLength: 1000, preservesOtherFields: true },
    idempotency: {
      version: 1,
      header: 'Idempotency-Key',
      minKeyLength: 16,
      maxKeyLength: 128,
      retentionSeconds: 604800,
      operations: ['timeentry.create', 'project.create', 'project-task.create'],
    },
    timeEntryPagination: {
      version: 1,
      defaultLimit: 200,
      maxLimit: 500,
      consistency: 'live-keyset',
      ownerPath: 'timeentry/daterange-page',
      projectPath: 'project/timeentriesfordaterange-page',
    },
  })
  for (const [pathname, method, status] of [
    ['/capabilities', 'OPTIONS', 204], ['/capabilities/', 'POST', 405],
    ['/capabilities/extra', 'GET', 404], ['/capabilities//', 'GET', 404],
  ]) {
    const candidate = httpFixture()
    candidate.req._parsedUrl.pathname = pathname
    candidate.req.method = method
    await createCapabilitiesHandler(candidate.deps)(candidate.req, candidate.res)
    assert.equal(candidate.calls.responses[0].status, status)
    assert.equal(candidate.calls.auth, 0)
  }
})

test('authorization accepts only explicit single Bearer/Token credentials and active users', async () => {
  const queries = []
  let user = { _id: 'owner-1', profile: { APItoken: 'abc' } }
  const find = async (query) => {
    queries.push(query)
    return Object.hasOwn(query, 'profile.APItoken') ? user : null
  }
  for (const header of ['Bearer abc', 'Token abc', 'bearer abc', 'TOKEN\tabc']) {
    assert.equal(await routeHelpers.authenticatedAPIUser(header, find), user)
    assert.deepEqual(queries.at(-1), { 'profile.APItoken': 'abc', inactive: { $ne: true } })
  }
  queries.length = 0
  for (const header of [undefined, null, [], 'abc', 'Whatever abc', 'Basic abc', 'Bearer', 'Bearer ', 'Bearer abc def', 'Bearer abc,def', ' Bearer abc', 'Bearer abc\n']) {
    assert.equal(await routeHelpers.authenticatedAPIUser(header, find), false)
  }
  assert.equal(queries.length, 0)
  for (const inactive of [true, 'true', 1]) {
    user = { _id: 'owner-1', inactive, profile: { APItoken: 'abc' } }
    assert.equal(await routeHelpers.authenticatedAPIUser('Bearer abc', find), false)
  }
  user = undefined
  assert.equal(await routeHelpers.authenticatedAPIUser('Bearer unknown', find), false)
})

// Execute the real API registration/handler code with only Meteor imports replaced
// by explicit fixtures. This catches terminal-response and wiring regressions,
// rather than asserting that particular source-code strings are present.
function registeredRoutes() {
  const handlers = new Map()
  const calls = {
    inserts: [], ruleInputs: [], projectReads: 0, dependencyReads: 0,
    timecardRecoveries: 0, taskRecoveries: 0,
  }
  const state = {
    user: { _id: 'owner-1', profile: { APItoken: 'test-token' } },
    ruleAllowed: true,
    projectAccessible: true,
    projectAdmin: true,
    dependenciesAvailable: true,
    receipts: new Map(),
    timecards: new Map(),
    projectTasks: new Map(),
    projects: new Map(),
  }
  const idempotencyStore = {
    async reserve(document) {
      if (state.receipts.has(document._id)) return false
      state.receipts.set(document._id, structuredClone(document))
      return true
    },
    async find(documentId) {
      const value = state.receipts.get(documentId)
      return value ? structuredClone(value) : null
    },
    async complete(documentId, fingerprint, result, now, replayExpiresAt, expiresAt) {
      if (state.failCompletionOnce) {
        state.failCompletionOnce = false
        throw new Error('simulated lost completion acknowledgement')
      }
      const value = state.receipts.get(documentId)
      if (!value || value.status !== 'reserved' || value.fingerprint !== fingerprint) {
        return value ? structuredClone(value) : null
      }
      Object.assign(value, {
        status: 'completed', result: structuredClone(result), updatedAt: now,
        replayExpiresAt, expiresAt,
      })
      return structuredClone(value)
    },
  }
  const fakeCheck = (value, pattern) => {
    if (pattern?.optional && value == null) return
    const type = pattern?.optional || pattern
    if (type === String && typeof value !== 'string') throw new Error('expected string')
    if (type === Number && typeof value !== 'number') throw new Error('expected number')
    if (type === Date && (!(value instanceof Date) || Number.isNaN(value.getTime()))) throw new Error('expected date')
    if (type?.where && !type.where(value)) throw new Error('invalid value')
  }
  const context = {
    ...routeHelpers, ...revisionHelpers, ...dateHelpers,
    createCapabilitiesHandler, createTimeentryTaskHandler,
    createAPIv2CapabilitiesHandler: () => async () => {},
    createTimeentryDetailsHandler: () => async () => {},
    createProjectGetHandler: () => async () => {},
    createProjectDetailsHandler: () => async () => {},
    createProjectArchiveHandler: () => async () => {},
    createProjectDeleteHandler: () => async () => {},
    createProjectFenceRecoveryHandler: () => async () => {},
    createProjectTaskGetHandler: () => async () => {},
    createProjectTaskDetailsHandler: () => async () => {},
    createProjectTaskDeleteHandler: () => async () => {},
    createTaskSuggestionGetHandler: () => async () => {},
    createTaskSuggestionDeleteHandler: () => async () => {},
    createTaskSuggestionListHandler: () => async () => {},
    createTimerStartHandler: () => async () => {},
    createTimerGetHandler: () => async () => {},
    createTimerStopHandler: () => async () => {},
    WEBHOOK_PATH: '/user/action-verification/webhook',
    webhookVerificationHandler: async () => {},
    Match: { Maybe: (pattern) => ({ optional: pattern }), Where: (predicate) => ({ where: predicate }) },
    check: fakeCheck, Date, String, Number, Object, console,
    IdempotencyError,
    validateIdempotencyKey,
    executeIdempotentCreate: (options) => executeIdempotentCreate({
      ...options,
      normalizedRequest: structuredClone(options.normalizedRequest),
    }),
    createMongoIdempotencyStore: () => idempotencyStore,
    ApiIdempotency: {},
    API_TOKEN_HASH_VERSION: 1,
    createAPIRateLimits: () => ({
      consumePeer: () => ({ allowed: true }),
      consumeUser: () => ({ allowed: true }),
    }),
    currentProjectAudienceClauses: async (userId) => [
      { userId }, { admins: userId }, { team: userId }, { public: true },
    ],
    WebApp: { handlers: { use: (path, callback) => handlers.set(path, callback) } },
    Meteor: {
      users: {
        findOneAsync: async () => state.user,
        rawCollection: () => ({
          updateOne: async (_selector, modifier) => {
            state.user.services = {
              ...(state.user.services || {}),
              titraApiToken: structuredClone(modifier.$set['services.titraApiToken']),
            }
            delete state.user.profile.APItoken
            return { matchedCount: 1, modifiedCount: 1 }
          },
        }),
      },
      Error: class extends Error {
        constructor(code, reason) { super(reason); this.error = code }
      },
    },
    getJson: async (req) => JSON.parse(req.rawBody),
    sanitizeObject: (value) => value || {},
    Projects: {
      findOneAsync: async () => {
        calls.projectReads += 1
        if (state.projectReadFailure) {
          throw new Error('private database project-read details')
        }
        return state.projectAccessible
          ? { _id: 'project-1', userId: 'owner-1', admins: ['owner-1'] }
          : undefined
      },
      insertAsync: async (doc) => {
        calls.inserts.push(doc)
        state.projects.set('project-created', structuredClone(doc))
        return 'project-created'
      },
    },
    Tasks: {
      find: () => ({
        countAsync: async () => {
          calls.dependencyReads += 1
          return state.dependenciesAvailable ? 1 : 0
        },
      }),
      insertAsync: async (doc) => {
        calls.inserts.push(doc)
        state.projectTasks.set(doc._id || 'task-created', structuredClone(doc))
        return doc._id || 'task-created'
      },
    },
    Timecards: {},
    randomUUID: () => `generated-${state.receipts.size + 1}`,
    isProjectAdministrator: () => state.projectAdmin,
    definiteProjectChildNoWrite: (error) => error,
    createProjectChildWithFence: async (options) => options.createChild(),
    insertAPIProjectWithId: async (projectFields, projectId) => {
      const existing = state.projects.get(projectId)
      if (!existing) {
        state.projects.set(projectId, structuredClone(projectFields))
        calls.inserts.push({ ...structuredClone(projectFields), _id: projectId })
      }
      return { projectId, created: !existing }
    },
    recoverAPIProjectWithId: async (projectFields, projectId) => (
      state.projects.has(projectId) ? { projectId, created: false } : null
    ),
    insertAPIProjectTaskWithId: async (taskFields, taskId) => {
      if (state.idempotentTaskInsertFailure) {
        throw new Error('simulated task insert failure before write')
      }
      const existing = state.projectTasks.get(taskId)
      if (!existing) {
        state.projectTasks.set(taskId, structuredClone(taskFields))
        calls.inserts.push({ ...structuredClone(taskFields), _id: taskId })
      }
      return { taskId, created: !existing }
    },
    recoverAPIProjectTaskWithId: async (taskFields, taskId) => {
      calls.taskRecoveries += 1
      return state.projectTasks.has(taskId) ? { taskId, created: false } : null
    },
    insertIdempotentAPITimeCard: async (
      projectId, task, date, hours, userId, taskRate, customfields,
      dateOnly, startTime, timecardId,
    ) => {
      if (state.idempotentTimecardInsertFailure) {
        throw new Error('simulated timecard insert failure before write')
      }
      const existing = state.timecards.get(timecardId)
      if (!existing) {
        const document = {
          projectId, task, date, hours, userId, taskRate, customfields, dateOnly, startTime,
        }
        state.timecards.set(timecardId, structuredClone(document))
        calls.inserts.push({ ...structuredClone(document), _id: timecardId })
      }
      return { timecardId, created: !existing }
    },
    recoverAPITimeCard: async (
      projectId, task, date, hours, userId, taskRate, customfields,
      dateOnly, startTime, timecardId,
    ) => {
      calls.timecardRecoveries += 1
      return state.timecards.has(timecardId) ? { timecardId, created: false } : null
    },
    deleteOwnedTimeCard: async () => {},
    updateOwnedTimeCardDetails: async () => {},
    updateOwnedTimeCardTask: async () => {},
    assertTimecardDateMigrationUnlocked: async () => {},
    checkTimeEntryRule: async (input) => {
      calls.ruleInputs.push(input)
      if (!state.ruleAllowed) {
        throw Object.assign(new Error('rule blocked'), { error: 'timecard-rule-blocked' })
      }
    },
    checkAuthorizedTimeEntryRule: async (input) => context.checkTimeEntryRule(input),
    insertTimeCard: async (...args) => {
      const [
        projectId, task, date, hours, userId, taskRate, customfields,
        dateOnly, startTime, options = {},
      ] = args
      if (options.timecardId) {
        if (state.idempotentTimecardInsertFailure) {
          throw new Error('simulated timecard insert failure before write')
        }
        const existing = state.timecards.get(options.timecardId)
        if (!existing) {
          const document = {
            projectId, task, date, hours, userId, taskRate, customfields, dateOnly, startTime,
          }
          state.timecards.set(options.timecardId, structuredClone(document))
          calls.inserts.push({ ...structuredClone(document), _id: options.timecardId })
        }
        return options.returnCreationMetadata
          ? { timecardId: options.timecardId, created: !existing }
          : options.timecardId
      }
      calls.inserts.push(args)
      if (state.insertFailure) throw new Error('private database connection details')
      return 'time-created'
    },
  }
  const methodsSource = readFileSync(new URL('../imports/api/timecards/server/methods.js', import.meta.url), 'utf8')
  const wrapper = methodsSource.slice(
    methodsSource.indexOf('async function insertAPITimeCard('),
    methodsSource.indexOf('\n/**', methodsSource.indexOf('async function insertAPITimeCard(')),
  )
  vm.runInNewContext(`${wrapper}\nthis.insertAPITimeCard = insertAPITimeCard`, context)
  const source = readFileSync(new URL('./APIroutes.js', import.meta.url), 'utf8')
    .replace(/^import[\s\S]*?from '[^']+'\r?\n/gm, '')
  vm.runInNewContext(source, context, { filename: 'APIroutes.js' })
  return { handlers, calls, state }
}

function rawResponse() {
  return {
    headers: {}, replies: [],
    setHeader(name, value) { this.headers[name] = value },
    writeHead(status, headers) { this.status = status; Object.assign(this.headers, headers) },
    end(body) { this.replies.push({ status: this.status, body: body ? JSON.parse(body) : null }) },
  }
}

const CREATE_KEY = '0123456789abcdef0123456789abcdef'

function keyedTimeentryRequest(key = CREATE_KEY) {
  return {
    method: 'POST',
    _parsedUrl: { pathname: '/timeentry/create/' },
    headers: {
      authorization: 'Bearer test-token',
      'content-type': 'application/json',
      'idempotency-key': key,
    },
    rawBody: JSON.stringify({
      projectId: 'project-1', task: 'Idempotent work', date: '2026-09-03',
      startTime: '09:17', hours: 1.237,
    }),
  }
}

function keyedProjectTaskRequest(key = CREATE_KEY) {
  return {
    method: 'POST',
    _parsedUrl: { pathname: '/project/task/create/' },
    headers: {
      authorization: 'Bearer test-token',
      'content-type': 'application/json',
      'idempotency-key': key,
    },
    rawBody: JSON.stringify({
      projectId: 'project-1', name: 'Idempotent project task',
      start: '2026-09-03T00:00:00.000Z', end: '2026-09-04T00:00:00.000Z',
      dependencies: ['dependency-1'],
    }),
  }
}

test('real create handlers reject wrong methods, invalid JSON and null once without side effects', async () => {
  for (const path of ['/timeentry/create/', '/project/create/', '/project/task/create/']) {
    for (const [method, rawBody, status] of [['GET', '{}', 405], ['POST', '{', 400], ['POST', 'null', 400]]) {
      const f = registeredRoutes()
      const res = rawResponse()
      await f.handlers.get(path)({
        method,
        rawBody,
        _parsedUrl: { pathname: path },
        headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
      }, res)
      assert.equal(res.replies.length, 1, `${path} ${method} ${rawBody}`)
      assert.equal(res.replies[0].status, status)
      assert.equal(f.calls.inserts.length, 0)
    }
  }
})

test('completed timeentry replay survives later project-access and rule denial', async () => {
  const f = registeredRoutes()
  const first = rawResponse()
  await f.handlers.get('/timeentry/create/')(keyedTimeentryRequest(), first)
  assert.equal(first.replies[0].status, 200)
  assert.equal(first.headers['Idempotency-Replayed'], 'false')
  assert.ok(Number.isFinite(Date.parse(first.headers['Idempotency-Expires-At'])))
  assert.equal(f.state.receipts.size, 1)
  assert.equal(f.state.timecards.size, 1)
  const firstPayload = first.replies[0].body.payload
  const readsAfterCreate = f.calls.projectReads
  const rulesAfterCreate = f.calls.ruleInputs.length
  const recoveriesAfterCreate = f.calls.timecardRecoveries

  f.state.projectAccessible = false
  f.state.ruleAllowed = false
  const replay = rawResponse()
  await f.handlers.get('/timeentry/create/')(keyedTimeentryRequest(), replay)
  assert.equal(replay.replies[0].status, 200)
  assert.equal(replay.headers['Idempotency-Replayed'], 'true')
  assert.equal(replay.headers['Idempotency-Expires-At'], first.headers['Idempotency-Expires-At'])
  assert.deepEqual(replay.replies[0].body.payload, firstPayload)
  assert.equal(f.state.receipts.size, 1)
  assert.equal(f.state.timecards.size, 1)
  assert.equal(f.calls.projectReads, readsAfterCreate)
  assert.equal(f.calls.ruleInputs.length, rulesAfterCreate)
  assert.equal(f.calls.timecardRecoveries, recoveriesAfterCreate)
})

test('completed project-task replay survives later admin and dependency denial', async () => {
  const f = registeredRoutes()
  const first = rawResponse()
  await f.handlers.get('/project/task/create/')(keyedProjectTaskRequest(), first)
  assert.equal(first.replies[0].status, 200)
  assert.equal(first.headers['Idempotency-Replayed'], 'false')
  assert.equal(f.state.receipts.size, 1)
  assert.equal(f.state.projectTasks.size, 1)
  const firstPayload = first.replies[0].body.payload
  const readsAfterCreate = f.calls.projectReads
  const dependenciesAfterCreate = f.calls.dependencyReads
  const recoveriesAfterCreate = f.calls.taskRecoveries

  f.state.projectAdmin = false
  f.state.dependenciesAvailable = false
  const replay = rawResponse()
  await f.handlers.get('/project/task/create/')(keyedProjectTaskRequest(), replay)
  assert.equal(replay.replies[0].status, 200)
  assert.equal(replay.headers['Idempotency-Replayed'], 'true')
  assert.deepEqual(replay.replies[0].body.payload, firstPayload)
  assert.equal(f.state.receipts.size, 1)
  assert.equal(f.state.projectTasks.size, 1)
  assert.equal(f.calls.projectReads, readsAfterCreate)
  assert.equal(f.calls.dependencyReads, dependenciesAfterCreate)
  assert.equal(f.calls.taskRecoveries, recoveriesAfterCreate)
})

test('reserved committed timeentry is recovered before changed mutable guards', async () => {
  const f = registeredRoutes()
  f.state.failCompletionOnce = true
  const uncertain = rawResponse()
  await f.handlers.get('/timeentry/create/')(keyedTimeentryRequest(), uncertain)
  assert.equal(uncertain.replies[0].status, 500)
  assert.equal(f.state.receipts.size, 1)
  assert.equal([...f.state.receipts.values()][0].status, 'reserved')
  assert.equal(f.state.timecards.size, 1)
  const readsAfterCreate = f.calls.projectReads
  const rulesAfterCreate = f.calls.ruleInputs.length

  f.state.projectAccessible = false
  f.state.ruleAllowed = false
  const recovered = rawResponse()
  await f.handlers.get('/timeentry/create/')(keyedTimeentryRequest(), recovered)
  assert.equal(recovered.replies[0].status, 200)
  assert.equal(recovered.headers['Idempotency-Replayed'], 'true')
  assert.equal([...f.state.receipts.values()][0].status, 'completed')
  assert.equal(f.state.timecards.size, 1)
  assert.equal(f.calls.projectReads, readsAfterCreate)
  assert.equal(f.calls.ruleInputs.length, rulesAfterCreate)
})

test('reserved committed project task is recovered before changed mutable guards', async () => {
  const f = registeredRoutes()
  f.state.failCompletionOnce = true
  const uncertain = rawResponse()
  await f.handlers.get('/project/task/create/')(keyedProjectTaskRequest(), uncertain)
  assert.equal(uncertain.replies[0].status, 500)
  assert.equal(f.state.receipts.size, 1)
  assert.equal([...f.state.receipts.values()][0].status, 'reserved')
  assert.equal(f.state.projectTasks.size, 1)
  const readsAfterCreate = f.calls.projectReads
  const dependenciesAfterCreate = f.calls.dependencyReads

  f.state.projectAdmin = false
  f.state.dependenciesAvailable = false
  const recovered = rawResponse()
  await f.handlers.get('/project/task/create/')(keyedProjectTaskRequest(), recovered)
  assert.equal(recovered.replies[0].status, 200)
  assert.equal(recovered.headers['Idempotency-Replayed'], 'true')
  assert.equal([...f.state.receipts.values()][0].status, 'completed')
  assert.equal(f.state.projectTasks.size, 1)
  assert.equal(f.calls.projectReads, readsAfterCreate)
  assert.equal(f.calls.dependencyReads, dependenciesAfterCreate)
})

test('new keyed guard denials create no receipt and retain established status codes', async () => {
  for (const [configure, path, request, status] of [
    [(state) => { state.projectAccessible = false }, '/timeentry/create/', keyedTimeentryRequest, 403],
    [(state) => { state.ruleAllowed = false }, '/timeentry/create/', keyedTimeentryRequest, 422],
    [(state) => { state.projectAdmin = false }, '/project/task/create/', keyedProjectTaskRequest, 403],
    [(state) => { state.dependenciesAvailable = false }, '/project/task/create/', keyedProjectTaskRequest, 400],
  ]) {
    const f = registeredRoutes()
    configure(f.state)
    const response = rawResponse()
    await f.handlers.get(path)(request(), response)
    assert.equal(response.replies.length, 1, path)
    assert.equal(response.replies[0].status, status, path)
    assert.equal(f.state.receipts.size, 0, path)
    assert.equal(f.state.timecards.size + f.state.projectTasks.size, 0, path)
    assert.equal(f.calls.inserts.length, 0, path)
  }
})

test('new keyed timeentry access-check failure is sanitized and creates no receipt', async () => {
  const f = registeredRoutes()
  f.state.projectReadFailure = true
  const response = rawResponse()
  await f.handlers.get('/timeentry/create/')(keyedTimeentryRequest(), response)
  assert.equal(response.replies[0].status, 500)
  assert.equal(response.replies[0].body.message, 'Project access could not be verified.')
  assert.doesNotMatch(JSON.stringify(response.replies[0].body), /private|database/i)
  assert.equal(f.state.receipts.size, 0)
  assert.equal(f.state.timecards.size, 0)
})

test('reserved absent resources fail closed without rerunning guards or creation', async () => {
  const timeentry = registeredRoutes()
  timeentry.state.idempotentTimecardInsertFailure = true
  const firstTimeentry = rawResponse()
  await timeentry.handlers.get('/timeentry/create/')(
    keyedTimeentryRequest(), firstTimeentry,
  )
  assert.equal(firstTimeentry.replies[0].status, 500)
  assert.equal([...timeentry.state.receipts.values()][0].status, 'reserved')
  assert.equal(timeentry.state.timecards.size, 0)
  timeentry.state.idempotentTimecardInsertFailure = false
  timeentry.state.projectAccessible = false
  const timeentryReads = timeentry.calls.projectReads
  const deniedTimeentry = rawResponse()
  await timeentry.handlers.get('/timeentry/create/')(
    keyedTimeentryRequest(), deniedTimeentry,
  )
  assert.equal(deniedTimeentry.replies[0].status, 500)
  assert.equal(timeentry.calls.projectReads, timeentryReads)
  assert.equal(timeentry.state.timecards.size, 0)
  assert.equal([...timeentry.state.receipts.values()][0].status, 'reserved')

  const projectTask = registeredRoutes()
  projectTask.state.idempotentTaskInsertFailure = true
  const firstTask = rawResponse()
  await projectTask.handlers.get('/project/task/create/')(
    keyedProjectTaskRequest(), firstTask,
  )
  assert.equal(firstTask.replies[0].status, 500)
  assert.equal([...projectTask.state.receipts.values()][0].status, 'reserved')
  assert.equal(projectTask.state.projectTasks.size, 0)
  projectTask.state.idempotentTaskInsertFailure = false
  projectTask.state.projectAdmin = false
  const projectTaskReads = projectTask.calls.projectReads
  const deniedTask = rawResponse()
  await projectTask.handlers.get('/project/task/create/')(
    keyedProjectTaskRequest(), deniedTask,
  )
  assert.equal(deniedTask.replies[0].status, 500)
  assert.equal(projectTask.calls.projectReads, projectTaskReads)
  assert.equal(projectTask.state.projectTasks.size, 0)
  assert.equal([...projectTask.state.receipts.values()][0].status, 'reserved')
})

test('real project-task create rejects coercible and noncanonical timestamps before insertion', async () => {
  const canonical = '2026-09-01T02:03:04.005Z'
  for (const [field, value] of [
    ['start', null],
    ['start', 0],
    ['start', true],
    ['start', []],
    ['start', '2026-09-01T02:03:04.005+00:00'],
    ['start', '2026-09-01T02:03:04Z'],
    ['start', '2026-02-29T02:03:04.005Z'],
    ['end', '2026-09-01T24:00:00.000Z'],
  ]) {
    const f = registeredRoutes()
    const response = rawResponse()
    const body = {
      projectId: 'project-1', name: 'Strict timestamp task',
      start: canonical, end: canonical,
    }
    body[field] = value
    await f.handlers.get('/project/task/create/')({
      method: 'POST',
      rawBody: JSON.stringify(body),
      _parsedUrl: { pathname: '/project/task/create/' },
      headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
    }, response)
    assert.equal(response.replies.length, 1, `${field}=${JSON.stringify(value)}`)
    assert.equal(response.replies[0].status, 400, `${field}=${JSON.stringify(value)}`)
    assert.equal(f.calls.inserts.length, 0, `${field}=${JSON.stringify(value)}`)
  }
})

test('real API create route checks rule with owner/new state and supplied modern fields before inserting', async () => {
  const f = registeredRoutes()
  const req = {
    method: 'POST', headers: {
      authorization: 'Bearer test-token', 'content-type': 'application/json',
    },
    _parsedUrl: { pathname: '/timeentry/create/' },
    rawBody: JSON.stringify({ projectId: 'project-1', task: 'Created task', date: '2026-07-03', startTime: '11:26', hours: 1.235 }),
  }
  f.state.ruleAllowed = false
  const denied = rawResponse()
  await f.handlers.get('/timeentry/create/')(req, denied)
  assert.equal(denied.replies.length, 1)
  assert.equal(denied.replies[0].status, 422)
  assert.equal(f.calls.inserts.length, 0)
  assert.equal(f.calls.ruleInputs[0].userId, 'owner-1')
  assert.equal(f.calls.ruleInputs[0].state, 'new')
  assert.equal(f.calls.ruleInputs[0].dateOnly, '2026-07-03')
  assert.equal(f.calls.ruleInputs[0].startTime, '11:26')
  f.state.ruleAllowed = true
  const allowed = rawResponse()
  await f.handlers.get('/timeentry/create/')(req, allowed)
  assert.equal(allowed.replies[0].status, 200)
  assert.equal(f.calls.inserts.length, 1)
  assert.equal(f.calls.inserts[0][4], 'owner-1')
})

test('real route shared auth rejects inactive users and CORS advertises PATCH with usable preflight', async () => {
  const f = registeredRoutes()
  f.state.user.inactive = true
  const denied = rawResponse()
  await f.handlers.get('/project/create/')({
    method: 'POST', rawBody: '{"name":"Forbidden"}',
    _parsedUrl: { pathname: '/project/create/' },
    headers: { authorization: 'Token test-token' },
  }, denied)
  assert.equal(denied.replies[0].status, 401)
  assert.equal(f.calls.inserts.length, 0)
  const preflight = rawResponse()
  await f.handlers.get('/timeentry/task/')({ method: 'OPTIONS', headers: {} }, preflight)
  assert.equal(preflight.replies[0].status, 204)
  assert.equal(preflight.replies[0].body, null)
  assert.match(preflight.headers['Access-Control-Allow-Methods'], /PATCH/)
  assert.match(preflight.headers['Access-Control-Allow-Headers'], /If-Match/)
  assert.match(preflight.headers['Access-Control-Expose-Headers'], /ETag/)
})

test('real API insertion failure remains uncertain 500 rather than definite rule rejection 422', async () => {
  const f = registeredRoutes()
  f.state.insertFailure = true
  const response = rawResponse()
  await f.handlers.get('/timeentry/create/')({
    method: 'POST',
    _parsedUrl: { pathname: '/timeentry/create/' },
    headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
    rawBody: JSON.stringify({ projectId: 'project-1', task: 'Created task', date: '2026-07-03', hours: 1.235 }),
  }, response)
  assert.equal(f.calls.inserts.length, 1)
  assert.equal(response.replies.length, 1)
  assert.equal(response.replies[0].status, 500)
  assert.match(response.replies[0].body.message, /before retrying/)
  assert.doesNotMatch(response.replies[0].body.message, /private|connection/)
})

test('real required preview GET accepts unauthenticated CORS preflight before accessing records', async () => {
  const f = registeredRoutes()
  f.state.user = undefined
  const preflight = rawResponse()
  await f.handlers.get('/timeentry/get/')({
    method: 'OPTIONS',
    _parsedUrl: { pathname: '/timeentry/get/entry-1' },
    headers: { origin: 'https://cli-ui.example', 'access-control-request-method': 'GET' },
  }, preflight)
  assert.deepEqual(preflight.replies, [{ status: 204, body: null }])
  assert.equal(preflight.headers.Allow, 'GET, OPTIONS')
  assert.equal(preflight.headers['Access-Control-Allow-Origin'], '*')
  assert.match(preflight.headers['Access-Control-Allow-Headers'], /Authorization/)
  assert.match(preflight.headers['Access-Control-Expose-Headers'], /ETag/)
  assert.equal(f.calls.inserts.length, 0)
})
