import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

function dataModule(source) {
  return `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
}

let source = readFileSync(new URL('./indexes.js', import.meta.url), 'utf8')
source = source
  .replaceAll("'meteor/meteor'", JSON.stringify(dataModule(`
    export const Meteor = { startup: (callback) => { globalThis.__taskIndexStartup = callback } }
  `)))
  .replaceAll("'../tasks.js'", JSON.stringify(dataModule('export default {}')))
const indexes = await import(dataModule(source))

test('startup creates the natural-key unique partial personal-suggestion index', async () => {
  const calls = []
  const collection = {
    rawCollection: () => ({
      createIndex: async (...args) => { calls.push(args); return 'index-name' },
    }),
  }
  await indexes.ensureTaskIndexes(collection)
  assert.deepEqual(calls, [[
    { userId: 1, name: 1 },
    {
      unique: true,
      name: 'task_personal_suggestion_user_name_unique',
      partialFilterExpression: {
        projectId: null,
        userId: { $type: 'string' },
        name: { $type: 'string' },
      },
    },
  ]])
})

test('duplicate startup failure is fail-closed without reflecting private index keys', async () => {
  const collection = {
    rawCollection: () => ({
      createIndex: async () => {
        throw Object.assign(new Error('dup key { userId: "private-user", name: "Secret task" }'), {
          code: 11000,
        })
      },
    }),
  }
  await assert.rejects(
    indexes.ensureTaskIndexes(collection),
    (error) => /duplicate cleanup/.test(error.message)
      && !/private-user|Secret task|dup key/.test(error.message),
  )
})
