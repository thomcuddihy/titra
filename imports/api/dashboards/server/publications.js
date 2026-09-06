import { Meteor } from 'meteor/meteor'
import { check, Match } from 'meteor/check'
import dayjs from 'dayjs'
import utc from 'dayjs/plugin/utc'
import customParseFormat from 'dayjs/plugin/customParseFormat'
import bcrypt from 'bcrypt'
import { DDPRateLimiter } from 'meteor/ddp-rate-limiter'
import { Dashboards } from '../dashboards.js'
import Timecards from '../../timecards/timecards'
import Projects from '../../projects/projects.js'
import { periodToDates } from '../../../utils/periodHelpers.js'
import {
  checkAdminAuthentication,
  checkAuthentication,
} from '../../../utils/server_method_helpers.js'
import {
  applyObserverChange,
  createPublicationReconciler,
  createRestartableDocumentObserver,
} from '../../../utils/reactivePublication.js'
import { PUBLIC_TIMECARD_FIELDS } from '../../timecards/server/publicationPrivacy.js'
import {
  DASHBOARD_OBSERVER_FIELDS,
  MAX_PRIVATE_DASHBOARD_PROJECTS,
  MAX_PRIVATE_DASHBOARD_ROWS,
  MAX_PUBLIC_DASHBOARD_PROJECTS,
  MAX_PUBLIC_DASHBOARD_TIMECARDS,
  boundedPublicTimecardDocuments,
  createPublicDashboardSubscriptionGate,
  dashboardCredentialUnchanged,
  dashboardHasPassword,
  dashboardMayStreamTimecards,
  dashboardPasswordAllowsAsync,
  isActiveAdministrator,
  isActiveUser,
  publicDashboardDateRangeAllowed,
  safeDashboardDocuments,
  safeDashboardFields,
} from './publicationSecurity.js'
import { createActivePublicationGate } from '../../../utils/activePublicationGate.js'

const MAX_SHARE_PASSWORD_LENGTH = 256
const publicDashboardSubscriptionGate = createPublicDashboardSubscriptionGate()
const privateDashboardSubscriptionGate = createActivePublicationGate()

function observerCallbacks(documents, changed) {
  return {
    added(id, fields) {
      documents.set(id, { _id: id, ...fields })
      changed()
    },
    changed(id, fields) {
      applyObserverChange(documents, id, fields)
      changed()
    },
    removed(id) {
      documents.delete(id)
      changed()
    },
  }
}

function publicationReconciler(context, collectionName) {
  return createPublicationReconciler({
    collectionName,
    added: (...args) => context.added(...args),
    changed: (...args) => context.changed(...args),
    removed: (...args) => context.removed(...args),
  })
}

function handlePublicationError(context, error) {
  if (typeof context.error === 'function') context.error(error)
  else throw error
}

function validateSharePassword(password) {
  check(password, Match.Optional(String))
  if ((password || '').length > MAX_SHARE_PASSWORD_LENGTH) {
    throw new Meteor.Error('invalid-password', 'Dashboard password is too long')
  }
}

function validateDashboardId(dashboardId) {
  check(dashboardId, String)
  if (!dashboardId || dashboardId.length > 128
    || /[\u0000-\u001f\u007f]/u.test(dashboardId)) {
    throw new Meteor.Error('invalid-dashboard-id', 'Invalid dashboard ID')
  }
}

function passwordMatches(dashboard, password) {
  return dashboardPasswordAllowsAsync(dashboard, password, bcrypt.compare)
}

for (const name of [
  'dashboardTimecardsById',
  'dashboardDetailsById',
  'dashboardPublicMeta',
]) {
  DDPRateLimiter.addRule({
    type: 'subscription',
    name,
    clientAddress(clientAddress) { return clientAddress },
  }, 10, 60 * 1000)
}

