import assert from 'node:assert/strict'
import test from 'node:test'

import {
  personalSuggestionSelector,
  refreshPersonalTaskSuggestion,
} from './taskSuggestions.js'

test('personal suggestion selector cannot match predefined project tasks', () => {
  assert.deepEqual(personalSuggestionSelector('u1', 'Task'), {
    userId: 'u1', name: 'Task', projectId: null,
  })
})

test('new suggestions contain no timecard custom fields and initialize revision', async () => {
  const calls = []
  await refreshPersonalTaskSuggestion({
    userId: 'u1', name: 'Task', lastUsed: new Date('2026-09-01T00:00:00Z'),
  }, {
    insertOne: async (document) => calls.push(document),
    updateOne: async () => 0,
  })
  assert.deepEqual(calls, [{
    userId: 'u1', name: 'Task', lastUsed: new Date('2026-09-01T00:00:00Z'),
    taskSuggestionRevision: 0,
  }])
})

test('existing personal suggestions refresh monotonically with an increment', async () => {
  const calls = []
  const lastUsed = new Date('2026-09-01T00:00:00Z')
  await refreshPersonalTaskSuggestion({ userId: 'u1', name: 'Task', lastUsed }, {
    insertOne: async () => { throw new Error('unexpected') },
    updateOne: async (...args) => { calls.push(args); return 1 },
  })
  assert.deepEqual(calls[0][0], personalSuggestionSelector('u1', 'Task'))
  assert.equal(calls[0][0].projectId, null)
  assert.deepEqual(calls[0][1].$inc, { taskSuggestionRevision: 1 })
  assert.deepEqual(calls[0][1].$max, { lastUsed })
})

test('concurrent first refreshes converge on one personal suggestion', async () => {
  const records = []
  const dependencies = {
    updateOne: async (selector, modifier) => {
      const record = records.find((value) => (
        value.userId === selector.userId
        && value.name === selector.name
        && (value.projectId === undefined || value.projectId === null)
      ))
      if (!record) return 0
      if (record.lastUsed < modifier.$max.lastUsed) record.lastUsed = modifier.$max.lastUsed
      record.taskSuggestionRevision += modifier.$inc.taskSuggestionRevision
      return 1
    },
    insertOne: async (document) => {
      await Promise.resolve()
      if (records.some((value) => (
        value.userId === document.userId
        && value.name === document.name
        && value.projectId === undefined
      ))) throw Object.assign(new Error('duplicate'), { code: 11000 })
      records.push({ ...document })
      return 'suggestion-1'
    },
  }
  const instants = Array.from(
    { length: 12 }, (_, index) => new Date(`2026-09-01T00:00:${String(index).padStart(2, '0')}Z`),
  )
  await Promise.all(instants.map((lastUsed) => refreshPersonalTaskSuggestion({
    userId: 'u1', name: 'Concurrent task', lastUsed,
  }, dependencies)))
  assert.equal(records.length, 1)
  assert.equal(records[0].lastUsed.toISOString(), instants.at(-1).toISOString())
  assert.equal(records[0].taskSuggestionRevision, instants.length - 1)
})

test('non-duplicate insert failures are never retried as races', async () => {
  let updates = 0
  await assert.rejects(refreshPersonalTaskSuggestion({ userId: 'u1', name: 'Task' }, {
    updateOne: async () => { updates += 1; return 0 },
    insertOne: async () => { throw new Error('database unavailable') },
  }), /database unavailable/)
  assert.equal(updates, 1)
})
