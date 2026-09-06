import { Match } from 'meteor/check'
import { DDPRateLimiter } from 'meteor/ddp-rate-limiter'
import Timecards from '../../timecards/timecards.js'
import Projects from '../../projects/projects.js'
import { Dashboards } from '../../dashboards/dashboards'
import { checkAuthentication, checkAdminAuthentication } from '../../../utils/server_method_helpers.js'
import {
  ADMIN_USER_LIST_FIELDS,
  allowedProjectResourceUserIds,
  canViewDashboardResource,
  dashboardUserPublicationDocuments,
  projectResourcesPublicationDocuments,
  projectTeamPublicationDocuments,
  projectUsersPublicationDocuments,
} from './projectUserPrivacy.js'
import { SIGNED_IN_USER_FIELDS } from './signedInUserPrivacy.js'
import {
  applyObserverChange,
  createPublicationReconciler,
  createRestartableDocumentObserver,
} from '../../../utils/reactivePublication.js'
import { publishReactiveCollection } from '../../../utils/adminCollectionPublication.js'
import {
  adminUserListDocuments,
  adminUserListLimit,
  adminUserListSelector,
} from './adminUserListSecurity.js'
import {
  currentPublicProjectsDisabled,
  stopPublicationOnPublicAccessDisable,
} from '../../projects/server/publicAccessServer.js'
import {
  canViewProjectUnderPolicy,
  projectAudienceClauses,
} from '../../projects/server/publicAccessPolicy.js'
import {
  MAX_PROJECT_SCOPE_IDS,
  RESOURCE_QUERY_MAX_TIME_MS,
  assertResultWithinLimit,
  normalizeResourceScope,
} from '../../../utils/resourceLimits.js'
import { createActivePublicationGate } from '../../../utils/activePublicationGate.js'

const projectAudienceFields = {
  _id: 1, userId: 1, admins: 1, team: 1, public: 1,
}
const MAX_PROJECT_AUDIENCE_USERS = 1000
const userAudiencePublicationGate = createActivePublicationGate({
  perUser: 20,
  perPeer: 50,
  total: 500,
})

for (const name of ['dashboardUser', 'projectResources', 'projectTeam', 'projectUsers']) {
  DDPRateLimiter.addRule({
    type: 'subscription',
    name,
    userId(userId) { return typeof userId === 'string' && userId.length > 0 },
  }, 60, 60 * 1000)
  DDPRateLimiter.addRule({
    type: 'subscription',
    name,
    clientAddress(clientAddress) {
      return typeof clientAddress === 'string' && clientAddress.length > 0
    },
  }, 120, 60 * 1000)
}

function acquireUserAudiencePublicationSlot(context) {
  const release = userAudiencePublicationGate.acquire({
    userId: context.userId,
    peerAddress: context.connection?.clientAddress,
  })
  if (!release) {
    throw new Meteor.Error(
      'subscription-limit',
      'Too many active user-list subscriptions. Close another view and try again.',
    )
  }
  context.onStop(release)
}

function visibleProjectsSelector(userId, publicDisabled) {
  return { $or: projectAudienceClauses(userId, publicDisabled) }
}

async function resolveVisibleProjects(projectId, userId, publicDisabled) {
  const scope = normalizeResourceScope(projectId, 'Project')
  const selector = visibleProjectsSelector(userId, publicDisabled)
  if (!scope.all) selector._id = { $in: scope.values }
  const projects = await Projects.find(selector, {
    fields: projectAudienceFields,
    limit: MAX_PROJECT_SCOPE_IDS + 1,
    sort: { _id: 1 },
  }).fetchAsync()
  return assertResultWithinLimit(projects, MAX_PROJECT_SCOPE_IDS, 'Visible project scope')
}

async function distinctTimecardUsers(projectIds) {
  const rows = await Timecards.rawCollection().aggregate([
    { $match: { projectId: { $in: projectIds } } },
    { $group: { _id: { projectId: '$projectId', userId: '$userId' } } },
    { $sort: { '_id.projectId': 1, '_id.userId': 1 } },
    { $limit: MAX_PROJECT_AUDIENCE_USERS + 1 },
    { $project: { _id: 0, projectId: '$_id.projectId', userId: '$_id.userId' } },
  ], {
    allowDiskUse: false,
    maxTimeMS: RESOURCE_QUERY_MAX_TIME_MS,
  }).toArray()
  return assertResultWithinLimit(rows, MAX_PROJECT_AUDIENCE_USERS, 'Project resource users')
}

