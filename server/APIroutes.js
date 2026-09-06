import { Meteor } from 'meteor/meteor'
import { WebApp } from 'meteor/webapp'
import { randomUUID } from 'node:crypto'
import { getJson } from './bodyparser'
import {
  checkTimeEntryRule,
  deleteOwnedTimeCard,
  insertAPITimeCard,
  insertIdempotentAPITimeCard,
  recoverAPITimeCard,
  updateOwnedTimeCardDetails,
  updateOwnedTimeCardTask,
} from '../imports/api/timecards/server/methods'
import { createCapabilitiesHandler, createTimeentryTaskHandler } from './timeentryTaskRoute.js'
import { createTimeentryDetailsHandler } from './timeentryDetailsRoute.js'
import {
  createProjectArchiveHandler,
  createProjectDeleteHandler,
  createProjectDetailsHandler,
  createProjectGetHandler,
} from './projectLifecycleRoutes.js'
import { createProjectFenceRecoveryHandler } from './projectFenceRecoveryRoutes.js'
import {
  createProjectTaskDeleteHandler,
  createProjectTaskDetailsHandler,
  createProjectTaskGetHandler,
  createTaskSuggestionDeleteHandler,
  createTaskSuggestionGetHandler,
  createTaskSuggestionListHandler,
} from './taskLifecycleRoutes.js'
import { createAPIv2CapabilitiesHandler } from './APIv2Route.js'
import { sendAPIv2Problem } from './APIv2Contracts.js'
import {
  createTimerGetHandler,
  createTimerStartHandler,
  createTimerStopHandler,
} from './timerRoutes.js'
import { sanitizeObject } from '../imports/utils/sanitizer.js'
import {
  authorizeAPIRequest,
  parseCanonicalUTCMillisecondTimestamp,
  publicUserIdentity,
  routeParameters,
  singleRouteParameter,
} from './APIrouteHelpers.js'
import { API_TOKEN_HASH_VERSION } from './apiTokenSecurity.js'
import { createAPIRateLimits } from './apiRateLimit.js'
import Timecards from '../imports/api/timecards/timecards'
import Projects from '../imports/api/projects/projects'
import Tasks from '../imports/api/tasks/tasks'
import ApiIdempotency from '../imports/api/apiidempotency/apiidempotency.js'
import {
  insertAPIProjectWithId,
  recoverAPIProjectWithId,
} from '../imports/api/projects/server/apiCreate.js'
import {
  insertAPIProjectTaskWithId,
  recoverAPIProjectTaskWithId,
} from '../imports/api/tasks/server/apiCreate.js'
import {
  createMongoIdempotencyStore,
  executeIdempotentCreate,
  IdempotencyError,
  validateIdempotencyKey,
} from './apiIdempotency.js'
import {
  MAX_DATE_RANGE_DAYS,
  MAX_LEGACY_RESULT_LIMIT,
  PaginationError,
  assertDateRangeLimit,
  fetchBoundedAggregationList,
  fetchBoundedLegacyList,
  fetchTimeentryPage,
} from './apiPagination.js'
import { fetchBoundedProjectTaskStats } from './projectTaskStats.js'
import { fetchTaskSuggestionPage } from './taskSuggestionPagination.js'
import {
  deleteEmptyOwnedProject,
  editProjectDetails,
  getProjectLifecyclePreview,
  isProjectAdministrator,
  isProjectMember,
  serializeProjectForCaller,
  setProjectArchived,
} from '../imports/api/projects/server/projectLifecycle.js'
import { deleteEmptyProjectForLifecycle } from '../imports/api/projects/server/methods.js'
import {
  createProjectChildWithFence,
  definiteProjectChildNoWrite,
  runWithProjectChildWriter,
} from '../imports/api/projects/server/projectChildFence.js'
import {
  deleteProjectTask,
  deleteTaskSuggestion,
  editProjectTask,
  getProjectTaskPreview,
  getTaskSuggestionPreview,
  serializeProjectTask,
  serializeSuggestion,
} from '../imports/api/tasks/server/taskLifecycle.js'
import { deleteProjectTaskWithFence } from '../imports/api/tasks/server/taskGraphFence.js'
import {
  previewProjectFenceRecovery,
  projectFenceRecoveryDeploymentEnabled,
  recoverProjectFence,
} from './projectFenceRecovery.js'
import {
  getTimerState,
  startTimerAtomic,
  stopTimerAtomic,
} from '../imports/api/users/server/timerTransitions.js'
import {
  WEBHOOK_PATH,
  webhookVerificationHandler,
} from './webhookVerificationRoute.js'
import { getGlobalSettingAsync } from '../imports/utils/server_method_helpers.js'
import {
  currentProjectAudienceClauses,
  currentPublicProjectsDisabled,
} from '../imports/api/projects/server/publicAccessServer.js'
import { unsafeLegacyScriptsEnabled } from '../imports/utils/legacyScriptPolicy.js'
import { oidcVerifiedEmailLinkingEnabled } from '../imports/utils/oidc/oidcSecurity.js'
import { oauthEncryptionConfigured } from '../imports/utils/oauthEncryptionPolicy.js'
import {
  PublicProjectPolicyError,
  assertPublicProjectValueAllowed,
  canViewProjectUnderPolicy,
} from '../imports/api/projects/server/publicAccessPolicy.js'
import {
  dateOnlyFromUTCDate,
  dateOnlyRange,
  isDateOnly,
  isStartTime,
  parseAPITimecardDate,
} from '../imports/utils/timecardDate.js'
import {
  parseTimecardDateRevisionETag,
  timecardDateRevisionETag,
} from '../imports/utils/timecardRevision.js'

const taskForbiddenCustomfieldKeys = new Set([
  '_id', 'projectId', 'name', 'start', 'end', 'estimatedHours', 'dependencies', 'isDefaultTask', 'userId', 'createdAt', 'updatedAt',
])

let idempotencyStore
const apiRateLimits = createAPIRateLimits()

function getIdempotencyStore() {
  if (!idempotencyStore) idempotencyStore = createMongoIdempotencyStore(ApiIdempotency)
  return idempotencyStore
}

function sendResponse(res, statusCode, message, payload) {
  const response = {}
  response.statusCode = statusCode
  response.message = message
  if (payload !== undefined) {
    response.payload = payload
  }
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    Pragma: 'no-cache',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, PUT, POST, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': [
      'Content-Type', 'Authorization', 'If-Match', 'Idempotency-Key',
      'X-Request-ID', 'X-Requested-With', 'X-Titra-Webhook-Timestamp',
      'X-Titra-Webhook-Event-Id', 'X-Titra-Webhook-Signature',
      'X-Titra-Expected-User-Id',
    ].join(', '),
    'Access-Control-Expose-Headers': [
      'ETag', 'Idempotency-Replayed', 'Idempotency-Expires-At',
      'X-Request-ID', 'Retry-After',
    ].join(', '),
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), geolocation=(), microphone=(), payment=(), usb=()',
  })
  res.end(statusCode === 204 ? undefined : JSON.stringify(response))
}

function sendBoundedReadFailure(res, error, oversizedMessage, internalMessage) {
  if (error instanceof PaginationError && error.code === 'legacy-result-too-large') {
    sendResponse(res, 413, oversizedMessage)
    return
  }
  sendResponse(res, 500, internalMessage)
}

function requireHttpMethod(req, res, method) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Allow', `${method}, OPTIONS`)
    sendResponse(res, 204, 'API preflight.')
    return false
  }
  if (req.method === method) {
    return true
  }
  res.setHeader('Allow', `${method}, OPTIONS`)
  sendResponse(res, 405, `Method not allowed. Use ${method}.`)
  return false
}

function requireStaticPath(req, res, expectedPath) {
  const pathname = req._parsedUrl?.pathname || ''
  if (pathname === expectedPath || pathname === `${expectedPath}/`) return true
  sendResponse(res, 404, 'API route not found.')
  return false
}

async function checkAuthorization(req, res) {
  try {
    const peerLimit = apiRateLimits.consumePeer(req)
    if (!peerLimit.allowed) {
      res.setHeader('Retry-After', String(peerLimit.retryAfterSeconds))
      sendResponse(res, 429, 'Too many requests. Retry after the indicated delay.')
      return false
    }
    const authorization = await authorizeAPIRequest(
      req, (selector) => Meteor.users.findOneAsync(selector),
      ({ userId, token, digest, version }) => Meteor.users.rawCollection().updateOne({
        _id: userId,
        inactive: { $ne: true },
        'profile.APItoken': token,
        $or: [
          { 'services.titraApiToken': { $exists: false } },
          {
            'services.titraApiToken.version': version,
            'services.titraApiToken.sha256': digest,
          },
        ],
      }, {
        $set: {
          'services.titraApiToken': {
            version: API_TOKEN_HASH_VERSION,
            sha256: digest,
            updatedAt: new Date(),
          },
        },
        $unset: { 'profile.APItoken': '' },
      }).then((result) => result.matchedCount === 1),
    )
    if (authorization.status === 'authorized') {
      const userLimit = apiRateLimits.consumeUser(authorization.user._id)
      if (!userLimit.allowed) {
        res.setHeader('Retry-After', String(userLimit.retryAfterSeconds))
        sendResponse(res, 429, 'Too many requests. Retry after the indicated delay.')
        return false
      }
      return authorization.user
    }
    if (authorization.status === 'precondition_failed') {
      sendResponse(res, 412, 'Expected API user precondition failed.')
      return false
    }
    if (authorization.status === 'action_verification_required') {
      sendResponse(res, 403, 'Required account verification is overdue.')
      return false
    }
    sendResponse(res, 401, 'Missing authorization header or invalid authorization token supplied.')
  } catch {
    sendResponse(res, 500, 'Authentication could not be completed.')
  }
  return false
}

