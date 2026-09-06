import assert from 'node:assert/strict'
import test from 'node:test'

import {
  MAX_DATE_RANGE_DAYS,
  MAX_LEGACY_RESULT_LIMIT,
  PaginationError,
  READ_AGGREGATION_MAX_TIME_MS,
  assertDateRangeLimit,
  decodeCursor,
  encodeCursor,
  fetchBoundedAggregationList,
  fetchBoundedLegacyList,
  fetchTimeentryPage,
  parsePageOptions,
  scopeDigest,
  selectorAfter,
} from './apiPagination.js'

const scope = {
  kind: 'owner-timeentries', userId: 'owner-1', from: '2026-07-01', to: '2026-08-31',
}

function entry(id, date) {
  return { _id: id, date: new Date(date), task: `Task ${id}` }
}

test('cursor round trips and is bound to the complete query scope', () => {
  const cursor = encodeCursor({
    scope, date: new Date('2026-07-02T00:00:00.000Z'), id: 'record-2',
  })
  assert.deepEqual(decodeCursor(cursor, scope), {
    date: new Date('2026-07-02T00:00:00.000Z'), id: 'record-2',
  })
  assert.throws(
    () => decodeCursor(cursor, { ...scope, userId: 'other-user' }),
    (error) => error instanceof PaginationError && error.code === 'cursor-query-mismatch',
  )
  assert.equal(scopeDigest(scope), scopeDigest({ to: scope.to, from: scope.from, ...scope }))
  assert.throws(() => scopeDigest({ value: Number.POSITIVE_INFINITY }), /scope number/)
  assert.throws(() => scopeDigest(new Date()), /plain objects/)
})

test('malformed, non-canonical and oversized cursors are rejected', () => {
  for (const cursor of ['', '***', 'e30=', 'x'.repeat(2049)]) {
    assert.throws(() => decodeCursor(cursor, scope), PaginationError)
  }
  const wrongKeys = Buffer.from(JSON.stringify({
    v: 1, q: scopeDigest(scope), d: '2026-07-01T00:00:00.000Z', i: 'id', extra: true,
  })).toString('base64url')
  assert.throws(() => decodeCursor(wrongKeys, scope), PaginationError)
})

test('page options validate duplicates, bounds and integer spelling', () => {
  assert.deepEqual(parsePageOptions(new URLSearchParams(), scope), { limit: 200, after: null })
  assert.equal(parsePageOptions(new URLSearchParams('limit=500'), scope).limit, 500)
  for (const query of ['limit=0', 'limit=501', 'limit=1.0', 'limit=01', 'limit=-1']) {
    assert.throws(() => parsePageOptions(new URLSearchParams(query), scope), PaginationError)
  }
  assert.throws(
    () => parsePageOptions(new URLSearchParams('limit=2&limit=3'), scope),
    PaginationError,
  )
  assert.throws(
    () => parsePageOptions(new URLSearchParams('limti=2'), scope),
    (error) => error instanceof PaginationError && error.code === 'invalid-page-options',
  )
  assert.throws(() => parsePageOptions([], scope), /plain object/)
  assert.throws(() => parsePageOptions({}, { value: Number.NaN }), /scope number/)
})

test('selector uses ascending date plus ID keyset without weakening the base filter', () => {
  const base = { userId: 'owner-1', date: { $gte: new Date('2026-07-01') } }
  const after = { date: new Date('2026-07-02'), id: 'record-2' }
  assert.deepEqual(selectorAfter(base, after), {
    $and: [
      base,
      {
        $or: [
          { date: { $gt: after.date } },
          { date: after.date, _id: { $gt: 'record-2' } },
        ],
      },
    ],
  })
  assert.equal(selectorAfter(base, null), base)
})

test('fetches limit plus one and emits explicit incomplete/complete metadata', async () => {
  const all = [
    entry('a', '2026-07-01T00:00:00.000Z'),
    entry('b', '2026-07-01T00:00:00.000Z'),
    entry('c', '2026-07-02T00:00:00.000Z'),
  ]
  const calls = []
  const first = await fetchTimeentryPage({
    baseSelector: { userId: 'owner-1' }, scope, query: new URLSearchParams('limit=2'),
    find: async (selector, options) => {
      calls.push({ selector, options })
      return all
    },
  })
  assert.deepEqual(first.items.map((value) => value._id), ['a', 'b'])
  assert.deepEqual(first.page, {
    version: 1,
    limit: 2,
    returned: 2,
    complete: false,
    nextCursor: first.page.nextCursor,
    consistency: 'live-keyset',
  })
  assert.equal(typeof first.page.nextCursor, 'string')
  assert.deepEqual(calls[0].options, { sort: { date: 1, _id: 1 }, limit: 3 })

  const second = await fetchTimeentryPage({
    baseSelector: { userId: 'owner-1' },
    scope,
    query: new URLSearchParams(`limit=2&cursor=${first.page.nextCursor}`),
    find: async (selector, options) => {
      calls.push({ selector, options })
      return [all[2]]
    },
  })
  assert.deepEqual(second.items.map((value) => value._id), ['c'])
  assert.equal(second.page.complete, true)
  assert.equal(second.page.nextCursor, null)
  assert.equal(calls[1].selector.$and[1].$or[1]._id.$gt, 'b')
})

