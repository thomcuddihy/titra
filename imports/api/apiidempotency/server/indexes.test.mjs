import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

function dataModule(source) {
  return `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
}

const calls = { idempotency: [], timecards: [], tasks: [] }
globalThis.__apiAvailabilityIndexCalls = calls
function collectionModule(name) {
  return dataModule(`
    export default {
      rawCollection: () => ({
        createIndex: async (...args) => (
          globalThis.__apiAvailabilityIndexCalls[${JSON.stringify(name)}].push(args)
        ),
      }),
    }
  `)
}

let source = readFileSync(new URL('./indexes.js', import.meta.url), 'utf8')
source = source
  .replaceAll("'../apiidempotency.js'", JSON.stringify(collectionModule('idempotency')))
  .replaceAll("'../../timecards/timecards.js'", JSON.stringify(collectionModule('timecards')))
  .replaceAll("'../../tasks/tasks.js'", JSON.stringify(collectionModule('tasks')))
const { ensureApiV6Indexes } = await import(dataModule(source))

test('API startup installs indexes for every bounded read access path', async () => {
  await ensureApiV6Indexes()
  assert.deepEqual(calls.timecards, [
    [{ userId: 1, date: 1, _id: 1 }, { name: 'api_timecards_owner_date_id' }],
    [{ projectId: 1, date: 1, _id: 1 }, { name: 'api_timecards_project_date_id' }],
    [{ projectId: 1, userId: 1 }, { name: 'api_timecards_project_user' }],
    [{ projectId: 1, task: 1 }, { name: 'api_timecards_project_task' }],
  ])
  assert.deepEqual(calls.tasks, [
    [{ projectId: 1, _id: 1 }, { name: 'api_tasks_project_id' }],
  ])
  assert.equal(calls.idempotency.length, 3)
})