function acquirePublicDashboardSubscriptionSlot(context, dashboardId) {
  const release = publicDashboardSubscriptionGate.acquire({
    dashboardId,
    peerAddress: context.connection?.clientAddress,
  })
  if (!release) {
    throw new Meteor.Error(
      'dashboard-subscription-limit',
      'Too many active public dashboard subscriptions. Try again later.',
    )
  }
  context.onStop(release)
}

function acquirePrivateDashboardSubscriptionSlot(context) {
  const release = privateDashboardSubscriptionGate.acquire({
    userId: context.userId,
    peerAddress: context.connection?.clientAddress,
  })
  if (!release) {
    throw new Meteor.Error(
      'subscription-limit',
      'Too many active dashboard subscriptions. Close another view and try again.',
    )
  }
  context.onStop(release)
}

async function observeAdminDashboards(context) {
  const users = new Map()
  const dashboards = new Map()
  const reconciler = publicationReconciler(context, 'dashboards')
  let initialized = false
  let stopped = false
  let userHandle
  let dashboardHandle
  const reconcile = () => {
    if (!initialized || stopped) return
    const user = users.get(context.userId)
    reconciler.reconcile(isActiveAdministrator(user, context.userId)
      ? safeDashboardDocuments(dashboards) : new Map())
  }
  context.onStop(() => {
    stopped = true
    if (userHandle) userHandle.stop()
    if (dashboardHandle) dashboardHandle.stop()
  })
  userHandle = await Meteor.users.find({ _id: context.userId }, {
    fields: { isAdmin: 1, inactive: 1 },
  }).observeChangesAsync(observerCallbacks(users, reconcile))
  if (stopped) {
    userHandle.stop()
    return
  }
  dashboardHandle = await Dashboards.find({}, {
    fields: DASHBOARD_OBSERVER_FIELDS,
  }).observeChangesAsync(observerCallbacks(dashboards, reconcile))
  if (stopped) {
    userHandle.stop()
    dashboardHandle.stop()
    return
  }
  initialized = true
  reconcile()
  context.ready()
}

/** Publish dashboard configuration to active administrators without password hashes. */
Meteor.publish('allDashboardsDetails', async function allDashboardsDetails() {
  await checkAdminAuthentication(this)
  return observeAdminDashboards(this)
})