test('empty terminal page is explicitly complete', async () => {
  const result = await fetchTimeentryPage({
    find: async () => [], baseSelector: {}, scope, query: {},
  })
  assert.deepEqual(result.items, [])
  assert.equal(result.page.returned, 0)
  assert.equal(result.page.complete, true)
  assert.equal(result.page.nextCursor, null)
})

test('invalid and out-of-order database results fail closed', async () => {
  await assert.rejects(fetchTimeentryPage({
    find: async () => [entry('b', '2026-07-02'), entry('a', '2026-07-01')],
    baseSelector: {}, scope, query: {},
  }), /out of order/)
  await assert.rejects(fetchTimeentryPage({
    find: async () => [{ _id: 'a', date: '2026-07-01' }],
    baseSelector: {}, scope, query: {},
  }), /invalid date/)
})

test('IDs tie-break entries with identical millisecond dates without duplication', async () => {
  const same = new Date('2026-07-01T12:00:00.000Z')
  const result = await fetchTimeentryPage({
    find: async () => [
      { _id: 'a', date: same }, { _id: 'b', date: same }, { _id: 'c', date: same },
    ],
    baseSelector: {}, scope, query: { limit: '2' },
  })
  const after = decodeCursor(result.page.nextCursor, scope)
  assert.equal(after.id, 'b')
  assert.equal(after.date.toISOString(), same.toISOString())
})

test('date ranges are capped at 366 inclusive calendar days', () => {
  assert.equal(assertDateRangeLimit({
    startDate: new Date('2024-01-01T00:00:00.000Z'),
    endDate: new Date('2024-12-31T23:59:59.999Z'),
  }), MAX_DATE_RANGE_DAYS)
  assert.throws(() => assertDateRangeLimit({
    startDate: new Date('2024-01-01T00:00:00.000Z'),
    endDate: new Date('2025-01-01T23:59:59.999Z'),
  }), (error) => error instanceof PaginationError && error.code === 'date-range-too-large')
  for (const range of [
    { startDate: new Date('invalid'), endDate: new Date() },
    { startDate: new Date('2026-01-02'), endDate: new Date('2026-01-01') },
  ]) {
    assert.throws(() => assertDateRangeLimit(range), TypeError)
  }
  assert.throws(
    () => assertDateRangeLimit({ startDate: new Date(), endDate: new Date() }, 0),
    /positive safe integer/,
  )
})

test('legacy lists query one sentinel row and never silently truncate', async () => {
  const calls = []
  const rows = [{ _id: 'a' }, { _id: 'b' }]
  assert.deepEqual(await fetchBoundedLegacyList({
    find: async (...args) => { calls.push(args); return rows },
    baseSelector: { owner: 'u1' },
    sort: { _id: 1 },
    maxLimit: 2,
  }), rows)
  assert.deepEqual(calls, [[{ owner: 'u1' }, { sort: { _id: 1 }, limit: 3 }]])
  await assert.rejects(fetchBoundedLegacyList({
    find: async () => [{ _id: 'a' }, { _id: 'b' }, { _id: 'c' }],
    baseSelector: {}, sort: { _id: 1 }, maxLimit: 2,
  }), (error) => error instanceof PaginationError && error.code === 'legacy-result-too-large')
  assert.equal(MAX_LEGACY_RESULT_LIMIT, 500)
})

test('bounded aggregations enforce output, time and no-disk-spill limits', async () => {
  const calls = []
  const pipeline = [{ $match: { projectId: 'p1' } }, { $group: { _id: '$userId' } }]
  const rows = [{ _id: 'u1' }, { _id: 'u2' }]
  assert.deepEqual(await fetchBoundedAggregationList({
    aggregate: async (...args) => { calls.push(args); return rows },
    pipeline,
    maxLimit: 2,
  }), rows)
  assert.deepEqual(calls, [[
    [...pipeline, { $limit: 3 }],
    { allowDiskUse: false, maxTimeMS: READ_AGGREGATION_MAX_TIME_MS },
  ]])
  await assert.rejects(fetchBoundedAggregationList({
    aggregate: async () => [{ _id: 1 }, { _id: 2 }],
    pipeline: [], maxLimit: 1,
  }), (error) => error instanceof PaginationError && error.code === 'legacy-result-too-large')
})

test('bounded read helpers reject callbacks that violate their contracts', async () => {
  await assert.rejects(fetchBoundedLegacyList({
    find: async () => null, baseSelector: {}, sort: { _id: 1 },
  }), /must return an array/)
  await assert.rejects(fetchBoundedAggregationList({
    aggregate: async () => null, pipeline: [],
  }), /must return an array/)
  await assert.rejects(fetchBoundedLegacyList({
    find: async () => [], baseSelector: {}, sort: null,
  }), /stable bounded-query sort/)
  await assert.rejects(fetchBoundedAggregationList({
    aggregate: async () => [], pipeline: {},
  }), /pipeline/)
})
