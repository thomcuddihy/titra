import assert from 'node:assert/strict'
import test from 'node:test'

import {
  appendWriteOnlyProfileSettings,
  MAX_WRITE_ONLY_SECRET_LENGTH,
} from './settingsSecrets.js'

test('absent, empty and whitespace-only secret placeholders preserve stored settings', () => {
  const set = appendWriteOnlyProfileSettings({ 'profile.theme': 'dark' }, {
    siwapptoken: '   ', zammadtoken: undefined, gitlabtoken: null,
  })
  assert.deepEqual(set, { 'profile.theme': 'dark' })
})

test('secret replacements reject header injection, malformed Unicode and oversized values', () => {
  for (const zammadtoken of [
    'token\r\nX-Injected: true',
    'bad\ud800token',
    'x'.repeat(MAX_WRITE_ONLY_SECRET_LENGTH + 1),
  ]) {
    assert.throws(
      () => appendWriteOnlyProfileSettings({}, { zammadtoken }, { sealSecret: (value) => value }),
      /Invalid write-only secret/,
    )
  }
  assert.equal(
    appendWriteOnlyProfileSettings({}, {
      zammadtoken: 'x'.repeat(MAX_WRITE_ONLY_SECRET_LENGTH),
    }, { sealSecret: (value) => value })['profile.zammadtoken'].length,
    MAX_WRITE_ONLY_SECRET_LENGTH,
  )
})

test('non-blank secret replacements are exact and do not mutate the ordinary settings map', () => {
  const ordinary = { 'profile.theme': 'light' }
  const set = appendWriteOnlyProfileSettings(ordinary, {
    siwapptoken: ' leading-is-deliberate ',
    zammadtoken: 'zammad-new',
    gitlabtoken: 'gitlab-new',
  }, { sealSecret: (value) => ({ sealed: value }) })
  assert.deepEqual(ordinary, { 'profile.theme': 'light' })
  assert.deepEqual(set, {
    'profile.theme': 'light',
    'profile.siwapptoken': { sealed: ' leading-is-deliberate ' },
    'profile.zammadtoken': { sealed: 'zammad-new' },
    'profile.gitlabtoken': { sealed: 'gitlab-new' },
  })
})

test('non-blank credentials cannot accidentally fall back to plaintext storage', () => {
  assert.throws(
    () => appendWriteOnlyProfileSettings({}, { siwapptoken: 'secret' }),
    /credential sealer/i,
  )
})
