import assert from 'node:assert/strict'
import test from 'node:test'
import { isDeepStrictEqual } from 'node:util'

import {
  MAX_TIMER_START_HISTORY,
  TIMER_START_HISTORY_GRACE_MS,
  TIMER_START_REPLAY_RETENTION_MS,
  getTimerState,
  retainedTimerStartHistory,
  startTimerAtomic,
  stopTimerAtomic,
  timerStartSnapshotSelector,
  timerSnapshotSelector,
  validateOperationId,
} from '../imports/api/users/server/timerTransitions.js'
import { createTimerGetHandler, createTimerStartHandler, createTimerStopHandler } from './timerRoutes.js'

const failsWith = (code) => (error) => error.error === code

function getPath(value, dotted) {
  return dotted.split('.').reduce((current, key) => current?.[key], value)
}

function hasPath(value, dotted) {
  const parts = dotted.split('.'); let current = value
  for (const part of parts) {
    if (!current || !Object.hasOwn(current, part)) return false
    current = current[part]
  }
  return true
}

function matches(record, selector) {
  return Boolean(record) && Object.entries(selector).every(([field, condition]) => {
    if (field === '$nor') return condition.every((candidate) => !matches(record, candidate))
    const value = getPath(record, field); const exists = hasPath(record, field)
    if (condition && typeof condition === 'object' && !(condition instanceof Date)) {
      if ('$exists' in condition && exists !== condition.$exists) return false
      if ('$eq' in condition && !isDeepStrictEqual(value, condition.$eq)) return false
      if ('$gt' in condition && !(value > condition.$gt)) return false
      if ('$elemMatch' in condition
        && (!Array.isArray(value)
          || !value.some((item) => matches(item, condition.$elemMatch)))) return false
      return true
    }
    return isDeepStrictEqual(value, condition)
  })
}

function setPath(value, dotted, next) {
  const parts = dotted.split('.'); let current = value
  parts.slice(0, -1).forEach((part) => { current[part] ||= {}; current = current[part] })
  current[parts.at(-1)] = next
}

function unsetPath(value, dotted) {
  const parts = dotted.split('.'); let current = value
  parts.slice(0, -1).forEach((part) => { current = current?.[part] })
  if (current) delete current[parts.at(-1)]
}

function fixture(profile = {}) {
  const state = { user: { _id: 'u1', profile: structuredClone(profile) } }
  const calls = { writes: [] }
  const deps = {
    now: () => new Date('2026-09-01T10:00:00.000Z'),
    findUser: async (selector) => (matches(state.user, selector) ? structuredClone(state.user) : undefined),
    updateOne: async (selector, modifier) => {
      calls.writes.push(structuredClone({ selector, modifier }))
      if (!matches(state.user, selector)) return { matchedCount: 0 }
      Object.entries(modifier.$set || {}).forEach(([field, value]) => setPath(state.user, field, value))
      Object.keys(modifier.$unset || {}).forEach((field) => unsetPath(state.user, field))
      Object.entries(modifier.$inc || {}).forEach(([field, amount]) => {
        setPath(state.user, field, (getPath(state.user, field) ?? 0) + amount)
      })
      return { matchedCount: 1 }
    },
  }
  return { state, calls, deps }
}

test('operation IDs are bounded safe text', () => {
  validateOperationId('cli:12345678')
  for (const value of ['', 'short', 'has space 123', '../bad/123', 'x'.repeat(129), null]) {
    assert.throws(() => validateOperationId(value), failsWith('timer-invalid'))
  }
})