async function checkAuthorizationV2(req, res) {
  try {
    const peerLimit = apiRateLimits.consumePeer(req)
    if (!peerLimit.allowed) {
      sendAPIv2Problem(res, 'RATE_LIMITED', {
        id: req.headers?.['x-request-id'],
        retryAfterSeconds: peerLimit.retryAfterSeconds,
      })
      return false
    }
    const authorization = await authorizeAPIRequest(
      req, (selector) => Meteor.users.findOneAsync(selector),
      ({ userId, token, digest, version }) => Meteor.users.rawCollection().updateOne({
        _id: userId,
        inactive: { $ne: true },
        'profile.APItoken': token,
        $or: [
          { 'services.titraApiToken': { $exists: false } },
          {
            'services.titraApiToken.version': version,
            'services.titraApiToken.sha256': digest,
          },
        ],
      }, {
        $set: {
          'services.titraApiToken': {
            version: API_TOKEN_HASH_VERSION,
            sha256: digest,
            updatedAt: new Date(),
          },
        },
        $unset: { 'profile.APItoken': '' },
      }).then((result) => result.matchedCount === 1),
    )
    if (authorization.status === 'authorized') {
      const userLimit = apiRateLimits.consumeUser(authorization.user._id)
      if (!userLimit.allowed) {
        sendAPIv2Problem(res, 'RATE_LIMITED', {
          id: req.headers?.['x-request-id'],
          retryAfterSeconds: userLimit.retryAfterSeconds,
        })
        return false
      }
      return authorization.user
    }
    if (authorization.status === 'precondition_failed') {
      sendAPIv2Problem(res, 'PRECONDITION_FAILED', { id: req.headers?.['x-request-id'] })
      return false
    }
    if (authorization.status === 'action_verification_required') {
      sendAPIv2Problem(res, 'ACTION_VERIFICATION_REQUIRED', {
        id: req.headers?.['x-request-id'],
      })
      return false
    }
    sendAPIv2Problem(res, 'UNAUTHENTICATED', { id: req.headers?.['x-request-id'] })
  } catch (error) {
    sendAPIv2Problem(res, 'INTERNAL_ERROR', { id: req.headers?.['x-request-id'] })
  }
  return false
}

function hasJsonContentType(req) {
  return typeof req.headers?.['content-type'] === 'string'
    && /^application\/json(?:\s*;\s*charset=utf-8)?\s*$/i.test(req.headers['content-type'])
}

function isPayloadTooLarge(error) {
  return error?.type === 'entity.too.large'
    || error?.status === 413
    || error?.statusCode === 413
}

function invalidJsonRequestStatus(req, error) {
  if (isPayloadTooLarge(error)) return 413
  return hasJsonContentType(req) ? 400 : 415
}

function assertExactKeys(value, required, optional = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new TypeError('Expected a JSON object.')
  }
  const requiredSet = new Set(required)
  const allowed = new Set([...required, ...optional])
  const keys = Object.keys(value)
  if (required.some((key) => !Object.hasOwn(value, key))
    || keys.some((key) => !allowed.has(key))
    || keys.filter((key) => requiredSet.has(key)).length !== required.length) {
    throw new TypeError('Unexpected or missing request fields.')
  }
  return value
}

function optionalIdempotencyKey(req) {
  const key = req.headers?.['idempotency-key']
  if (key == null) return null
  return validateIdempotencyKey(key)
}

function setIdempotencyResponseHeaders(res, operation) {
  res.setHeader('Idempotency-Replayed', operation.replayed ? 'true' : 'false')
  if (operation.expiresAt instanceof Date && !Number.isNaN(operation.expiresAt.getTime())) {
    res.setHeader('Idempotency-Expires-At', operation.expiresAt.toISOString())
  }
}

function sendIdempotencyFailure(res, error) {
  if (error instanceof IdempotencyError) {
    if (error.code === 'invalid-idempotency-key') {
      sendResponse(res, 400, 'Idempotency-Key must contain 16 to 128 visible ASCII characters.')
      return true
    }
    if (error.code === 'idempotency-key-reused') {
      sendResponse(res, 409, 'This Idempotency-Key was already used with a different request.')
      return true
    }
    sendResponse(res, 500, 'The idempotent write outcome could not be confirmed. Retry only with the same Idempotency-Key.')
    return true
  }
  return false
}

function serializeProjectTimecard(timecard, project, userId) {
  if (isProjectMember(project, userId)) return timecard
  return Object.fromEntries([
    '_id', 'userId', 'projectId', 'date', 'dateOnly', 'startTime',
    'hours', 'task', 'dateRevision',
  ].filter((field) => Object.hasOwn(timecard, field)).map((field) => [field, timecard[field]]))
}

async function projectVisibleSelector(userId) {
  return {
    $or: await currentProjectAudienceClauses(userId),
  }
}

const projectChildFenceDependencies = {
  findOneAndUpdate: (...args) => Projects.rawCollection().findOneAndUpdate(...args),
  findOne: (selector) => Projects.findOneAsync(selector),
  updateOne: (selector, modifier) => Projects.rawCollection().updateOne(selector, modifier),
}

async function validateAPIProjectTaskDependencies(projectId, dependencies, taskId) {
  if (!dependencies.length) return
  if (taskId && dependencies.includes(taskId)) {
    throw Object.assign(new Error('A task cannot depend on itself.'), {
      error: 'project-task-invalid',
    })
  }
  const count = await Tasks.find({
    projectId,
    _id: { $in: dependencies },
  }).countAsync()
  if (count !== dependencies.length) {
    throw Object.assign(new Error('Task dependency is unavailable.'), {
      error: 'project-task-invalid',
    })
  }
}

async function checkAPIProjectTaskCreateGuards(projectId, dependencies, userId) {
  const project = await Projects.findOneAsync({ _id: projectId })
  if (!project || !isProjectAdministrator(project, userId)) {
    throw Object.assign(new Error('Project administrator access is required.'), {
      error: 'api-project-task-admin-required',
    })
  }
  try {
    await validateAPIProjectTaskDependencies(projectId, dependencies)
  } catch (error) {
    if (error?.error === 'project-task-invalid') throw error
    throw Object.assign(new Error('A project task dependency could not be verified.'), {
      error: 'project-task-invalid',
      cause: error,
    })
  }
}

const projectLifecycleDependencies = {
  findProject: (selector) => Projects.findOneAsync(selector),
  updateOne: (selector, modifier) => Projects.rawCollection().updateOne(selector, modifier),
}

const projectFenceRecoveryDependencies = {
  findProject: (selector) => Projects.findOneAsync(selector),
  findTimecard: (selector) => Timecards.findOneAsync(selector),
  findTask: (selector) => Tasks.findOneAsync(selector),
  updateOne: (selector, modifier) => Projects.rawCollection().updateOne(selector, modifier),
}

async function previewAPIProject(options) {
  const publicDisabled = await currentPublicProjectsDisabled()
  return getProjectLifecyclePreview(options, {
    ...projectLifecycleDependencies,
    findProject: async (selector) => {
      const project = await projectLifecycleDependencies.findProject(selector)
      return canViewProjectUnderPolicy(project, options.userId, publicDisabled)
        ? project : null
    },
  })
}

async function previewAPIProjectTask(options) {
  const publicDisabled = await currentPublicProjectsDisabled()
  return getProjectTaskPreview(options, {
    ...taskLifecycleDependencies,
    canView: (project, userId) => canViewProjectUnderPolicy(
      project, userId, publicDisabled,
    ),
  })
}

async function editAPIProject(options) {
  try {
    if (Object.prototype.hasOwnProperty.call(options.body?.changes || {}, 'public')) {
      assertPublicProjectValueAllowed(
        options.body.changes.public, await currentPublicProjectsDisabled(),
      )
    }
  } catch (error) {
    if (error instanceof PublicProjectPolicyError) {
      throw Object.assign(new Error(error.code), { error: error.code })
    }
    throw error
  }
  return editProjectDetails(options, projectLifecycleDependencies)
}

function archiveAPIProject(options) {
  return setProjectArchived(options, projectLifecycleDependencies)
}

function deleteAPIProject(options) {
  return deleteEmptyOwnedProject(options, {
    findProject: projectLifecycleDependencies.findProject,
    deleteEmptyProject: (selector) => deleteEmptyProjectForLifecycle(selector),
  })
}

async function inspectProjectTaskReferences(task) {
  const [dependentTaskCount, usage] = await Promise.all([
    Tasks.find({ projectId: task.projectId, dependencies: task._id }).countAsync(),
    fetchBoundedAggregationList({
      aggregate: (pipeline, options) => Timecards.rawCollection()
        .aggregate(pipeline, options).toArray(),
      pipeline: [
        { $match: { projectId: task.projectId, task: task.name } },
        {
          $group: {
            _id: null,
            recordCount: { $sum: 1 },
            totalHours: { $sum: '$hours' },
          },
        },
      ],
      maxLimit: 1,
    }),
  ])
  return {
    dependentTaskCount,
    recordCount: usage[0]?.recordCount ?? 0,
    totalHours: usage[0]?.totalHours ?? 0,
  }
}