function publicationReconciler(context, collectionName) {
  return createPublicationReconciler({
    collectionName,
    added: (...args) => context.added(...args),
    changed: (...args) => context.changed(...args),
    removed: (...args) => context.removed(...args),
  })
}

function reportAsyncPublicationError(context, error) {
  if (typeof context.error === 'function') context.error(error)
  else throw error
}

function observerCallbacks(documents, changed) {
  return {
    added(id, fields) { documents.set(id, { _id: id, ...fields }); changed() },
    changed(id, fields) { applyObserverChange(documents, id, fields); changed() },
    removed(id) { documents.delete(id); changed() },
  }
}

async function publishProjectAudienceUsers(context, { projectId, collectionName }) {
  acquireUserAudiencePublicationSlot(context)
  const projectScope = normalizeResourceScope(projectId, 'Project')
  const publicDisabled = await currentPublicProjectsDisabled()
  await stopPublicationOnPublicAccessDisable(context, publicDisabled)
  const initialProjects = await resolveVisibleProjects(
    projectId, context.userId, publicDisabled,
  )
  const requestedIds = projectScope.values
  const requestsAll = projectScope.all
  if (!requestsAll && initialProjects.length !== new Set(requestedIds).size) {
    return context.ready()
  }
  const projectIds = initialProjects.map((project) => project._id)
  if (!projectIds.length) return context.ready()

  const projects = new Map()
  let timecardUsers = []
  const reconciler = publicationReconciler(context, collectionName)
  let initialized = false
  let stopped = false
  let projectHandle
  let userScope = ''
  let refreshChain = Promise.resolve()

  const visibleProjectMap = () => new Map([...projects].filter(([, project]) => (
    canViewProjectUnderPolicy(project, context.userId, publicDisabled)
  )))
  const desiredDocuments = (users) => (collectionName === 'projectUsers'
    ? projectUsersPublicationDocuments({
      publicationId: projectId, projects: visibleProjectMap(), timecards: timecardUsers, users,
      callerUserId: context.userId,
    })
    : projectResourcesPublicationDocuments({
      projects: visibleProjectMap(), timecards: timecardUsers, users,
      callerUserId: context.userId,
    }))
  const userObserver = createRestartableDocumentObserver({
    cursorForScope: (ids) => (ids?.length ? Meteor.users.find({
      _id: { $in: ids }, inactive: { $ne: true },
    }, { fields: { 'profile.name': 1 } }) : null),
    documentsChanged: (users) => {
      if (initialized && !stopped) reconciler.reconcile(desiredDocuments(users))
    },
  })
  const refresh = async () => {
    timecardUsers = await distinctTimecardUsers([...visibleProjectMap().keys()])
    if (stopped) return
    const allowedIds = allowedProjectResourceUserIds(
      [...visibleProjectMap().values()], timecardUsers, context.userId,
    ).sort()
    const nextScope = JSON.stringify(allowedIds)
    if (nextScope !== userScope) {
      userScope = nextScope
      await userObserver.restart(allowedIds)
    }
    if (!stopped) reconciler.reconcile(desiredDocuments(userObserver.documents()))
  }
  const queueRefresh = () => {
    if (!initialized || stopped) return
    refreshChain = refreshChain.then(refresh).catch(
      (error) => reportAsyncPublicationError(context, error),
    )
  }

  context.onStop(() => {
    stopped = true
    if (projectHandle) projectHandle.stop()
    userObserver.stop()
  })
  projectHandle = await Projects.find({ _id: { $in: projectIds } }, {
    fields: projectAudienceFields,
    limit: MAX_PROJECT_SCOPE_IDS,
    sort: { _id: 1 },
  }).observeChangesAsync(observerCallbacks(projects, queueRefresh))
  if (stopped) { projectHandle.stop(); return undefined }
  initialized = true
  await refresh()
  if (!stopped) context.ready()
  return undefined
}
/**
 * Publishes the users who tracked time on a project based on the provided project ID.
 * @param {String} projectId - The project ID.
 * @returns {Array} - The list of users that have time tracked for the project ID.
 */