test('concurrent starts have one winner and same operation can reconcile', async () => {
  const f = fixture({ timerRevision: 4 })
  const results = await Promise.allSettled([
    startTimerAtomic({ userId: 'u1', operationId: 'client-op-0001' }, f.deps),
    startTimerAtomic({ userId: 'u1', operationId: 'client-op-0002' }, f.deps),
  ])
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1)
  assert.equal(results.find((result) => result.status === 'rejected').reason.error, 'timer-write-conflict')
  assert.equal(f.state.user.profile.timerRevision, 5)
  assert.deepEqual(f.state.user.profile.timerStartHistory.map((entry) => entry.operationId), [
    f.state.user.profile.timerId,
  ])
  const replay = await startTimerAtomic({ userId: 'u1', operationId: f.state.user.profile.timerId }, f.deps)
  assert.equal(replay.payload.changed, false)
  assert.equal(f.calls.writes.length, 2)
})

test('concurrent starts with the same ID append once and reconcile the active timer', async () => {
  const f = fixture({ timerRevision: 4 })
  const results = await Promise.all([
    startTimerAtomic({ userId: 'u1', operationId: 'client-op-same01' }, f.deps),
    startTimerAtomic({ userId: 'u1', operationId: 'client-op-same01' }, f.deps),
  ])
  assert.deepEqual(results.map((result) => result.payload.changed).sort(), [false, true])
  assert.equal(f.state.user.profile.timerRevision, 5)
  assert.deepEqual(f.state.user.profile.timerStartHistory.map((entry) => entry.operationId), [
    'client-op-same01',
  ])
})

test('a stopped timer consumes its start operation ID without a second write', async () => {
  const f = fixture({ timerRevision: 0 })
  await startTimerAtomic({ userId: 'u1', operationId: 'client-op-used01' }, f.deps)
  await stopTimerAtomic({
    userId: 'u1', timerId: 'client-op-used01', expectedRevision: 1,
  }, f.deps)
  const before = structuredClone(f.state.user)
  const writesBefore = f.calls.writes.length
  await assert.rejects(
    startTimerAtomic({ userId: 'u1', operationId: 'client-op-used01' }, f.deps),
    failsWith('timer-operation-consumed'),
  )
  assert.equal(f.calls.writes.length, writesBefore)
  assert.deepEqual(f.state.user, before)
  assert.equal(Object.hasOwn(f.state.user.profile, 'timer'), false)
})

test('timer start prunes only physically expired history and never evicts retained IDs', async () => {
  const now = new Date('2026-09-01T10:00:00.000Z')
  const f = fixture({
    timerRevision: 2,
    timerStartHistory: [
      { operationId: 'client-op-expired', expiresAt: new Date(now.getTime() - 1) },
      { operationId: 'client-op-retained', expiresAt: new Date(now.getTime() + 60_000) },
    ],
  })
  await startTimerAtomic({ userId: 'u1', operationId: 'client-op-expired' }, f.deps)
  assert.deepEqual(f.state.user.profile.timerStartHistory.map((entry) => entry.operationId), [
    'client-op-retained', 'client-op-expired',
  ])
  assert.equal(
    f.state.user.profile.timerStartHistory[1].expiresAt.getTime() - now.getTime(),
    TIMER_START_REPLAY_RETENTION_MS + TIMER_START_HISTORY_GRACE_MS,
  )
  assert.equal(TIMER_START_REPLAY_RETENTION_MS, 604_800_000)
  assert.equal(TIMER_START_HISTORY_GRACE_MS, 86_400_000)
})

test('invalid timer start history fails closed without a write', async () => {
  const f = fixture({ timerRevision: 2, timerStartHistory: [{ operationId: 'hidden' }] })
  await assert.rejects(
    startTimerAtomic({ userId: 'u1', operationId: 'client-op-valid01' }, f.deps),
    failsWith('timer-write-conflict'),
  )
  assert.equal(f.calls.writes.length, 0)
  assert.equal(Object.hasOwn(f.state.user.profile, 'timer'), false)
})

