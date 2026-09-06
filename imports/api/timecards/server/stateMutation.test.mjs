import assert from 'node:assert/strict'
import test from 'node:test'

import {
  setAuthorizedTimeEntryStates,
  validateStateMutationInput,
} from './stateMutation.js'

function fixture(entries, administered = []) {
  const calls = []
  return {
    calls,
    dependencies: {
      async findTimeEntries(selector, options) {
        calls.push({ type: 'find-timecards', selector, options })
        return structuredClone(entries)
      },
      async findAdministeredProjectIds(selector, options) {
        calls.push({ type: 'find-projects', selector, options })
        return [...administered]
      },
      async updateTimeEntries(selector, modifier) {
        calls.push({ type: 'update', selector, modifier })
        return { matchedCount: entries.length, modifiedCount: entries.length }
      },
    },
  }
}

test('state mutation input is bounded, canonical and state allowlisted', () => {
  assert.deepEqual(validateStateMutationInput(['one', 'two_2'], 'notBillable'), ['one', 'two_2'])
  for (const [ids, state] of [
    [[], 'new'],
    [['same', 'same'], 'new'],
    [['has space'], 'new'],
    [['x'.repeat(129)], 'new'],
    [[42], 'new'],
    [Array.from({ length: 1001 }, (_, index) => `id_${index}`), 'new'],
    [['one'], 'arbitrary'],
  ]) assert.throws(() => validateStateMutationInput(ids, state), /timecard-state-invalid/)
})

test('owners can change only their complete requested set in one guarded write', async () => {
  const f = fixture([
    { _id: 'one', userId: 'caller', projectId: 'p1' },
    { _id: 'two', userId: 'caller', projectId: 'p2' },
  ])
  assert.deepEqual(await setAuthorizedTimeEntryStates({
    callerId: 'caller', timeEntries: ['one', 'two'], state: 'exported',
  }, f.dependencies), { updated: 2, state: 'exported' })
  assert.equal(f.calls.some((call) => call.type === 'find-projects'), false)
  assert.deepEqual(f.calls.at(-1), {
    type: 'update',
    selector: { _id: { $in: ['one', 'two'] }, $or: [{ userId: 'caller' }] },
    modifier: { $set: { state: 'exported' } },
  })
})

test('project administrators can change foreign entries only in every authorized project', async () => {
  const entries = [
    { _id: 'own', userId: 'caller', projectId: 'p0' },
    { _id: 'foreign', userId: 'other', projectId: 'p1' },
  ]
  const allowed = fixture(entries, ['p1'])
  await setAuthorizedTimeEntryStates({
    callerId: 'caller', timeEntries: ['own', 'foreign'], state: 'billed',
  }, allowed.dependencies)
  assert.deepEqual(allowed.calls.at(-1).selector, {
    _id: { $in: ['own', 'foreign'] },
    $or: [{ userId: 'caller' }, { projectId: { $in: ['p1'] } }],
  })

  const denied = fixture(entries, [])
  await assert.rejects(
    setAuthorizedTimeEntryStates({
      callerId: 'caller', timeEntries: ['own', 'foreign'], state: 'billed',
    }, denied.dependencies),
    (error) => error.error === 'not-authorized',
  )
  assert.equal(denied.calls.some((call) => call.type === 'update'), false)
})

test('missing records and concurrent authorization changes fail without partial success', async () => {
  const missing = fixture([{ _id: 'one', userId: 'caller', projectId: 'p1' }])
  await assert.rejects(
    setAuthorizedTimeEntryStates({
      callerId: 'caller', timeEntries: ['one', 'two'], state: 'new',
    }, missing.dependencies),
    (error) => error.error === 'not-authorized',
  )
  assert.equal(missing.calls.some((call) => call.type === 'update'), false)

  const changed = fixture([{ _id: 'one', userId: 'caller', projectId: 'p1' }])
  changed.dependencies.updateTimeEntries = async () => ({ matchedCount: 0, modifiedCount: 0 })
  await assert.rejects(
    setAuthorizedTimeEntryStates({
      callerId: 'caller', timeEntries: ['one'], state: 'new',
    }, changed.dependencies),
    (error) => error.error === 'timecard-write-conflict',
  )
})