const taskLifecycleDependencies = {
  findTask: (selector) => Tasks.findOneAsync(selector),
  findProject: (selector) => Projects.findOneAsync(selector),
  inspectReferences: inspectProjectTaskReferences,
  validateDependencies: validateAPIProjectTaskDependencies,
  withProjectWriter: ({ projectId, userId, taskId }, operation) => runWithProjectChildWriter({
    selector: { _id: projectId, $or: [{ userId }, { admins: userId }] },
    projectId,
    reservationId: `task-update:${taskId}:${randomUUID()}`,
    kind: 'project-task-update',
    resourceId: taskId,
    operation,
  }, projectChildFenceDependencies),
  deleteTaskWithFence: ({
    task, project, userId, taskFingerprint,
    acknowledgeRecordedEntries, expectedTaskSelector,
  }) => deleteProjectTaskWithFence({
    projectSelector: {
      _id: project._id,
      $or: [{ userId }, { admins: userId }],
    },
    projectId: project._id,
    taskId: task._id,
    taskName: task.name,
    taskFingerprint,
    lockId: `task-delete:${task._id}:${randomUUID()}`,
    acknowledgeRecordedEntries,
    inspectLockedState: async () => {
      const [currentTask, currentProject, dependentTaskCount, recordCount] = await Promise.all([
        Tasks.findOneAsync(expectedTaskSelector),
        Projects.findOneAsync({
          _id: project._id,
          $or: [{ userId }, { admins: userId }],
        }),
        Tasks.find({ projectId: project._id, dependencies: task._id }).countAsync(),
        Timecards.find({ projectId: project._id, task: task.name }).countAsync(),
      ])
      return {
        conflict: !currentTask || !currentProject,
        isDefault: currentTask?.isDefaultTask === true
          || currentProject?.defaultTask === task.name,
        dependentTaskCount,
        recordCount,
      }
    },
    deleteTask: () => Tasks.rawCollection().deleteOne(expectedTaskSelector),
  }, projectChildFenceDependencies),
  updateOne: (selector, modifier) => Tasks.rawCollection().updateOne(selector, modifier),
  deleteOne: (selector) => Tasks.rawCollection().deleteOne(selector),
}

async function taskSuggestionUsage(userId, name) {
  const usage = await fetchBoundedAggregationList({
    aggregate: (pipeline, options) => Timecards.rawCollection()
      .aggregate(pipeline, options).toArray(),
    pipeline: [
      { $match: { userId, task: name } },
      {
        $group: {
          _id: '$projectId',
          recordCount: { $sum: 1 },
          totalHours: { $sum: '$hours' },
          lastRecordedAt: { $max: '$date' },
        },
      },
      {
        $group: {
          _id: null,
          recordCount: { $sum: '$recordCount' },
          totalHours: { $sum: '$totalHours' },
          lastRecordedAt: { $max: '$lastRecordedAt' },
          projectCount: { $sum: 1 },
        },
      },
    ],
    maxLimit: 1,
  })
  return {
    recordCount: usage[0]?.recordCount ?? 0,
    totalHours: usage[0]?.totalHours ?? 0,
    lastRecordedAt: usage[0]?.lastRecordedAt ?? null,
    projectCount: usage[0]?.projectCount ?? 0,
  }
}

const suggestionLifecycleDependencies = {
  findSuggestion: (selector) => Tasks.findOneAsync(selector),
  getUsage: taskSuggestionUsage,
  deleteOne: (selector) => Tasks.rawCollection().deleteOne(selector),
}

async function listPersonalTaskSuggestions({ userId, limit, cursor }) {
  return fetchTaskSuggestionPage({
    userId,
    limit,
    cursor,
    find: (selector, options) => Tasks.find(selector, options).fetchAsync(),
    serialize: async (suggestion) => serializeSuggestion(
      suggestion, await taskSuggestionUsage(userId, suggestion.name),
    ),
  })
}

async function createAPIProjectTaskWithFence({
  projectId, userId, taskFields, taskId,
}) {
  const targetTaskId = taskId || randomUUID()
  return createProjectChildWithFence({
    selector: { _id: projectId, $or: [{ userId }, { admins: userId }] },
    projectId,
    reservationId: `api-task:${targetTaskId}`,
    kind: 'project-task-create',
    resourceId: targetTaskId,
    createChild: async () => {
      try {
        await validateAPIProjectTaskDependencies(projectId, taskFields.dependencies || [])
      } catch (error) {
        throw definiteProjectChildNoWrite(error)
      }
      if (taskId) {
        const result = await insertAPIProjectTaskWithId(taskFields, taskId)
        return result && {
          resourceId: result.taskId,
          created: result.created,
          payload: { taskId: result.taskId },
        }
      }
      await Tasks.insertAsync({ ...taskFields, _id: targetTaskId })
      return {
        resourceId: targetTaskId,
        created: true,
        payload: { taskId: targetTaskId },
      }
    },
    removeCreatedChild: (resourceId) => Tasks.rawCollection().deleteOne({
      _id: resourceId, projectId,
    }),
  }, projectChildFenceDependencies)
}

async function checkProjectAccess(projectId, userId, res) {
  try {
    const project = await Projects.findOneAsync({
      _id: projectId,
      $or: await currentProjectAudienceClauses(userId),
    })
    if (project) return project
    sendResponse(res, 403, 'Access denied to project.')
  } catch (error) {
    sendResponse(res, 500, 'Project access could not be verified.')
  }
  return false
}

async function requireTimeentryCreateProjectAccess(projectId, userId) {
  let project
  try {
    project = await Projects.findOneAsync({
      _id: projectId,
      $or: await currentProjectAudienceClauses(userId),
    })
  } catch (error) {
    throw Object.assign(new Error('Project access could not be verified.'), {
      error: 'api-project-access-check-failed',
      cause: error,
    })
  }
  if (!project) {
    throw Object.assign(new Error('Access denied to project.'), {
      error: 'api-project-access-denied',
    })
  }
  return project
}

async function checkIdempotentTimeentryCreateGuards({
  userId, projectId, task, date, dateOnly, startTime, hours,
}) {
  await requireTimeentryCreateProjectAccess(projectId, userId)
  await checkTimeEntryRule({
    userId, projectId, task, state: 'new', date, dateOnly, startTime, hours,
  })
}

/**
 * @apiDefine AuthError
 * @apiHeader {String} [X-Titra-Expected-User-Id] Optional immutable user-ID pin. When supplied,
 * every authenticated request fails with HTTP 412 if the token resolves to another user.
 * @apiError {json} AuthError The request is missing the authentication header or an invalid API token has been provided.
 * @apiError (403) ActionVerificationRequired Required account verification is overdue.
 * @apiError (412) ExpectedUserMismatch The optional expected-user identity pin did not match.
 * @apiErrorExample {json} Authorization-Error-Response:
 *     HTTP/1.1 401 Unauthorized
 *     {
 *       "message": "Missing authorization header or invalid authorization token supplied."
 *     }
 */

/**
 * @api {post} /timeentry/create Create time entry
 * @apiName createTimeEntry
 * @apiDescription Create a new time entry for the user assigned to the provided API token
 * @apiGroup TimeEntry
 *
 * @apiHeader {String} Token The authorization header Bearer API token.
 * @apiBody {String} projectId The project ID.
 * @apiBody {String} task The task description of the new time entry.
 * @apiBody {Date} date The date for the new time entry in format YYYY-MM-DD.
 * @apiBody {String} [startTime] Optional start time in format HH:mm.
 * @apiBody {Number} hours The number of hours to track.
 * @apiBody {Number} [taskRate] The rate for the task.
 * @apiBody {Object} [customfields] An object containing custom fields for the time entry.
 * @apiParamExample {json} Request-Example:
 *                  {
 *                    "projectId": "123456",
 *                    "task": "Work done.",
 *                    "date": "2019-11-10",
 *                    "hours": 8
 *                  }
 * @apiSuccess {json} response The id of the new time entry.
 * @apiSuccessExample {json} Success response:
 * {
 *  message: "time entry created."
 *  payload: {
 *    timecardId: "123456"
 *  }
 *  }
 * @apiUse AuthError
 */