test('full retained timer history rejects a unique start without eviction or write', async () => {
  const expiresAt = new Date('2026-09-02T10:00:00Z')
  const history = Array.from({ length: MAX_TIMER_START_HISTORY }, (_, index) => ({
    operationId: `bounded-op-${String(index).padStart(4, '0')}`,
    expiresAt,
  }))
  const f = fixture({ timerRevision: 2, timerStartHistory: history })
  await assert.rejects(
    startTimerAtomic({ userId: 'u1', operationId: 'client-op-overflow' }, f.deps),
    failsWith('timer-write-conflict'),
  )
  assert.equal(f.calls.writes.length, 0)
  assert.deepEqual(f.state.user.profile.timerStartHistory, history)
})

test('expired entries free bounded capacity but oversized stored history fails closed', async () => {
  const expired = Array.from({ length: MAX_TIMER_START_HISTORY }, (_, index) => ({
    operationId: `expired-op-${String(index).padStart(4, '0')}`,
    expiresAt: new Date('2026-09-01T09:59:59Z'),
  }))
  const reusable = fixture({ timerRevision: 2, timerStartHistory: expired })
  await startTimerAtomic({ userId: 'u1', operationId: 'client-op-after-expiry' }, reusable.deps)
  assert.deepEqual(reusable.state.user.profile.timerStartHistory.map((entry) => entry.operationId), [
    'client-op-after-expiry',
  ])

  const oversized = fixture({
    timerRevision: 2,
    timerStartHistory: [
      ...expired,
      { operationId: 'expired-op-overflow', expiresAt: new Date('2026-09-01T09:59:59Z') },
    ],
  })
  await assert.rejects(
    startTimerAtomic({ userId: 'u1', operationId: 'client-op-refuse01' }, oversized.deps),
    failsWith('timer-write-conflict'),
  )
  assert.equal(oversized.calls.writes.length, 0)
})

test('timer start writes associated UI metadata in the same atomic transition', async () => {
  const f = fixture({
    timerRevision: 2,
    timer_project: 'stale-project',
    timer_start_time: '08:00',
  })
  await startTimerAtomic({
    userId: 'u1', operationId: 'client-op-meta-1',
    metadata: {
      project: 'p1', task: 'Review', customFields: [{ name: 'ticket', value: 'T-1' }],
    },
  }, f.deps)
  assert.equal(f.calls.writes.length, 1)
  assert.equal(f.state.user.profile.timer_project, 'p1')
  assert.equal(f.state.user.profile.timer_task, 'Review')
  assert.deepEqual(f.state.user.profile.timer_custom_fields,
    [{ name: 'ticket', value: 'T-1' }])
  assert.equal(Object.hasOwn(f.state.user.profile, 'timer_start_time'), false)
})

test('GET returns stable ID/revision and STOP CAS cannot stop a replacement timer', async () => {
  const f = fixture({
    timer: new Date('2026-09-01T09:00:00Z'), timerId: 'client-op-0001', timerRevision: 5,
  })
  const read = await getTimerState({ userId: 'u1' }, f.deps)
  assert.equal(read.payload.duration, 3600000)
  assert.equal(read.etag, '"titra-timer-revision-5"')
  await assert.rejects(stopTimerAtomic({
    userId: 'u1', timerId: 'client-op-0002', expectedRevision: 5,
  }, f.deps), failsWith('timer-write-conflict'))
  const stopped = await stopTimerAtomic({
    userId: 'u1', timerId: 'client-op-0001', expectedRevision: 5,
  }, f.deps)
  assert.equal(stopped.payload.duration, 3600000)
  assert.equal(stopped.etag, '"titra-timer-revision-6"')
  assert.equal(Object.hasOwn(f.state.user.profile, 'timer'), false)
  assert.equal(f.state.user.profile.timerRevision, 6)
})

