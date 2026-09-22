import { Meteor } from 'meteor/meteor'
import { ValidatedMethod } from 'meteor/mdg:validated-method'
import { DDPRateLimiter } from 'meteor/ddp-rate-limiter'
import { EJSON } from 'meteor/ejson'
import { check } from 'meteor/check'
import Timecards from '../timecards.js'
import Projects from '../../projects/projects.js'
import CustomFields from '../../customfields/customfields.js'
import {
  authenticationMixin,
  transactionLogMixin,
  checkAuthentication,
  buildDetailedTimeEntriesForPeriodSelectorAsync,
  buildDailyHoursSelectorAsync,
  buildTotalHoursForPeriodSelectorAsync,
  buildworkingTimeSelectorAsync,
  workingTimeEntriesMapper,
  getGlobalSettingAsync,
} from '../../../utils/server_method_helpers.js'
import { createActivePublicationGate } from '../../../utils/activePublicationGate.js'
import { RESOURCE_QUERY_MAX_TIME_MS, MAX_PROJECT_SCOPE_IDS } from '../../../utils/resourceLimits.js'
import { projectIdsFromTimecardSelector, timecardFields, timecardFieldsForCaller } from './publicationPrivacy.js'
import {
  EXPORT_PAGE_SIZE,
  TimecardExportError,
  assertExportCount,
  assertExportFilterVisibility,
  exportAccessFingerprint,
  exportRowKey,
  normalizeExportPageInput,
  readAuthorizedExportPage,
  workingExportNameVisibility,
} from './exportPolicy.js'
import { validateStateMutationInput } from './stateMutation.js'
import { markAuthorizedTimeEntriesExported } from './exportState.js'

const exportGate = createActivePublicationGate({ perUser: 1, perPeer: 4, total: 20 })
const ACCESS_FIELDS = { _id: 1, userId: 1, admins: 1, team: 1, public: 1, archived: 1 }
const WORKING_SETTING_NAMES = ['addBreakToWorkingTime', 'breakDuration', 'breakStartTime', 'dailyStartTime', 'regularWorkingTime']
const WORKING_PROFILE_FIELDS = Object.fromEntries([
  '_id', 'inactive', 'profile.name', 'profile.breakDuration', 'profile.breakStartTime',
  'profile.dailyStartTime', 'profile.regularWorkingTime',
].map((name) => [name, 1]))

function publicExportError(error) {
  if (error instanceof TimecardExportError) return new Meteor.Error(error.error, error.message)
  if (error?.error === 'not-authorized') return new Meteor.Error('not-authorized', 'One or more time entries cannot be updated by this user.')
  if (error?.error === 'timecard-state-invalid') return new Meteor.Error('timecard-state-invalid', 'Select between 1 and 1,000 unique time-entry IDs.')
  if (error?.error === 'timecard-write-conflict') return new Meteor.Error('timecard-write-conflict', 'The time-entry update could not be verified.')
  return error
}

async function buildDataPlan(request) {
  const { view, query, page, limit } = request
  if (view === 'detailed') {
    const [selector, options] = await buildDetailedTimeEntriesForPeriodSelectorAsync({ ...query, page, limit })
    return {
      ...request, selector,
      options: { ...options, sort: { ...options.sort, _id: 1 } },
      projectIds: projectIdsFromTimecardSelector(selector),
    }
  }
  const { projectId, period, dates, userId, customer } = query
  let pipeline
  if (view === 'daily') pipeline = await buildDailyHoursSelectorAsync(projectId, period, dates, userId, customer, limit, page)
  else if (view === 'total') pipeline = await buildTotalHoursForPeriodSelectorAsync(projectId, period, dates, userId, customer, limit, page)
  else pipeline = await buildworkingTimeSelectorAsync(projectId, period, dates, userId, limit, page)
  // Preserve the authorized match and grouping semantics of the on-screen
  // methods. Only their final sort/skip/limit stages are omitted for counting.
  const countPipeline = pipeline.filter((stage) => !('$sort' in stage || '$skip' in stage || '$limit' in stage))
  countPipeline.push({ $count: 'totalEntries' })
  return { ...request, pipeline, countPipeline, projectIds: projectIdsFromTimecardSelector(pipeline[0].$match) }
}