/** Publish safe dashboard configuration for projects the active user can currently view. */
Meteor.publish('myDashboards', async function myDashboards() {
  await checkAuthentication(this)
  acquirePrivateDashboardSubscriptionSlot(this)
  const users = new Map()
  const projects = new Map()
  const reconciler = publicationReconciler(this, 'dashboards')
  let initialized = false
  let stopped = false
  let userHandle
  let projectHandle
  let dashboardObserver
  let failed = false
  const failPublication = (code, reason) => {
    if (stopped || failed) return
    failed = true
    reconciler.removeAll()
    if (typeof this.error === 'function') this.error(new Meteor.Error(code, reason))
    else throw new Meteor.Error(code, reason)
  }
  const activeProjectIds = () => [...projects.keys()].sort()
  const desiredDocuments = () => {
    if (!isActiveUser(users.get(this.userId), this.userId)) return new Map()
    const visible = new Set(projects.keys())
    return safeDashboardDocuments(new Map([...dashboardObserver.documents()]
      .filter(([, dashboard]) => visible.has(dashboard.projectId))))
  }
  const reconcile = () => {
    if (initialized && !stopped && !failed) reconciler.reconcile(desiredDocuments())
  }
  dashboardObserver = createRestartableDocumentObserver({
    cursorForScope: (projectIds) => (projectIds?.length ? Dashboards.find({
      projectId: { $in: projectIds },
    }, {
      fields: DASHBOARD_OBSERVER_FIELDS,
      sort: { _id: 1 },
      limit: MAX_PRIVATE_DASHBOARD_ROWS + 1,
    }) : null),
    documentsChanged(documents) {
      if (documents.size > MAX_PRIVATE_DASHBOARD_ROWS) {
        failPublication(
          'dashboard-result-limit',
          `Dashboard subscriptions may not exceed ${MAX_PRIVATE_DASHBOARD_ROWS} rows.`,
        )
        return
      }
      reconcile()
    },
  })
  const refresh = () => {
    if (projects.size > MAX_PRIVATE_DASHBOARD_PROJECTS) {
      failPublication(
        'dashboard-project-limit',
        `Dashboard subscriptions may not span more than ${MAX_PRIVATE_DASHBOARD_PROJECTS} projects.`,
      )
      return
    }
    reconcile()
    if (!initialized || stopped || failed) return
    const scope = isActiveUser(users.get(this.userId), this.userId)
      ? activeProjectIds() : null
    dashboardObserver.restart(scope).catch((error) => {
      if (!stopped && !failed) handlePublicationError(this, error)
    })
  }
  this.onStop(() => {
    stopped = true
    if (userHandle) userHandle.stop()
    if (projectHandle) projectHandle.stop()
    dashboardObserver.stop()
  })
  userHandle = await Meteor.users.find({ _id: this.userId }, {
    fields: { inactive: 1 },
  }).observeChangesAsync(observerCallbacks(users, refresh))
  if (stopped) {
    userHandle.stop()
    return undefined
  }
  projectHandle = await Projects.find({
    $or: [
      { userId: this.userId },
      { admins: this.userId },
      { team: this.userId },
    ],
  }, {
    fields: { _id: 1 },
    sort: { _id: 1 },
    limit: MAX_PRIVATE_DASHBOARD_PROJECTS + 1,
  }).observeChangesAsync(observerCallbacks(projects, refresh))
  if (stopped) {
    userHandle.stop()
    projectHandle.stop()
    return undefined
  }
  initialized = true
  if (projects.size > MAX_PRIVATE_DASHBOARD_PROJECTS) {
    failPublication(
      'dashboard-project-limit',
      `Dashboard subscriptions may not span more than ${MAX_PRIVATE_DASHBOARD_PROJECTS} projects.`,
    )
    return undefined
  }
  const initialScope = isActiveUser(users.get(this.userId), this.userId)
    ? activeProjectIds() : null
  await dashboardObserver.restart(initialScope)
  if (stopped || failed) return undefined
  reconcile()
  return this.ready()
})

async function dashboardTimecardSelector(dashboard, projects = new Map()) {
  if (!dashboardMayStreamTimecards(dashboard)) return null
  const customer = typeof dashboard.customer === 'string' ? dashboard.customer : undefined
  let selector
  if (dashboard.projectId === 'all') {
    if (customer && customer !== 'all') {
      selector = {
        projectId: {
          $in: [...projects.values()]
            .filter((project) => project.customer === customer)
            .map((project) => project._id),
        },
      }
    } else selector = {}
  } else {
    if (customer && customer !== 'all'
      && projects.get(dashboard.projectId)?.customer !== customer) return null
    selector = { projectId: dashboard.projectId }
  }
  if (dashboard.resourceId && dashboard.resourceId !== 'all') {
    selector.userId = dashboard.resourceId
  }
  let startDate
  let endDate
  if (dashboard.timePeriod === 'custom') {
    startDate = dashboard.startDate
      ? new Date(dashboard.startDate) : dayjs().startOf('month').toDate()
    endDate = dashboard.endDate ? new Date(dashboard.endDate) : dayjs().endOf('month').toDate()
  } else {
    const dates = await periodToDates(dashboard.timePeriod)
    startDate = dates.startDate
    endDate = dates.endDate
  }
  if (!publicDashboardDateRangeAllowed(startDate, endDate)) {
    throw new Meteor.Error(
      'dashboard-date-range-not-allowed',
      'Public dashboards require a valid date range of at most 366 days.',
    )
  }
  selector.date = { $gte: startDate, $lte: endDate }
  return selector
}

/**
 * Publish a public dashboard's strictly allowlisted timecards. Dashboard
 * deletion, password rotation/addition and selector changes immediately clear
 * the old client snapshot before a replacement observer can publish data.
 */
