import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  GoogleOAuthSecurityError,
  normalizeGoogleAuthorizationCode,
  normalizeGoogleTokenResponse,
  normalizeGrantedScopes,
  sealGoogleServiceData,
} from './googleOAuthSecurity.js'

const rejects = (callback) => assert.throws(callback, GoogleOAuthSecurityError)

test('authorization codes and scopes are opaque, bounded and control-free', () => {
  assert.equal(normalizeGoogleAuthorizationCode('code-123'), 'code-123')
  for (const value of ['', null, 1, `a\nsecret`, 'x'.repeat(4097)]) {
    rejects(() => normalizeGoogleAuthorizationCode(value))
  }
  assert.deepEqual(normalizeGrantedScopes('calendar  gmail calendar'), ['calendar', 'gmail'])
  for (const value of ['', null, 'scope\nheader', `${'a'.repeat(513)} other`]) {
    rejects(() => normalizeGrantedScopes(value))
  }
})

test('token responses require a bounded bearer token, granted scopes and sane expiry', () => {
  const normalized = normalizeGoogleTokenResponse({
    access_token: 'access', refresh_token: 'refresh', token_type: 'Bearer',
    expires_in: 3600, scope: 'calendar gmail',
  }, 1000)
  assert.deepEqual(normalized, {
    accessToken: 'access', refreshToken: 'refresh', scopes: ['calendar', 'gmail'],
    expiresAt: 3601000,
  })
  for (const response of [
    null,
    { access_token: 'a', expires_in: 3600, scope: 'calendar', error: 'denied' },
    { access_token: '', expires_in: 3600, scope: 'calendar' },
    { access_token: 'a', token_type: 'Basic', expires_in: 3600, scope: 'calendar' },
    { access_token: 'a', expires_in: 0, scope: 'calendar' },
    { access_token: 'a', expires_in: 999999999, scope: 'calendar' },
    { access_token: 'a', expires_in: 3600, scope: '' },
  ]) rejects(() => normalizeGoogleTokenResponse(response))
})

test('persisted Google bearer credentials are sealed and the ID token is discarded', () => {
  const calls = []
  const result = sealGoogleServiceData({
    accessToken: 'access', refreshToken: 'refresh', scopes: ['calendar'], expiresAt: 42,
  }, 'user-1', (value) => {
    calls.push(value)
    return { sealed: value }
  })
  assert.deepEqual(calls, ['access', 'refresh'])
  assert.deepEqual(result, {
    id: 'user-1', accessToken: { sealed: 'access' }, refreshToken: { sealed: 'refresh' },
    scope: ['calendar'], expiresAt: 42,
  })
  assert.equal(result.idToken, undefined)
})

test('Google server uses bounded HTTP handling without token-bearing validation URLs', () => {
  const source = readFileSync(new URL('./google_server.js', import.meta.url), 'utf8')
  assert.match(source, /fetchOidcJson/u)
  assert.match(source, /OAuth\.sealSecret/u)
  assert.doesNotMatch(source, /tokeninfo\?/u)
  assert.doesNotMatch(source, /idToken|id_token/u)
  assert.doesNotMatch(source, /request\.json\(\)/u)
})
