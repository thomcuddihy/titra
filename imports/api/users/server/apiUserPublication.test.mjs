import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  API_SAFE_USER_FIELDS,
  IMPLICIT_CURRENT_USER_FIELDS,
  configureAPIUserPublication,
} from './apiUserPublication.js'

test('browser user projections exclude plaintext and hashed API credentials', () => {
  assert.deepEqual(IMPLICIT_CURRENT_USER_FIELDS, { _id: 1 })
  for (const forbidden of [
    'profile.APItoken',
    'services',
    'services.titraApiToken',
    'services.titraApiToken.sha256',
  ]) assert.equal(API_SAFE_USER_FIELDS[forbidden], undefined, forbidden)
  assert.equal(API_SAFE_USER_FIELDS['profile.timerId'], 1)
  assert.equal(API_SAFE_USER_FIELDS['profile.timerRevision'], 1)
  // This branch intentionally isolates API-token protection; broader
  // integration-secret privacy hardening is maintained separately.
  assert.equal(API_SAFE_USER_FIELDS['profile.siwapptoken'], 1)
  assert.equal(API_SAFE_USER_FIELDS['profile.zammadtoken'], 1)
  assert.equal(API_SAFE_USER_FIELDS['profile.gitlabtoken'], 1)
})

test('Accounts and userRoles are wired to the API-safe projections', () => {
  let configured
  configureAPIUserPublication({ setDefaultPublishFields(fields) { configured = fields } })
  assert.deepEqual(configured, { _id: 1 })

  const publicationSource = readFileSync(new URL('./publications.js', import.meta.url), 'utf8')
  assert.match(publicationSource, /fields:\s*API_SAFE_USER_FIELDS/u)
  const accountSource = readFileSync(
    new URL('../../../startup/server/useraccounts-configuration.js', import.meta.url), 'utf8',
  )
  assert.match(accountSource, /configureAPIUserPublication\(Accounts\)/u)
})
