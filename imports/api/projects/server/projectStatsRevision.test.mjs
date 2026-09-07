import assert from 'node:assert/strict'
import test from 'node:test'

import {
  invalidateProjectStats,
  normalizedProjectIds,
  runWithProjectStatsInvalidation,
} from './projectStatsRevision.js'

test('project statistics invalidation performs one deduplicated internal update', async () => {
  const writes = []
  const result = await invalidateProjectStats(
    ['p2', '', 'p1', 'p2', null, 'p1'],
    {
      updateMany: async (...args) => {
        writes.push(args)
        return { matchedCount: 2, modifiedCount: 2 }
      },
    },
  )

  assert.deepEqual(writes, [[
    { _id: { $in: ['p2', 'p1'] } },
    { $inc: { _statsRevision: 1 } },
  ]])
  assert.deepEqual(result, {
    projectIds: ['p2', 'p1'], matchedCount: 2, modifiedCount: 2,
  })
  assert.deepEqual(normalizedProjectIds(() => new Set(['p1', 'p1', 'p3'])), ['p1', 'p3'])
  assert.deepEqual(normalizedProjectIds('project-not-characters'), ['project-not-characters'])
})

test('empty project statistics invalidation performs no write', async () => {
  let writes = 0
  const result = await invalidateProjectStats([], {
    updateMany: async () => { writes += 1 },
  })
  assert.equal(writes, 0)
  assert.deepEqual(result, { projectIds: [], matchedCount: 0, modifiedCount: 0 })
})

test('write wrapper invalidates after success and after uncertain failure', async () => {
  const events = []
  const successful = await runWithProjectStatsInvalidation(['p1'], async () => {
    events.push('write')
    return 'saved'
  }, {
    invalidate: async (ids) => events.push(['invalidate', ...ids]),
  })
  assert.equal(successful, 'saved')
  assert.deepEqual(events, ['write', ['invalidate', 'p1']])

  const writeError = new Error('write acknowledgement lost')
  await assert.rejects(runWithProjectStatsInvalidation(['p2'], async () => {
    throw writeError
  }, {
    invalidate: async (ids) => events.push(['uncertain', ...ids]),
  }), (error) => error === writeError)
  assert.deepEqual(events.at(-1), ['uncertain', 'p2'])
})

test('invalidation failure does not change success or mask a primary error', async () => {
  const writeError = new Error('primary write error')
  const invalidationError = new Error('revision write error')
  const logged = []
  await assert.rejects(runWithProjectStatsInvalidation(['p1'], async () => {
    throw writeError
  }, {
    invalidate: async () => { throw invalidationError },
    logInvalidationError: (error) => logged.push(error),
  }), (error) => error === writeError)
  assert.deepEqual(logged, [invalidationError])

  const successful = await runWithProjectStatsInvalidation(['p1'], async () => 'saved', {
    invalidate: async () => { throw invalidationError },
    logInvalidationError: (error) => logged.push(error),
  })
  assert.equal(successful, 'saved')
  assert.deepEqual(logged, [invalidationError, invalidationError])
})
