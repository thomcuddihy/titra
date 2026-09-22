import assert from 'node:assert/strict'
import test from 'node:test'
import { createActivePublicationGate } from '../../../utils/activePublicationGate.js'
import {
  EXPORT_PAGE_SIZE, MAX_EXPORT_PAGE, MAX_EXPORT_RESPONSE_BYTES, MAX_EXPORT_ROWS,
  assertExportCount, assertExportFilterVisibility, assertExportResponse, exportAccessFingerprint, exportRowKey,
  normalizeExportPageInput, readAuthorizedExportPage, workingExportNameVisibility,
} from './exportPolicy.js'

const input = (view = 'detailed', query = {}) => ({
  view, query: { projectId: 'all', userId: 'all', customer: 'all', period: 'all', ...query },
  page: 1, limit: 500,
})
const failsWith = code => error => error.error === code

test('export pages keep a fixed per-query ceiling and an explicit finite total ceiling', () => {
  assert.equal(EXPORT_PAGE_SIZE, 500)
  assert.equal(MAX_EXPORT_PAGE, 200)
  assert.equal(MAX_EXPORT_ROWS, 100000)
  assert.equal(normalizeExportPageInput({ ...input(), page: 200 }).page, 200)
  for (const page of [undefined, 0, -1, 201, 1.5, '1', NaN, Infinity]) {
    assert.throws(() => normalizeExportPageInput({ ...input(), page }), failsWith('export-invalid-input'))
  }
  for (const limit of [0, -1, 501, 100000, 1, '500', NaN, Infinity]) {
    assert.throws(() => normalizeExportPageInput({ ...input(), limit }), failsWith('export-invalid-input'))
  }
  assert.equal(assertExportCount(0), 0)
  assert.equal(assertExportCount(100000), 100000)
  assert.throws(() => assertExportCount(100001), failsWith('export-too-large'))
  for (const count of [-1, 1.5, '1', NaN, Infinity]) assert.throws(() => assertExportCount(count), failsWith('export-invalid-result'))
})

test('detailed export preserves authorized filter shapes and clones custom dates and scopes', () => {
  const startDate = new Date('2026-09-01T00:00:00Z')
  const endDate = new Date('2026-09-30T23:59:59Z')
  const supplied = input('detailed', {
    projectId: ['project1'], userId: ['user1'], customer: ['customer1'],
    period: 'custom', dates: { startDate, endDate }, search: 'task.*',
    sort: { column: 2, order: 'desc' }, filters: { state: 'new', hours: '1.234', custom: true },
  })
  const normalized = normalizeExportPageInput(supplied)
  assert.deepEqual(normalized, supplied)
  assert.notEqual(normalized.query.projectId, supplied.query.projectId)
  assert.notEqual(normalized.query.dates.startDate, startDate)
})

test('export validation rejects selector operators, unsafe prototypes, malformed filters and unbounded scopes', () => {
  const bad = [
    null, [], { ...input(), extra: true }, { ...input(), view: 'unknown' },
    input('detailed', { $where: 'secret' }),
    input('detailed', { projectId: ['all', 'private'] }),
    input('detailed', { userId: [] }),
    input('detailed', { projectId: Array.from({ length: 501 }, (_, index) => `p${index}`) }),
    input('detailed', { period: 'unexpected' }),
    input('detailed', { period: 'custom', dates: { startDate: new Date('bad'), endDate: new Date() } }),
    input('detailed', { search: 'x'.repeat(1001) }),
    input('detailed', { filters: { $where: 'secret' } }),
    input('detailed', { filters: { task: { $ne: '' } } }),
    input('detailed', { filters: JSON.parse('{"__proto__":null}') }),
    input('detailed', { filters: { constructor: 'x' } }),
    input('detailed', { sort: { column: 5, order: 'asc' } }),
  ]
  for (const candidate of bad) assert.throws(() => normalizeExportPageInput(candidate), failsWith('export-invalid-input'))
})