WebApp.handlers.use('/timeentry/create/', async (req, res) => {
  if (!requireStaticPath(req, res, '/timeentry/create')) return
  if (!requireHttpMethod(req, res, 'POST')) return
  const meteorUser = await checkAuthorization(req, res)
  if (!meteorUser) return
  let json; let date; let dateOnly; let key
  try {
    if (!hasJsonContentType(req)) throw new TypeError()
    json = assertExactKeys(
      await getJson(req, { limit: '64kb' }),
      ['projectId', 'task', 'date', 'hours'],
      ['startTime', 'taskRate', 'customfields'],
    )
    if (typeof json.projectId !== 'string' || !json.projectId || json.projectId.length > 128
      || typeof json.task !== 'string' || !json.task.trim() || !json.task.isWellFormed()
      || [...json.task].length > 1000 || typeof json.date !== 'string'
      || typeof json.hours !== 'number' || !Number.isFinite(json.hours)
      || (json.startTime != null && !isStartTime(json.startTime))
      || (json.taskRate != null
        && (typeof json.taskRate !== 'number' || !Number.isFinite(json.taskRate)))
      || (json.customfields != null
        && (!json.customfields || typeof json.customfields !== 'object'
          || Array.isArray(json.customfields)))) throw new TypeError()
    date = parseAPITimecardDate(json.date)
    const normalizedDateOnly = isDateOnly(json.date) ? json.date : dateOnlyFromUTCDate(date)
    // A timestamp without a separate start time is a legacy payload. Keep its
    // combined Date intact because the originating timezone cannot be inferred.
    dateOnly = isDateOnly(json.date) || json.startTime != null ? normalizedDateOnly : undefined
    key = optionalIdempotencyKey(req)
  } catch (error) {
    if (sendIdempotencyFailure(res, error)) return
    sendResponse(
      res,
      invalidJsonRequestStatus(req, error),
      isPayloadTooLarge(error) ? 'Time entry create request is too large.' : 'Invalid time entry create request.',
    )
    return
  }
  try {
    let payload
    if (key) {
      const operation = await executeIdempotentCreate({
        key,
        userId: meteorUser._id,
        operation: 'timeentry.create',
        normalizedRequest: {
          projectId: json.projectId,
          task: json.task,
          date: date.toISOString(),
          dateOnly: dateOnly ?? null,
          startTime: json.startTime ?? null,
          hours: json.hours,
          taskRate: json.taskRate ?? null,
          customfields: json.customfields ?? null,
        },
        store: getIdempotencyStore(),
        beforeCreate: () => checkIdempotentTimeentryCreateGuards({
          userId: meteorUser._id,
          projectId: json.projectId,
          task: json.task,
          date,
          dateOnly,
          startTime: json.startTime,
          hours: json.hours,
        }),
        create: async (timecardId) => {
          const result = await insertIdempotentAPITimeCard(
            json.projectId, json.task, date, json.hours, meteorUser._id,
            json.taskRate, json.customfields, dateOnly, json.startTime, timecardId,
          )
          return { timecardId: result.timecardId }
        },
        recover: async (timecardId) => {
          const result = await recoverAPITimeCard(
            json.projectId, json.task, date, json.hours, meteorUser._id,
            json.taskRate, json.customfields, dateOnly, json.startTime, timecardId,
          )
          return result ? { timecardId: result.timecardId } : null
        },
      })
      setIdempotencyResponseHeaders(res, operation)
      payload = operation.result
    } else {
      const project = await checkProjectAccess(json.projectId, meteorUser._id, res)
      if (!project) return
      payload = {
        timecardId: await insertAPITimeCard(
          json.projectId, json.task, date, json.hours, meteorUser._id,
          json.taskRate, json.customfields, dateOnly, json.startTime,
        ),
      }
    }
    sendResponse(res, 200, key && payload ? 'Time entry create result returned.' : 'Time entry created.', payload)
  } catch (error) {
    if (sendIdempotencyFailure(res, error)) return
    if (error?.error === 'notifications.timecard_migration_locked') {
      sendResponse(res, 503, 'Time entries are temporarily locked for date migration.')
    } else if (error?.error === 'api-project-access-denied') {
      sendResponse(res, 403, 'Access denied to project.')
    } else if (error?.error === 'api-project-access-check-failed') {
      sendResponse(res, 500, 'Project access could not be verified.')
    } else if (error?.error === 'timecard-rule-blocked') {
      sendResponse(res, 422, 'The configured time entry rule prevented this time entry.')
    } else if (key) {
      sendResponse(res, 500, 'Time entry creation could not be confirmed. Retry only with the same Idempotency-Key.')
    } else {
      sendResponse(res, 500, 'Time entry creation could not be confirmed. Inspect saved entries before retrying.')
    }
  }
})

/**
 * @api {get} /timeentry/get/:timecardId Get time entry
 * @apiDescription Return one time entry owned by the user assigned to the API token.
 * @apiName getTimeEntry
 * @apiGroup TimeEntry
 *
 * @apiHeader {String} Token The authorization header Bearer API token.
 * @apiParam {String} timecardId The time entry ID.
 * @apiSuccess {Object} payload The owned time entry.
 * @apiSuccessHeader {String} ETag The date revision required to delete this version.
 * @apiError (404) NotFound The time entry does not exist or is not owned by the user.
 * @apiUse AuthError
 */
WebApp.handlers.use('/timeentry/get/', async (req, res) => {
  if (!requireHttpMethod(req, res, 'GET')) {
    return
  }
  const meteorUser = await checkAuthorization(req, res)
  if (!meteorUser) {
    return
  }
  let timecardId
  try {
    timecardId = singleRouteParameter(req._parsedUrl?.pathname, '/timeentry/get')
  } catch (error) {
    sendResponse(res, 400, 'Invalid time entry ID.')
    return
  }
  const timecard = await Timecards.findOneAsync({
    _id: timecardId,
    userId: meteorUser._id,
  })
  if (!timecard) {
    sendResponse(res, 404, 'Time entry not found.')
    return
  }
  let revisionETag
  try {
    revisionETag = timecardDateRevisionETag(timecard)
  } catch (error) {
    sendResponse(res, 500, 'The time entry revision could not be read.')
    return
  }
  res.setHeader('ETag', revisionETag)
  sendResponse(res, 200, 'Returning time entry.', timecard)
})

/**
 * @api {patch} /timeentry/task/:timecardId Edit owned time entry task only
 * @apiName updateTimeEntryTask
 * @apiGroup TimeEntry
 * @apiDescription Changes only task and its concurrency revision. Dates (including
 * legacy timestamps), hours, projects, rates, custom fields and task suggestions
 * are unchanged. A no-op still checks authorization, rule, migration lock and
 * preview preconditions, but does not increment the revision.
 * @apiHeader {String} Authorization Bearer API token.
 * @apiHeader {String} Content-Type application/json.
 * @apiHeader {String} If-Match ETag from GET /timeentry/get/:timecardId.
 * @apiParam {String} timecardId Owned time entry ID.
 * @apiBody {String} task Exact new task text; nonblank, at most 1000 Unicode code points.
 * @apiBody {String} expectedTask Exact previous task text, including an empty string.
 * @apiSuccess {Object} payload timecardId, task, previousTask and changed boolean.
 * @apiSuccessHeader {String} ETag Updated revision, or unchanged revision for a no-op.
 * @apiError (400) InvalidRequest Invalid JSON, fields, ID or If-Match; no extra fields accepted.
 * @apiError (404) NotFound Entry is missing, not owned, or its project is inaccessible.
 * @apiError (409) WriteConflict Old task/revision changed or revision cannot advance.
 * @apiError (422) RuleBlocked The configured time entry rule prevented the edit.
 * @apiError (428) PreconditionRequired Missing If-Match.
 * @apiError (503) MigrationLocked Time-entry changes are temporarily locked.
 * @apiUse AuthError
 */
WebApp.handlers.use('/timeentry/task/', createTimeentryTaskHandler({
  authorize: checkAuthorization,
  readJson: getJson,
  editTask: updateOwnedTimeCardTask,
  sendResponse,
}))

WebApp.handlers.use('/timeentry/details/', createTimeentryDetailsHandler({
  authorize: checkAuthorization,
  readJson: getJson,
  editDetails: updateOwnedTimeCardDetails,
  sendResponse,
}))

WebApp.handlers.use('/project/get/', createProjectGetHandler({
  authorize: checkAuthorization,
  previewProject: previewAPIProject,
  sendResponse,
}))

WebApp.handlers.use('/project/details/', createProjectDetailsHandler({
  authorize: checkAuthorization,
  readJson: getJson,
  editProject: editAPIProject,
  sendResponse,
}))

WebApp.handlers.use('/project/archive/', createProjectArchiveHandler({
  authorize: checkAuthorization,
  readJson: getJson,
  archiveProject: archiveAPIProject,
  sendResponse,
}))

WebApp.handlers.use('/project/delete/', createProjectDeleteHandler({
  authorize: checkAuthorization,
  readJson: getJson,
  deleteProject: deleteAPIProject,
  sendResponse,
}))

WebApp.handlers.use('/project/recovery/', createProjectFenceRecoveryHandler({
  authorize: checkAuthorization,
  readJson: getJson,
  previewRecovery: (options) => previewProjectFenceRecovery(
    options, projectFenceRecoveryDependencies,
  ),
  recover: (options) => recoverProjectFence(options, projectFenceRecoveryDependencies),
  sendResponse,
}))

WebApp.handlers.use('/project/task/get/', createProjectTaskGetHandler({
  authorize: checkAuthorization,
  previewTask: previewAPIProjectTask,
  sendResponse,
}))

WebApp.handlers.use('/project/task/details/', createProjectTaskDetailsHandler({
  authorize: checkAuthorization,
  readJson: getJson,
  editTask: (options) => editProjectTask(options, taskLifecycleDependencies),
  sendResponse,
}))

WebApp.handlers.use('/project/task/delete/', createProjectTaskDeleteHandler({
  authorize: checkAuthorization,
  readJson: getJson,
  deleteTask: (options) => deleteProjectTask(options, taskLifecycleDependencies),
  sendResponse,
}))

WebApp.handlers.use('/task-suggestions/get/', createTaskSuggestionGetHandler({
  authorize: checkAuthorization,
  previewSuggestion: (options) => getTaskSuggestionPreview(
    options, suggestionLifecycleDependencies,
  ),
  sendResponse,
}))

WebApp.handlers.use('/task-suggestions/delete/', createTaskSuggestionDeleteHandler({
  authorize: checkAuthorization,
  readJson: getJson,
  deleteSuggestion: (options) => deleteTaskSuggestion(
    options, suggestionLifecycleDependencies,
  ),
  sendResponse,
}))

WebApp.handlers.use('/task-suggestions/', createTaskSuggestionListHandler({
  authorize: checkAuthorization,
  listSuggestions: listPersonalTaskSuggestions,
  sendResponse,
}))

WebApp.handlers.use('/capabilities/v2/', createAPIv2CapabilitiesHandler({
  authorize: checkAuthorizationV2,
  configuration: async () => ({
    projectFenceRecoveryEnabled: projectFenceRecoveryDeploymentEnabled(),
    webhookActionVerificationEnabled: await getGlobalSettingAsync(
      'enableUserActionVerification',
    ) === true,
    hstsEnabled: process.env.TITRA_ENABLE_HSTS === 'true',
    oidcVerifiedEmailLinkingEnabled: oidcVerifiedEmailLinkingEnabled(),
    oauthEncryptionConfigured: oauthEncryptionConfigured(),
    publicProjectsDisabled: await currentPublicProjectsDisabled(),
    unsafeLegacyScriptsEnabled: unsafeLegacyScriptsEnabled(),
  }),
}))