Meteor.publish('projectUsers', async function projectUsers({ projectId }) {
  check(projectId, String)
  await checkAuthentication(this)
  return publishProjectAudienceUsers(this, { projectId, collectionName: 'projectUsers' })
})
/** 
 * Publishes the users who are part of a project team based on the provided user IDs.
 * @param {Array} userIds - The list of user IDs.
 * @returns {Array} - The list of users that are part of the project team.
 */
Meteor.publish('projectTeam', async function projectTeam({ userIds }) {
  check(userIds, [String])
  await checkAuthentication(this)
  acquireUserAudiencePublicationSlot(this)
  const requestedUserIds = normalizeResourceScope(userIds, 'User', { allowAll: false }).values
  const projects = new Map()
  const users = new Map()
  const reconciler = publicationReconciler(this, 'users')
  let initialized = false
  let stopped = false
  let projectHandle
  let userHandle
  const reconcile = () => {
    if (!initialized || stopped) return
    if (projects.size > MAX_PROJECT_SCOPE_IDS) {
      this.error(new Meteor.Error(
        'project-scope-limit',
        `User-list subscriptions may not span more than ${MAX_PROJECT_SCOPE_IDS} projects.`,
      ))
      return
    }
    reconciler.reconcile(projectTeamPublicationDocuments({
      projects, users, requestedUserIds, callerUserId: this.userId,
    }))
  }
  this.onStop(() => {
    stopped = true
    if (projectHandle) projectHandle.stop()
    if (userHandle) userHandle.stop()
  })
  projectHandle = await Projects.find({
    $or: [{ userId: this.userId }, { admins: this.userId }, { team: this.userId }],
  }, {
    fields: projectAudienceFields,
    limit: MAX_PROJECT_SCOPE_IDS + 1,
    sort: { _id: 1 },
  }).observeChangesAsync(
    observerCallbacks(projects, reconcile),
  )
  if (stopped) { projectHandle.stop(); return undefined }
  userHandle = await Meteor.users.find({
    _id: { $in: requestedUserIds }, inactive: { $ne: true },
  }, {
    fields: { 'profile.name': 1 },
    limit: MAX_PROJECT_AUDIENCE_USERS,
    sort: { _id: 1 },
  }).observeChangesAsync(observerCallbacks(users, reconcile))
  if (stopped) { projectHandle.stop(); userHandle.stop(); return undefined }
  initialized = true
  reconcile()
  this.ready()
  return undefined
})
/** 
 * Publishes the user who is the resource of a dashboard based on the provided dashboard ID.
 * @param {String} _id - The dashboard ID.
 * @returns {Object} - The user that is the resource of the dashboard.
 */
