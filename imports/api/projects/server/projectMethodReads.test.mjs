import assert from 'node:assert/strict'
import test from 'node:test'

import {
  aggregateBoundedProjectMethodRows,
  aggregateProjectMethodScalar,
  aggregateProjectMonthTotals,
  bestProjectMatch,
  fetchBoundedProjectMethodRows,
  monthTotalsPipeline,
} from './projectMethodReads.js'

const dates = {
  currentMonthStart: new Date('2026-09-01T00:00:00.000Z'),
  currentMonthEnd: new Date('2026-09-30T23:59:59.999Z'),
  previousMonthStart: new Date('2026-08-01T00:00:00.000Z'),
  previousMonthEnd: new Date('2026-08-31T23:59:59.999Z'),
  beforePreviousMonthStart: new Date('2026-07-01T00:00:00.000Z'),
  beforePreviousMonthEnd: new Date('2026-07-31T23:59:59.999Z'),
}

test('project method queries request only a projection and one sentinel row', async () => {
  const calls = []
  const rows = [{ _id: 'p1' }, { _id: 'p2' }]
  assert.deepEqual(await fetchBoundedProjectMethodRows({
    find: async (...args) => { calls.push(args); return rows },
    selector: { active: true },
    fields: { _id: 1 },
    label: 'Projects',
    maxResults: 2,
  }), rows)
  assert.deepEqual(calls, [[
    { active: true },
    { fields: { _id: 1 }, sort: { _id: 1 }, limit: 3 },
  ]])
  await assert.rejects(fetchBoundedProjectMethodRows({
    find: async () => [...rows, { _id: 'p3' }],
    selector: {}, fields: { _id: 1 }, label: 'Projects', maxResults: 2,
  }), /Projects exceeds the 2-item safety limit/)
})

test('aggregations enforce a sentinel result cap, deadline and no disk spill', async () => {
  const calls = []
  const pipeline = [{ $group: { _id: '$projectId', count: { $sum: '$hours' } } }]
  await aggregateBoundedProjectMethodRows({
    aggregate: async (...args) => { calls.push(args); return [{ _id: 'p1', count: 2 }] },
    pipeline,
    label: 'Distribution',
    maxResults: 2,
  })
  assert.deepEqual(calls, [[
    [...pipeline, { $limit: 3 }],
    { allowDiskUse: false, maxTimeMS: 5000 },
  ]])
  await assert.rejects(aggregateBoundedProjectMethodRows({
    aggregate: async () => [{}, {}], pipeline: [], label: 'Scalar', maxResults: 1,
  }), /Scalar exceeds the 1-item safety limit/)
})

test('scalar aggregations return finite totals and normalize empty/corrupt output', async () => {
  const pipeline = [{ $group: { _id: null, value: { $sum: '$hours' } } }]
  for (const [rows, expected] of [
    [[{ _id: null, value: 4.25 }], 4.25],
    [[], 0],
    [[{ _id: null, value: Number.NaN }], 0],
  ]) {
    assert.equal(await aggregateProjectMethodScalar({
      aggregate: async () => rows, pipeline, label: 'Hours',
    }), expected)
  }
})

test('month totals are grouped in one bounded server-side aggregation', async () => {
  const calls = []
  const options = {
    projectIds: ['p1', 'p2'],
    ...dates,
    aggregate: async (...args) => {
      calls.push(args)
      return [{
        currentMonthHours: 4,
        previousMonthHours: 3.5,
        beforePreviousMonthHours: 2,
      }]
    },
  }
  assert.deepEqual(await aggregateProjectMonthTotals(options), {
    currentMonthHours: 4,
    previousMonthHours: 3.5,
    beforePreviousMonthHours: 2,
  })
  assert.deepEqual(calls[0][0], [...monthTotalsPipeline(options), { $limit: 2 }])
  assert.deepEqual(calls[0][1], { allowDiskUse: false, maxTimeMS: 5000 })
})

test('project search scores bounded projected rows and has deterministic ties', () => {
  const projects = [
    { _id: 'a', name: 'Alpha' },
    { _id: 'b', name: 'Beta' },
    { _id: 'c', name: null },
  ]
  assert.equal(bestProjectMatch(
    projects, 'target', (name) => ({ Alpha: 0.4, Beta: 0.9 }[name]),
  ), 'b')
  assert.equal(bestProjectMatch(projects, 'target', () => 0.5), 'a')
  assert.equal(bestProjectMatch([], 'target', () => 1), null)
  assert.equal(bestProjectMatch(projects, 'target', () => Number.NaN), null)
})

test('invalid helper requests fail before invoking storage', async () => {
  let calls = 0
  await assert.rejects(fetchBoundedProjectMethodRows({
    find: async () => { calls += 1; return [] },
    selector: {}, fields: { _id: 1 }, label: 'Rows', maxResults: 0,
  }), /positive project-method result limit/)
  await assert.rejects(aggregateBoundedProjectMethodRows({
    aggregate: async () => { calls += 1; return [] },
    pipeline: [], label: 'Rows', maxResults: 0,
  }), /positive project-method result limit/)
  assert.equal(calls, 0)
})
