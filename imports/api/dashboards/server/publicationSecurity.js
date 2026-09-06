import { PUBLIC_TIMECARD_FIELDS } from '../../timecards/server/publicationPrivacy.js'

const DASHBOARD_PUBLIC_FIELDS = Object.freeze({
  projectId: 1,
  timePeriod: 1,
  customer: 1,
  resourceId: 1,
  startDate: 1,
  endDate: 1,
  timeunit: 1,
  hoursToDays: 1,
  slug: 1,
})

// The password and the all-project authorization marker are observed only to
// make an access decision. Neither is copied into a client document.
const DASHBOARD_OBSERVER_FIELDS = Object.freeze({
  ...DASHBOARD_PUBLIC_FIELDS,
  password: 1,
  allProjectsAuthorized: 1,
})

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000
const MAX_PUBLIC_DASHBOARD_DATE_SPAN_DAYS = 366
const MAX_PUBLIC_DASHBOARD_TIMECARDS = 5000
const MAX_PUBLIC_DASHBOARD_PROJECTS = 500
const MAX_PUBLIC_DASHBOARD_SUBSCRIPTIONS_PER_PEER = 10
const MAX_PUBLIC_DASHBOARD_SUBSCRIPTIONS_PER_DASHBOARD = 50
const MAX_PUBLIC_DASHBOARD_SUBSCRIPTIONS_TOTAL = 200
const MAX_PRIVATE_DASHBOARD_PROJECTS = 1000
const MAX_PRIVATE_DASHBOARD_ROWS = 1000
const BOUNDED_PUBLIC_DASHBOARD_PERIODS = new Set([
  'currentMonth',
  'currentWeek',
  'currentYear',
  'lastMonth',
  'last3months',
  'lastWeek',
  'lastYear',
  'custom',
])

function exactFields(document, fields) {
  return Object.fromEntries(Object.keys(fields)
    .filter((field) => field !== '_id'
      && Object.prototype.hasOwnProperty.call(document || {}, field))
    .map((field) => [field, document[field]]))
}

function safeDashboardFields(dashboard) {
  return {
    ...exactFields(dashboard, DASHBOARD_PUBLIC_FIELDS),
    hasPassword: dashboardHasPassword(dashboard),
  }
}

function safeDashboardDocuments(dashboards) {
  return new Map([...dashboards].map(([id, dashboard]) => [
    id, safeDashboardFields(dashboard),
  ]))
}

function safeTimecardDocuments(timecards) {
  return new Map([...timecards].map(([id, timecard]) => [
    id, exactFields(timecard, PUBLIC_TIMECARD_FIELDS),
  ]))
}

function boundedPublicTimecardDocuments(
  timecards,
  maximum = MAX_PUBLIC_DASHBOARD_TIMECARDS,
) {
  if (!(timecards instanceof Map) || !Number.isSafeInteger(maximum) || maximum < 1) {
    throw new TypeError('Invalid public dashboard timecard bound')
  }
  if (timecards.size > maximum) {
    return { exceeded: true, documents: new Map() }
  }
  return { exceeded: false, documents: safeTimecardDocuments(timecards) }
}

function isActiveUser(user, userId) {
  return user?._id === userId && user.inactive !== true
}

function isActiveAdministrator(user, userId) {
  return isActiveUser(user, userId) && user.isAdmin === true
}

function isProjectMember(project, userId) {
  return project?.userId === userId
    || project?.admins?.includes(userId)
    || project?.team?.includes(userId)
}

function canCreateDashboard({ user, userId, projectId, project }) {
  if (!isActiveUser(user, userId)) return false
  if (projectId === 'all') return user.isAdmin === true
  if (!project || project._id !== projectId) return false
  return user.isAdmin === true || isProjectMember(project, userId)
}

function dashboardMayStreamTimecards(dashboard) {
  if (!dashboard || typeof dashboard.projectId !== 'string') return false
  if (!BOUNDED_PUBLIC_DASHBOARD_PERIODS.has(dashboard.timePeriod)) return false
  return dashboard.projectId !== 'all' || dashboard.allProjectsAuthorized === true
}

function publicDashboardDateRangeAllowed(startDate, endDate) {
  if (!(startDate instanceof Date) || Number.isNaN(startDate.getTime())
    || !(endDate instanceof Date) || Number.isNaN(endDate.getTime())) return false
  const elapsed = endDate.getTime() - startDate.getTime()
  return elapsed >= 0
    && elapsed <= MAX_PUBLIC_DASHBOARD_DATE_SPAN_DAYS * MILLISECONDS_PER_DAY
}

