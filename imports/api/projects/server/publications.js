import dayjs from 'dayjs'
import utc from 'dayjs/plugin/utc'
import { check, Match } from 'meteor/check'
import bcrypt from 'bcrypt'
import { DDPRateLimiter } from 'meteor/ddp-rate-limiter'
import Projects from '../projects'
import Timecards from '../../timecards/timecards.js'
import CustomFields from '../../customfields/customfields.js'
import { Dashboards } from '../../dashboards/dashboards.js'
import {
  dashboardPasswordAllowsAsync,
  dashboardProjectNameDocuments,
} from '../../dashboards/server/publicationSecurity.js'
import { checkAuthentication, getGlobalSettingAsync } from '../../../utils/server_method_helpers.js'
import {
  buildProjectStatsAggregation,
  emptyTotals,
} from '../../../utils/projectStats.js'
import {
  applyObserverChange,
  createPublicationReconciler,
} from '../../../utils/reactivePublication.js'
import {
  MAX_PROJECT_SCOPE_IDS,
  RESOURCE_QUERY_MAX_TIME_MS,
  normalizeBoundedPagination,
  normalizeResourceScope,
} from '../../../utils/resourceLimits.js'
import { createAnonymousPublicationGate } from '../../../utils/activePublicationGate.js'
import {
  changedProjectFields,
  projectFields,
  projectFieldsForCaller,
  projectStatsPublicationDocuments,
} from './publicationPrivacy.js'
import {
  currentPublicProjectsDisabled,
  stopPublicationOnPublicAccessDisable,
} from './publicAccessServer.js'
import {
  canViewProjectUnderPolicy,
  projectAudienceClauses,
} from './publicAccessPolicy.js'

const publicProjectMetadataGate = createAnonymousPublicationGate()

function acquirePublicProjectMetadataSlot(context, resourceId) {
  const release = publicProjectMetadataGate.acquire({
    peerAddress: context.connection?.clientAddress,
    resourceId,
  })
  if (!release) {
    throw new Meteor.Error(
      'subscription-limit',
      'Too many active public project subscriptions. Try again later.',
    )
  }
  context.onStop(release)
}

async function memberProjectFields() {
  const customFields = await CustomFields.find({ classname: 'project' }, {
    fields: { name: 1 },
  }).fetchAsync()
  return projectFields({
    member: true,
    customFieldNames: customFields.map((field) => field.name),
  })
}

async function publishProjectsForCaller(context, userId, selector = {}, options = {}) {
  const publicDisabled = await currentPublicProjectsDisabled()
  await stopPublicationOnPublicAccessDisable(context, publicDisabled)
  const memberFields = await memberProjectFields()
  const customFieldNames = Object.keys(memberFields)
    .filter((field) => !Object.prototype.hasOwnProperty.call(
      projectFields({ member: true }), field,
    ))
  const documents = new Map()
  const published = new Map()
  const cursor = Projects.find({
    ...selector,
    $or: projectAudienceClauses(userId, publicDisabled),
  }, { ...options, fields: memberFields })
  const handle = await cursor.observeChangesAsync({
    added(id, fields) {
      const project = { _id: id, ...fields }
      documents.set(id, project)
      const safeFields = projectFieldsForCaller(project, userId, customFieldNames)
      published.set(id, safeFields)
      context.added('projects', id, safeFields)
    },
    changed(id, fields) {
      const project = documents.get(id) || { _id: id }
      Object.entries(fields).forEach(([field, value]) => {
        if (value === undefined) delete project[field]
        else project[field] = value
      })
      documents.set(id, project)
      const safeFields = projectFieldsForCaller(project, userId, customFieldNames)
      const changes = changedProjectFields(published.get(id), safeFields)
      published.set(id, safeFields)
      if (Object.keys(changes).length) context.changed('projects', id, changes)
    },
    removed(id) {
      documents.delete(id)
      published.delete(id)
      context.removed('projects', id)
    },
  })
  context.ready()
  context.onStop(() => handle.stop())
}

/**
 * Publishes all projects for the current user.
 * @param {Number} projectLimit - The number of projects to return.
 * @returns {Array} - The list of projects for the current user.
 */
Meteor.publish('myprojects', async function myProjects({ projectLimit } = {}) {
  if(this.userId) {
    await checkAuthentication(this)
  } else {
    return this.ready()
  }
  check(projectLimit, Match.Maybe(Number))
  const { limit } = normalizeBoundedPagination(projectLimit ?? MAX_PROJECT_SCOPE_IDS, 1, {
    label: 'Project publication',
    maxLimit: MAX_PROJECT_SCOPE_IDS,
  })
  return publishProjectsForCaller(
    this, this.userId, {}, { limit, sort: { _id: 1 } },
  )
})
/**
 * Publishes a single project based on a provided projectId.
 * @param {String} projectId - The project ID to filter projects by.
 * @returns {Object} - The project that matches the projectId.
 */
