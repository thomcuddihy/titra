import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  MAX_DASHBOARDS_PER_CREATOR,
  createDashboardCreationCoordinator,
  dashboardCreatorQuotaAvailable,
  dashboardInputProblem,
  insertDashboardIfAuthorized,
  loadDashboardCreationAccess,
} from './creationSecurity.js'

test('dashboard create input is bounded to supported periods and safe text', () => {
  const valid = {
    projectId: 'p1',
    timePeriod: 'custom',
    resourceId: 'u1',
    customer: 'Customer',
    startDate: '2026-09-01',
    endDate: '2026-09-30',
    password: 'share password',
    slug: 'september-share',
  }
  assert.equal(dashboardInputProblem(valid), null)
  assert.equal(dashboardInputProblem({
    projectId: 'p1', timePeriod: 'currentMonth',
  }), null)
  assert.equal(dashboardInputProblem({ ...valid, timePeriod: 'forever' }), 'timePeriod')
  assert.equal(dashboardInputProblem({ ...valid, projectId: 'x'.repeat(129) }), 'projectId')
  assert.equal(dashboardInputProblem({ ...valid, password: 'x'.repeat(257) }), 'password')
  assert.equal(dashboardInputProblem({ ...valid, slug: 'x'.repeat(129) }), 'slug')
  assert.equal(dashboardInputProblem({ ...valid, customer: 'bad\nvalue' }), 'customer')
  assert.equal(dashboardInputProblem({ ...valid, startDate: 'not-a-date' }), 'startDate')
  assert.equal(dashboardInputProblem({ ...valid, timePeriod: 'all' }), 'timePeriod')
  assert.equal(
    dashboardInputProblem({ timePeriod: 'all', slug: '' }, { update: true }),
    'timePeriod',
  )
})

test('dashboard editors do not offer an unbounded all-history period', () => {
  for (const relativeUrl of [
    '../../../ui/pages/dashboard/dashboardList.html',
    '../../../ui/pages/administration/components/customerdashboardscomponent.html',
    '../../../ui/pages/overview/components/dashboardModal.html',
  ]) {
    const source = readFileSync(new URL(relativeUrl, import.meta.url), 'utf8')
    assert.doesNotMatch(source, /<option[^>]+value="all"/u)
  }
})

test('fresh authorization is re-read immediately before insertion', async () => {
  let user = { _id: 'member' }
  let project = { _id: 'p1', team: ['member'] }
  let inserts = 0
  const dependencies = {
    userId: 'member',
    projectId: 'p1',
    findUser: async () => user,
    findProject: async () => project,
  }
  const initial = await loadDashboardCreationAccess(dependencies)
  assert.equal(initial.allowed, true)

  project = { _id: 'p1', team: [] }
  const revoked = await insertDashboardIfAuthorized({
    ...dependencies,
    insert: async () => { inserts += 1 },
  })
  assert.deepEqual(revoked, { inserted: false })
  assert.equal(inserts, 0)

  user = { _id: 'member', inactive: true, isAdmin: true }
  project = { _id: 'p1', team: ['member'] }
  const inactive = await insertDashboardIfAuthorized({
    ...dependencies,
    insert: async () => { inserts += 1 },
  })
  assert.deepEqual(inactive, { inserted: false })
  assert.equal(inserts, 0)
})

test('authorized insert is invoked exactly once with the fresh access snapshot', async () => {
  let inserts = 0
  const result = await insertDashboardIfAuthorized({
    userId: 'admin',
    projectId: 'all',
    findUser: async () => ({ _id: 'admin', isAdmin: true }),
    findProject: async () => { throw new Error('all must not load a project') },
    insert: async ({ user }) => {
      inserts += 1
      assert.equal(user.isAdmin, true)
      return 'dashboard-id'
    },
  })
  assert.deepEqual(result, { inserted: true, result: 'dashboard-id' })
  assert.equal(inserts, 1)
})

test('dashboard creator quota fails closed at its hard maximum', () => {
  assert.equal(dashboardCreatorQuotaAvailable(0), true)
  assert.equal(dashboardCreatorQuotaAvailable(MAX_DASHBOARDS_PER_CREATOR - 1), true)
  assert.equal(dashboardCreatorQuotaAvailable(MAX_DASHBOARDS_PER_CREATOR), false)
  assert.equal(dashboardCreatorQuotaAvailable(MAX_DASHBOARDS_PER_CREATOR + 1), false)
  for (const invalid of [-1, 1.5, Number.NaN, '1']) {
    assert.throws(() => dashboardCreatorQuotaAvailable(invalid), TypeError)
  }
  assert.throws(() => dashboardCreatorQuotaAvailable(0, 0), TypeError)
})

test('dashboard creation coordinator serializes one creator and releases after failure', async () => {
  const coordinator = createDashboardCreationCoordinator()
  const events = []
  let releaseFirst
  const firstMayFinish = new Promise((resolve) => { releaseFirst = resolve })
  const first = coordinator.run('creator', async () => {
    events.push('first-start')
    await firstMayFinish
    events.push('first-end')
  })
  const second = coordinator.run('creator', async () => {
    events.push('second-start')
  })

  await new Promise((resolve) => { setImmediate(resolve) })
  assert.deepEqual(events, ['first-start'])
  assert.equal(coordinator.pendingCreators(), 1)
  releaseFirst()
  await Promise.all([first, second])
  assert.deepEqual(events, ['first-start', 'first-end', 'second-start'])
  assert.equal(coordinator.pendingCreators(), 0)

  await assert.rejects(
    coordinator.run('creator', async () => { throw new Error('insert failed') }),
    /insert failed/u,
  )
  assert.equal(await coordinator.run('creator', async () => 'recovered'), 'recovered')
  assert.equal(coordinator.pendingCreators(), 0)
})

test('dashboard creation coordinator does not block independent creators', async () => {
  const coordinator = createDashboardCreationCoordinator()
  let releaseFirst
  const firstMayFinish = new Promise((resolve) => { releaseFirst = resolve })
  const first = coordinator.run('creator-one', () => firstMayFinish)
  const second = coordinator.run('creator-two', async () => 'independent')
  assert.equal(await second, 'independent')
  assert.equal(coordinator.pendingCreators(), 1)
  releaseFirst()
  await first
  assert.equal(coordinator.pendingCreators(), 0)
})

test('dashboard methods enforce storage quota, serialization, index, and bcrypt rates', () => {
  const source = readFileSync(new URL('./methods.js', import.meta.url), 'utf8')
  assert.match(source, /createIndex\(\{ createdBy: 1, _id: 1 \}\)/u)
  assert.match(source, /limit:\s*MAX_DASHBOARDS_PER_CREATOR/u)
  assert.equal(
    (source.match(/assertDashboardCreatorQuota\(this\.userId\)/gu) || []).length,
    2,
  )
  assert.match(source, /dashboardCreationCoordinator\.run\(/u)
  assert.match(source, /createdBy:\s*this\.userId/u)
  assert.match(source, /for \(const name of \['addDashboard', 'updateDashboard'\]\)/u)
  assert.match(source, /\}, 10, 60 \* 1000\)/u)
  assert.match(source, /\}, 20, 60 \* 1000\)/u)
})