test('exact stop retry recovers the bounded atomic receipt after a lost response', async () => {
  const f = fixture({
    timer: new Date('2026-09-01T09:00:00Z'), timerId: 'client-op-retry1', timerRevision: 8,
    timerStopReceipt: { stale: 'receipt is replaced, not appended' },
  })
  const first = await stopTimerAtomic({
    userId: 'u1', timerId: 'client-op-retry1', expectedRevision: 8,
  }, f.deps)
  // Model a response lost after the one successful database write.
  const retry = await stopTimerAtomic({
    userId: 'u1', timerId: 'client-op-retry1', expectedRevision: 8,
  }, f.deps)
  assert.equal(f.calls.writes.length, 1)
  assert.equal(retry.etag, first.etag)
  assert.equal(retry.payload.startTime.getTime(), first.payload.startTime.getTime())
  assert.equal(retry.payload.stoppedAt.getTime(), first.payload.stoppedAt.getTime())
  assert.equal(retry.payload.duration, first.payload.duration)
  assert.equal(retry.payload.changed, false)
  assert.deepEqual(Object.keys(f.state.user.profile.timerStopReceipt).sort(), [
    'expectedRevision', 'payload', 'stoppedRevision', 'timerId',
  ])
})

test('old stop receipt cannot stop or mask a replacement timer', async () => {
  const f = fixture({
    timer: new Date('2026-09-01T09:30:00Z'), timerId: 'client-op-new001', timerRevision: 10,
    timerStopReceipt: {
      timerId: 'client-op-old001', expectedRevision: 8, stoppedRevision: 9,
      payload: {
        timerId: 'client-op-old001', startTime: new Date('2026-09-01T08:00:00Z'),
        stoppedAt: new Date('2026-09-01T09:00:00Z'), duration: 3600000,
      },
    },
  })
  await assert.rejects(stopTimerAtomic({
    userId: 'u1', timerId: 'client-op-old001', expectedRevision: 8,
  }, f.deps), failsWith('timer-write-conflict'))
  assert.equal(f.state.user.profile.timerId, 'client-op-new001')
})

test('legacy active timer can be read/stopped only with exact legacy ETag and null ID', async () => {
  const f = fixture({ timer: new Date('2026-09-01T09:30:00Z'), timer_task: 'keep until stop' })
  const read = await getTimerState({ userId: 'u1' }, f.deps)
  assert.equal(read.payload.legacy, true)
  assert.equal(read.payload.timerId, null)
  assert.equal(read.etag, '"titra-timer-revision-legacy"')
  await assert.rejects(stopTimerAtomic({
    userId: 'u1', timerId: null, expectedRevision: 0,
  }, f.deps), failsWith('timer-write-conflict'))
  await stopTimerAtomic({ userId: 'u1', timerId: null, expectedRevision: null }, f.deps)
  assert.equal(f.state.user.profile.timerRevision, 1)
  assert.equal(Object.hasOwn(f.state.user.profile, 'timer_task'), false)
})

test('timer selector protects timestamp, ID and revision', () => {
  const user = { _id: 'u1', profile: {
    timer: new Date('2026-09-01T09:00:00Z'), timerId: 'client-op-0001', timerRevision: 2,
  } }
  const selector = timerSnapshotSelector(user)
  assert.deepEqual(selector['profile.timerId'], { $eq: 'client-op-0001', $exists: true })
  assert.deepEqual(selector['profile.timerRevision'], { $eq: 2, $exists: true })
})

test('timer start selector also protects the complete operation history snapshot', () => {
  const history = [{
    operationId: 'client-op-0001', expiresAt: new Date('2026-09-09T10:00:00Z'),
  }]
  const instant = new Date('2026-09-01T10:00:00Z')
  const selector = timerStartSnapshotSelector({
    _id: 'u1', profile: { timerRevision: 2, timerStartHistory: history },
  }, 'client-op-0002', instant)
  assert.deepEqual(selector['profile.timerStartHistory'], { $eq: history, $exists: true })
  assert.deepEqual(selector.$nor, [{
    'profile.timerStartHistory': {
      $elemMatch: { operationId: 'client-op-0002', expiresAt: { $gt: instant } },
    },
  }])
  assert.equal(matches({
    _id: 'u1', profile: { timerRevision: 2, timerStartHistory: history },
  }, timerStartSnapshotSelector({
    _id: 'u1', profile: { timerRevision: 2, timerStartHistory: history },
  }, 'client-op-0001', instant)), false)
  assert.deepEqual(retainedTimerStartHistory({ profile: { timerStartHistory: history } },
    instant), history)
})