async function buildExportPlan(request, callerId) {
  const hasCustomerFilter = (request.query.customer !== undefined && request.query.customer !== 'all')
    || Object.hasOwn(request.query.filters || {}, 'customer')
  const permissionQuery = { ...request.query, customer: 'all' }
  if (request.view === 'detailed') permissionQuery.filters = {}
  // Customer resolution is global in the shared selector helpers (and even
  // overrides project selection in Daily/Total). Authorize against the full
  // visible scope first so a guessed hidden customer cannot be distinguished
  // by an empty result, a matching project, or a selector-limit error.
  if (hasCustomerFilter) permissionQuery.projectId = 'all'
  const permissionPlan = await buildDataPlan({ ...request, query: permissionQuery })
  const permissionAccess = await exportAccessSnapshot({ ...permissionPlan, query: request.query }, callerId)
  const dataPlan = await buildDataPlan(request)
  return { ...dataPlan, permissionProjectIds: permissionPlan.projectIds, permissionFingerprint: permissionAccess.fingerprint }
}

async function exportAccessSnapshot(plan, callerId) {
  const projectIds = [...new Set([...(plan.permissionProjectIds || []), ...plan.projectIds])]
  const projects = await Projects.rawCollection().find({ _id: { $in: projectIds } }, {
    projection: ACCESS_FIELDS, limit: MAX_PROJECT_SCOPE_IDS + 1, maxTimeMS: RESOURCE_QUERY_MAX_TIME_MS,
  }).toArray()
  if (projects.length !== projectIds.length) {
    throw new TimecardExportError('export-access-changed', 'Project access changed while preparing the export. Try again.')
  }
  const publicDisabled = await getGlobalSettingAsync('disablePublicProjects') === true
  const customFields = plan.view === 'detailed' ? await CustomFields.rawCollection().find({ classname: 'time_entry' }, {
    projection: { name: 1 }, limit: 501, maxTimeMS: RESOURCE_QUERY_MAX_TIME_MS,
  }).toArray() : []
  if (customFields.length > 500) throw new TimecardExportError('export-too-large', 'Too many configured custom fields to export safely.')
  const customFieldNames = customFields.map((field) => field.name).filter((name) => typeof name === 'string')
  assertExportFilterVisibility(plan.query, projects, callerId, customFieldNames)
  const fingerprint = exportAccessFingerprint(projects, callerId, publicDisabled, customFieldNames)
  if (plan.permissionFingerprint) {
    const permissionProjects = projects.filter((project) => plan.permissionProjectIds.includes(project._id))
    if (plan.permissionFingerprint !== exportAccessFingerprint(permissionProjects, callerId, publicDisabled, customFieldNames)) {
      throw new TimecardExportError('export-access-changed', 'Project access changed while preparing the export. Try again.')
    }
  }
  return {
    callerId, projects, customFieldNames,
    fingerprint,
  }
}

function finiteHours(value) {
  const number = typeof value === 'number' ? value : Number(value?.toString())
  if (!Number.isFinite(number)) throw new TimecardExportError('export-invalid-result', 'A time-entry total is not a finite number.')
  return number
}

