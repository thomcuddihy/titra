import { Match } from 'meteor/check'
import { DDPRateLimiter } from 'meteor/ddp-rate-limiter'
import Timecards from '../timecards.js'
import Projects from '../../projects/projects.js'
import CustomFields from '../../customfields/customfields.js'
import { checkAuthentication, buildDetailedTimeEntriesForPeriodSelectorAsync } from '../../../utils/server_method_helpers.js'
import {
  applyObserverChange,
  createPublicationReconciler,
  createRestartableDocumentObserver,
} from '../../../utils/reactivePublication.js'
import {
  isProjectMember,
  projectIdsFromTimecardSelector,
  scopeSelectorToProjects,
  timecardFields,
  timecardPublicationDocuments,
} from './publicationPrivacy.js'
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
  MAX_TIMECARD_PUBLICATION_RECORDS,
  RESOURCE_QUERY_MAX_TIME_MS,
  assertBoundedDateRange,
  normalizeResourceScope,
} from '../../../utils/resourceLimits.js'
import { createActivePublicationGate } from '../../../utils/activePublicationGate.js'

const timecardPublicationGate = createActivePublicationGate()
const HEAVY_TIMECARD_PUBLICATIONS = [
  'getDetailedTimeEntriesForPeriod',
  'periodTimecards',
]

for (const name of HEAVY_TIMECARD_PUBLICATIONS) {
  DDPRateLimiter.addRule({
    type: 'subscription',
    name,
    userId(userId) { return typeof userId === 'string' && userId.length > 0 },
  }, 30, 60 * 1000)
  DDPRateLimiter.addRule({
    type: 'subscription',
    name,
    clientAddress(clientAddress) {
      return typeof clientAddress === 'string' && clientAddress.length > 0
    },
  }, 60, 60 * 1000)
}

function acquireTimecardPublicationSlot(context) {
  const release = timecardPublicationGate.acquire({
    userId: context.userId,
    peerAddress: context.connection?.clientAddress,
  })
  if (!release) {
    throw new Meteor.Error(
      'subscription-limit',
      'Too many active timecard subscriptions. Close another view and try again.',
    )
  }
  context.onStop(release)
}

const projectAccessFields = {
  _id: 1, userId: 1, admins: 1, team: 1, public: 1,
}

async function configuredTimecardCustomFields() {
  const customFields = await CustomFields.find({ classname: 'time_entry' }, {
    fields: { name: 1 },
  }).fetchAsync()
  return customFields.map((field) => field.name)
}

