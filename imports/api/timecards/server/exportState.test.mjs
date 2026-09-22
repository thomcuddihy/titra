import assert from 'node:assert/strict'
import test from 'node:test'
import { markAuthorizedTimeEntriesExported } from './exportState.js'

function fixture(entries, admins = []) {
  const rows = structuredClone(entries)
  const calls = []
  const dependencies = {
    async findTimeEntries(selector, options) { calls.push({ type: 'read', selector, options }); return rows.map(({ _id, userId, projectId }) => ({ _id, userId, projectId })) },
    async findAdministeredProjectIds(selector) { calls.push({ type: 'admin-read', selector }); return admins },
    async beforeWrite() { calls.push({ type: 'reauthenticate' }) },
    async updateTimeEntries(selector, modifier) {
      calls.push({ type: 'write', selector, modifier })
      let matchedCount = 0
      for (const row of rows) {
        const authorized = selector.$and[0].$or.some(branch => branch.userId === row.userId
          || branch.projectId?.$in.includes(row.projectId))
        const sameIdentity = selector.$and[2].$or.some(branch => branch._id === row._id
          && branch.userId === row.userId && branch.projectId === row.projectId)
        if (selector._id.$in.includes(row._id) && authorized
          && sameIdentity
          && (!Object.hasOwn(row, 'state') || row.state === 'new')) {
          row.state = modifier.$set.state
          matchedCount += 1
        }
      }
      return { matchedCount, modifiedCount: matchedCount }
    },
  }
  return { rows, calls, dependencies }
}
const run = (f, ids) => markAuthorizedTimeEntriesExported({ callerId: 'caller', timecardIds: ids }, f.dependencies)

test('export marking changes only current new/missing states and preserves all other states', async () => {
  const f = fixture([
    { _id: 'missing', userId: 'caller', projectId: 'p1' },
    { _id: 'new', userId: 'caller', projectId: 'p1', state: 'new' },
    { _id: 'billed', userId: 'caller', projectId: 'p1', state: 'billed' },
    { _id: 'notBillable', userId: 'caller', projectId: 'p1', state: 'notBillable' },
    { _id: 'exported', userId: 'caller', projectId: 'p1', state: 'exported' },
    { _id: 'null', userId: 'caller', projectId: 'p1', state: null },
  ])
  const ids = f.rows.map(row => row._id)
  assert.deepEqual(await run(f, ids), { updated: 2, skipped: 4 })
  assert.deepEqual(f.rows.map(row => row.state), ['exported', 'exported', 'billed', 'notBillable', 'exported', null])
  assert.deepEqual(f.calls.at(-1).selector, {
    _id: { $in: ids },
    $and: [
      { $or: [{ userId: 'caller' }] },
      { $or: [{ state: 'new' }, { state: { $exists: false } }] },
      { $or: ids.map(_id => ({ _id, userId: 'caller', projectId: 'p1' })) },
    ],
  })
  assert.deepEqual(await run(f, ids), { updated: 0, skipped: 6 }, 'Retry is harmless')
})

test('a billed-state change between export and marking is not overwritten', async () => {
  const f = fixture([{ _id: 'one', userId: 'caller', projectId: 'p1', state: 'new' }])
  f.dependencies.beforeWrite = async () => { f.rows[0].state = 'billed' }
  assert.deepEqual(await run(f, ['one']), { updated: 0, skipped: 1 })
  assert.equal(f.rows[0].state, 'billed')
})

test('a single unauthorized or missing entry rejects the entire batch before any write', async () => {
  const mixed = fixture([
    { _id: 'own', userId: 'caller', projectId: 'p1' },
    { _id: 'foreign', userId: 'other', projectId: 'private', state: 'new' },
  ])
  await assert.rejects(run(mixed, ['own', 'foreign']), error => error.error === 'not-authorized')
  assert.equal(mixed.calls.some(call => call.type === 'write'), false)
  assert.equal(Object.hasOwn(mixed.rows[0], 'state'), false)
  const missing = fixture([{ _id: 'one', userId: 'caller', projectId: 'p1' }])
  await assert.rejects(run(missing, ['one', 'gone']), error => error.error === 'not-authorized')
  assert.equal(missing.calls.some(call => call.type === 'write'), false)
})