async function readExportPage(plan, access) {
  const collection = Timecards.rawCollection()
  if (plan.view === 'detailed') {
    const totalEntries = assertExportCount(await collection.countDocuments(plan.selector, { maxTimeMS: RESOURCE_QUERY_MAX_TIME_MS }))
    const entries = await collection.find(plan.selector, {
      ...plan.options, projection: timecardFields({ member: true, customFieldNames: access.customFieldNames }),
      limit: EXPORT_PAGE_SIZE, maxTimeMS: RESOURCE_QUERY_MAX_TIME_MS,
    }).toArray()
    const projects = new Map(access.projects.map((project) => [project._id, project]))
    const rows = entries.map((entry) => ({
      _id: entry._id,
      ...timecardFieldsForCaller(entry, projects.get(entry.projectId), access.callerId, access.customFieldNames),
    }))
    return { rows, keys: rows.map((row) => exportRowKey('detailed', row)), totalEntries }
  }
  const [count] = await collection.aggregate(plan.countPipeline, { maxTimeMS: RESOURCE_QUERY_MAX_TIME_MS }).toArray()
  const totalEntries = assertExportCount(count?.totalEntries ?? 0)
  const pipeline = structuredClone(plan.pipeline)
  if (plan.view === 'working') {
    pipeline.find((stage) => stage.$group).$group._exportResourceAllowed = workingExportNameVisibility(access.projects, access.callerId)
  }
  const entries = await collection.aggregate(pipeline, { maxTimeMS: RESOURCE_QUERY_MAX_TIME_MS }).toArray()
  const keys = entries.map((entry) => exportRowKey(plan.view, entry))
  if (plan.view !== 'working') {
    const rows = entries.map((entry) => ({ _id: entry._id, totalHours: finiteHours(entry.totalHours) }))
    return { rows, keys, totalEntries }
  }
  const userIds = [...new Set(entries.map((entry) => entry._id.userId))]
  // Project membership/admin rights permit names, not another user's private
  // working schedule. Only fetch the caller's schedule; all other profiles use
  // the mapper's global-setting defaults, including when names are visible.
  const ownUsers = userIds.includes(access.callerId) ? await Meteor.users.rawCollection().find({ _id: access.callerId }, {
    projection: WORKING_PROFILE_FIELDS, limit: 1, maxTimeMS: RESOURCE_QUERY_MAX_TIME_MS,
  }).toArray() : []
  const otherUsers = await Meteor.users.rawCollection().find({ _id: { $in: userIds.filter((id) => id !== access.callerId) } }, {
    projection: { _id: 1, inactive: 1, 'profile.name': 1 }, limit: EXPORT_PAGE_SIZE, maxTimeMS: RESOURCE_QUERY_MAX_TIME_MS,
  }).toArray()
  const users = [...ownUsers, ...otherUsers]
  const settingValues = await Promise.all(WORKING_SETTING_NAMES.map(getGlobalSettingAsync))
  const context = {
    usersById: new Map(users.map((user) => [user._id, user])),
    settings: Object.fromEntries(WORKING_SETTING_NAMES.map((name, index) => [name, settingValues[index]])),
  }
  const rows = await Promise.all(entries.map(async (entry) => {
    const row = await workingTimeEntriesMapper({ ...entry, totalTime: finiteHours(entry.totalTime) }, context)
    const user = context.usersById.get(entry._id.userId)
    if (!entry._exportResourceAllowed || user?.inactive === true || typeof user?.profile?.name !== 'string') row.resource = ''
    return row
  }))
  return { rows, keys, totalEntries }
}

const exportPage = new ValidatedMethod({
  name: 'timecards.exportPage',
  validate(input) {
    try { normalizeExportPageInput(input) } catch (error) { throw publicExportError(error) }
  },
  mixins: [authenticationMixin],
  async run(input) {
    try {
      return await readAuthorizedExportPage(this, input, {
        acquire: (context) => exportGate.acquire(context),
        buildPlan: buildExportPlan,
        accessSnapshot: exportAccessSnapshot,
        readPage: readExportPage,
        authenticate: checkAuthentication,
        measureBytes: (result) => Buffer.byteLength(EJSON.stringify(result), 'utf8'),
      })
    } catch (error) { throw publicExportError(error) }
  },
})

const markExported = new ValidatedMethod({
  name: 'timecards.markExported',
  validate(input) {
    check(input, { timecardIds: Array })
    try { validateStateMutationInput(input.timecardIds, 'exported') } catch (error) { throw publicExportError(error) }
  },
  mixins: [authenticationMixin, transactionLogMixin],
  async run({ timecardIds }) {
    try {
      return await markAuthorizedTimeEntriesExported({ callerId: this.userId, timecardIds }, {
        findTimeEntries: (selector, { fields }) => Timecards.rawCollection().find(selector, {
          projection: fields, limit: 1000, maxTimeMS: RESOURCE_QUERY_MAX_TIME_MS,
        }).toArray(),
        findAdministeredProjectIds: async (selector, { fields }) => (await Projects.rawCollection().find(selector, {
          projection: fields, limit: 1000, maxTimeMS: RESOURCE_QUERY_MAX_TIME_MS,
        }).toArray()).map((project) => project._id),
        beforeWrite: () => checkAuthentication(this),
        updateTimeEntries: (selector, modifier) => Timecards.rawCollection().updateMany(selector, modifier, { maxTimeMS: RESOURCE_QUERY_MAX_TIME_MS }),
      })
    } catch (error) { throw publicExportError(error) }
  },
})

for (const name of ['timecards.exportPage', 'timecards.markExported']) {
  DDPRateLimiter.addRule({ type: 'method', name, userId: (userId) => typeof userId === 'string' && Boolean(userId) }, 220, 60000)
  DDPRateLimiter.addRule({ type: 'method', name, clientAddress: (address) => typeof address === 'string' && Boolean(address) }, 440, 60000)
}

export { exportPage, markExported }