test('aggregate export query contract does not silently ignore detailed-only filters', () => {
  for (const view of ['daily', 'total', 'working']) {
    assert.equal(normalizeExportPageInput(input(view)).view, view)
    for (const query of [{ userId: ['one'] }, { search: 'task' }, { sort: { column: 1, order: 'asc' } }, { filters: { state: 'new' } }]) {
      assert.throws(() => normalizeExportPageInput(input(view, query)), failsWith('export-invalid-input'))
    }
  }
  assert.equal(normalizeExportPageInput(input('working')).query.customer, undefined)
  assert.throws(() => normalizeExportPageInput(input('working', { customer: 'customer1' })), failsWith('export-invalid-input'))
})

test('export group keys preserve resource identity even when display names collide', () => {
  const date = new Date('2026-09-01T00:00:00Z')
  assert.equal(exportRowKey('detailed', { _id: 'record1' }), 'record1')
  assert.equal(exportRowKey('daily', { _id: { date, userId: 'u1', projectId: 'p1' } }), '["2026-09-01T00:00:00.000Z","u1","p1"]')
  assert.equal(exportRowKey('total', { _id: { userId: 'u1', projectId: 'p1' } }), '["u1","p1"]')
  assert.notEqual(exportRowKey('working', { _id: { date, userId: 'u1' }, resource: 'Same name' }),
    exportRowKey('working', { _id: { date, userId: 'u2' }, resource: 'Same name' }))
  for (const [view, row] of [['detailed', {}], ['total', { _id: { userId: 'u1' } }], ['daily', { _id: { date: '2026-09-01', userId: 'u1', projectId: 'p1' } }]]) {
    assert.throws(() => exportRowKey(view, row))
  }
})

test('post-read access fingerprints fail closed for revocation, archived projects, public policy and field policy changes', () => {
  const project = { _id: 'p1', userId: 'owner', admins: ['caller', 'admin2'], team: ['member1', 'member2'] }
  const before = exportAccessFingerprint([project], 'caller', false, ['custom1'])
  assert.equal(before, exportAccessFingerprint([{ ...project, admins: ['admin2', 'caller'], team: ['member2', 'member1'] }], 'caller', false, ['custom1']))
  assert.notEqual(before, exportAccessFingerprint([project], 'caller', false, ['custom2']))
  assert.notEqual(before, exportAccessFingerprint([{ ...project, team: [] }], 'caller', false, ['custom1']))
  assert.throws(() => exportAccessFingerprint([{ ...project, admins: [] }], 'caller', false), failsWith('export-access-changed'))
  assert.notEqual(before, exportAccessFingerprint([{ ...project, archived: true }], 'caller', false, ['custom1']))
  const publicProject = { _id: 'p2', userId: 'owner', public: true }
  assert.doesNotThrow(() => exportAccessFingerprint([publicProject], 'caller', false))
  assert.throws(() => exportAccessFingerprint([publicProject], 'caller', true), failsWith('export-access-changed'))
})

test('filters cannot infer private or unconfigured fields through counts in public or mixed project scopes', () => {
  const memberProject = { _id: 'member', userId: 'owner', team: ['caller'] }
  const publicProject = { _id: 'public', userId: 'owner', public: true }
  for (const projects of [[publicProject], [memberProject, publicProject]]) {
    assert.doesNotThrow(() => assertExportFilterVisibility({ filters: { task: 'known', hours: '1.234' }, customer: 'all' }, projects, 'caller', ['custom']))
    for (const name of ['state', 'taskRate', 'customer', 'custom', 'confidentialCustom']) {
      assert.throws(() => assertExportFilterVisibility({ filters: { [name]: 'secret' } }, projects, 'caller', ['custom']), failsWith('export-filter-not-visible'))
    }
    assert.throws(() => assertExportFilterVisibility({ customer: 'customer1' }, projects, 'caller'), failsWith('export-filter-not-visible'))
  }
  assert.doesNotThrow(() => assertExportFilterVisibility({ filters: { state: 'new', taskRate: 42, customer: 'client', custom: true } }, [memberProject], 'caller', ['custom']))
  assert.throws(() => assertExportFilterVisibility({ filters: { confidentialCustom: 'secret' } }, [memberProject], 'caller', ['custom']), failsWith('export-filter-not-visible'))
})

