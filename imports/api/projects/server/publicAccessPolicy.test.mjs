import assert from 'node:assert/strict'
import test from 'node:test'

import {
  PublicProjectPolicyError,
  assertPublicProjectValueAllowed,
  canViewProjectUnderPolicy,
  projectAudienceClauses,
  publicProjectsDisabled,
} from './publicAccessPolicy.js'

test('only exact boolean true disables public-project access', () => {
  assert.equal(publicProjectsDisabled(true), true)
  for (const value of [false, undefined, null, 'true', 1]) {
    assert.equal(publicProjectsDisabled(value), false)
  }
})

test('disabled policy removes the public audience without affecting membership', () => {
  assert.deepEqual(projectAudienceClauses('u1', true), [
    { userId: 'u1' }, { admins: 'u1' }, { team: 'u1' },
  ])
  assert.equal(canViewProjectUnderPolicy({ public: true }, 'u1', true), false)
  assert.equal(canViewProjectUnderPolicy({ team: ['u1'], public: true }, 'u1', true), true)
})

test('creating or changing a project to public is rejected while disabled', () => {
  assert.throws(
    () => assertPublicProjectValueAllowed(true, true),
    (error) => error instanceof PublicProjectPolicyError,
  )
  assert.equal(assertPublicProjectValueAllowed(false, true), false)
  assert.equal(assertPublicProjectValueAllowed(true, false), true)
})
