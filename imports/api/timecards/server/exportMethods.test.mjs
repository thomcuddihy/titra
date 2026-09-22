import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import dayjs from 'dayjs'
import customParseFormat from 'dayjs/plugin/customParseFormat.js'
import { createActivePublicationGate } from '../../../utils/activePublicationGate.js'
import { RESOURCE_QUERY_MAX_TIME_MS, MAX_PROJECT_SCOPE_IDS } from '../../../utils/resourceLimits.js'
import * as privacy from './publicationPrivacy.js'
import * as policy from './exportPolicy.js'
import { validateStateMutationInput } from './stateMutation.js'
import { markAuthorizedTimeEntriesExported } from './exportState.js'

// Exercise the actual Meteor method wiring and database options with explicit
// in-memory adapters. Pure policy/state tests cover authorization expressions;
// these tests cover their integration, projection boundaries and mapper output.
const source = readFileSync(new URL('./exportMethods.js', import.meta.url), 'utf8')
  .replace(/^import\s+[\s\S]*?\s+from\s+['"][^'"]+['"]\s*;?\r?\n/gm, '')
  .replace(/^export \{[^}]*\}\s*$/gm, '')
const helpersSource = readFileSync(new URL('../../../utils/server_method_helpers.js', import.meta.url), 'utf8')
const mapperSource = helpersSource.match(/async function workingTimeEntriesMapper\(entry, context = \{\}\) \{[\s\S]*?\r?\n\}/)?.[0]
assert.ok(mapperSource, 'Use the production mapper, not a duplicate test implementation')
const workingTimeEntriesMapper = new Function('dayjs', 'customParseFormat', `${mapperSource}; return workingTimeEntriesMapper`)(dayjs, customParseFormat)
const caller = { userId: 'caller', connection: { clientAddress: '127.0.0.1' } }
const date = new Date('2026-09-01T00:00:00Z')
const input = (view = 'detailed', query = {}) => ({
  view, query: { projectId: 'all', userId: 'all', customer: 'all', period: 'all', ...query }, page: 1, limit: 500,
})

function project(document, fields) {
  const result = {}
  for (const key of Object.keys(fields)) {
    const parts = key.split('.')
    const value = parts.reduce((object, part) => object?.[part], document)
    if (value === undefined) continue
    let target = result
    for (const part of parts.slice(0, -1)) target = (target[part] ??= {})
    target[parts.at(-1)] = structuredClone(value)
  }
  return result
}

