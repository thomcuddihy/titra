import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  MAX_LOG_ARRAY_ITEMS,
  MAX_LOG_JSON_CHARS,
  MAX_LOG_OBJECT_KEYS,
  MAX_LOG_STRING_CHARS,
  REDACTED,
  sensitiveFieldName,
  serializeTransactionArguments,
  serializeTransactionUser,
} from './transactionLogSecurity.js'

test('sensitive field matching covers credentials, executable payloads, and email identities', () => {
  for (const key of [
    'password', 'client_secret', 'APItoken', 'api-key', 'Authorization',
    'privateKey', 'access_key', 'credentials', 'processData', 'emails', 'wekanurl',
  ]) assert.equal(sensitiveFieldName(key), true, key)
  assert.equal(sensitiveFieldName('taskName'), false)
})

test('project transaction history never stores plaintext Wekan credentials', () => {
  const secretUrl = 'https://wekan.example.test/api/boards?authToken=wekan-secret'
  const serialized = serializeTransactionArguments({
    projectId: 'project-1',
    projectArray: [
      { name: 'name', value: 'Visible project' },
      { name: 'wekanurl', value: secretUrl },
    ],
  }, 'updateProject')

  assert.deepEqual(JSON.parse(serialized), {
    projectId: 'project-1',
    projectArray: [
      { name: 'name', value: 'Visible project' },
      { name: 'wekanurl', value: REDACTED },
    ],
  })
  assert.equal(serialized.includes('wekan-secret'), false)
})

test('transaction arguments recursively redact secrets without mutating the method arguments', () => {
  const args = {
    profile: {
      password: 'password-value',
      APItoken: 'api-token-value',
      emails: [{ address: 'person@example.test' }],
    },
    request: {
      headers: { Authorization: 'Bearer authorization-value' },
      configuration: { clientSecret: 'client-secret-value' },
    },
    processData: 'return dangerousExecutable',
    ordinary: { task: 'Visible task' },
  }
  const serialized = serializeTransactionArguments(args, 'example.method')
  const logged = JSON.parse(serialized)
  assert.equal(logged.profile.password, REDACTED)
  assert.equal(logged.profile.APItoken, REDACTED)
  assert.equal(logged.profile.emails, REDACTED)
  assert.equal(logged.request.headers.Authorization, REDACTED)
  assert.equal(logged.request.configuration.clientSecret, REDACTED)
  assert.equal(logged.processData, REDACTED)
  assert.equal(logged.ordinary.task, 'Visible task')
  for (const secret of [
    'password-value', 'api-token-value', 'person@example.test',
    'authorization-value', 'client-secret-value', 'dangerousExecutable',
  ]) assert.equal(serialized.includes(secret), false, secret)
  assert.equal(args.profile.password, 'password-value')
})

test('known and future global setting values are write-only in transaction history', () => {
  const args = [
    { name: 'google_clientid', value: 'google-value' },
    { name: 'openai_apikey', value: 'openai-value' },
    { name: 'futureBenignName', value: 'future-value' },
  ]
  const serialized = serializeTransactionArguments(args, 'updateGlobalSettings')
  assert.deepEqual(JSON.parse(serialized), [
    { name: 'google_clientid', value: REDACTED },
    { name: 'openai_apikey', value: REDACTED },
    { name: 'futureBenignName', value: REDACTED },
  ])
  assert.equal(serialized.includes('google-value'), false)
  assert.equal(serialized.includes('openai-value'), false)
  assert.equal(serialized.includes('future-value'), false)
})

test('recursive transaction logs are bounded for strings, arrays, objects, depth, cycles, and total size', () => {
  const cyclic = { label: 'root' }
  cyclic.self = cyclic
  const serialized = serializeTransactionArguments({
    long: 'x'.repeat(MAX_LOG_STRING_CHARS + 100),
    list: Array.from({ length: MAX_LOG_ARRAY_ITEMS + 10 }, (_, index) => index),
    object: Object.fromEntries(Array.from(
      { length: MAX_LOG_OBJECT_KEYS + 10 },
      (_, index) => [`key${index}`, index],
    )),
    deep: { a: { b: { c: { d: { e: { f: { hidden: 'value' } } } } } } },
    cyclic,
  }, 'example.method')
  assert.ok(serialized.length <= MAX_LOG_JSON_CHARS)
  const logged = JSON.parse(serialized)
  assert.match(logged.long, /\[TRUNCATED\]$/)
  assert.equal(logged.list.length, MAX_LOG_ARRAY_ITEMS + 1)
  assert.equal(logged.object.__truncatedKeys, 10)
  assert.equal(logged.deep.a.b.c.d.e, '[MAX DEPTH]')
  assert.equal(logged.cyclic.self, '[CIRCULAR]')

  const totalBound = serializeTransactionArguments(
    Array.from({ length: MAX_LOG_ARRAY_ITEMS }, () => 'y'.repeat(MAX_LOG_STRING_CHARS)),
    'example.method',
  )
  assert.ok(totalBound.length <= MAX_LOG_JSON_CHARS)
  const totalBoundResult = JSON.parse(totalBound)
  assert.equal(totalBoundResult.truncated, true)
  assert.ok(totalBoundResult.originalCharacters > MAX_LOG_JSON_CHARS)
})

test('transaction user summaries omit email fields and helper integration uses safe serializers', () => {
  const serialized = serializeTransactionUser({
    _id: 'user-1',
    profile: { name: 'Example User' },
    emails: [{ address: 'identity@example.test' }],
    isAdmin: true,
  })
  assert.deepEqual(JSON.parse(serialized), {
    _id: 'user-1', name: 'Example User', isAdmin: true,
  })
  assert.equal(serialized.includes('identity@example.test'), false)

  const helpers = readFileSync(new URL('./server_method_helpers.js', import.meta.url), 'utf8')
  const mixin = helpers.slice(
    helpers.indexOf('function transactionLogMixin'),
    helpers.indexOf('/**\n * Calculates the edit distance'),
  )
  assert.match(mixin, /serializeTransactionUser\(user\)/)
  assert.match(mixin, /serializeTransactionArguments\(args, this\.name\)/)
  assert.doesNotMatch(mixin, /emails/)
})