async function publicationFieldsForProjects(projects, userId, ownsEveryRecord = false) {
  const member = ownsEveryRecord
    || (projects.length > 0 && projects.every((project) => isProjectMember(project, userId)))
  return timecardFields({
    member,
    customFieldNames: member ? await configuredTimecardCustomFields() : [],
  })
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

/**
 * Observe project access and replace the data observer whenever the visible
 * project set changes. Reconciliation runs before a replacement so revocation
 * removes documents immediately and stale callbacks cannot re-add them.
 */
async function publishAccessScopedDocuments({
  context,
  collectionName,
  projectCursor,
  cursorForProjectIds,
  desiredDocuments,
}) {
  const publicDisabled = await currentPublicProjectsDisabled()
  await stopPublicationOnPublicAccessDisable(context, publicDisabled)
  const projects = new Map()
  const reconciler = publicationReconciler(context, collectionName)
  let projectHandle
  let initialized = false
  let stopped = false
  let accessKey

  const dataObserver = createRestartableDocumentObserver({
    cursorForScope: (projectIds) => (projectIds ? cursorForProjectIds(projectIds) : null),
    documentsChanged(documents) {
      if (!stopped) reconciler.reconcile(desiredDocuments(documents, new Map(
        [...projects].filter(([, project]) => canViewProjectUnderPolicy(
          project, context.userId, publicDisabled,
        )),
      )))
    },
  })

  const reconcile = () => {
    if (initialized && !stopped) {
      reconciler.reconcile(desiredDocuments(dataObserver.documents(), new Map(
        [...projects].filter(([, project]) => canViewProjectUnderPolicy(
          project, context.userId, publicDisabled,
        )),
      )))
    }
  }
  const visibleIds = () => [...projects.values()]
    .filter((project) => canViewProjectUnderPolicy(
      project, context.userId, publicDisabled,
    ))
    .map((project) => project._id)
    .sort()
  const refreshDataObserver = async (force = false) => {
    if (stopped) return
    const ids = visibleIds()
    const nextAccessKey = ids.join('\u0000')
    if (!force && accessKey === nextAccessKey) return
    accessKey = nextAccessKey
    await dataObserver.restart(ids.length ? ids : null)
  }
  const accessChanged = () => {
    reconcile()
    if (initialized) {
      refreshDataObserver().catch((error) => {
        if (!stopped) handlePublicationError(context, error)
      })
    }
  }

  context.onStop(() => {
    stopped = true
    if (projectHandle) projectHandle.stop()
    dataObserver.stop()
  })

  projectHandle = await projectCursor.observeChangesAsync({
    added(id, fields) {
      projects.set(id, { _id: id, ...fields })
      accessChanged()
    },
    changed(id, fields) {
      applyObserverChange(projects, id, fields)
      accessChanged()
    },
    removed(id) {
      projects.delete(id)
      accessChanged()
    },
  })
  if (stopped) {
    projectHandle.stop()
    return undefined
  }
  initialized = true
  await refreshDataObserver(true)
  if (stopped) return undefined
  reconcile()
  context.ready()
  return undefined
}

/**
   * Publishes the project list based on the provided period.
   *
   * @name periodTimecards
   * @param {Object} this - The context of the current publication.
   * @param {Date} startDate - The start date of the timecards.
   * @param {Date} endDate - The end date of the timecards.
   * @returns {Array} - The list of projects that match the period.
   */
Meteor.publish('periodTimecards', async function periodTimecards({ startDate, endDate, userId }) {
  check(startDate, Date)
  check(endDate, Date)
  check(userId, String)
  await checkAuthentication(this)
  acquireTimecardPublicationSlot(this)
  const userScope = normalizeResourceScope(userId, 'User')
  assertBoundedDateRange(startDate, endDate, { label: 'Timecard publication range' })
  const publicDisabled = await currentPublicProjectsDisabled()
  const customFieldNames = await configuredTimecardCustomFields()
  const rawFields = timecardFields({ member: true, customFieldNames })
  return publishAccessScopedDocuments({
    context: this,
    collectionName: 'timecards',
    projectCursor: Projects.find(
    {
      $and: [
        { $or: projectAudienceClauses(this.userId, publicDisabled) },
        { $or: [{ archived: false }, { archived: { $exists: false } }] },
      ],
    },
    {
      fields: projectAccessFields,
      sort: { _id: 1 },
      limit: MAX_PROJECT_SCOPE_IDS,
    },
    ),
    cursorForProjectIds: (projectIds) => Timecards.find({
      projectId: { $in: projectIds },
      ...(userScope.all ? {} : { userId: userScope.value }),
      date: { $gte: startDate, $lte: endDate },
    }, {
      fields: rawFields,
      sort: { date: -1, _id: 1 },
      limit: MAX_TIMECARD_PUBLICATION_RECORDS,
    }),
    desiredDocuments: (timecards, projects) => timecardPublicationDocuments({
      timecards, projects, userId: this.userId, customFieldNames,
    }),
  })
})
/**
 * Publishes timecards based on the provided start date.
 *
 * @param {String} date - The calendar date accepted by the existing UI.
 */
Meteor.publish('myTimecardsForDate', async function myTimecardsForDate({ date }) {
  check(date, String)
  await checkAuthentication(this)
  const startDate = new Date(date)
  const endDate = new Date(date)
  if (Number.isNaN(startDate.getTime())) return this.ready()
  startDate.setHours(0, 0, 0, 0)
  endDate.setHours(23, 59, 59, 999)
  return Timecards.find({
    userId: this.userId,
    date: { $gte: startDate, $lte: endDate },
  }, { fields: await publicationFieldsForProjects([], this.userId, true) })
})
/**
 * Publishes the counts of time entries for the provided period.
 * @name getDetailedTimeEntriesForPeriodCount
 * @param {string} projectId - The ID of the project.
 * @param {string} userId - The ID of the user.
 * @param {string} customer - The ID of the customer.
 * @param {string} period - The period to filter the time entries.
 * @param {Object} dates - The start and end dates for the custom period.
 * @param {string} search - The search string.
 * @param {Object} filters - The filters to apply.
 * @returns {number} - The number of time entries that match the period.
 */
Meteor.publish('getDetailedTimeEntriesForPeriodCount', async function getDetailedTimeEntriesForPeriodCount({
  projectId,
  userId,
  customer,
  period,
  dates,
  search,
  filters,
}) {
  check(projectId, Match.OneOf(String, Array))
  check(userId, Match.OneOf(String, Array))
  check(customer, Match.OneOf(String, Array))
  check(period, String)
  if (period === 'custom') {
    check(dates, Object)
    check(dates.startDate, Date)
    check(dates.endDate, Date)
  }
  check(search, Match.Maybe(String))
  await checkAuthentication(this)
  const selector = await buildDetailedTimeEntriesForPeriodSelectorAsync({
    projectId, search, customer, period, dates, userId, filters,
  })
  const requestedProjectIds = projectIdsFromTimecardSelector(selector[0])
  const countsId = projectId instanceof Array ? projectId.join('') : projectId
  const publicDisabled = await currentPublicProjectsDisabled()
  await stopPublicationOnPublicAccessDisable(this, publicDisabled)
  const visibleProjects = await Projects.find({
    _id: { $in: requestedProjectIds },
    $or: projectAudienceClauses(this.userId, publicDisabled),
  }, { fields: { _id: 1 } }).fetchAsync()
  const visibleProjectIds = visibleProjects.map(({ _id }) => _id)
  const count = visibleProjectIds.length
    ? await Timecards.rawCollection().countDocuments(
      scopeSelectorToProjects(selector[0], visibleProjectIds),
      { maxTimeMS: RESOURCE_QUERY_MAX_TIME_MS },
    )
    : 0
  this.added('counts', countsId, { count })
  return this.ready()
})
/**
 * Publishes time entries for the provided period.
 * @name getDetailedTimeEntriesForPeriod
 * @param {string} projectId - The ID of the project.
 * @param {string} userId - The ID of the user.
 * @param {string} customer - The ID of the customer.
 * @param {string} period - The period to filter the time entries.
 * @param {Object} dates - The start and end dates for the custom period.
 * @param {string} search - The search string.
 * @param {Object} sort - The sort object.
 * @param {number} limit - The number of time entries to return.
 * @param {number} page - The page number.
 * @param {Object} filters - The filters to apply.
 * @returns {Array} - The list of time entries that match the period.
 */
Meteor.publish('getDetailedTimeEntriesForPeriod', async function getDetailedTimeEntriesForPeriod({
  projectId,
  userId,
  customer,
  period,
  dates,
  search,
  sort,
  limit,
  page,
  filters,
}) {
  check(projectId, Match.OneOf(String, Array))
  check(userId, Match.OneOf(String, Array))
  check(customer, Match.OneOf(String, Array))
  check(period, String)
  check(search, Match.Maybe(String))
  check(sort, Match.Maybe(Object))
  if (period === 'custom') {
    check(dates, Object)
    check(dates.startDate, Date)
    check(dates.endDate, Date)
  }
  if (sort) {
    check(sort.column, Number)
    check(sort.order, String)
  }
  check(limit, Number)
  check(page, Match.Maybe(Number))
  check(filters, Match.Maybe(Object))
  await checkAuthentication(this)
  acquireTimecardPublicationSlot(this)
  const selector = await buildDetailedTimeEntriesForPeriodSelectorAsync({
    projectId, search, customer, period, dates, userId, limit, page, sort, filters,
  })
  const projectIds = projectIdsFromTimecardSelector(selector[0])
  if (!projectIds.length) return this.ready()
  const customFieldNames = await configuredTimecardCustomFields()
  const rawFields = timecardFields({ member: true, customFieldNames })
  return publishAccessScopedDocuments({
    context: this,
    collectionName: 'timecards',
    projectCursor: Projects.find({ _id: { $in: projectIds } }, {
      fields: projectAccessFields,
    }),
    cursorForProjectIds: (visibleIds) => Timecards.find(
      scopeSelectorToProjects(selector[0], visibleIds),
      { ...selector[1], fields: rawFields },
    ),
    desiredDocuments: (timecards, projects) => timecardPublicationDocuments({
      timecards, projects, userId: this.userId, customFieldNames,
    }),
  })
})
/**
 * Publishes a single timecard based on the provided ID.
 * @name singleTimecard
 * @param {string} _id - The ID of the timecard.
 */
Meteor.publish('singleTimecard', async function singleTimecard(_id) {
  check(_id, String)
  await checkAuthentication(this)
  const timecard = await Timecards.findOneAsync({ _id }, {
    fields: { _id: 1, projectId: 1, userId: 1 },
  })
  if (!timecard) return this.ready()
  const publicDisabled = await currentPublicProjectsDisabled()
  await stopPublicationOnPublicAccessDisable(this, publicDisabled)
  const initialProject = await Projects.findOneAsync({ _id: timecard.projectId }, {
    fields: projectAccessFields,
  })
  const initiallyOwned = timecard.userId === this.userId
  if (!initiallyOwned
      && !canViewProjectUnderPolicy(initialProject, this.userId, publicDisabled)) {
    return this.ready()
  }
  const customFieldNames = await configuredTimecardCustomFields()
  const rawFields = timecardFields({ member: true, customFieldNames })
  const projects = new Map()
  const timecards = new Map()
  const reconciler = publicationReconciler(this, 'timecards')
  let initialized = false
  let stopped = false
  let projectHandle
  let timecardHandle
  const reconcile = () => {
    if (!initialized || stopped) return
    const visibleProjects = new Map([...projects].filter(([, project]) => (
      canViewProjectUnderPolicy(project, this.userId, publicDisabled)
    )))
    reconciler.reconcile(timecardPublicationDocuments({
      timecards,
      projects: visibleProjects,
      userId: this.userId,
      customFieldNames,
      includeOwnedRecords: true,
    }))
  }
  this.onStop(() => {
    stopped = true
    if (projectHandle) projectHandle.stop()
    if (timecardHandle) timecardHandle.stop()
  })
  projectHandle = await Projects.find({ _id: timecard.projectId }, {
    fields: projectAccessFields,
  }).observeChangesAsync({
    added(id, fields) { projects.set(id, { _id: id, ...fields }); reconcile() },
    changed(id, fields) { applyObserverChange(projects, id, fields); reconcile() },
    removed(id) { projects.delete(id); reconcile() },
  })
  if (stopped) {
    projectHandle.stop()
    return undefined
  }
  if (!initiallyOwned && !canViewProjectUnderPolicy(
    projects.get(timecard.projectId), this.userId, publicDisabled,
  )) {
    projectHandle.stop()
    projectHandle = undefined
    return this.ready()
  }
  timecardHandle = await Timecards.find({
    _id, userId: timecard.userId, projectId: timecard.projectId,
  }, { fields: rawFields }).observeChangesAsync({
    added(id, fields) { timecards.set(id, { _id: id, ...fields }); reconcile() },
    changed(id, fields) { applyObserverChange(timecards, id, fields); reconcile() },
    removed(id) { timecards.delete(id); reconcile() },
  })
  if (stopped) {
    timecardHandle.stop()
    return undefined
  }
  initialized = true
  reconcile()
  return this.ready()
})
