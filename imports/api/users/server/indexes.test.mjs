import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

function dataModule(source) {
  return `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
}

const starts = []
const meteorModule = dataModule(`
  export const Meteor = {
    users: {},
    startup(callback) { globalThis.__userIndexStarts.push(callback) },
  }
`)
globalThis.__userIndexStarts = starts
const source = readFileSync(new URL('./indexes.js', import.meta.url), 'utf8')
  .replaceAll("'meteor/meteor'", JSON.stringify(meteorModule))
const { ensureUserSecurityIndexes } = await import(dataModule(source))

test('API token digests have an exact sparse unique index', async () => {
  const calls = []
  const collection = {
    rawCollection: () => ({
      createIndex: async (...args) => { calls.push(args) },
    }),
  }
  await ensureUserSecurityIndexes(collection)
  assert.deepEqual(calls, [[
    { 'services.titraApiToken.sha256': 1 },
    {
      unique: true,
      name: 'user_titra_api_token_sha256_unique',
      partialFilterExpression: {
        'services.titraApiToken.version': 1,
        'services.titraApiToken.sha256': { $type: 'string' },
      },
    },
  ]])
  assert.equal(starts.length, 1)
})

test('duplicate index failures are fail-closed without exposing a digest', async () => {
  const collection = {
    rawCollection: () => ({
      createIndex: async () => {
        throw Object.assign(new Error('dup key sha256: private-digest'), { code: 11000 })
      },
    }),
  }
  await assert.rejects(
    ensureUserSecurityIndexes(collection),
    (error) => /duplicate cleanup/.test(error.message) && !/private-digest/.test(error.message),
  )
})