test('foreign entries require owner/admin authority for every project; team/public visibility is insufficient', async () => {
  const f = fixture([
    { _id: 'a', userId: 'other', projectId: 'p1', state: 'new' },
    { _id: 'b', userId: 'other', projectId: 'p2', state: 'billed' },
  ], ['p1', 'p2'])
  assert.deepEqual(await run(f, ['a', 'b']), { updated: 1, skipped: 1 })
  assert.deepEqual(f.calls.find(call => call.type === 'admin-read').selector, {
    _id: { $in: ['p1', 'p2'] }, $or: [{ userId: 'caller' }, { admins: 'caller' }],
  })
  assert.equal(f.calls.filter(call => call.type === 'admin-read').length, 2, 'Project authority is refreshed immediately before write')
  const partial = fixture(f.rows, ['p1'])
  await assert.rejects(run(partial, ['a', 'b']), error => error.error === 'not-authorized')
  assert.equal(partial.calls.some(call => call.type === 'write'), false)
})

test('project administration revoked during account reauthentication rejects the whole batch before writing', async () => {
  const admins = ['p1']
  const f = fixture([
    { _id: 'own', userId: 'caller', projectId: 'p1', state: 'new' },
    { _id: 'foreign', userId: 'other', projectId: 'p1', state: 'new' },
  ], admins)
  f.dependencies.beforeWrite = async () => { admins.length = 0 }
  await assert.rejects(run(f, ['own', 'foreign']), error => error.error === 'not-authorized')
  assert.equal(f.calls.some(call => call.type === 'write'), false)
  assert.deepEqual(f.rows.map(row => row.state), ['new', 'new'])
})

test('record identity CAS skips records reassigned or moved even inside an authorized scope', async () => {
  for (const change of [row => { row.userId = 'another' }, row => { row.projectId = 'p2' }]) {
    const f = fixture([{ _id: 'one', userId: 'other', projectId: 'p1', state: 'new' }], ['p1', 'p2'])
    f.dependencies.beforeWrite = async () => change(f.rows[0])
    assert.deepEqual(await run(f, ['one']), { updated: 0, skipped: 1 })
    assert.equal(f.rows[0].state, 'new')
  }
})

test('export marking bounds input, rejects empty/duplicate IDs and makes no database call for invalid input', async () => {
  for (const ids of [[], ['same', 'same'], ['bad id'], [42], Array.from({ length: 1001 }, (_, index) => `id_${index}`)]) {
    const f = fixture([])
    await assert.rejects(run(f, ids), error => error.error === 'timecard-state-invalid')
    assert.equal(f.calls.length, 0)
  }
  const rows = Array.from({ length: 1000 }, (_, index) => ({ _id: `id_${index}`, userId: 'caller', projectId: 'p1' }))
  assert.deepEqual(await run(fixture(rows), rows.map(row => row._id)), { updated: 1000, skipped: 0 })
})

test('reauthentication failure and moved ownership cannot change unauthorized records', async () => {
  const blocked = fixture([{ _id: 'one', userId: 'caller', projectId: 'p1' }])
  blocked.dependencies.beforeWrite = async () => { throw new Error('account disabled') }
  await assert.rejects(run(blocked, ['one']), /account disabled/)
  assert.equal(blocked.calls.some(call => call.type === 'write'), false)
  const moved = fixture([{ _id: 'one', userId: 'caller', projectId: 'p1' }])
  moved.dependencies.beforeWrite = async () => { moved.rows[0].userId = 'other' }
  assert.deepEqual(await run(moved, ['one']), { updated: 0, skipped: 1 })
  assert.equal(Object.hasOwn(moved.rows[0], 'state'), false)
})