function harness({
  projects = [{ _id: 'p1', userId: 'caller' }], entries = [], groups = [], users = [],
  customFields = ['custom'], total, onReauthenticate = () => {},
} = {}) {
  const calls = []
  const rules = []
  const settings = {
    disablePublicProjects: false, dailyStartTime: '09:00', breakStartTime: '12:00',
    breakDuration: 0.5, regularWorkingTime: 8, addBreakToWorkingTime: true,
  }
  const cursor = values => ({ async toArray() { return values } })
  const find = (kind, documents) => (selector, options) => {
    calls.push({ kind, selector, options })
    assert.equal(options.maxTimeMS, 5000)
    assert.ok(options.limit > 0 && options.limit <= 1001)
    const selected = documents.filter(document => typeof selector._id === 'string'
      ? selector._id === document._id : !selector._id?.$in || selector._id.$in.includes(document._id))
    return cursor(selected.slice(0, options.limit).map(document => project(document, options.projection)))
  }
  const rawTimecards = {
    async countDocuments(selector, options) { calls.push({ kind: 'count', selector, options }); return total ?? entries.length },
    find: find('timecard-read', entries),
    aggregate(pipeline, options) {
      calls.push({ kind: pipeline.at(-1).$count ? 'group-count' : 'group-read', pipeline, options })
      return cursor(pipeline.at(-1).$count ? [{ totalEntries: total ?? groups.length }] : structuredClone(groups))
    },
    async updateMany(selector, modifier, options) { calls.push({ kind: 'write', selector, modifier, options }); return { matchedCount: entries.length } },
  }
  const projectIdsForQuery = query => projects.filter(value => (query.projectId === 'all'
    || [query.projectId].flat().includes(value._id)) && (query.customer === 'all' || value.customer === query.customer))
    .map(value => value._id)
  const pipeline = (view, query) => [{ $match: { projectId: { $in: projectIdsForQuery(query) } } },
    { $project: { hours: { $toDecimal: '$hours' }, userId: 1, projectId: 1, date: 1 } },
    { $group: { _id: view, totalHours: { $sum: '$hours' } } },
    { $sort: { '_id.userId': 1, '_id.projectId': 1 } }, { $skip: 0 }, { $limit: 500 }]
  class MeteorError extends Error { constructor(code, reason) { super(reason); this.error = code } }
  const authenticationMixin = method => method
  const transactionLogMixin = method => method
  const bindings = {
    ...privacy, ...policy, createActivePublicationGate, RESOURCE_QUERY_MAX_TIME_MS, MAX_PROJECT_SCOPE_IDS,
    validateStateMutationInput, markAuthorizedTimeEntriesExported, workingTimeEntriesMapper,
    authenticationMixin, transactionLogMixin,
    Meteor: { Error: MeteorError, users: { rawCollection: () => ({ find: find('user-read', users) }) } },
    ValidatedMethod: class { constructor(options) { Object.assign(this, options) } },
    DDPRateLimiter: { addRule(...args) { rules.push(args) } },
    EJSON: { stringify: JSON.stringify },
    check(value, pattern) { assert.deepEqual(Object.keys(value), Object.keys(pattern)); assert.ok(Array.isArray(value.timecardIds)) },
    Timecards: { rawCollection: () => rawTimecards },
    Projects: { rawCollection: () => ({ find: find('project-read', projects) }) },
    CustomFields: { rawCollection: () => ({ find: find('custom-read', customFields.map(name => ({ name }))) }) },
    async checkAuthentication() { calls.push({ kind: 'reauthenticate' }); await onReauthenticate(projects) },
    async getGlobalSettingAsync(name) { return settings[name] },
    async buildDetailedTimeEntriesForPeriodSelectorAsync(query) {
      calls.push({ kind: 'detailed-helper', query })
      return [{ projectId: { $in: projectIdsForQuery(query) } }, { sort: { date: -1 }, skip: (query.page - 1) * query.limit }]
    },
    async buildDailyHoursSelectorAsync(...args) { calls.push({ kind: 'daily-helper', args }); return pipeline('daily', { projectId: args[4] === 'all' ? args[0] : 'all', customer: args[4] }) },
    async buildTotalHoursForPeriodSelectorAsync(...args) { calls.push({ kind: 'total-helper', args }); return pipeline('total', { projectId: args[4] === 'all' ? args[0] : 'all', customer: args[4] }) },
    async buildworkingTimeSelectorAsync(...args) { calls.push({ kind: 'working-helper', args }); return pipeline('working', { projectId: args[0], customer: 'all' }) },
  }
  const methods = new Function(...Object.keys(bindings), `${source}; return { exportPage, markExported }`)(...Object.values(bindings))
  return { calls, rules, methods, authenticationMixin, transactionLogMixin,
    async run(request = input()) { methods.exportPage.validate(request); return methods.exportPage.run.call(caller, request) },
  }
}

test('real export methods register authentication and bounded per-user/per-peer rates', () => {
  const f = harness()
  assert.deepEqual(f.methods.exportPage.mixins, [f.authenticationMixin])
  assert.deepEqual(f.methods.markExported.mixins, [f.authenticationMixin, f.transactionLogMixin])
  assert.equal(f.rules.length, 4)
  for (const name of ['timecards.exportPage', 'timecards.markExported']) {
    const [[userRule, userLimit, interval], [peerRule, peerLimit]] = f.rules.filter(([rule]) => rule.name === name)
    assert.equal(userLimit, 220)
    assert.equal(peerLimit, 440)
    assert.equal(interval, 60000)
    assert.equal(userRule.userId('caller'), true)
    assert.equal(userRule.userId(null), false)
    assert.equal(peerRule.clientAddress('127.0.0.1'), true)
  }
})

test('real detailed endpoint projects member fields per row, appends deterministic ID sort and bounds every query', async () => {
  const f = harness({
    projects: [{ _id: 'member', userId: 'caller' }, { _id: 'public', userId: 'other', public: true }],
    entries: [
      { _id: 'one', projectId: 'member', userId: 'caller', task: 'Visible', hours: 1.234, state: 'new', taskRate: 20, custom: 'member field', secret: 'no' },
      { _id: 'two', projectId: 'public', userId: 'other', task: 'Public task', hours: 0.5, state: 'billed', taskRate: 99, custom: 'hidden', secret: 'no' },
    ],
  })
  const result = await f.run({ ...input(), page: 2 })
  assert.equal(result.totalEntries, 2)
  assert.deepEqual(result.keys, ['one', 'two'])
  assert.equal(result.rows[0].custom, 'member field')
  assert.equal(result.rows[0].taskRate, 20)
  for (const key of ['state', 'taskRate', 'custom', 'secret']) assert.equal(Object.hasOwn(result.rows[1], key), false)
  assert.equal(Object.hasOwn(result.rows[0], 'secret'), false)
  const read = f.calls.find(call => call.kind === 'timecard-read')
  assert.deepEqual(read.options.sort, { date: -1, _id: 1 })
  assert.equal(read.options.skip, 500)
  assert.equal(read.options.limit, 500)
  assert.equal(f.calls.find(call => call.kind === 'count').options.maxTimeMS, 5000)
  assert.equal(f.calls.filter(call => call.kind === 'project-read').length, 3)
  assert.equal(f.calls.some(call => call.kind === 'write'), false)
})