function createPublicDashboardSubscriptionGate({
  perPeer = MAX_PUBLIC_DASHBOARD_SUBSCRIPTIONS_PER_PEER,
  perDashboard = MAX_PUBLIC_DASHBOARD_SUBSCRIPTIONS_PER_DASHBOARD,
  total = MAX_PUBLIC_DASHBOARD_SUBSCRIPTIONS_TOTAL,
} = {}) {
  for (const value of [perPeer, perDashboard, total]) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new TypeError('Invalid public dashboard subscription bound')
    }
  }
  const peerCounts = new Map()
  const dashboardCounts = new Map()
  let activeCount = 0

  function acquire({ dashboardId, peerAddress }) {
    if (typeof dashboardId !== 'string' || !dashboardId || dashboardId.length > 128) return null
    const peer = typeof peerAddress === 'string' && peerAddress && peerAddress.length <= 256
      ? peerAddress : 'unknown'
    if (activeCount >= total
      || (peerCounts.get(peer) || 0) >= perPeer
      || (dashboardCounts.get(dashboardId) || 0) >= perDashboard) return null

    activeCount += 1
    peerCounts.set(peer, (peerCounts.get(peer) || 0) + 1)
    dashboardCounts.set(dashboardId, (dashboardCounts.get(dashboardId) || 0) + 1)
    let active = true
    return () => {
      if (!active) return
      active = false
      activeCount -= 1
      const peerCount = (peerCounts.get(peer) || 1) - 1
      const dashboardCount = (dashboardCounts.get(dashboardId) || 1) - 1
      if (peerCount) peerCounts.set(peer, peerCount)
      else peerCounts.delete(peer)
      if (dashboardCount) dashboardCounts.set(dashboardId, dashboardCount)
      else dashboardCounts.delete(dashboardId)
    }
  }

  return {
    acquire,
    snapshot: () => ({
      activeCount,
      dashboards: dashboardCounts.size,
      peers: peerCounts.size,
    }),
  }
}

function dashboardHasPassword(dashboard) {
  const value = dashboard?.password
  return value !== undefined && value !== null && value !== ''
}

function dashboardPasswordAllows(dashboard, password, comparePassword) {
  if (!dashboardHasPassword(dashboard)) return true
  if (typeof dashboard.password !== 'string') return false
  try {
    return comparePassword(password || '', dashboard.password) === true
  } catch {
    return false
  }
}

async function dashboardPasswordAllowsAsync(dashboard, password, comparePassword) {
  if (!dashboardHasPassword(dashboard)) return true
  if (typeof dashboard.password !== 'string') return false
  try {
    return await comparePassword(password || '', dashboard.password) === true
  } catch {
    return false
  }
}

function dashboardCredentialUnchanged(dashboard, expectedPassword) {
  return Boolean(dashboard) && Object.is(dashboard.password, expectedPassword)
}

function dashboardProjectNameDocuments({
  dashboard,
  project,
  projectId,
  password,
  comparePassword,
  credentialVerified = false,
  expectedPassword,
}) {
  const allowed = dashboard?.projectId === projectId
    && project?._id === projectId
    && (credentialVerified
      ? dashboardCredentialUnchanged(dashboard, expectedPassword)
      : dashboardPasswordAllows(dashboard, password, comparePassword))
  return allowed ? new Map([[projectId, { name: project.name }]]) : new Map()
}

export {
  DASHBOARD_OBSERVER_FIELDS,
  DASHBOARD_PUBLIC_FIELDS,
  MAX_PUBLIC_DASHBOARD_DATE_SPAN_DAYS,
  MAX_PUBLIC_DASHBOARD_PROJECTS,
  MAX_PUBLIC_DASHBOARD_SUBSCRIPTIONS_PER_DASHBOARD,
  MAX_PUBLIC_DASHBOARD_SUBSCRIPTIONS_PER_PEER,
  MAX_PUBLIC_DASHBOARD_SUBSCRIPTIONS_TOTAL,
  MAX_PUBLIC_DASHBOARD_TIMECARDS,
  MAX_PRIVATE_DASHBOARD_PROJECTS,
  MAX_PRIVATE_DASHBOARD_ROWS,
  boundedPublicTimecardDocuments,
  canCreateDashboard,
  createPublicDashboardSubscriptionGate,
  dashboardHasPassword,
  dashboardCredentialUnchanged,
  dashboardMayStreamTimecards,
  dashboardPasswordAllows,
  dashboardPasswordAllowsAsync,
  dashboardProjectNameDocuments,
  exactFields,
  isActiveAdministrator,
  isActiveUser,
  isProjectMember,
  publicDashboardDateRangeAllowed,
  safeDashboardDocuments,
  safeDashboardFields,
  safeTimecardDocuments,
}
