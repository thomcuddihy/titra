import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  OAuthEncryptionConfigurationError,
  normalizeOAuthSecretKey,
  oauthEncryptionConfigured,
  requireOAuthEncryptionConfigured,
} from './oauthEncryptionPolicy.js'

const KEY = 'MDEyMzQ1Njc4OWFiY2RlZg=='

test('OAuth encryption accepts only canonical base64 encoding of exactly 16 bytes', () => {
  assert.equal(normalizeOAuthSecretKey(undefined), undefined)
  assert.equal(normalizeOAuthSecretKey(''), undefined)
  assert.equal(normalizeOAuthSecretKey(KEY), KEY)
  for (const value of [
    null, 12, 'short', 'MDEyMzQ1Njc4OWFiY2Rl',
    'MDEyMzQ1Njc4OWFiY2RlZg', 'MDEyMzQ1Njc4OWFiY2RlZg==\n',
  ]) assert.throws(() => normalizeOAuthSecretKey(value), OAuthEncryptionConfigurationError)
})

test('credential writes can require an explicitly configured persistent key', () => {
  assert.equal(oauthEncryptionConfigured({}), false)
  assert.equal(oauthEncryptionConfigured({ TITRA_OAUTH_SECRET_KEY: KEY }), true)
  assert.equal(requireOAuthEncryptionConfigured({ TITRA_OAUTH_SECRET_KEY: KEY }), KEY)
  assert.throws(() => requireOAuthEncryptionConfigured({}), OAuthEncryptionConfigurationError)
  assert.throws(
    () => oauthEncryptionConfigured({ TITRA_OAUTH_SECRET_KEY: 'invalid' }),
    OAuthEncryptionConfigurationError,
  )
})

test('server bootstrap loads the validated key through Accounts before credential migration', () => {
  const accounts = readFileSync(new URL(
    '../startup/server/useraccounts-configuration.js', import.meta.url,
  ), 'utf8')
  const startupIndex = readFileSync(new URL(
    '../startup/server/index.js', import.meta.url,
  ), 'utf8')

  assert.match(accounts, /const oauthSecretKey = oauthEncryptionKey\(\)/u)
  assert.match(accounts, /accountsConfiguration\.oauthSecretKey = oauthSecretKey/u)
  assert.match(accounts, /Accounts\.config\(accountsConfiguration\)/u)
  assert.ok(
    startupIndex.indexOf("import './useraccounts-configuration.js'")
      < startupIndex.indexOf("import './startup.js'"),
  )
})