test('matching/nonmatching customer guesses fail identically before global customer lookup, including selected-owned scopes', async () => {
  for (const view of ['detailed', 'daily', 'total']) {
    for (const customer of ['secret-customer', 'not-a-customer']) {
      for (const projectId of ['all', 'owned']) {
        const f = harness({ projects: [
          { _id: 'owned', userId: 'caller', customer: 'own-customer' },
          { _id: 'public', userId: 'other', public: true, customer: 'secret-customer' },
        ] })
        await assert.rejects(f.run(input(view, { projectId, customer })), error => error.error === 'export-filter-not-visible')
        const helpers = f.calls.filter(call => call.kind.endsWith('-helper'))
        assert.equal(helpers.length, 1, 'Only the unfiltered permission scope may be resolved')
        if (view === 'detailed') {
          assert.equal(helpers[0].query.customer, 'all')
          assert.equal(helpers[0].query.projectId, 'all')
        } else {
          assert.equal(helpers[0].args[4], 'all')
          assert.equal(helpers[0].args[0], 'all')
        }
        assert.equal(f.calls.some(call => ['count', 'timecard-read', 'group-count', 'group-read'].includes(call.kind)), false)
      }
      if (view === 'detailed') {
        const f = harness({ projects: [{ _id: 'owned', userId: 'caller' }, { _id: 'public', userId: 'other', public: true, customer: 'secret-customer' }] })
        await assert.rejects(f.run(input(view, { projectId: 'owned', filters: { customer } })), error => error.error === 'export-filter-not-visible')
        const helpers = f.calls.filter(call => call.kind === 'detailed-helper')
        assert.equal(helpers.length, 1)
        assert.deepEqual(helpers[0].query.filters, {})
      }
    }
  }
})

test('member-only customer exports retain the original filtered query after permission preflight', async () => {
  const f = harness({ projects: [{ _id: 'owned', userId: 'caller', customer: 'customer1' }] })
  await f.run(input('detailed', { customer: 'customer1', filters: { state: 'new' } }))
  const helpers = f.calls.filter(call => call.kind === 'detailed-helper')
  assert.equal(helpers.length, 2)
  assert.deepEqual(helpers[0].query.filters, {})
  assert.equal(helpers[0].query.customer, 'all')
  assert.deepEqual(helpers[1].query.filters, { state: 'new' })
  assert.equal(helpers[1].query.customer, 'customer1')
})

test('real endpoint denies invisible filter inference before count/data queries and fails closed after access revocation', async () => {
  for (const filters of [{ taskRate: 50 }, { custom: 'hidden' }, { confidentialCustom: 'secret' }]) {
    const f = harness({ projects: [{ _id: 'p1', userId: 'other', public: true }] })
    await assert.rejects(f.run(input('detailed', { filters })), error => error.error === 'export-filter-not-visible')
    assert.equal(f.calls.some(call => ['count', 'timecard-read', 'group-read'].includes(call.kind)), false)
  }
  const changed = harness({ projects: [{ _id: 'p1', userId: 'other', admins: ['caller'] }],
    entries: [{ _id: 'one', projectId: 'p1', userId: 'other', hours: 1 }],
    onReauthenticate(projects) { projects[0].admins = [] },
  })
  await assert.rejects(changed.run(), error => error.error === 'export-access-changed')
})

test('real endpoint checks the total ceiling before reading any row batch for every view', async () => {
  for (const view of ['detailed', 'daily', 'total', 'working']) {
    const f = harness({ total: 100001 })
    await assert.rejects(f.run(input(view)), error => error.error === 'export-too-large')
    assert.equal(f.calls.some(call => ['timecard-read', 'group-read', 'user-read'].includes(call.kind)), false)
  }
})

