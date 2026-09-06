import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { createPublicationReconciler } from '../../../utils/reactivePublication.js'
import {
  DASHBOARD_OBSERVER_FIELDS,
  MAX_PUBLIC_DASHBOARD_DATE_SPAN_DAYS,
  MAX_PRIVATE_DASHBOARD_PROJECTS,
  MAX_PRIVATE_DASHBOARD_ROWS,
  MAX_PUBLIC_DASHBOARD_PROJECTS,
  MAX_PUBLIC_DASHBOARD_TIMECARDS,
  boundedPublicTimecardDocuments,
  canCreateDashboard,
  createPublicDashboardSubscriptionGate,
  dashboardCredentialUnchanged,
  dashboardHasPassword,
  dashboardMayStreamTimecards,
  dashboardPasswordAllows,
  dashboardPasswordAllowsAsync,
  dashboardProjectNameDocuments,
  publicDashboardDateRangeAllowed,
  safeDashboardDocuments,
  safeDashboardFields,
  safeTimecardDocuments,
} from './publicationSecurity.js'

test('dashboard client documents never contain hashes or internal authorization markers', () => {
  const fields = safeDashboardFields({
    projectId: 'project',
    timePeriod: 'all',
    slug: 'share',
    password: '$2b$10$secret-hash',
    allProjectsAuthorized: true,
    unexpectedFutureSecret: 'nope',
  })
  assert.deepEqual(fields, {
    projectId: 'project',
    timePeriod: 'all',
    slug: 'share',
    hasPassword: true,
  })
  assert.equal(DASHBOARD_OBSERVER_FIELDS.password, 1)
  assert.equal(fields.password, undefined)
  assert.equal(fields.allProjectsAuthorized, undefined)
  assert.equal(fields.unexpectedFutureSecret, undefined)
})

test('public dashboard timecards use the public projection only', () => {
  const safe = safeTimecardDocuments(new Map([['timecard', {
    _id: 'timecard',
    userId: 'user',
    projectId: 'project',
    date: new Date('2026-09-01T00:00:00.000Z'),
    hours: 1.25,
    task: 'Allowed task label',
    state: 'billed',
    taskRate: 500,
    confidentialCustomField: 'secret',
  }]])).get('timecard')
  assert.equal(safe.task, 'Allowed task label')
  assert.equal(safe.state, undefined)
  assert.equal(safe.taskRate, undefined)
  assert.equal(safe.confidentialCustomField, undefined)
})

test('dashboard creation requires active membership and all-project shares require admin', () => {
  const project = { _id: 'p1', userId: 'owner', admins: ['manager'], team: ['member'] }
  const user = (id, extra = {}) => ({ _id: id, ...extra })
  for (const id of ['owner', 'manager', 'member']) {
    assert.equal(canCreateDashboard({ user: user(id), userId: id, projectId: 'p1', project }), true)
  }
  assert.equal(canCreateDashboard({
    user: user('public'), userId: 'public', projectId: 'p1', project: { ...project, public: true },
  }), false)
  assert.equal(canCreateDashboard({
    user: user('admin', { isAdmin: true }), userId: 'admin', projectId: 'p1', project,
  }), true)
  assert.equal(canCreateDashboard({
    user: user('admin', { isAdmin: true, inactive: true }),
    userId: 'admin',
    projectId: 'all',
  }), false)
  assert.equal(canCreateDashboard({
    user: user('member'), userId: 'member', projectId: 'all',
  }), false)
  assert.equal(canCreateDashboard({
    user: user('admin', { isAdmin: true }), userId: 'admin', projectId: 'all',
  }), true)
})

test('public dashboard streams require a bounded period and authorized project scope', () => {
  assert.equal(dashboardMayStreamTimecards({
    projectId: 'p1', timePeriod: 'currentMonth',
  }), true)
  assert.equal(dashboardMayStreamTimecards({ projectId: 'p1', timePeriod: 'all' }), false)
  assert.equal(dashboardMayStreamTimecards({ projectId: 'p1', timePeriod: 'forever' }), false)
  assert.equal(dashboardMayStreamTimecards({ projectId: 'p1' }), false)
  assert.equal(dashboardMayStreamTimecards({
    projectId: 'all', timePeriod: 'currentMonth',
  }), false)
  assert.equal(dashboardMayStreamTimecards({
    projectId: 'all', timePeriod: 'currentYear', allProjectsAuthorized: true,
  }), true)
})