Meteor.publish('dashboardTimecardsById', async function dashboardTimecardsById(_id, password) {
  validateDashboardId(_id)
  validateSharePassword(password)
  dayjs.extend(utc)
  dayjs.extend(customParseFormat)
  const initialDashboard = await Dashboards.findOneAsync({ _id }, {
    fields: DASHBOARD_OBSERVER_FIELDS,
  })
  if (!initialDashboard) return this.ready()
  if (initialDashboard.timePeriod === 'all') {
    throw new Meteor.Error(
      'dashboard-date-range-not-allowed',
      'All-history public dashboards are disabled. Select a bounded period.',
    )
  }
  if (!dashboardMayStreamTimecards(initialDashboard)) return this.ready()
  if (!await passwordMatches(initialDashboard, password)) {
    throw new Meteor.Error('Wrong password', 'inserted password is not correct')
  }
  acquirePublicDashboardSubscriptionSlot(this, _id)

  const dashboards = new Map()
  const expectedPassword = initialDashboard.password
  const projects = new Map()
  const reconciler = publicationReconciler(this, 'timecards')
  let dashboardHandle
  let projectHandle
  let projectInitialized = false
  let stopped = false
  let failed = false
  let refreshGeneration = 0
  let authorizedGeneration = 0
  const failPublication = (code, reason) => {
    if (stopped || failed) return
    failed = true
    authorizedGeneration = 0
    reconciler.removeAll()
    handlePublicationError(this, new Meteor.Error(code, reason))
  }
  const timecardObserver = createRestartableDocumentObserver({
    cursorForScope: (selector) => (selector ? Timecards.find(selector, {
      fields: PUBLIC_TIMECARD_FIELDS,
      sort: { date: 1, _id: 1 },
      limit: MAX_PUBLIC_DASHBOARD_TIMECARDS + 1,
    }) : null),
    documentsChanged(documents) {
      const bounded = boundedPublicTimecardDocuments(documents)
      if (bounded.exceeded) {
        failPublication(
          'dashboard-result-limit',
          `Public dashboard results may not exceed ${MAX_PUBLIC_DASHBOARD_TIMECARDS} `
            + 'time entries. Select a narrower period.',
        )
        return
      }
      if (!stopped && authorizedGeneration === refreshGeneration) {
        reconciler.reconcile(bounded.documents)
      }
    },
  })
  const refresh = async () => {
    refreshGeneration += 1
    const generation = refreshGeneration
    authorizedGeneration = 0
    reconciler.removeAll()
    await timecardObserver.restart(null)
    if (stopped || failed || generation !== refreshGeneration) return
    const dashboard = dashboards.get(_id)
    if (!dashboardMayStreamTimecards(dashboard)
        || !dashboardCredentialUnchanged(dashboard, expectedPassword)) return
    const selector = await dashboardTimecardSelector(dashboard, projects)
    if (!selector || stopped || failed || generation !== refreshGeneration) return
    authorizedGeneration = generation
    const started = await timecardObserver.restart(selector)
    if (!started || stopped || failed || generation !== refreshGeneration) return
  }
  const changed = () => {
    reconciler.removeAll()
    refresh().catch((error) => {
      if (!stopped) handlePublicationError(this, error)
    })
  }
  const projectChanged = () => {
    if (projects.size > MAX_PUBLIC_DASHBOARD_PROJECTS) {
      failPublication(
        'dashboard-project-limit',
        `Public dashboards may not span more than ${MAX_PUBLIC_DASHBOARD_PROJECTS} projects.`,
      )
      return
    }
    if (projectInitialized) changed()
  }
  this.onStop(() => {
    stopped = true
    refreshGeneration += 1
    if (dashboardHandle) dashboardHandle.stop()
    if (projectHandle) projectHandle.stop()
    timecardObserver.stop()
  })
  dashboardHandle = await Dashboards.find({ _id }, {
    fields: DASHBOARD_OBSERVER_FIELDS,
  }).observeChangesAsync(observerCallbacks(dashboards, changed))
  if (stopped) {
    dashboardHandle.stop()
    return undefined
  }
  const projectSelector = initialDashboard.projectId === 'all'
    ? (initialDashboard.customer && initialDashboard.customer !== 'all'
      ? { customer: initialDashboard.customer } : null)
    : { _id: initialDashboard.projectId }
  if (projectSelector) {
    projectHandle = await Projects.find(projectSelector, {
      fields: { customer: 1 },
      sort: { _id: 1 },
      limit: MAX_PUBLIC_DASHBOARD_PROJECTS + 1,
    }).observeChangesAsync(observerCallbacks(projects, projectChanged))
    if (stopped) {
      dashboardHandle.stop()
      projectHandle.stop()
      return undefined
    }
    projectInitialized = true
  }
  await refresh()
  if (!stopped && !failed) this.ready()
  return undefined
})

