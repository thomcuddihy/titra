import assert from 'node:assert/strict'
import test from 'node:test'

import {
  AdminSafetyError,
  assertAdministrativeContinuity,
  reserveInitialAdministrator,
} from './adminSafety.js'

test('only an empty installation can reserve the initial administrator marker', async () => {
  const calls = []
  const deps = {
    countUsers: async () => 0,
    findActiveAdministrator: async () => null,
    claimBootstrap: async (userId) => { calls.push(userId); return { upsertedCount: 1 } },
  }
  assert.equal(await reserveInitialAdministrator({ userId: 'u1' }, deps), true)
  assert.deepEqual(calls, ['u1'])
  deps.countUsers = async () => 1
  assert.equal(await reserveInitialAdministrator({ userId: 'u2' }, deps), false)
  assert.deepEqual(calls, ['u1'])
})

test('a racing duplicate bootstrap marker fails closed', async () => {
  assert.equal(await reserveInitialAdministrator({ userId: 'u2' }, {
    countUsers: async () => 0,
    findActiveAdministrator: async () => null,
    claimBootstrap: async () => { const error = new Error('duplicate'); error.code = 11000; throw error },
  }), false)
})

test('delete, demotion and deactivation cannot remove the final active administrator', async () => {
  const dependencies = {
    findUser: async () => ({ _id: 'admin', isAdmin: true, inactive: false }),
    countActiveAdministrators: async () => 1,
  }
  await assert.rejects(
    assertAdministrativeContinuity({ targetUserId: 'admin', removesAccess: true }, dependencies),
    (error) => error instanceof AdminSafetyError && error.code === 'last-active-administrator',
  )
  assert.equal((await assertAdministrativeContinuity({
    targetUserId: 'admin', removesAccess: false,
  }, dependencies))._id, 'admin')
})

test('non-admin and missing targets are handled without leaking continuity checks', async () => {
  const dependencies = {
    findUser: async () => ({ _id: 'user', isAdmin: false }),
    countActiveAdministrators: async () => { throw new Error('must not count') },
  }
  assert.equal((await assertAdministrativeContinuity({
    targetUserId: 'user', removesAccess: true,
  }, dependencies))._id, 'user')
  dependencies.findUser = async () => null
  await assert.rejects(
    assertAdministrativeContinuity({ targetUserId: 'missing', removesAccess: true }, dependencies),
    (error) => error instanceof AdminSafetyError && error.code === 'user-not-found',
  )
})