test('public dashboard date windows are valid, ordered, and at most one year', () => {
  const start = new Date('2024-01-01T00:00:00.000Z')
  const atLimit = new Date(start.getTime()
    + MAX_PUBLIC_DASHBOARD_DATE_SPAN_DAYS * 24 * 60 * 60 * 1000)
  assert.equal(publicDashboardDateRangeAllowed(start, atLimit), true)
  assert.equal(publicDashboardDateRangeAllowed(
    start, new Date(atLimit.getTime() + 1),
  ), false)
  assert.equal(publicDashboardDateRangeAllowed(atLimit, start), false)
  assert.equal(publicDashboardDateRangeAllowed(new Date('invalid'), atLimit), false)
  assert.equal(publicDashboardDateRangeAllowed('2024-01-01', atLimit), false)
})

test('public dashboard result materialization fails closed above its hard cap', () => {
  const source = new Map([
    ['one', { task: 'one', secret: 'hidden' }],
    ['two', { task: 'two', secret: 'hidden' }],
  ])
  const atLimit = boundedPublicTimecardDocuments(source, 2)
  assert.equal(atLimit.exceeded, false)
  assert.deepEqual([...atLimit.documents.keys()], ['one', 'two'])
  assert.equal(atLimit.documents.get('one').secret, undefined)
  source.set('three', { task: 'three' })
  const exceeded = boundedPublicTimecardDocuments(source, 2)
  assert.equal(exceeded.exceeded, true)
  assert.deepEqual(exceeded.documents, new Map())
})

test('public dashboard subscription gate caps peer, dashboard, and total occupancy', () => {
  const gate = createPublicDashboardSubscriptionGate({
    perPeer: 2, perDashboard: 3, total: 4,
  })
  const first = gate.acquire({ dashboardId: 'd1', peerAddress: '192.0.2.1' })
  const second = gate.acquire({ dashboardId: 'd1', peerAddress: '192.0.2.1' })
  assert.equal(typeof first, 'function')
  assert.equal(typeof second, 'function')
  assert.equal(gate.acquire({ dashboardId: 'd1', peerAddress: '192.0.2.1' }), null)
  const third = gate.acquire({ dashboardId: 'd1', peerAddress: '192.0.2.2' })
  assert.equal(typeof third, 'function')
  assert.equal(gate.acquire({ dashboardId: 'd1', peerAddress: '192.0.2.3' }), null)
  const fourth = gate.acquire({ dashboardId: 'd2', peerAddress: '192.0.2.2' })
  assert.equal(typeof fourth, 'function')
  assert.equal(gate.acquire({ dashboardId: 'd3', peerAddress: '192.0.2.3' }), null)
  assert.deepEqual(gate.snapshot(), { activeCount: 4, dashboards: 2, peers: 2 })

  first()
  first()
  const replacement = gate.acquire({ dashboardId: 'd1', peerAddress: '192.0.2.3' })
  assert.equal(typeof replacement, 'function')
  for (const release of [second, third, fourth, replacement]) release()
  assert.deepEqual(gate.snapshot(), { activeCount: 0, dashboards: 0, peers: 0 })
})

