import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

function dataModule(source) {
  return `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
}

let source = readFileSync(new URL('./indexes.js', import.meta.url), 'utf8')
source = source
  .replaceAll("'meteor/meteor'", JSON.stringify(dataModule(`
    export const Meteor = { startup: (callback) => { globalThis.__webhookIndexStartup = callback } }
  `)))
  .replaceAll("'../webhookverification.js'", JSON.stringify(dataModule('export default {}')))
const indexes = await import(dataModule(source))

test('secure endpoint identity has a unique partial database index', async () => {
  const calls = []
  const collection = {
    rawCollection: () => ({
      createIndex: async (...args) => { calls.push(args); return 'webhook_secure_endpoint_unique' },
    }),
  }
  await indexes.ensureWebhookVerificationIndexes(collection)
  assert.deepEqual(calls, [[
    { endpointId: 1 },
    {
      unique: true,
      name: 'webhook_secure_endpoint_unique',
      partialFilterExpression: {
        endpointId: { $type: 'string' }, securityVersion: 2, mappingVersion: 1,
      },
    },
  ]])
})