/**
 * @api {get} /capabilities/ Get API capabilities
 * @apiName getAPICapabilities
 * @apiGroup API
 * @apiDescription Authenticated discovery of this server's supported API features.
 * @apiSuccess {Number} payload.apiVersion Capability contract version (1).
 * @apiSuccess {Object} payload.features Supported feature flags.
 * @apiSuccess {Object} payload.taskUpdate Task-only edit safety requirements and limit.
 * @apiUse AuthError
 */
WebApp.handlers.use('/capabilities/', createCapabilitiesHandler({
  authorize: checkAuthorization,
  sendResponse,
}))

/**
 * @api {delete} /timeentry/delete/:timecardId Delete time entry
 * @apiDescription Delete one time entry owned by the user assigned to the API token.
 * @apiName deleteTimeEntry
 * @apiGroup TimeEntry
 *
 * @apiHeader {String} Token The authorization header Bearer API token.
 * @apiHeader {String} If-Match The ETag returned by Get time entry.
 * @apiParam {String} timecardId The time entry ID.
 * @apiSuccess {Object} payload The deleted time entry ID.
 * @apiError (404) NotFound The time entry does not exist or is not owned by the user.
 * @apiError (409) WriteConflict The time entry changed while it was being deleted.
 * @apiError (428) PreconditionRequired The If-Match header is missing.
 * @apiError (503) MigrationLocked Time-entry changes are temporarily locked.
 * @apiUse AuthError
 */
WebApp.handlers.use('/timeentry/delete/', async (req, res) => {
  if (!requireHttpMethod(req, res, 'DELETE')) {
    return
  }
  const meteorUser = await checkAuthorization(req, res)
  if (!meteorUser) {
    return
  }
  let timecardId
  try {
    timecardId = singleRouteParameter(req._parsedUrl?.pathname, '/timeentry/delete')
  } catch (error) {
    sendResponse(res, 400, `Invalid time entry ID. ${error.message}`)
    return
  }
  const ifMatch = req.headers['if-match']
  if (ifMatch == null) {
    sendResponse(res, 428, 'If-Match is required. Preview the time entry before deleting it.')
    return
  }
  let expectedDateRevision
  try {
    expectedDateRevision = parseTimecardDateRevisionETag(ifMatch)
  } catch (error) {
    sendResponse(res, 400, error.message)
    return
  }
  try {
    await deleteOwnedTimeCard(timecardId, meteorUser._id, expectedDateRevision)
  } catch (error) {
    if (error?.error === 'not-authorized') {
      sendResponse(res, 404, 'Time entry not found.')
      return
    }
    if (error?.error === 'timecard-write-conflict') {
      sendResponse(res, 409, error.reason || error.message)
      return
    }
    if (error?.error === 'notifications.timecard_migration_locked') {
      sendResponse(res, 503, 'Time entries are temporarily locked for date migration.')
      return
    }
    if (error?.error === 'timecard-rule-blocked') {
      sendResponse(res, 422, 'The configured time entry rule prevented this deletion.')
      return
    }
    sendResponse(res, 500, 'Time entry deletion could not be confirmed. Inspect the entry before retrying.')
    return
  }
  sendResponse(res, 200, 'Time entry deleted.', { timecardId })
})

/**
  * @api {get} /timeentry/list/:date Get time entries for date
  * @apiDescription list time entries of the authorized user for the provided date
  * @apiName getTimeEntriesForDate
  * @apiGroup TimeEntry
  *
  * @apiHeader {String} Token The authorization header Bearer API token.
  * @apiParam {Date} date The date to list time entries for in format YYYY-MM-DD.

  * @apiSuccess {json} response An array of time entries tracked for the user with the
  * provided API token
  * for the provided date.
  * @apiError (413) ResultTooLarge More than 500 entries exist for the requested day; use
  * the paginated date-range endpoint.
  * @apiUse AuthError
  */
WebApp.handlers.use('/timeentry/list/', async (req, res) => {
  if (!requireHttpMethod(req, res, 'GET')) return
  const meteorUser = await checkAuthorization(req, res)
  if (!meteorUser) {
    return
  }
  let requestedDate; let dateRange
  try {
    ;[requestedDate] = routeParameters(req._parsedUrl?.pathname, '/timeentry/list', 1)
    dateRange = dateOnlyRange(requestedDate)
  } catch (error) {
    sendResponse(res, 400, 'Invalid date. Use YYYY-MM-DD.')
    return
  }
  try {
    const payload = await fetchBoundedLegacyList({
      find: (selector, options) => Timecards.find(selector, options).fetchAsync(),
      baseSelector: {
        userId: meteorUser._id,
        date: { $gte: dateRange.startDate, $lte: dateRange.endDate },
      },
      sort: { date: 1, _id: 1 },
    })
    sendResponse(res, 200, `Returning user time entries for date ${requestedDate}`, payload)
  } catch (error) {
    sendBoundedReadFailure(
      res,
      error,
      `More than ${MAX_LEGACY_RESULT_LIMIT} time entries exist for that day. `
        + 'Use the paginated date-range endpoint.',
      'Time entries for that day could not be read.',
    )
  }
})

WebApp.handlers.use('/timeentry/daterange-page/', async (req, res) => {
  if (!requireHttpMethod(req, res, 'GET')) return
  const meteorUser = await checkAuthorization(req, res)
  if (!meteorUser) return
  let from; let to; let dateRange
  try {
    ;[from, to] = routeParameters(
      req._parsedUrl?.pathname, '/timeentry/daterange-page', 2,
    )
    dateRange = dateOnlyRange(from, to)
    assertDateRangeLimit(dateRange)
  } catch (error) {
    sendResponse(
      res,
      400,
      `Invalid paginated date-range request. A range may contain at most `
        + `${MAX_DATE_RANGE_DAYS} days.`,
    )
    return
  }
  try {
    const query = new URL(
      req.url || req._parsedUrl?.pathname || '/', 'http://local.invalid',
    ).searchParams
    const payload = await fetchTimeentryPage({
      find: (selector, options) => Timecards.find(selector, options).fetchAsync(),
      baseSelector: {
        userId: meteorUser._id,
        date: { $gte: dateRange.startDate, $lte: dateRange.endDate },
      },
      scope: { kind: 'owner-timeentries', userId: meteorUser._id, from, to },
      query,
    })
    sendResponse(res, 200, `Returning a page of user time entries from ${from} to ${to}.`, payload)
  } catch (error) {
    if (error instanceof PaginationError) {
      sendResponse(res, 400, 'Invalid page options or cursor.')
    } else {
      sendResponse(res, 500, 'The paginated date-range request could not be completed.')
    }
  }
})
/**
  * @api {get} /timeentry/daterange/:fromDate/:toDate Get time entries for daterange
  * @apiDescription List time entries of the authorized user for a range of at most 366 days.
  * @apiName getTimeEntriesForDateRange
  * @apiGroup TimeEntry
  *
  * @apiHeader {String} Token The authorization header Bearer API token.
  * @apiParam {Date} fromDate The date to list time entries starting from in format YYYY-MM-DD.
  * @apiParam {Date} toDate The date to list time entries ending at in format YYYY-MM-DD.
  * @apiSuccess {json} response An array of time entries tracked for the user with the
  * provided API token
  * for the provided date range.
  * @apiError (413) ResultTooLarge More than 500 entries match; use the paginated endpoint.
  * @apiUse AuthError
  */
WebApp.handlers.use('/timeentry/daterange/', async (req, res) => {
  if (!requireHttpMethod(req, res, 'GET')) return
  const meteorUser = await checkAuthorization(req, res)
  if (!meteorUser) {
    return
  }
  let from; let to; let dateRange
  try {
    ;[from, to] = routeParameters(req._parsedUrl?.pathname, '/timeentry/daterange', 2)
    dateRange = dateOnlyRange(from, to)
    assertDateRangeLimit(dateRange)
  } catch (error) {
    sendResponse(
      res,
      400,
      `Invalid date range. Use two YYYY-MM-DD dates spanning at most ${MAX_DATE_RANGE_DAYS} days.`,
    )
    return
  }
  try {
    const payload = await fetchBoundedLegacyList({
      find: (selector, options) => Timecards.find(selector, options).fetchAsync(),
      baseSelector: {
        userId: meteorUser._id,
        date: { $gte: dateRange.startDate, $lte: dateRange.endDate },
      },
      sort: { date: 1, _id: 1 },
    })
    sendResponse(res, 200, `Returning user time entries for date range ${from} to ${to}`, payload)
  } catch (error) {
    sendBoundedReadFailure(
      res,
      error,
      `This range contains more than ${MAX_LEGACY_RESULT_LIMIT} time entries. `
        + 'Use the paginated date-range endpoint.',
      'Time entries for that range could not be read.',
    )
  }
})

/**
   * @api {get} /project/list/ Get all projects
   * @apiDescription Lists all projects visible to the user assigned to the provided API token
   * @apiName getProjects
   * @apiGroup Project
   *
   * @apiHeader {String} Token The authorization header Bearer API token.
   * @apiSuccess {json} response An array of all projects visible for the user with the
   * provided API token.
   * @apiError (413) ResultTooLarge More than 500 projects are visible.
   * @apiUse AuthError
   */