test('public dashboard publication wires hard observer and occupancy bounds', () => {
  const source = readFileSync(new URL('./publications.js', import.meta.url), 'utf8')
  assert.match(source, /initialDashboard\.timePeriod === 'all'/u)
  assert.match(source, /limit:\s*MAX_PUBLIC_DASHBOARD_TIMECARDS \+ 1/u)
  assert.match(source, /limit:\s*MAX_PUBLIC_DASHBOARD_PROJECTS \+ 1/u)
  assert.match(source, /function acquirePublicDashboardSubscriptionSlot\(/u)
  assert.match(source, /publicDashboardSubscriptionGate\.acquire\(\{/u)
  assert.match(source, /peerAddress:\s*context\.connection\?\.clientAddress/u)
  assert.match(source, /acquirePublicDashboardSubscriptionSlot\(this, resolved\._id\)/u)
  assert.equal(
    (source.match(/acquirePublicDashboardSubscriptionSlot\(this, _id\)/gu) || []).length,
    2,
  )
  assert.match(source, /'dashboardPublicMeta'/u)
  assert.equal((source.match(/validateDashboardId\(_id\)/gu) || []).length, 3)
  assert.ok(MAX_PUBLIC_DASHBOARD_TIMECARDS > 0)
  assert.ok(MAX_PUBLIC_DASHBOARD_PROJECTS > 0)
})

test('authenticated dashboard publication bounds scope, rows, and active occupancy', () => {
  const source = readFileSync(new URL('./publications.js', import.meta.url), 'utf8')
  assert.match(source, /acquirePrivateDashboardSubscriptionSlot\(this\)/u)
  assert.match(source, /createActivePublicationGate\(\)/u)
  assert.match(source, /limit:\s*MAX_PRIVATE_DASHBOARD_PROJECTS \+ 1/u)
  assert.match(source, /limit:\s*MAX_PRIVATE_DASHBOARD_ROWS \+ 1/u)
  assert.match(source, /projects\.size > MAX_PRIVATE_DASHBOARD_PROJECTS/u)
  assert.match(source, /documents\.size > MAX_PRIVATE_DASHBOARD_ROWS/u)
  assert.ok(MAX_PRIVATE_DASHBOARD_PROJECTS > 0)
  assert.ok(MAX_PRIVATE_DASHBOARD_ROWS > 0)
})

test('dashboard password checks fail closed for mismatches and malformed hashes', () => {
  assert.equal(dashboardPasswordAllows({}, '', () => false), true)
  assert.equal(dashboardPasswordAllows({ password: 'hash' }, 'right', () => true), true)
  assert.equal(dashboardPasswordAllows({ password: 'hash' }, 'wrong', () => false), false)
  assert.equal(dashboardPasswordAllows({ password: 'malformed' }, 'value', () => {
    throw new Error('invalid bcrypt hash')
  }), false)
  for (const malformed of [false, 0, {}, []]) {
    assert.equal(dashboardHasPassword({ password: malformed }), true)
    assert.equal(dashboardPasswordAllows({ password: malformed }, '', () => true), false)
  }
})

test('public password verification is asynchronous and bound to the verified hash', async () => {
  let resolved = false
  assert.equal(await dashboardPasswordAllowsAsync(
    { password: 'hash-one' }, 'right', async (password, hash) => {
      await Promise.resolve()
      resolved = true
      return password === 'right' && hash === 'hash-one'
    },
  ), true)
  assert.equal(resolved, true)
  assert.equal(dashboardCredentialUnchanged({ password: 'hash-one' }, 'hash-one'), true)
  assert.equal(dashboardCredentialUnchanged({ password: 'hash-two' }, 'hash-one'), false)
  assert.equal(dashboardCredentialUnchanged({}, undefined), true)
  assert.equal(await dashboardPasswordAllowsAsync(
    { password: 'bad' }, 'value', async () => { throw new Error('bad hash') },
  ), false)
})

test('project-name share disappears on password rotation or project retarget', () => {
  const project = { _id: 'p1', name: 'Private project' }
  const compare = (password, hash) => password === hash
  assert.deepEqual(dashboardProjectNameDocuments({
    dashboard: { projectId: 'p1', password: 'valid' },
    project,
    projectId: 'p1',
    password: 'valid',
    comparePassword: compare,
  }), new Map([['p1', { name: 'Private project' }]]))
  assert.deepEqual(dashboardProjectNameDocuments({
    dashboard: { projectId: 'p1', password: 'rotated' },
    project,
    projectId: 'p1',
    password: 'valid',
    comparePassword: compare,
  }), new Map())
  assert.deepEqual(dashboardProjectNameDocuments({
    dashboard: { projectId: 'p2', password: 'valid' },
    project,
    projectId: 'p1',
    password: 'valid',
    comparePassword: compare,
  }), new Map())
})

test('password/config changes reconcile fields and revocation removes the dashboard', () => {
  const events = []
  const reconciler = createPublicationReconciler({
    collectionName: 'dashboards',
    added: (...args) => events.push(['added', ...args]),
    changed: (...args) => events.push(['changed', ...args]),
    removed: (...args) => events.push(['removed', ...args]),
  })
  const source = new Map([['d1', {
    projectId: 'p1', timePeriod: 'all', password: 'hash-one',
  }]])
  reconciler.reconcile(safeDashboardDocuments(source))
  source.set('d1', {
    projectId: 'p1', timePeriod: 'custom', password: undefined,
  })
  reconciler.reconcile(safeDashboardDocuments(source))
  reconciler.reconcile(new Map())
  assert.deepEqual(events, [
    ['added', 'dashboards', 'd1', {
      projectId: 'p1', timePeriod: 'all', hasPassword: true,
    }],
    ['changed', 'dashboards', 'd1', {
      timePeriod: 'custom', hasPassword: false,
    }],
    ['removed', 'dashboards', 'd1'],
  ])
})