test('real aggregate exports count grouped rows without pagination and normalize Decimal128-like totals', async () => {
  for (const view of ['daily', 'total']) {
    const id = { userId: 'caller', projectId: 'p1', ...(view === 'daily' ? { date } : {}) }
    const f = harness({ groups: [{ _id: id, totalHours: '1.234' }] })
    const result = await f.run(input(view))
    assert.equal(result.rows[0].totalHours, 1.234)
    assert.equal(result.keys[0], policy.exportRowKey(view, { _id: id }))
    const count = f.calls.find(call => call.kind === 'group-count')
    assert.deepEqual(count.pipeline.at(-1), { $count: 'totalEntries' })
    assert.equal(count.pipeline.some(stage => '$skip' in stage || '$limit' in stage || '$sort' in stage), false)
    assert.equal(count.options.maxTimeMS, 5000)
    const data = f.calls.find(call => call.kind === 'group-read')
    assert.deepEqual(data.pipeline.at(-1), { $limit: 500 })
    assert.equal(data.options.maxTimeMS, 5000)
  }
})

test('working exports never fetch another user schedule even when membership/admin rights permit their name', async () => {
  for (const role of ['public', 'member', 'admin']) {
    const projectData = { _id: 'p1', userId: 'owner', public: true,
      ...(role === 'member' ? { team: ['caller', 'other'] } : {}), ...(role === 'admin' ? { admins: ['caller'] } : {}) }
    const f = harness({ projects: [projectData],
      users: [
        { _id: 'caller', profile: { name: 'Caller', dailyStartTime: '07:00', breakStartTime: '10:00', breakDuration: 1, regularWorkingTime: 6 } },
        { _id: 'other', profile: { name: 'Colleague', dailyStartTime: '03:00', breakStartTime: '04:00', breakDuration: 2, regularWorkingTime: 11 } },
      ],
      groups: [
        { _id: { date, userId: 'caller' }, totalTime: '8', _exportResourceAllowed: 1 },
        { _id: { date, userId: 'other' }, totalTime: '8', _exportResourceAllowed: role === 'public' ? 0 : 1 },
      ],
    })
    const result = await f.run(input('working'))
    assert.equal(result.rows[0].startTime, '07:00')
    assert.equal(result.rows[0].regularWorkingTime, 6)
    assert.equal(result.rows[1].startTime, '09:00')
    assert.equal(result.rows[1].breakStartTime, '12:00')
    assert.equal(result.rows[1].breakEndTime, '12:30')
    assert.equal(result.rows[1].endTime, '17:30')
    assert.equal(result.rows[1].regularWorkingTime, 8)
    assert.equal(result.rows[1].resource, role === 'public' ? '' : 'Colleague')
    const reads = f.calls.filter(call => call.kind === 'user-read')
    assert.deepEqual(reads[0].selector, { _id: 'caller' })
    assert.equal(reads[0].options.limit, 1)
    assert.deepEqual(reads[1].selector, { _id: { $in: ['other'] } })
    assert.deepEqual(reads[1].options.projection, { _id: 1, inactive: 1, 'profile.name': 1 })
    const data = f.calls.find(call => call.kind === 'group-read')
    assert.deepEqual(data.pipeline.find(stage => stage.$group).$group._exportResourceAllowed,
      policy.workingExportNameVisibility([projectData], 'caller'))
    assert.equal(Object.hasOwn(result.rows[1], '_exportResourceAllowed'), false)
  }
})

test('working exports blank inactive/missing resource names and distinguish users with duplicate names', async () => {
  const f = harness({ users: [{ _id: 'inactive', inactive: true, profile: { name: 'Hidden' } },
    { _id: 'same1', profile: { name: 'Same' } }, { _id: 'same2', profile: { name: 'Same' } }],
  groups: ['inactive', 'missing', 'same1', 'same2'].map(userId => ({ _id: { date, userId }, totalTime: '1', _exportResourceAllowed: 1 })),
  })
  const result = await f.run(input('working'))
  assert.deepEqual(result.rows.map(row => row.resource), ['', '', 'Same', 'Same'])
  assert.equal(new Set(result.keys).size, 4)
  assert.equal(f.calls.filter(call => call.kind === 'user-read').length, 1, 'Do not fetch own profile when not needed')
})

test('real marking method validates input and bounds lookup/update operations', async () => {
  const f = harness({ entries: [{ _id: 'one', projectId: 'p1', userId: 'caller' }] })
  f.methods.markExported.validate({ timecardIds: ['one'] })
  assert.deepEqual(await f.methods.markExported.run.call(caller, { timecardIds: ['one'] }), { updated: 1, skipped: 0 })
  const write = f.calls.find(call => call.kind === 'write')
  assert.equal(write.options.maxTimeMS, 5000)
  assert.deepEqual(write.selector.$and[1], { $or: [{ state: 'new' }, { state: { $exists: false } }] })
  assert.deepEqual(write.selector.$and[2], { $or: [{ _id: 'one', userId: 'caller', projectId: 'p1' }] })
  assert.throws(() => f.methods.markExported.validate({ timecardIds: [] }), error => error.error === 'timecard-state-invalid')
})