WebApp.handlers.use('/project/list/', async (req, res) => {
  if (!requireStaticPath(req, res, '/project/list')) return
  if (!requireHttpMethod(req, res, 'GET')) return
  const meteorUser = await checkAuthorization(req, res)
  if (!meteorUser) {
    return
  }
  try {
    const projects = await fetchBoundedLegacyList({
      find: (selector, options) => Projects.find(selector, options).fetchAsync(),
      baseSelector: await projectVisibleSelector(meteorUser._id),
      sort: { _id: 1 },
    })
    const payload = projects
      .map((project) => serializeProjectForCaller(project, meteorUser._id))
      .filter(Boolean)
    sendResponse(res, 200, 'Returning projects', payload)
  } catch (error) {
    sendBoundedReadFailure(
      res,
      error,
      `More than ${MAX_LEGACY_RESULT_LIMIT} projects are visible. Archive projects before `
        + 'listing them through this legacy endpoint.',
      'Projects could not be read.',
    )
  }
})

/**
 * @api {get} /project/timeentries/:projectId Get time entries for project
 * @apiDescription List time entries for the specified project
 * @apiName getTimeEntriesForProject
 * @apiGroup Project
 *
 * @apiHeader {String} Token The authorization header Bearer API token.
 * @apiParam {String} projectId The ID of the project to list time entries for.
 * @apiSuccess {json} response An array of time entries for the specified project.
 * @apiError (413) ResultTooLarge More than 500 entries exist; use paginated project
 * date ranges.
 * @apiUse AuthError
 */
WebApp.handlers.use('/project/timeentries/', async (req, res) => {
  if (!requireHttpMethod(req, res, 'GET')) return
  const meteorUser = await checkAuthorization(req, res)
  if (!meteorUser) {
    return
  }
  let projectId
  try {
    projectId = singleRouteParameter(req._parsedUrl?.pathname, '/project/timeentries')
  } catch (error) {
    sendResponse(res, 400, 'Invalid project ID.')
    return
  }

  // Check if user has access to the project
  const project = await checkProjectAccess(projectId, meteorUser._id, res)
  if (!project) {
    return
  }

  try {
    const timecards = await fetchBoundedLegacyList({
      find: (selector, options) => Timecards.find(selector, options).fetchAsync(),
      baseSelector: { projectId },
      sort: { date: 1, _id: 1 },
    })
    const payload = timecards.map((timecard) => (
      serializeProjectTimecard(timecard, project, meteorUser._id)
    ))
    sendResponse(res, 200, 'Returning time entries for project', payload)
  } catch (error) {
    sendBoundedReadFailure(
      res,
      error,
      `This project contains more than ${MAX_LEGACY_RESULT_LIMIT} time entries. `
        + 'Use paginated project date ranges.',
      'Project time entries could not be read.',
    )
  }
})

/**
 * @api {get} /project/users/:projectId Get project users
 * @apiDescription Return IDs and display names for users with time entries on an
 * accessible project.
 * @apiName getProjectUsers
 * @apiGroup Project
 *
 * @apiHeader {String} Token The authorization header Bearer API token.
 * @apiParam {String} projectId The project ID.
 * @apiSuccess {Object[]} payload Project time-entry user IDs and display names.
 * @apiError (413) ResultTooLarge More than 500 users have entries on the project.
 * @apiUse AuthError
 */
WebApp.handlers.use('/project/users/', async (req, res) => {
  if (!requireHttpMethod(req, res, 'GET')) {
    return
  }
  const meteorUser = await checkAuthorization(req, res)
  if (!meteorUser) {
    return
  }
  let projectId
  try {
    projectId = singleRouteParameter(req._parsedUrl?.pathname, '/project/users')
  } catch (error) {
    sendResponse(res, 400, 'Invalid project ID.')
    return
  }
  const project = await checkProjectAccess(projectId, meteorUser._id, res)
  if (!project) {
    return
  }
  let userIds
  try {
    const userRows = await fetchBoundedAggregationList({
      aggregate: (pipeline, options) => Timecards.rawCollection()
        .aggregate(pipeline, options).toArray(),
      pipeline: [
        { $match: { projectId, userId: { $type: 'string' } } },
        { $group: { _id: '$userId' } },
        { $sort: { _id: 1 } },
      ],
    })
    userIds = userRows
      .map((row) => row._id)
      .filter((userId) => typeof userId === 'string' && userId)
  } catch (error) {
    sendBoundedReadFailure(
      res,
      error,
      `More than ${MAX_LEGACY_RESULT_LIMIT} users have time entries on this project.`,
      'Project users could not be read.',
    )
    return
  }
  const member = isProjectMember(project, meteorUser._id)
  const users = member ? await Meteor.users.find({
    _id: { $in: userIds }, inactive: { $ne: true },
  }, {
    fields: { 'profile.name': 1 },
    limit: MAX_LEGACY_RESULT_LIMIT,
  }).fetchAsync() : []
  const byId = new Map(users.map((user) => [user._id, publicUserIdentity(user)]))
  const payload = userIds
    .map((userId) => (member ? byId.get(userId) || { _id: userId, name: null }
      : { _id: userId, name: null }))
    .sort((left, right) => (left.name || '').localeCompare(right.name || '')
      || left._id.localeCompare(right._id))
  sendResponse(res, 200, 'Returning project users.', payload)
})

WebApp.handlers.use('/project/timeentriesfordaterange-page/', async (req, res) => {
  if (!requireHttpMethod(req, res, 'GET')) return
  const meteorUser = await checkAuthorization(req, res)
  if (!meteorUser) return
  let projectId; let from; let to; let dateRange; let project
  try {
    ;[projectId, from, to] = routeParameters(
      req._parsedUrl?.pathname, '/project/timeentriesfordaterange-page', 3,
    )
    dateRange = dateOnlyRange(from, to)
    assertDateRangeLimit(dateRange)
  } catch (error) {
    sendResponse(
      res,
      400,
      `Invalid paginated project date-range request. A range may contain at most `
        + `${MAX_DATE_RANGE_DAYS} days.`,
    )
    return
  }
  project = await checkProjectAccess(projectId, meteorUser._id, res)
  if (!project) return
  try {
    const query = new URL(req.url || req._parsedUrl?.pathname || '/', 'http://local.invalid')
      .searchParams
    const page = await fetchTimeentryPage({
      find: (selector, options) => Timecards.find(selector, options).fetchAsync(),
      baseSelector: {
        projectId,
        date: { $gte: dateRange.startDate, $lte: dateRange.endDate },
      },
      scope: {
        kind: 'project-timeentries', userId: meteorUser._id, projectId, from, to,
        audience: isProjectMember(project, meteorUser._id) ? 'member' : 'public',
      },
      query,
    })
    page.items = page.items.map((timecard) => (
      serializeProjectTimecard(timecard, project, meteorUser._id)
    ))
    sendResponse(res, 200, `Returning a page of project time entries from ${from} to ${to}.`, page)
  } catch (error) {
    if (error instanceof PaginationError) {
      sendResponse(res, 400, 'Invalid page options or cursor.')
    } else {
      sendResponse(res, 500, 'The paginated project date-range request could not be completed.')
    }
  }
})

/**
 * @api {get} /project/timeentriesfordaterange/:projectId/:fromDate/:toDate Get project
 * time entries within a date range
 * @apiDescription The inclusive date range may contain at most 366 days.
 * @apiName GetTimeEntriesForDateRange
 * @apiGroup Project
 *
 * @apiParam {String} projectId The ID of the project.
 * @apiParam {String} fromDate The start date of the range in YYYY-MM-DD format.
 * @apiParam {String} toDate The end date of the range in YYYY-MM-DD format.
 *
 * @apiSuccess {Object[]} payload A list of time entries for the specified project and
 * date range.
 * @apiSuccess {String} payload.projectId The ID of the project.
 * @apiSuccess {String} payload.date The date of the time entry.
 * @apiSuccess {Number} payload.hours The number of hours logged.
 * @apiSuccess {String} payload.description A description of the work done.
 *
 * @apiError (500) InvalidParameters Invalid parameters received.
 * @apiError (413) ResultTooLarge More than 500 entries match; use the paginated endpoint.
 *
 * @apiExample {curl} Example usage:
 *     curl -i http://localhost:3000/project/timeentriesfordaterange/12345/2023-01-01/2023-01-31
 */
WebApp.handlers.use('/project/timeentriesfordaterange/', async (req, res) => {
  if (!requireHttpMethod(req, res, 'GET')) return
  const meteorUser = await checkAuthorization(req, res)
  if (!meteorUser) {
    return
  }
  let projectId; let from; let to; let dateRange
  try {
    ;[projectId, from, to] = routeParameters(
      req._parsedUrl?.pathname, '/project/timeentriesfordaterange', 3,
    )
    dateRange = dateOnlyRange(from, to)
    assertDateRangeLimit(dateRange)
  } catch (error) {
    sendResponse(
      res,
      400,
      'Invalid project/date range. Use a project ID and two YYYY-MM-DD dates spanning at most '
        + `${MAX_DATE_RANGE_DAYS} days.`,
    )
    return
  }

  // Check if user has access to the project
  const project = await checkProjectAccess(projectId, meteorUser._id, res)
  if (!project) {
    return
  }

  try {
    const timecards = await fetchBoundedLegacyList({
      find: (selector, options) => Timecards.find(selector, options).fetchAsync(),
      baseSelector: {
        projectId,
        date: { $gte: dateRange.startDate, $lte: dateRange.endDate },
      },
      sort: { date: 1, _id: 1 },
    })
    const payload = timecards.map((timecard) => (
      serializeProjectTimecard(timecard, project, meteorUser._id)
    ))
    sendResponse(
      res, 200, `Returning project time entries for date range ${from} to ${to}`, payload,
    )
  } catch (error) {
    sendBoundedReadFailure(
      res,
      error,
      `This range contains more than ${MAX_LEGACY_RESULT_LIMIT} project time entries. `
        + 'Use the paginated endpoint.',
      'Project time entries for that range could not be read.',
    )
  }
})