test('working resource-name visibility is computed on contributing project records before grouping', () => {
  const expression = workingExportNameVisibility([
    { _id: 'owned', userId: 'caller' },
    { _id: 'administered', userId: 'owner', admins: ['caller'] },
    { _id: 'member', userId: 'owner', admins: ['other-admin'], team: ['caller', 'colleague'] },
    { _id: 'public', userId: 'owner', public: true },
  ], 'caller')
  assert.deepEqual(expression, { $max: { $cond: [{ $or: [
    { $eq: ['$userId', 'caller'] },
    { $in: ['$projectId', ['owned', 'administered']] },
    { $and: [{ $eq: ['$projectId', 'member'] }, { $in: ['$userId', ['owner', 'other-admin', 'caller', 'colleague']] }] },
  ] }, 1, 0] } })
  assert.doesNotMatch(JSON.stringify(expression), /public/)
})

test('server enforces response byte size, row count, distinct keys and exact key alignment', () => {
  const response = { rows: [{ _id: 'one' }], keys: ['one'], totalEntries: 1, page: 1 }
  assert.equal(assertExportResponse(response, () => MAX_EXPORT_RESPONSE_BYTES), response)
  assert.throws(() => assertExportResponse(response, () => MAX_EXPORT_RESPONSE_BYTES + 1), failsWith('export-page-too-large'))
  for (const candidate of [
    { ...response, rows: null },
    { ...response, rows: Array(501).fill({}) },
    { ...response, keys: [] },
    { ...response, keys: [undefined] },
    { ...response, rows: [{}, {}], keys: ['same', 'same'] },
  ]) assert.throws(() => assertExportResponse(candidate, () => 1), failsWith('export-invalid-result'))
})

function controllerFixture() {
  const events = []
  const gate = createActivePublicationGate({ perUser: 1, perPeer: 4, total: 20 })
  let fingerprint = 'same'
  const dependencies = {
    acquire: context => gate.acquire(context),
    async buildPlan(request) { events.push('build'); return request },
    async accessSnapshot() { events.push('access'); return { fingerprint } },
    async readPage() { events.push('read'); return { rows: [{ _id: 'one' }], keys: ['one'], totalEntries: 1 } },
    async authenticate() { events.push('reauthenticate') },
    measureBytes: value => Buffer.byteLength(JSON.stringify(value)),
  }
  return { events, gate, dependencies, changeAccess: () => { fingerprint = 'changed' } }
}
const caller = { userId: 'caller', connection: { clientAddress: '127.0.0.1' } }

test('export reads are isolated, reauthorize before return and release capacity on completion', async () => {
  const fixture = controllerFixture()
  assert.deepEqual(await readAuthorizedExportPage(caller, input(), fixture.dependencies), { rows: [{ _id: 'one' }], keys: ['one'], totalEntries: 1, page: 1 })
  assert.deepEqual(fixture.events, ['build', 'access', 'read', 'reauthenticate', 'access'])
  assert.equal(fixture.gate.snapshot().activeCount, 0)
})

test('export read or reauthorization failures release all capacity and return no partial page', async () => {
  for (const failure of ['buildPlan', 'accessSnapshot', 'readPage', 'authenticate']) {
    const fixture = controllerFixture()
    fixture.dependencies[failure] = async () => { throw new Error(failure) }
    await assert.rejects(readAuthorizedExportPage(caller, input(), fixture.dependencies), new RegExp(failure))
    assert.deepEqual(fixture.gate.snapshot(), { activeCount: 0, peers: 0, users: 0 })
  }
  const fixture = controllerFixture()
  fixture.dependencies.authenticate = async () => fixture.changeAccess()
  await assert.rejects(readAuthorizedExportPage(caller, input(), fixture.dependencies), failsWith('export-access-changed'))
  assert.equal(fixture.gate.snapshot().activeCount, 0)
})

test('parallel requests from the same user are rejected without starting another query', async () => {
  const fixture = controllerFixture()
  let releaseRead
  fixture.dependencies.readPage = async () => {
    await new Promise(resolve => { releaseRead = resolve })
    return { rows: [], keys: [], totalEntries: 0 }
  }
  const first = readAuthorizedExportPage(caller, input(), fixture.dependencies)
  while (!releaseRead) await Promise.resolve()
  await assert.rejects(readAuthorizedExportPage(caller, input(), fixture.dependencies), failsWith('export-busy'))
  releaseRead()
  await first
  assert.equal(fixture.gate.snapshot().activeCount, 0)
})