Meteor.publish('singleProject', async function singleProject(projectId) {
  check(projectId, String)
  await checkAuthentication(this)
  return publishProjectsForCaller(this, this.userId, { _id: projectId })
})
/**
 * Publishes the calculated statistics for a project.
 * @param {String} projectId - The project ID to filter statistics by.
 * @returns {Object} - The statistics object for the project.
 */
Meteor.publish('projectStats', async function projectStats(projectId) {
  check(projectId, String)
  await checkAuthentication(this)
  projectId = normalizeResourceScope(projectId, 'Project', { allowAll: false }).value
  const callerId = this.userId
  const publicDisabled = await currentPublicProjectsDisabled()
  await stopPublicationOnPublicAccessDisable(this, publicDisabled)
  const initialAccess = await Projects.findOneAsync({
    _id: projectId,
    $or: projectAudienceClauses(callerId, publicDisabled),
  }, {
    fields: {
      _id: 1, userId: 1, admins: 1, team: 1, public: 1, rate: 1, rates: 1,
    },
  })
  // Do not run an all-history aggregation merely because an authenticated
  // caller guessed a project identifier.
  if (!initialAccess) return this.ready()
  dayjs.extend(utc)
  const currentMonth = dayjs.utc()
  const currentMonthName = currentMonth.format('MMM')
  const currentMonthStart = currentMonth.startOf('month').toDate()
  const currentMonthEnd = currentMonth.endOf('month').toDate()
  const previousMonthName = currentMonth.subtract(1, 'month').format('MMM')
  const previousMonthStart = currentMonth.subtract(1, 'month').startOf('month').toDate()
  const previousMonthEnd = currentMonth.subtract(1, 'month').endOf('month').toDate()
  const beforePreviousMonthStart = currentMonth.subtract(2, 'month').startOf('month').toDate()
  const beforePreviousMonthEnd = currentMonth.subtract(2, 'month').endOf('month').toDate()
  const beforePreviousMonthName = currentMonth.subtract(2, 'month').format('MMM')

  const monthNames = {
    currentMonthName,
    previousMonthName,
    beforePreviousMonthName,
  }
  const allowIndividualTaskRates = await getGlobalSettingAsync('allowIndividualTaskRates')
  const monthRanges = {
    currentMonthHours: { start: currentMonthStart, end: currentMonthEnd },
    previousMonthHours: { start: previousMonthStart, end: previousMonthEnd },
    beforePreviousMonthHours: {
      start: beforePreviousMonthStart, end: beforePreviousMonthEnd,
    },
  }
  const reconciler = createPublicationReconciler({
    collectionName: 'projectStats',
    added: (...args) => this.added(...args),
    changed: (...args) => this.changed(...args),
    removed: (...args) => this.removed(...args),
  })
  let initialized = false
  let stopped = false
  let projectHandle
  let project = initialAccess
  let aggregationGeneration = 0

  const retract = () => {
    aggregationGeneration += 1
    reconciler.removeAll()
  }
  const refresh = async () => {
    const snapshot = project
    const generation = ++aggregationGeneration
    if (!canViewProjectUnderPolicy(snapshot, callerId, publicDisabled)) {
      reconciler.removeAll()
      return
    }
    const [totals = emptyTotals()] = await Timecards.rawCollection().aggregate(
      buildProjectStatsAggregation({
        project: snapshot,
        allowIndividualTaskRates,
        monthRanges,
      }),
      { allowDiskUse: false, maxTimeMS: RESOURCE_QUERY_MAX_TIME_MS },
    ).toArray()
    if (stopped || generation !== aggregationGeneration) return
    reconciler.reconcile(projectStatsPublicationDocuments({
      projectId,
      project: snapshot,
      totals,
      userId: callerId,
      monthNames,
    }))
  }
  const refreshAfterChange = () => {
    if (!initialized || stopped) return
    refresh().catch((error) => {
      if (!stopped) this.error(error)
    })
  }

  this.onStop(() => {
    stopped = true
    aggregationGeneration += 1
    if (projectHandle) projectHandle.stop()
  })
  projectHandle = await Projects.find({ _id: projectId }, {
    fields: {
      _id: 1, userId: 1, admins: 1, team: 1, public: 1, rate: 1, rates: 1,
    },
  }).observeChangesAsync({
    added(id, fields) {
      project = { _id: id, ...fields }
      refreshAfterChange()
    },
    changed(id, fields) {
      const projects = new Map([[id, project]])
      applyObserverChange(projects, id, fields)
      project = projects.get(id)
      if (!canViewProjectUnderPolicy(project, callerId, publicDisabled)) retract()
      else refreshAfterChange()
    },
    removed() {
      project = undefined
      retract()
    },
  })
  if (stopped) {
    projectHandle.stop()
    return undefined
  }
  if (!canViewProjectUnderPolicy(project, callerId, publicDisabled)) {
    projectHandle.stop()
    projectHandle = undefined
    return this.ready()
  }
  initialized = true
  // Timecard changes become visible after the UI resubscribes. Avoiding an
  // all-history observer keeps one project view from retaining every record.
  await refresh()
  if (stopped) return undefined
  return this.ready()
})
/**
 * Publishes the project name based on the provided projectId.
 * @param {String} _id - The project ID to filter projects by.
 * @returns {String} - The name of the project that matches the projectId.
 */