/**
   * @api {post} /project/create/ Create a new project
   * @apiDescription Creates a new titra project based on the parameters provided
   * @apiName CreateProject
   * @apiGroup Project
   *
   * @apiHeader {String} Token The authorization header Bearer API token.
   * @apiBody {String} name The project name.
   * @apiBody {String} [description] The description of the project.
   * @apiBody {String} [color] The project color in HEX color code.
   * @apiBody {String} [customer] The customer of the project.
   * @apiBody {Number} [rate] The hourly rate of the project.
   * @apiBody {Number} [budget] The budget for this project in hours.

   * @apiParamExample {json} Request-Example:
   *                  {
   *                    "name": "Project A",
   *                    "description": "This is the description of Project A.",
   *                    "color": "#009688",
   *                    "customer": "Paying customer",
   *                    "rate": 100,
   *                    "budget": 50
   *                  }
   * @apiSuccess {json} response The id of the new project.
   *  * @apiSuccessExample {json} Success response:
    * {
    *    message: "time entry created.",
    *    payload: {
    *      projectId: "123456"
    *    }
    *  }
   * @apiUse AuthError
   * @apiExample {curl} Example usage:
 *     curl -d '{"name":"api-test-project", "description":"fabians api project"}' -H "Content-Type: application/json" -H "Authorization: Token abcdefgHIJKLMNOP" -X POST http://localhost:3000/project/create
   */
