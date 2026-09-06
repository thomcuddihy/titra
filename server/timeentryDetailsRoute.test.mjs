import assert from 'node:assert/strict'
import test from 'node:test'
import { isDeepStrictEqual } from 'node:util'

import {
  editOwnedTimecardDetails,
  validateTimecardDetailsEditBody,
} from '../imports/api/timecards/server/detailsEdit.js'
import { createTimeentryDetailsHandler } from './timeentryDetailsRoute.js'

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
  const state = {
    access: true,
    record: {
      _id: 'record-1', userId: 'owner-1', projectId: 'project-1', task: 'Task',
      date: new Date('2026-09-01T00:00:00.000Z'), dateOnly: '2026-09-01',
      startTime: '09:00', dateRevision: 4, hours: 1.25, taskRate: 90,
      state: 'new', custom: { remains: true }, ...overrides,
    },
  }
  const calls = { writes: [], rules: [], leases: 0, moveFences: [] }
  const deps = {
    findTimecard: async (selector) => (matches(state.record, selector)
      ? structuredClone(state.record) : undefined),
    canAccessProject: async () => state.access,
    checkRule: async (candidate) => { calls.rules.push(structuredClone(candidate)) },
    assertUnlocked: async () => {},
    withWriteLease: async (callback) => { calls.leases += 1; return callback(async () => {}) },
    moveToProjectWithFence: async ({ projectId, userId, write }) => {
      calls.moveFences.push({ projectId, userId })
      return write()
    },
    updateOne: async (selector, modifier) => {
      calls.writes.push(structuredClone({ selector, modifier }))
      if (!matches(state.record, selector)) return { matchedCount: 0 }
      Object.assign(state.record, modifier.$set)
      Object.keys(modifier.$unset || {}).forEach((field) => delete state.record[field])
      state.record.dateRevision = (state.record.dateRevision ?? 0) + 1
      return { matchedCount: 1 }
    },
  }
  return { state, calls, deps }
}

test('details body is exact, field-limited, and rejects malformed values', () => {
  validateTimecardDetailsEditBody({
    expected: { hours: 1, startTime: null }, changes: { hours: 2, startTime: '09:30' },
  })
  for (const body of [
    null, {}, [],
    { expected: { hours: 1 }, changes: { hours: 2 }, userId: 'other' },
    { expected: { hours: 1 }, changes: { projectId: 'p' } },
    { expected: { task: 'a' }, changes: { task: 'b' } },
    { expected: { hours: 1 }, changes: { hours: Number.POSITIVE_INFINITY } },
    { expected: { dateOnly: null }, changes: { dateOnly: '2026-02-30' } },
    { expected: { startTime: null }, changes: { startTime: '25:00' } },
    { expected: { projectId: 'p' }, changes: { projectId: '\ud800' } },
  ]) assert.throws(() => validateTimecardDetailsEditBody(body), failsWith('timecard-details-invalid'))
})

test('hours/project/calendar update is one guarded write and preserves every other field', async () => {
  const f = fixture()
  const before = structuredClone(f.state.record)
  const body = {
    expected: { hours: 1.25, projectId: 'project-1', dateOnly: '2026-09-01', startTime: '09:00' },
    changes: { hours: 2.375, projectId: 'project-2', dateOnly: '2026-09-02', startTime: null },
  }
  const result = await editOwnedTimecardDetails({
    timecardId: 'record-1', userId: 'owner-1', body, expectedDateRevision: 4,
  }, f.deps)
  const expectedRecord = {
    ...before, hours: 2.375, projectId: 'project-2',
    date: new Date('2026-09-02T00:00:00.000Z'), dateOnly: '2026-09-02',
    dateRevision: 5,
  }
  delete expectedRecord.startTime
  assert.deepEqual(f.state.record, expectedRecord)
  assert.equal(result.etag, '"titra-date-revision-5"')
  assert.deepEqual(result.payload.changedFields, ['dateOnly', 'hours', 'projectId', 'startTime'])
  assert.deepEqual(f.calls.rules[0].custom, { remains: true })
  assert.deepEqual(f.calls.writes[0].modifier.$unset, { startTime: '' })
  assert.deepEqual(f.calls.moveFences, [{ projectId: 'project-2', userId: 'owner-1' }])
})

test('legacy calendar conversion is explicit and project/hour-only edits preserve legacy date', async () => {
  const legacy = fixture({ date: new Date('2026-08-31T23:37:11.000Z') })
  delete legacy.state.record.dateOnly
  delete legacy.state.record.startTime
  delete legacy.state.record.dateRevision
  await assert.rejects(editOwnedTimecardDetails({
    timecardId: 'record-1', userId: 'owner-1', expectedDateRevision: null,
    body: { expected: { dateOnly: null }, changes: { dateOnly: '2026-09-01' } },
  }, legacy.deps), failsWith('timecard-legacy-conversion-required'))
  const originalDate = legacy.state.record.date
  const result = await editOwnedTimecardDetails({
    timecardId: 'record-1', userId: 'owner-1', expectedDateRevision: null,
    body: { expected: { hours: 1.25 }, changes: { hours: 2 } },
  }, legacy.deps)
  assert.equal(legacy.state.record.date.getTime(), originalDate.getTime())
  assert.equal(result.etag, '"titra-date-revision-1"')

  const converted = fixture({ date: new Date('2026-08-31T23:37:11.000Z') })
  delete converted.state.record.dateOnly
  delete converted.state.record.startTime
  delete converted.state.record.dateRevision
  await editOwnedTimecardDetails({
    timecardId: 'record-1', userId: 'owner-1', expectedDateRevision: null,
    body: {
      expected: { dateOnly: null }, changes: { dateOnly: '2026-09-01' },
      acceptLegacyConversion: true,
    },
  }, converted.deps)
  assert.equal(converted.state.record.date.toISOString(), '2026-09-01T00:00:00.000Z')
})

