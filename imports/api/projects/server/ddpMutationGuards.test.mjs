import assert from 'node:assert/strict'
import test from 'node:test'

import {
  isDefaultProjectTask,
  projectAdministratorMutationSelector,
  projectMutationMatched,
  projectRateModifier,
} from './ddpMutationGuards.js'

test('project mutation selectors re-check caller administration in the atomic write', () => {
  assert.deepEqual(projectAdministratorMutationSelector('project', 'caller'), {
    _id: 'project',
    $or: [{ userId: 'caller' }, { admins: 'caller' }],
    lifecycleLock: { $exists: false },
    taskGraphLock: { $exists: false },
    $and: [
      {
        $or: [
          { lifecycleWriters: { $exists: false } },
          { lifecycleWriters: { $size: 0 } },
        ],
      },
      {
        $or: [
          { lifecycleWriterMetadata: { $exists: false } },
          { lifecycleWriterMetadata: { $size: 0 } },
        ],
      },
    ],
  })
  assert.throws(() => projectAdministratorMutationSelector('', 'caller'), TypeError)
  assert.equal(projectMutationMatched({ matchedCount: 1, modifiedCount: 0 }), true)
  assert.equal(projectMutationMatched({ matchedCount: 0, modifiedCount: 0 }), false)
  assert.equal(projectMutationMatched(1), true)
  assert.equal(projectMutationMatched(0), false)
})

test('rate mutations are atomic per user and reject dotted field-path injection', () => {
  assert.deepEqual(projectRateModifier('member_1', 37.5), {
    $set: { 'rates.member_1': 37.5 },
  })
  assert.deepEqual(projectRateModifier('member_1', 0), {
    $unset: { 'rates.member_1': '' },
  })
  for (const userId of ['member.name', '$member', '', 'x'.repeat(129)]) {
    assert.throws(() => projectRateModifier(userId, 1), TypeError)
  }
})

test('legacy project.defaultTask and the task flag both protect renames', () => {
  assert.equal(isDefaultProjectTask(
    { defaultTask: 'Legacy default' }, { name: 'Legacy default' },
  ), true)
  assert.equal(isDefaultProjectTask(
    {}, { name: 'Flagged default', isDefaultTask: true },
  ), true)
  assert.equal(isDefaultProjectTask(
    { defaultTask: 'Elsewhere' }, { name: 'Ordinary task' },
  ), false)
})
