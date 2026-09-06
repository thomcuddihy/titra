import assert from 'node:assert/strict'
import test from 'node:test'

import { runAuthorizedTimecardCreateRule } from './createAuthorization.js'

test('private project nonmember is rejected before the custom rule is invoked', async () => {
  let ruleCalls = 0
  await assert.rejects(runAuthorizedTimecardCreateRule({
    projectId: 'private-1', userId: 'outsider', ruleInput: { secretProbe: true },
  }, {
    findProject: async () => ({
      _id: 'private-1', userId: 'owner', public: false, privateBillingValue: 12345,
    }),
    checkRule: async () => { ruleCalls += 1 },
  }), { error: 'not-authorized' })
  assert.equal(ruleCalls, 0)
})

test('owner, administrator, member, and public caller reach the rule only after access', async () => {
  for (const [userId, project] of [
    ['owner', { userId: 'owner' }],
    ['admin', { userId: 'owner', admins: ['admin'] }],
    ['member', { userId: 'owner', team: ['member'] }],
    ['viewer', { userId: 'owner', public: true }],
  ]) {
    let ruleCalls = 0
    await runAuthorizedTimecardCreateRule({
      projectId: 'p1', userId, ruleInput: { projectId: 'p1' },
    }, {
      findProject: async (selector) => {
        assert.deepEqual(selector, {
          _id: 'p1', lifecycleLock: { $exists: false }, taskGraphLock: { $exists: false },
        })
        return { _id: 'p1', ...project }
      },
      checkRule: async () => { ruleCalls += 1 },
    })
    assert.equal(ruleCalls, 1)
  }
})
