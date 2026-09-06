import assert from 'node:assert/strict'
import test from 'node:test'

import {
  apiTokenDigest,
  findUserForAPIToken,
  tokenHashDocument,
  validNewAPIToken,
} from './apiTokenSecurity.js'

test('new API tokens are bounded URL-safe bearer values and hash deterministically', () => {
  const token = 'Abcdefghijklmnop_1234.~'
  assert.equal(validNewAPIToken(token), true)
  assert.match(apiTokenDigest(token), /^[0-9a-f]{64}$/)
  assert.equal(apiTokenDigest(token), apiTokenDigest(token))
  assert.notEqual(apiTokenDigest(token), apiTokenDigest(`${token}x`))
  assert.deepEqual(tokenHashDocument(token, new Date('2026-09-03T00:00:00.000Z')), {
    version: 1,
    sha256: apiTokenDigest(token),
    updatedAt: new Date('2026-09-03T00:00:00.000Z'),
  })
  for (const invalid of [
    '', 'short', 'x'.repeat(513), 'has whitespace token', 'has,comma', 'not/urlsafe', 42,
  ]) {
    assert.equal(validNewAPIToken(invalid), false, String(invalid))
  }
})

test('hashed token authentication never queries plaintext after a verified match', async () => {
  const token = 'hashed-token-1234567890'
  const user = {
    _id: 'user-1',
    services: { titraApiToken: { version: 1, sha256: apiTokenDigest(token) } },
  }
  const selectors = []
  const result = await findUserForAPIToken(token, {
    findUser: async (selector) => {
      selectors.push(selector)
      return user
    },
  })
  assert.equal(result, user)
  assert.equal(selectors.length, 1)
  assert.equal(JSON.stringify(selectors[0]).includes(token), false)
})

test('legacy token authentication migrates by guarded callback without changing the credential', async () => {
  const token = 'legacy-token-123456789'
  const user = { _id: 'legacy', profile: { APItoken: token } }
  const calls = []
  const result = await findUserForAPIToken(token, {
    findUser: async (selector) => {
      calls.push({ type: 'find', selector })
      return Object.hasOwn(selector, 'profile.APItoken') ? user : null
    },
    migrateLegacyToken: async (request) => {
      calls.push({ type: 'migrate', request })
      return true
    },
  })
  assert.equal(result, user)
  assert.deepEqual(calls.at(-1).request, {
    userId: 'legacy', token, digest: apiTokenDigest(token), version: 1,
  })
})

test('failed and conflicting token migrations fail closed while same-user races reconcile', async () => {
  const token = 'legacy-token-123456789'
  const digest = apiTokenDigest(token)
  const legacy = { _id: 'legacy', profile: { APItoken: token } }
  let call = 0
  const reconciled = await findUserForAPIToken(token, {
    findUser: async () => {
      call += 1
      if (call === 1) return null
      if (call === 2) return legacy
      return { _id: 'legacy', services: { titraApiToken: { version: 1, sha256: digest } } }
    },
    migrateLegacyToken: async () => false,
  })
  assert.equal(reconciled?._id, 'legacy')

  call = 0
  assert.equal(await findUserForAPIToken(token, {
    findUser: async () => {
      call += 1
      if (call === 1) return null
      if (call === 2) return legacy
      return { _id: 'other', services: { titraApiToken: { version: 1, sha256: digest } } }
    },
    migrateLegacyToken: async () => false,
  }), false)
})

test('malformed, inactive and mismatched stored credentials never authenticate', async () => {
  for (const candidate of [
    null,
    { _id: 'inactive', inactive: true, profile: { APItoken: 'valid-legacy-token-123' } },
    { _id: 'wrong', profile: { APItoken: 'another-token' } },
  ]) {
    assert.equal(await findUserForAPIToken('valid-legacy-token-123', {
      findUser: async (selector) => (Object.hasOwn(selector, 'profile.APItoken') ? candidate : null),
    }), false)
  }
  assert.equal(await findUserForAPIToken('has whitespace', { findUser: async () => ({}) }), false)
})
