import { canCreateDashboard } from './publicationSecurity.js'

const DASHBOARD_TIME_PERIODS = new Set([
  'currentMonth',
  'currentWeek',
  'currentYear',
  'lastMonth',
  'last3months',
  'lastWeek',
  'lastYear',
  'custom',
])

const MAX_DASHBOARDS_PER_CREATOR = 100

function boundedText(value, { optional = false, max = 256 } = {}) {
  if (value === undefined && optional) return true
  return typeof value === 'string' && value.length > 0 && value.length <= max
    && !/[\u0000-\u001f\u007f]/.test(value)
}

function validDashboardDate(value) {
  if (value === undefined) return true
  if (!boundedText(value, { max: 64 })) return false
  const parsed = new Date(value)
  return !Number.isNaN(parsed.getTime())
}

function dashboardCreatorQuotaAvailable(
  existingCount,
  maximum = MAX_DASHBOARDS_PER_CREATOR,
) {
  if (!Number.isSafeInteger(existingCount) || existingCount < 0
    || !Number.isSafeInteger(maximum) || maximum < 1) {
    throw new TypeError('Invalid dashboard creator quota state')
  }
  return existingCount < maximum
}

/** Serialize quota check-and-insert in this app process for each creator. */
function createDashboardCreationCoordinator() {
  const tails = new Map()

  async function run(userId, operation) {
    if (typeof userId !== 'string' || !userId || userId.length > 128
      || typeof operation !== 'function') {
      throw new TypeError('Invalid dashboard creation operation')
    }
    const previous = tails.get(userId) || Promise.resolve()
    let release
    const current = new Promise((resolve) => { release = resolve })
    const tail = previous.then(() => current)
    tails.set(userId, tail)
    await previous
    try {
      return await operation()
    } finally {
      release()
      if (tails.get(userId) === tail) tails.delete(userId)
    }
  }

  return { run, pendingCreators: () => tails.size }
}

function dashboardInputProblem({
  projectId,
  timePeriod,
  resourceId,
  customer,
  startDate,
  endDate,
  password,
  slug,
}, { update = false } = {}) {
  if (!update && !boundedText(projectId, { max: 128 })) return 'projectId'
  if ((!update || timePeriod !== undefined)
    && (!boundedText(timePeriod, { max: 32 }) || !DASHBOARD_TIME_PERIODS.has(timePeriod))) {
    return 'timePeriod'
  }
  if (!boundedText(resourceId, { optional: true, max: 128 })) return 'resourceId'
  if (!boundedText(customer, { optional: true, max: 256 })) return 'customer'
  if (!validDashboardDate(startDate)) return 'startDate'
  if (!validDashboardDate(endDate)) return 'endDate'
  if (password !== undefined && (typeof password !== 'string'
    || password.length > 256 || /[\u0000-\u001f\u007f]/.test(password))) return 'password'
  if (slug !== undefined && (typeof slug !== 'string'
    || slug.length > 128 || /[\u0000-\u001f\u007f]/.test(slug))) return 'slug'
  return null
}

async function loadDashboardCreationAccess({
  userId,
  projectId,
  findUser,
  findProject,
}) {
  const user = await findUser(userId)
  const project = projectId === 'all' ? undefined : await findProject(projectId)
  return {
    allowed: canCreateDashboard({ user, userId, projectId, project }),
    user,
    project,
  }
}

/** Re-read authorization and invoke the insert without another asynchronous gap. */
async function insertDashboardIfAuthorized({
  userId,
  projectId,
  findUser,
  findProject,
  insert,
}) {
  const access = await loadDashboardCreationAccess({
    userId, projectId, findUser, findProject,
  })
  if (!access.allowed) return { inserted: false }
  return { inserted: true, result: await insert(access) }
}

export {
  DASHBOARD_TIME_PERIODS,
  MAX_DASHBOARDS_PER_CREATOR,
  boundedText,
  createDashboardCreationCoordinator,
  dashboardCreatorQuotaAvailable,
  dashboardInputProblem,
  insertDashboardIfAuthorized,
  loadDashboardCreationAccess,
  validDashboardDate,
}