Meteor.publish('dashboardUser', async function dashboardUser({ _id }) {
  check(_id, String)
  await checkAuthentication(this)
  acquireUserAudiencePublicationSlot(this)
  _id = normalizeResourceScope(_id, 'Dashboard', { allowAll: false }).value
  const initialDashboard = await Dashboards.findOneAsync({ _id }, {
    fields: { projectId: 1, resourceId: 1 },
  })
  const initialProject = initialDashboard && await Projects.findOneAsync({
    _id: initialDashboard.projectId,
  }, {
    fields: projectAudienceFields,
  })
  if (!canViewDashboardResource(initialDashboard, initialProject, this.userId)) return this.ready()

  const dashboards = new Map()
  const reconciler = publicationReconciler(this, 'users')
  let initialized = false
  let initializationDirty = false
  let stopped = false
  let refreshChain = Promise.resolve()
  let userScope = ''
  let projectScope = ''
  let dashboardHandle
  let queueRefresh = () => {}
  const projectObserver = createRestartableDocumentObserver({
    cursorForScope: (projectId) => (projectId ? Projects.find({ _id: projectId }, {
      fields: projectAudienceFields,
      limit: 1,
    }) : null),
    documentsChanged: () => queueRefresh(),
  })
  const userObserver = createRestartableDocumentObserver({
    cursorForScope: (userId) => (userId ? Meteor.users.find({
      _id: userId, inactive: { $ne: true },
    }, { fields: { 'profile.name': 1 } }) : null),
    documentsChanged: (users) => {
      if (stopped) return
      if (!initialized) {
        initializationDirty = true
        return
      }
      const dashboard = dashboards.get(_id)
      reconciler.reconcile(dashboardUserPublicationDocuments({
        dashboard,
        project: projectObserver.documents().get(dashboard?.projectId),
        users,
        callerUserId: this.userId,
      }))
    },
  })
  const refresh = async () => {
    const dashboard = dashboards.get(_id)
    const nextProjectScope = typeof dashboard?.projectId === 'string'
      && dashboard.projectId && dashboard.projectId.length <= 128
      ? dashboard.projectId : ''
    if (nextProjectScope !== projectScope) {
      projectScope = nextProjectScope
      await projectObserver.restart(nextProjectScope || null)
    }
    const project = projectObserver.documents().get(nextProjectScope)
    const nextScope = canViewDashboardResource(dashboard, project, this.userId)
      ? dashboard.resourceId : ''
    if (nextScope !== userScope) {
      userScope = nextScope
      await userObserver.restart(nextScope || null)
    }
    if (!stopped && (initialized || !initializationDirty)) {
      reconciler.reconcile(dashboardUserPublicationDocuments({
        dashboard,
        project,
        users: userObserver.documents(),
        callerUserId: this.userId,
      }))
    }
  }
  queueRefresh = () => {
    if (stopped) return
    if (!initialized) {
      initializationDirty = true
      return
    }
    refreshChain = refreshChain.then(refresh).catch(
      (error) => reportAsyncPublicationError(this, error),
    )
  }
  this.onStop(() => {
    stopped = true
    if (dashboardHandle) dashboardHandle.stop()
    projectObserver.stop()
    userObserver.stop()
  })
  dashboardHandle = await Dashboards.find({ _id }, {
    fields: { projectId: 1, resourceId: 1 },
  }).observeChangesAsync(observerCallbacks(dashboards, queueRefresh))
  if (stopped) { dashboardHandle.stop(); return undefined }
  // Keep nested observer callbacks gated until a complete, stable initial
  // dashboard -> project -> user snapshot has been awaited. Observer changes
  // update their maps and mark an in-flight pass dirty; dirty passes publish
  // nothing and are drained before ready, preventing both an empty ready race
  // and a transient stale-authorization disclosure.
  do {
    initializationDirty = false
    await refresh()
  } while (initializationDirty && !stopped)
  if (!stopped) {
    initialized = true
    this.ready()
  }
  return undefined
})
/**
 * Publishes the signed-in user's browser-safe UI profile and role fields.
 * Accounts' implicit current-user document contains only _id; this explicit,
 * live-gated subscription supplies every additional field required by the UI.
 * @returns {Object} - The browser-safe fields of the current user.
 */
Meteor.publish('userRoles', async function userRoles() {
  await checkAuthentication(this)
  return Meteor.users.find({ _id: this.userId }, { fields: SIGNED_IN_USER_FIELDS })
})
/** 
 * Publishes user list for administrators based on the provided limit and search string.
 * @param {Number} limit - The limit of users to return.
 * @param {String} search - The search string.
 * @returns {Array} - The list of users that match the search string.
 */
Meteor.publish('adminUserList', async function adminUserList({ limit, search } = {}) {
  check(limit, Match.Maybe(Number))
  check(search, Match.Maybe(String))
  await checkAdminAuthentication(this)
  return publishReactiveCollection(this, {
    users: Meteor.users,
    collection: Meteor.users,
    collectionName: 'users',
    fields: ADMIN_USER_LIST_FIELDS,
    selector: adminUserListSelector(search),
    cursorOptions: {
      sort: { createdAt: -1 },
      limit: adminUserListLimit(limit),
    },
    documentsForUser: adminUserListDocuments,
  })
})

/**
 * Publishes the users who tracked time on a project based on the provided project ID.
 * @param {String|Array} projectId - The project ID or list of project IDs.
 * @returns {Array} - The list of users that have time tracked for the project ID.
 */
Meteor.publish('projectResources', async function projectResources({ projectId }) {
  check(projectId, Match.OneOf(String, [String]))
  await checkAuthentication(this)
  return publishProjectAudienceUsers(this, { projectId, collectionName: 'projectResources' })
})
