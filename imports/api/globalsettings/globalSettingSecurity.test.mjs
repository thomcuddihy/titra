import assert from 'node:assert/strict'
import test from 'node:test'

import {
  GLOBAL_SETTING_SOURCE_FIELDS,
  globalSettingDocuments,
  isWriteOnlyGlobalSetting,
  shouldPreserveWriteOnlySetting,
  shouldSealGlobalSetting,
} from './globalSettingSecurity.js'

const settings = new Map([
  ['public', {
    _id: 'public', name: 'unit', description: 'Unit', type: 'text', value: '€',
    category: 'global', accidentalFutureField: 'must-not-publish',
  }],
  ['known', {
    _id: 'known', name: 'google_clientid', description: 'Client', type: 'text',
    value: 'client-secret-value', category: 'interfaces', restricted: false,
  }],
  ['restricted', {
    _id: 'restricted', name: 'futureCredential', description: 'Future', type: 'text',
    value: 'future-secret-value', category: 'interfaces', restricted: true,
  }],
  ['password', {
    _id: 'password', name: 'futurePassword', description: 'Password', type: 'password',
    value: '', category: 'interfaces',
  }],
])

test('write-only classification fails closed for known, restricted, and password settings', () => {
  assert.equal(isWriteOnlyGlobalSetting(settings.get('public')), false)
  assert.equal(isWriteOnlyGlobalSetting(settings.get('known')), true)
  assert.equal(isWriteOnlyGlobalSetting(settings.get('restricted')), true)
  assert.equal(isWriteOnlyGlobalSetting(settings.get('password')), true)
  assert.equal(isWriteOnlyGlobalSetting({ name: 'future', type: 'PASSWORD' }), true)
})

test('admins receive secret metadata and configured presence but never secret values', () => {
  const published = globalSettingDocuments({
    user: { _id: 'admin', isAdmin: true },
    userId: 'admin',
    documents: settings,
  })
  assert.deepEqual(published.get('public'), {
    name: 'unit', description: 'Unit', type: 'text', category: 'global', value: '€',
  })
  assert.deepEqual(published.get('known'), {
    name: 'google_clientid', description: 'Client', type: 'text', category: 'interfaces',
    restricted: false, configured: true,
  })
  assert.equal(JSON.stringify([...published]).includes('client-secret-value'), false)
  assert.equal(JSON.stringify([...published]).includes('future-secret-value'), false)
  assert.equal(published.get('password').configured, false)
})

test('ordinary, demoted, inactive, and absent users receive public settings only', () => {
  for (const user of [
    undefined,
    { _id: 'user', isAdmin: false },
    { _id: 'user', isAdmin: true, inactive: true },
  ]) {
    const published = globalSettingDocuments({ user, userId: 'user', documents: settings })
    assert.deepEqual([...published.keys()], ['public'])
  }
})

test('blank write-only submissions preserve stored values while explicit replacements remain valid', () => {
  assert.equal(shouldPreserveWriteOnlySetting(settings.get('known'), ''), true)
  assert.equal(shouldPreserveWriteOnlySetting(settings.get('known'), '   '), true)
  assert.equal(shouldPreserveWriteOnlySetting(settings.get('restricted'), ''), true)
  assert.equal(shouldPreserveWriteOnlySetting(settings.get('password'), ''), true)
  assert.equal(shouldPreserveWriteOnlySetting(settings.get('known'), 'replacement'), false)
  assert.equal(shouldPreserveWriteOnlySetting(settings.get('public'), ''), false)
})

test('only actual stored credentials are encrypted at rest', () => {
  assert.equal(shouldSealGlobalSetting('google_secret'), true)
  assert.equal(shouldSealGlobalSetting('openai_apikey'), true)
  assert.equal(shouldSealGlobalSetting('google_clientid'), false)
  assert.equal(shouldSealGlobalSetting('futureCredential'), false)
})

test('source projection is an explicit allowlist containing the value only for server-side mapping', () => {
  assert.deepEqual(GLOBAL_SETTING_SOURCE_FIELDS, {
    name: 1, description: 1, type: 1, value: 1, category: 1, restricted: 1,
  })
})
