import assert from 'node:assert/strict'
import test from 'node:test'

import { PaginationError } from './apiPagination.js'
import { fetchBoundedProjectTaskStats } from './projectTaskStats.js'

function taskFinder(tasks, calls) {
  return async (selector, options) => {
    calls.push({ selector, options })
    return tasks.slice(0, options.limit)
  }
}

test('task statistics use one grouped, bounded aggregation', async () => {
  const findCalls = []
  const aggregateCalls = []
  const payload = await fetchBoundedProjectTaskStats({
    projectId: 'p1',
    maxTasks: 4,
    findTasks: taskFinder([
      { _id: 't1', name: 'Build', estimatedHours: 4, start: 's1', end: 'e1' },
      { _id: 't2', name: 'Review', estimatedHours: 1.5, start: 's2', end: 'e2' },
      { _id: 't3', name: 'Build', estimatedHours: 2 },
    ], findCalls),
    aggregateTimecards: async (...args) => {
      aggregateCalls.push(args)
      return [{ _id: 'Build', totalHours: 3.25 }, { _id: 'Review', totalHours: 2 }]
    },
  })
  assert.deepEqual(findCalls, [{
    selector: { projectId: 'p1' },
    options: { sort: { _id: 1 }, limit: 5 },
  }])
  assert.equal(aggregateCalls.length, 1)
  assert.deepEqual(aggregateCalls[0], [[
    { $match: { projectId: 'p1', task: { $in: ['Build', 'Review'] } } },
    { $group: { _id: '$task', totalHours: { $sum: '$hours' } } },
    { $sort: { _id: 1 } },
    { $limit: 5 },
  ], { allowDiskUse: false, maxTimeMS: 5000 }])
  assert.deepEqual(payload, {
    projectId: 'p1',
    totalEstimatedHours: 7.5,
    totalActualHours: 8.5,
    tasks: [
      {
        taskId: 't1', taskName: 'Build', estimatedHours: 4, actualHours: 3.25,
        variance: -0.75, start: 's1', end: 'e1',
      },
      {
        taskId: 't2', taskName: 'Review', estimatedHours: 1.5, actualHours: 2,
        variance: 0.5, start: 's2', end: 'e2',
      },
      {
        taskId: 't3', taskName: 'Build', estimatedHours: 2, actualHours: 3.25,
        variance: 1.25, start: undefined, end: undefined,
      },
    ],
  })
})

test('empty or malformed task names do not trigger broad timecard aggregation', async () => {
  let aggregates = 0
  const payload = await fetchBoundedProjectTaskStats({
    projectId: 'p1',
    findTasks: async () => [{ _id: 't1', estimatedHours: Number.NaN }],
    aggregateTimecards: async () => { aggregates += 1; return [] },
  })
  assert.equal(aggregates, 0)
  assert.equal(payload.tasks[0].estimatedHours, 0)
  assert.equal(payload.tasks[0].actualHours, 0)
})

test('task ceiling is checked before aggregation', async () => {
  let aggregates = 0
  await assert.rejects(fetchBoundedProjectTaskStats({
    projectId: 'p1',
    maxTasks: 2,
    findTasks: async () => [
      { _id: 't1', name: 'A' }, { _id: 't2', name: 'B' }, { _id: 't3', name: 'C' },
    ],
    aggregateTimecards: async () => { aggregates += 1; return [] },
  }), (error) => error instanceof PaginationError && error.code === 'legacy-result-too-large')
  assert.equal(aggregates, 0)
})

test('invalid grouped totals are not reflected as non-finite statistics', async () => {
  const payload = await fetchBoundedProjectTaskStats({
    projectId: 'p1',
    findTasks: async () => [{ _id: 't1', name: 'A', estimatedHours: '4' }],
    aggregateTimecards: async () => [{ _id: 'A', totalHours: Number.POSITIVE_INFINITY }],
  })
  assert.deepEqual(payload.tasks[0], {
    taskId: 't1', taskName: 'A', estimatedHours: 0, actualHours: 0,
    variance: 0, start: undefined, end: undefined,
  })
})