function httpFixture(method = 'GET') {
  const responses = []
  const req = {
    method, headers: { 'content-type': 'application/json' }, _parsedUrl: { pathname: '/timer/get/' },
  }
  const res = { headers: {}, setHeader(key, value) { this.headers[key] = value } }
  const common = {
    authorize: async () => ({ _id: 'u1' }), readJson: async () => ({}),
    sendResponse: (_res, status, message, payload) => responses.push({ status, message, payload }),
  }
  return { req, res, responses, common }
}

test('consumed timer-start response is a distinct stable 409 result', async () => {
  const f = httpFixture('POST'); f.req._parsedUrl.pathname = '/timer/start/'
  f.common.readJson = async () => ({ operationId: 'client-op-used01' })
  await createTimerStartHandler({
    ...f.common,
    startTimer: async () => {
      const error = new Error('private detail must not be reflected')
      error.error = 'timer-operation-consumed'
      throw error
    },
  })(f.req, f.res)
  assert.deepEqual(f.responses, [{
    status: 409,
    message: 'This timer start operation was already used.',
    payload: { code: 'timer-operation-consumed' },
  }])
  assert.doesNotMatch(JSON.stringify(f.responses), /private detail/)
})

test('timer handlers enforce GET/POST/OPTIONS, operation IDs and stop If-Match', async () => {
  const get = httpFixture()
  await createTimerGetHandler({
    ...get.common,
    getTimer: async () => ({ payload: { timerId: 'client-op-0001' }, etag: '"titra-timer-revision-1"' }),
  })(get.req, get.res)
  assert.equal(get.responses[0].status, 200)

  const start = httpFixture('POST'); start.req._parsedUrl.pathname = '/timer/start/'
  start.common.readJson = async () => ({ operationId: 'client-op-0001' })
  await createTimerStartHandler({
    ...start.common,
    startTimer: async () => ({ payload: { changed: true }, etag: '"titra-timer-revision-1"' }),
  })(start.req, start.res)
  assert.equal(start.responses[0].status, 200)

  const legacyStart = httpFixture('POST'); legacyStart.req._parsedUrl.pathname = '/timer/start/'
  legacyStart.common.readJson = async () => ({})
  let generatedId
  await createTimerStartHandler({
    ...legacyStart.common, makeOperationId: () => 'generated-0001',
    startTimer: async ({ operationId }) => {
      generatedId = operationId
      return { payload: { changed: true }, etag: '"titra-timer-revision-1"' }
    },
  })(legacyStart.req, legacyStart.res)
  assert.equal(generatedId, 'legacy:generated-0001')

  const emptyJsonStart = httpFixture('POST')
  emptyJsonStart.req._parsedUrl.pathname = '/timer/start/'
  emptyJsonStart.req.headers['content-length'] = '0'
  emptyJsonStart.common.readJson = async () => { throw new Error('empty body must not be parsed') }
  await createTimerStartHandler({
    ...emptyJsonStart.common, makeOperationId: () => 'generated-0002',
    startTimer: async ({ operationId }) => ({
      payload: { changed: operationId === 'legacy:generated-0002' },
      etag: '"titra-timer-revision-1"',
    }),
  })(emptyJsonStart.req, emptyJsonStart.res)
  assert.equal(emptyJsonStart.responses[0].status, 200)

  const legacy = httpFixture('POST'); legacy.req._parsedUrl.pathname = '/timer/stop/'
  let legacyStopArgs
  await createTimerStopHandler({
    ...legacy.common,
    getTimer: async () => ({
      payload: { timerId: 'legacy-client-0001' }, etag: '"titra-timer-revision-3"',
    }),
    stopTimer: async (args) => {
      legacyStopArgs = args
      return { payload: { changed: true }, etag: '"titra-timer-revision-4"' }
    },
  })(legacy.req, legacy.res)
  assert.equal(legacy.responses[0].status, 200)
  assert.deepEqual(legacyStopArgs, {
    userId: 'u1', timerId: 'legacy-client-0001', expectedRevision: 3,
  })

  const bodylessLegacy = httpFixture('POST')
  bodylessLegacy.req._parsedUrl.pathname = '/timer/stop/'
  bodylessLegacy.req.headers = {}
  await createTimerStopHandler({
    ...bodylessLegacy.common,
    getTimer: async () => ({
      payload: { timerId: null }, etag: '"titra-timer-revision-legacy"',
    }),
    stopTimer: async ({ timerId, expectedRevision }) => {
      assert.equal(timerId, null); assert.equal(expectedRevision, null)
      return { payload: { changed: true }, etag: '"titra-timer-revision-1"' }
    },
  })(bodylessLegacy.req, bodylessLegacy.res)
  assert.equal(bodylessLegacy.responses[0].status, 200)

  const emptyJsonLegacy = httpFixture('POST')
  emptyJsonLegacy.req._parsedUrl.pathname = '/timer/stop/'
  emptyJsonLegacy.req.headers['content-length'] = '0'
  emptyJsonLegacy.common.readJson = async () => { throw new Error('empty body must not be parsed') }
  await createTimerStopHandler({
    ...emptyJsonLegacy.common,
    getTimer: async () => ({
      payload: { timerId: null }, etag: '"titra-timer-revision-legacy"',
    }),
    stopTimer: async () => ({ payload: { changed: true }, etag: '"titra-timer-revision-1"' }),
  })(emptyJsonLegacy.req, emptyJsonLegacy.res)
  assert.equal(emptyJsonLegacy.responses[0].status, 200)

  const unsafeMissing = httpFixture('POST'); unsafeMissing.req._parsedUrl.pathname = '/timer/stop/'
  unsafeMissing.common.readJson = async () => ({ timerId: 'legacy-client-0001' })
  await createTimerStopHandler({
    ...unsafeMissing.common, getTimer: async () => ({}), stopTimer: async () => ({}),
  })(unsafeMissing.req, unsafeMissing.res)
  assert.equal(unsafeMissing.responses[0].status, 428)

  const replacement = httpFixture('POST'); replacement.req._parsedUrl.pathname = '/timer/stop/'
  await createTimerStopHandler({
    ...replacement.common,
    getTimer: async () => ({
      payload: { timerId: 'legacy-client-0001' }, etag: '"titra-timer-revision-3"',
    }),
    stopTimer: async () => {
      throw Object.assign(new Error('replacement detail'), { error: 'timer-write-conflict' })
    },
  })(replacement.req, replacement.res)
  assert.equal(replacement.responses[0].status, 409)
  assert.equal(replacement.responses[0].message.includes('replacement detail'), false)

  const stop = httpFixture('POST'); stop.req._parsedUrl.pathname = '/timer/stop/'
  stop.req.headers['if-match'] = '"titra-timer-revision-1"'
  stop.common.readJson = async () => ({ timerId: 'client-op-0001' })
  await createTimerStopHandler({
    ...stop.common, getTimer: async () => { throw new Error('must not read modern timer') },
    stopTimer: async () => { throw Object.assign(new Error('private'), { error: 'timer-write-conflict' }) },
  })(stop.req, stop.res)
  assert.equal(stop.responses[0].status, 409)
  assert.equal(stop.responses[0].message.includes('private'), false)

  const wrong = httpFixture('DELETE')
  await createTimerGetHandler({ ...wrong.common, getTimer: async () => ({}) })(wrong.req, wrong.res)
  assert.equal(wrong.responses[0].status, 405)
  assert.equal(wrong.res.headers.Allow, 'GET, OPTIONS')
})