Meteor.publish('publicProjectName', async function publicProjectName(_id) {
  check(_id, String)
  _id = normalizeResourceScope(_id, 'Project', { allowAll: false }).value
  const publicDisabled = await currentPublicProjectsDisabled()
  await stopPublicationOnPublicAccessDisable(this, publicDisabled)
  const selector = { _id }
  if (this.userId) {
    await checkAuthentication(this)
    selector.$or = projectAudienceClauses(this.userId, publicDisabled)
  } else if (publicDisabled) return this.ready()
  else selector.public = true
  const initialProject = await Projects.findOneAsync(selector, { fields: { _id: 1 } })
  if (!initialProject) return this.ready()
  acquirePublicProjectMetadataSlot(this, `project:${_id}`)
  return Projects.find(selector, { fields: { name: 1 }, limit: 1 })
})

for (const name of ['dashboardProjectName', 'publicProjectName']) {
  DDPRateLimiter.addRule({
    type: 'subscription',
    name,
    clientAddress(clientAddress) {
      return typeof clientAddress === 'string' && clientAddress.length > 0
    },
  }, 10, 60 * 1000)
}

/** Publish a private dashboard's project name only after its share password is verified. */
Meteor.publish('dashboardProjectName', async function dashboardProjectName({ dashboardId, password }) {
  check(dashboardId, String)
  check(password, Match.Maybe(String))
  dashboardId = normalizeResourceScope(
    dashboardId, 'Dashboard', { allowAll: false },
  ).value
  if ((password || '').length > 256) return this.ready()
  const initialDashboard = await Dashboards.findOneAsync({ _id: dashboardId }, {
    fields: { projectId: 1, password: 1 },
  })
  const initialPasswordMatches = initialDashboard && await dashboardPasswordAllowsAsync(
    initialDashboard, password, bcrypt.compare,
  )
  if (!initialDashboard || !initialPasswordMatches) return this.ready()
  acquirePublicProjectMetadataSlot(this, `dashboard:${dashboardId}`)
  const dashboards = new Map()
  const expectedPassword = initialDashboard.password
  const projects = new Map()
  const reconciler = createPublicationReconciler({
    collectionName: 'projects',
    added: (...args) => this.added(...args),
    changed: (...args) => this.changed(...args),
    removed: (...args) => this.removed(...args),
  })
  let initialized = false
  let stopped = false
  let dashboardHandle
  let projectHandle
  const reconcile = () => {
    if (!initialized || stopped) return
    const dashboard = dashboards.get(dashboardId)
    const project = projects.get(initialDashboard.projectId)
    reconciler.reconcile(dashboardProjectNameDocuments({
      dashboard,
      project,
      projectId: initialDashboard.projectId,
      credentialVerified: true,
      expectedPassword,
    }))
  }
  const callbacks = (documents) => ({
    added(id, fields) { documents.set(id, { _id: id, ...fields }); reconcile() },
    changed(id, fields) { applyObserverChange(documents, id, fields); reconcile() },
    removed(id) { documents.delete(id); reconcile() },
  })
  this.onStop(() => {
    stopped = true
    if (dashboardHandle) dashboardHandle.stop()
    if (projectHandle) projectHandle.stop()
  })
  dashboardHandle = await Dashboards.find({ _id: dashboardId }, {
    fields: { projectId: 1, password: 1 },
  }).observeChangesAsync(callbacks(dashboards))
  if (stopped) {
    dashboardHandle.stop()
    return undefined
  }
  projectHandle = await Projects.find({ _id: initialDashboard.projectId }, {
    fields: { name: 1 },
  }).observeChangesAsync(callbacks(projects))
  if (stopped) {
    dashboardHandle.stop()
    projectHandle.stop()
    return undefined
  }
  initialized = true
  reconcile()
  return this.ready()
})