WebApp.handlers.use('/project/create/', async (req, res) => {
  if (!requireStaticPath(req, res, '/project/create')) return
  if (!requireHttpMethod(req, res, 'POST')) return
  const meteorUser = await checkAuthorization(req, res)
  if (!meteorUser) return
  let json; let key
  try {
    if (!hasJsonContentType(req)) throw new TypeError()
    json = assertExactKeys(
      await getJson(req, { limit: '64kb' }), ['name'],
      ['description', 'color', 'customer', 'rate', 'budget'],
    )
    if (typeof json.name !== 'string' || !json.name.trim() || !json.name.isWellFormed()
      || [...json.name].length > 200
      || (json.description != null && (typeof json.description !== 'string'
        || !json.description.isWellFormed() || [...json.description].length > 50000))
      || (json.color != null && (typeof json.color !== 'string'
        || !/^#[\da-f]{6}$/i.test(json.color)))
      || (json.customer != null && (typeof json.customer !== 'string'
        || !json.customer.isWellFormed() || [...json.customer].length > 500))
      || ['rate', 'budget'].some((field) => json[field] != null
        && (typeof json[field] !== 'number' || !Number.isFinite(json[field])
          || json[field] < 0))) throw new TypeError()
    key = optionalIdempotencyKey(req)
  } catch (error) {
    if (sendIdempotencyFailure(res, error)) return
    sendResponse(
      res,
      invalidJsonRequestStatus(req, error),
      isPayloadTooLarge(error) ? 'Project create request is too large.' : 'Invalid project create request.',
    )
    return
  }
  const projectFields = { userId: meteorUser._id, name: json.name, projectRevision: 0 }
  if (json.description != null) {
    projectFields.description = json.description
    projectFields.desc = json.description
  }
  for (const field of ['color', 'customer', 'rate', 'budget']) {
    if (json[field] != null) projectFields[field] = json[field]
  }
  try {
    let payload
    if (key) {
      const operation = await executeIdempotentCreate({
        key,
        userId: meteorUser._id,
        operation: 'project.create',
        normalizedRequest: projectFields,
        store: getIdempotencyStore(),
        create: async (projectId) => {
          const result = await insertAPIProjectWithId(projectFields, projectId)
          return { projectId: result.projectId }
        },
        recover: async (projectId) => {
          const result = await recoverAPIProjectWithId(projectFields, projectId)
          return result ? { projectId: result.projectId } : null
        },
      })
      setIdempotencyResponseHeaders(res, operation)
      payload = operation.result
    } else {
      payload = { projectId: await Projects.insertAsync(projectFields) }
    }
    sendResponse(res, 200, key ? 'Project create result returned.' : 'Project created.', payload)
  } catch (error) {
    if (sendIdempotencyFailure(res, error)) return
    sendResponse(
      res,
      500,
      key
        ? 'Project creation could not be confirmed. Retry only with the same Idempotency-Key.'
        : 'Project creation could not be confirmed. Inspect saved projects before retrying.',
    )
  }
})
/**
   * @api {post} /timer/start/ Start a new timer
   * @apiDescription Starts a new timer for the API user if there is no current running timer.
   * A caller-supplied operationId can reconcile the same active timer after a lost response.
   * Once that timer is stopped, its operationId remains consumed for the advertised seven-day
   * recovery window and cannot start a second timer.
   * @apiName startTimer
   * @apiGroup TimeEntry
   *
   * @apiHeader {String} Token The authorization header Bearer API token.
   * @apiSuccess {json} response If there is no current running timer a new one will be started.
   *  * @apiSuccessExample {json} Success response:
    * {
    *  message: "New timer started."
    *  payload: {
    *    "startTime": "Sat Jun 26 2021 21:48:11 GMT+0200"
    *  }
    * }
   * @apiError {json} response There is another running timer, the state changed, or this
   * operationId was already consumed by a stopped timer.
    *      @apiErrorExample {json} Error-Response:
    *     HTTP/1.1 409 Conflict
    *     {
    *       "statusCode": 409,
    *       "message": "This timer start operation was already used.",
    *       "payload": { "code": "timer-operation-consumed" }
    *     }
   * @apiUse AuthError
   */
const timerTransitionDependencies = {
  findUser: (selector) => Meteor.users.findOneAsync(selector),
  updateOne: (selector, modifier) => Meteor.users.rawCollection().updateOne(selector, modifier),
}

WebApp.handlers.use('/timer/start/', createTimerStartHandler({
  authorize: checkAuthorization,
  readJson: getJson,
  startTimer: (options) => startTimerAtomic(options, timerTransitionDependencies),
  sendResponse,
}))

/**
   * @api {get} /timer/get/ Get the duration of the current timer
   * @apiDescription Get the duration in milliseconds and the start timestamp of the currently running timer for the API user.
   * @apiName getTimer
   * @apiGroup TimeEntry
   *
   * @apiHeader {String} Token The authorization header Bearer API token.
   * @apiSuccess {json} response Returns the duration of the currently running timer.
   *  * @apiSuccessExample {json} Success response:
    * {
    *  message: "Running timer received."
    *  payload: {
    *    "duration": 60000,
    *    "startTime": "Sat Jun 26 2021 21:48:11 GMT+0200"
    *  }
    * }
   * @apiError {json} response There is no running timer.
    *      @apiErrorExample {json} Error-Response:
    *     HTTP/1.1 500 Internal Server Error
    *     {
    *       "message": "No running timer found."
    *     }
   * @apiUse AuthError
   */
WebApp.handlers.use('/timer/get/', createTimerGetHandler({
  authorize: checkAuthorization,
  getTimer: (options) => getTimerState(options, timerTransitionDependencies),
  sendResponse,
}))
/**
   * @api {post} /timer/stop/ Stop a running timer
   * @apiDescription Stop a running timer of the API user and return the start timestamp and duration in milliseconds.
   * @apiName stopTimer
   * @apiGroup TimeEntry
   *
   * @apiHeader {String} Token The authorization header Bearer API token.
   * @apiSuccess {json} response Returns the duration in milliseconds and the start timestamp of the stopped timer as result.
   *  * @apiSuccessExample {json} Success response:
    * {
    *  message: "Running timer stopped."
    *  payload: {
    *    "duration": 60000,
    *    "startTime": "Sat Jun 26 2021 21:48:11 GMT+0200"
    *  }
    * }
  * @apiError {json} response No running timer to stop.
    *      @apiErrorExample {json} Error-Response:
    *     HTTP/1.1 500 Internal Server Error
    *     {
    *       "message": "No running timer found."
    *     }
   * @apiUse AuthError
   */
WebApp.handlers.use('/timer/stop/', createTimerStopHandler({
  authorize: checkAuthorization,
  readJson: getJson,
  getTimer: (options) => getTimerState(options, timerTransitionDependencies),
  stopTimer: (options) => stopTimerAtomic(options, timerTransitionDependencies),
  sendResponse,
}))

/**
 * @api {post} /project/task/create Create a predefined task for a project
 * @apiName createProjectTask
 * @apiDescription Create a new predefined task for a project with estimated hours
 * @apiGroup Task
 *
 * @apiHeader {String} Token The authorization header Bearer API token.
 * @apiBody {String} projectId The project ID.
 * @apiBody {String} name The name of the task.
 * @apiBody {Date} start The start date of the task in ISO format.
 * @apiBody {Date} end The end date of the task in ISO format.
 * @apiBody {Number} [estimatedHours] The estimated/planned hours for the task.
 * @apiBody {String[]} [dependencies] An array of task IDs that this task depends on.
 * @apiBody {Object} [customfields] An object containing custom fields for the task.
 * @apiParamExample {json} Request-Example:
 *                  {
 *                    "projectId": "123456",
 *                    "name": "Development Task",
 *                    "start": "2024-01-01T09:00:00.000Z",
 *                    "end": "2024-01-05T17:00:00.000Z",
 *                    "estimatedHours": 40
 *                  }
 * @apiSuccess {json} response The id of the new task.
 * @apiSuccessExample {json} Success response:
 * {
 *  message: "Task created."
 *  payload: {
 *    taskId: "123456"
 *  }
 *  }
 * @apiUse AuthError
 */
WebApp.handlers.use('/project/task/create/', async (req, res) => {
  if (!requireStaticPath(req, res, '/project/task/create')) return
  if (!requireHttpMethod(req, res, 'POST')) return
  const meteorUser = await checkAuthorization(req, res)
  if (!meteorUser) return
  let json; let start; let end; let key
  try {
    if (!hasJsonContentType(req)) throw new TypeError()
    json = assertExactKeys(
      await getJson(req, { limit: '64kb' }), ['projectId', 'name', 'start', 'end'],
      ['estimatedHours', 'dependencies', 'customfields'],
    )
    start = parseCanonicalUTCMillisecondTimestamp(json.start)
    end = parseCanonicalUTCMillisecondTimestamp(json.end)
    const dependencies = json.dependencies ?? []
    if (typeof json.projectId !== 'string' || !json.projectId || json.projectId.length > 128
      || typeof json.name !== 'string' || !json.name.trim() || !json.name.isWellFormed()
      || [...json.name].length > 1000
      || start > end
      || (json.estimatedHours != null && (typeof json.estimatedHours !== 'number'
        || !Number.isFinite(json.estimatedHours) || json.estimatedHours < 0))
      || !Array.isArray(dependencies) || dependencies.length > 500
      || dependencies.some((id) => typeof id !== 'string' || !id || id.length > 128)
      || new Set(dependencies).size !== dependencies.length
      || (json.customfields != null && (!json.customfields
        || typeof json.customfields !== 'object' || Array.isArray(json.customfields)))) {
      throw new TypeError()
    }
    json.dependencies = dependencies
    key = optionalIdempotencyKey(req)
  } catch (error) {
    if (sendIdempotencyFailure(res, error)) return
    sendResponse(
      res,
      invalidJsonRequestStatus(req, error),
      isPayloadTooLarge(error) ? 'Project task create request is too large.' : 'Invalid project task create request.',
    )
    return
  }
  const taskFields = {
    ...sanitizeObject(json.customfields, taskForbiddenCustomfieldKeys),
    projectId: json.projectId,
    name: json.name,
    start,
    end,
    estimatedHours: json.estimatedHours,
    dependencies: json.dependencies,
    projectTaskRevision: 0,
  }
  try {
    let payload
    if (key) {
      const operation = await executeIdempotentCreate({
        key,
        userId: meteorUser._id,
        operation: 'project-task.create',
        normalizedRequest: taskFields,
        store: getIdempotencyStore(),
        beforeCreate: () => checkAPIProjectTaskCreateGuards(
          json.projectId, json.dependencies, meteorUser._id,
        ),
        create: async (taskId) => {
          const result = await createAPIProjectTaskWithFence({
            projectId: json.projectId,
            userId: meteorUser._id,
            taskFields,
            taskId,
          })
          return result.payload
        },
        recover: async (taskId) => {
          const result = await recoverAPIProjectTaskWithId(taskFields, taskId)
          return result ? { taskId: result.taskId } : null
        },
      })
      setIdempotencyResponseHeaders(res, operation)
      payload = operation.result
    } else {
      await checkAPIProjectTaskCreateGuards(
        json.projectId, json.dependencies, meteorUser._id,
      )
      const result = await createAPIProjectTaskWithFence({
        projectId: json.projectId,
        userId: meteorUser._id,
        taskFields,
      })
      payload = result.payload
    }
    sendResponse(res, 200, key ? 'Task create result returned.' : 'Task created.', payload)
  } catch (error) {
    if (sendIdempotencyFailure(res, error)) return
    if (error?.error === 'api-project-task-admin-required') {
      sendResponse(res, 403, 'Project administrator access is required.')
    } else if (['project-child-write-blocked', 'project-child-fence-invalid'].includes(error?.error)) {
      sendResponse(res, 409, 'The project is being deleted or cannot currently accept tasks.')
    } else if (error?.error === 'project-task-invalid') {
      sendResponse(res, 400, 'A project task dependency is invalid.')
    } else {
      sendResponse(
        res,
        500,
        key
          ? 'Task creation could not be confirmed. Retry only with the same Idempotency-Key.'
          : 'Task creation could not be confirmed. Inspect saved tasks before retrying.',
      )
    }
  }
})

/**
 * @api {get} /project/tasks/:projectId Get all tasks for a project
 * @apiName getProjectTasks
 * @apiDescription List all tasks for the specified project
 * @apiGroup Task
 *
 * @apiHeader {String} Token The authorization header Bearer API token.
 * @apiParam {String} projectId The ID of the project to list tasks for.
 * @apiSuccess {json} response An array of tasks for the specified project.
 * @apiError (413) ResultTooLarge More than 500 predefined tasks exist for the project.
 * @apiUse AuthError
 */
WebApp.handlers.use('/project/tasks/', async (req, res) => {
  if (!requireHttpMethod(req, res, 'GET')) return
  const meteorUser = await checkAuthorization(req, res)
  if (!meteorUser) {
    return
  }
  let projectId
  try {
    projectId = singleRouteParameter(req._parsedUrl?.pathname, '/project/tasks')
  } catch (error) {
    sendResponse(res, 400, 'Invalid project ID.')
    return
  }

  // Check if user has access to the project
  const project = await checkProjectAccess(projectId, meteorUser._id, res)
  if (!project) {
    return
  }

  try {
    const tasks = await fetchBoundedLegacyList({
      find: (selector, options) => Tasks.find(selector, options).fetchAsync(),
      baseSelector: { projectId },
      sort: { _id: 1 },
    })
    sendResponse(res, 200, 'Returning tasks for project', tasks.map(serializeProjectTask))
  } catch (error) {
    sendBoundedReadFailure(
      res,
      error,
      `This project has more than ${MAX_LEGACY_RESULT_LIMIT} predefined tasks.`,
      'Project tasks could not be read.',
    )
  }
})

/**
 * @api {get} /project/task/stats/:projectId Get task statistics for a project
 * @apiName getProjectTaskStats
 * @apiDescription Get planned vs actual hours statistics for all tasks in a project
 * @apiGroup Task
 *
 * @apiHeader {String} Token The authorization header Bearer API token.
 * @apiParam {String} projectId The ID of the project to get task statistics for.
 * @apiSuccess {json} response Task statistics with planned vs actual hours.
 * @apiError (413) ResultTooLarge More than 500 predefined tasks exist for the project.
 * @apiUse AuthError
 */
WebApp.handlers.use('/project/task/stats/', async (req, res) => {
  if (!requireHttpMethod(req, res, 'GET')) return
  const meteorUser = await checkAuthorization(req, res)
  if (!meteorUser) {
    return
  }
  let projectId
  try {
    projectId = singleRouteParameter(req._parsedUrl?.pathname, '/project/task/stats')
  } catch (error) {
    sendResponse(res, 400, 'Invalid project ID.')
    return
  }

  // Check if user has access to the project
  const project = await checkProjectAccess(projectId, meteorUser._id, res)
  if (!project) {
    return
  }

  try {
    const payload = await fetchBoundedProjectTaskStats({
      projectId,
      findTasks: (selector, options) => Tasks.find(selector, options).fetchAsync(),
      aggregateTimecards: (pipeline, options) => Timecards.rawCollection()
        .aggregate(pipeline, options).toArray(),
    })
    sendResponse(res, 200, 'Returning task statistics for project', payload)
  } catch (error) {
    sendBoundedReadFailure(
      res,
      error,
      `Task statistics are limited to ${MAX_LEGACY_RESULT_LIMIT} predefined tasks.`,
      'Project task statistics could not be read.',
    )
  }
})

/**
 * @api {get} /user/me Get current user
 * @apiDescription Return the ID and display name of the user assigned to the API token.
 * @apiName getCurrentUser
 * @apiGroup User
 *
 * @apiHeader {String} Token The authorization header Bearer API token.
 * @apiSuccess {Object} payload The authenticated user's ID and display name.
 * @apiUse AuthError
 */
WebApp.handlers.use('/user/me/', async (req, res) => {
  if (!requireStaticPath(req, res, '/user/me')) return
  if (!requireHttpMethod(req, res, 'GET')) {
    return
  }
  const meteorUser = await checkAuthorization(req, res)
  if (!meteorUser) {
    return
  }
  sendResponse(res, 200, 'Returning current user.', publicUserIdentity(meteorUser))
})

/**
 * @api {post} /user/action-verification/webhook/:endpointId Signed action-verification webhook
 * @apiName userActionVerificationWebhook
 * @apiDescription Accepts only an enabled declarative interface with an environment-supplied
 * HMAC-SHA256 secret. Host and forwarded-host headers are never sender credentials. Successful
 * applied and ignored events deliberately return the same generic response. A retry re-signs the
 * exact event ID and body with a fresh authentication timestamp; unfinished work remains bound to
 * the first accepted timestamp and interface configuration revision.
 * @apiGroup UserVerification
 * @apiParam {String} endpointId Random public endpoint identity configured by an administrator.
 * @apiHeader {String} X-Titra-Webhook-Timestamp Unix timestamp in the signature input.
 * @apiHeader {String} X-Titra-Webhook-Event-Id Bounded provider event identity for replay protection.
 * @apiHeader {String} X-Titra-Webhook-Signature HMAC-SHA256 over timestamp, a dot, and exact body bytes.
 * @apiSuccess (202) {Boolean} payload.accepted Always true for valid applied or ignored events.
 * @apiError (400) BadRequest Invalid JSON or request shape.
 * @apiError (401) AuthenticationFailed Missing interface, deployment secret, or valid signature.
 * @apiError (409) ReplayConflict Event identity reused with a different body, or unfinished work
 * was claimed under a different interface configuration revision.
 * @apiError (413) PayloadTooLarge Body exceeds the advertised limit.
 * @apiError (415) UnsupportedMediaType Content-Type is not application/json.
 * @apiError (503) Processing An earlier delivery is still inside its processing lease.
 */
WebApp.handlers.use(WEBHOOK_PATH, webhookVerificationHandler)
