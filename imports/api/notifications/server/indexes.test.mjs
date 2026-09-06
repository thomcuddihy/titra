import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

function dataModule(source) {
  return `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
}

const starts = []
globalThis.__dailyMailIndexStarts = starts
const meteorModule = dataModule(`
  export const Meteor = {
    startup(callback) { globalThis.__dailyMailIndexStarts.push(callback) },
  }
`)
let source = readFileSync(new URL('./indexes.js', import.meta.url), 'utf8')
source = source
  .replaceAll("'meteor/meteor'", JSON.stringify(meteorModule))
  .replaceAll("'../dailymaillimit.js'", JSON.stringify(dataModule('export default {}')))
const { ensureDailyMailLimitIndexes } = await import(dataModule(source))

test('daily mail indexes expire v2 fences and bound the legacy-day lookup', async () => {
  const calls = []
  const collection = {
    rawCollection: () => ({
      createIndex: async (...args) => { calls.push(args) },
    }),
  }
  await ensureDailyMailLimitIndexes(collection)
  assert.deepEqual(calls, [
    [
      { expiresAt: 1 },
      { expireAfterSeconds: 0, name: 'daily_mail_limit_expiry' },
    ],
    [
      { email: 1, timestamp: 1 },
      {
        name: 'daily_mail_legacy_lookup',
        partialFilterExpression: {
          email: { $type: 'string' },
          timestamp: { $type: 'date' },
        },
      },
    ],
  ])
  assert.equal(starts.length, 1)
})

test('index creation failures remain fail-closed', async () => {
  const collection = {
    rawCollection: () => ({
      createIndex: async () => { throw new Error('synthetic index failure') },
    }),
  }
  await assert.rejects(
    ensureDailyMailLimitIndexes(collection),
    /synthetic index failure/,
  )
})