/** Publish only existence, slug and password presence for public discovery. */
Meteor.publish('dashboardPublicMeta', async function dashboardPublicMeta(_id) {
  validateDashboardId(_id)
  const byId = await Dashboards.findOneAsync({ _id }, { fields: { _id: 1 } })
  const resolved = byId || await Dashboards.findOneAsync({ slug: _id }, {
    fields: { _id: 1 },
  })
  if (!resolved) {
    this.added('dashboards', _id, { exists: false, hasPassword: false })
    return this.ready()
  }
  acquirePublicDashboardSubscriptionSlot(this, resolved._id)
  const dashboards = new Map()
  const reconciler = publicationReconciler(this, 'dashboards')
  let initialized = false
  let stopped = false
  let dashboardHandle
  const reconcile = () => {
    if (!initialized || stopped) return
    const dashboard = dashboards.values().next().value
    reconciler.reconcile(dashboard ? new Map([[dashboard._id, {
      slug: dashboard.slug,
      hasPassword: dashboardHasPassword(dashboard),
      exists: true,
    }]]) : new Map([[resolved._id, { exists: false, hasPassword: false }]]))
  }
  this.onStop(() => {
    stopped = true
    if (dashboardHandle) dashboardHandle.stop()
  })
  dashboardHandle = await Dashboards.find(byId
    ? { _id: resolved._id }
    : { _id: resolved._id, slug: _id }, {
    fields: { slug: 1, password: 1 },
  }).observeChangesAsync(
    observerCallbacks(dashboards, reconcile),
  )
  if (stopped) {
    dashboardHandle.stop()
    return undefined
  }
  initialized = true
  reconcile()
  return this.ready()
})

/** Publish safe dashboard details while the supplied password remains valid. */
Meteor.publish('dashboardDetailsById', async function dashboardDetailsById(_id, password) {
  validateDashboardId(_id)
  validateSharePassword(password)
  const initialDashboard = await Dashboards.findOneAsync({ _id }, {
    fields: DASHBOARD_OBSERVER_FIELDS,
  })
  if (!initialDashboard) return this.ready()
  if (!await passwordMatches(initialDashboard, password)) {
    throw new Meteor.Error('Wrong password', 'inserted password is not correct')
  }
  acquirePublicDashboardSubscriptionSlot(this, _id)
  const dashboards = new Map()
  const expectedPassword = initialDashboard.password
  const reconciler = publicationReconciler(this, 'dashboards')
  let initialized = false
  let stopped = false
  let dashboardHandle
  const reconcile = () => {
    if (!initialized || stopped) return
    const dashboard = dashboards.get(_id)
    reconciler.reconcile(dashboardCredentialUnchanged(dashboard, expectedPassword)
      ? new Map([[_id, safeDashboardFields(dashboard)]]) : new Map())
  }
  this.onStop(() => {
    stopped = true
    if (dashboardHandle) dashboardHandle.stop()
  })
  dashboardHandle = await Dashboards.find({ _id }, {
    fields: DASHBOARD_OBSERVER_FIELDS,
  }).observeChangesAsync(observerCallbacks(dashboards, reconcile))
  if (stopped) {
    dashboardHandle.stop()
    return undefined
  }
  initialized = true
  reconcile()
  return this.ready()
})