test('ownership, expected values, project access, rule and CAS failures do not write', async () => {
  for (const phase of ['owner', 'expected', 'project', 'rule', 'cas']) {
    const f = fixture()
    if (phase === 'owner') f.state.record.userId = 'other'
    if (phase === 'project') f.state.access = false
    if (phase === 'rule') {
      f.deps.checkRule = async () => {
        throw Object.assign(new Error('private'), { error: 'timecard-rule-blocked' })
      }
    }
    if (phase === 'cas') f.deps.updateOne = async () => ({ matchedCount: 0 })
    const request = {
      timecardId: 'record-1', userId: 'owner-1', expectedDateRevision: 4,
      body: { expected: { hours: phase === 'expected' ? 9 : 1.25 }, changes: { hours: 2 } },
    }
    const accepted = ['not-authorized', 'timecard-write-conflict', 'timecard-rule-blocked']
    await assert.rejects(editOwnedTimecardDetails(request, f.deps), (error) => accepted.includes(error.error))
    assert.equal(f.calls.writes.length, 0)
  }
})

test('no-op verifies the snapshot without incrementing its revision', async () => {
  const f = fixture()
  const result = await editOwnedTimecardDetails({
    timecardId: 'record-1', userId: 'owner-1', expectedDateRevision: 4,
    body: { expected: { hours: 1.25 }, changes: { hours: 1.25 } },
  }, f.deps)
  assert.equal(result.payload.changed, false)
  assert.equal(result.etag, '"titra-date-revision-4"')
  assert.equal(f.calls.writes.length, 0)
  assert.equal(f.calls.moveFences.length, 0)
})

test('project-only move performs its CAS inside the target project writer fence', async () => {
  const f = fixture()
  let fenceHeld = false
  f.deps.moveToProjectWithFence = async ({ projectId, write }) => {
    assert.equal(projectId, 'project-2')
    fenceHeld = true
    try {
      return await write()
    } finally {
      fenceHeld = false
    }
  }
  const originalUpdate = f.deps.updateOne
  f.deps.updateOne = async (...args) => {
    assert.equal(fenceHeld, true, 'the target delete fence must cover the timecard CAS')
    return originalUpdate(...args)
  }
  await editOwnedTimecardDetails({
    timecardId: 'record-1', userId: 'owner-1', expectedDateRevision: 4,
    body: {
      expected: { projectId: 'project-1' }, changes: { projectId: 'project-2' },
    },
  }, f.deps)
  assert.equal(fenceHeld, false)
  assert.equal(f.state.record.projectId, 'project-2')
})

function httpFixture() {
  const responses = []
  const req = {
    method: 'PATCH', _parsedUrl: { pathname: '/timeentry/details/record-1/' },
    headers: { 'if-match': '"titra-date-revision-4"', 'content-type': 'application/json' },
  }
  const res = { headers: {}, setHeader(key, value) { this.headers[key] = value } }
  const deps = {
    authorize: async () => ({ _id: 'owner-1' }),
    readJson: async () => ({ expected: { hours: 1 }, changes: { hours: 2 } }),
    editDetails: async (args) => ({
      etag: '"titra-date-revision-5"',
      payload: { timecardId: args.timecardId, changed: true, changedFields: ['hours'] },
    }),
    sendResponse: (_res, status, message, payload) => responses.push({ status, message, payload }),
  }
  return { req, res, deps, responses }
}

test('details handler enforces method, content type, If-Match and maps safe errors', async () => {
  const f = httpFixture()
  await createTimeentryDetailsHandler(f.deps)(f.req, f.res)
  assert.equal(f.responses[0].status, 200)
  assert.equal(f.res.headers.ETag, '"titra-date-revision-5"')
  for (const mutation of [
    (value) => { value.req.method = 'GET' },
    (value) => { delete value.req.headers['if-match'] },
    (value) => { value.req.headers['content-type'] = 'text/plain' },
  ]) {
    const bad = httpFixture(); mutation(bad)
    await createTimeentryDetailsHandler(bad.deps)(bad.req, bad.res)
    assert.notEqual(bad.responses[0].status, 200)
  }
  const failed = httpFixture()
  failed.deps.editDetails = async () => { throw Object.assign(new Error('secret'), { error: 'timecard-rule-blocked' }) }
  await createTimeentryDetailsHandler(failed.deps)(failed.req, failed.res)
  assert.deepEqual(failed.responses[0], {
    status: 422, message: 'The configured time entry rule prevented this details change.', payload: undefined,
  })
})
