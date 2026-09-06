import { singleRouteParameter } from './APIrouteHelpers.js'
import { parseResourceRevisionETag } from '../imports/utils/resourceRevision.js'
import { validateProjectTaskDetailsBody } from '../imports/api/tasks/server/taskLifecycle.js'
import { MAX_TASK_SUGGESTION_CURSOR_LENGTH } from './taskSuggestionPagination.js'

function methodGuard(req, res, sendResponse, method, label) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Allow', `${method}, OPTIONS`)
    sendResponse(res, 204, `${label} preflight.`)
    return false
  }
  if (req.method !== method) {
    res.setHeader('Allow', `${method}, OPTIONS`)
    sendResponse(res, 405, `Method not allowed. Use ${method}.`)
    return false
  }
  return true
}

function sendTaskError(res, sendResponse, error, fallback) {
  const statuses = {
    'project-task-invalid': 400,
    'task-suggestion-invalid': 400,
    'not-authorized': 404,
    'project-task-write-conflict': 409,
    'task-suggestion-write-conflict': 409,
    'project-task-default': 409,
    'project-task-dependent': 409,
    'project-task-recorded': 409,
    'task-suggestion-referenced': 409,
  }
  const messages = {
    'project-task-invalid': 'Invalid project task request.',
    'task-suggestion-invalid': 'Invalid task suggestion request.',
    'not-authorized': 'Task not found.',
    'project-task-write-conflict': 'The project task changed after preview.',
    'task-suggestion-write-conflict': 'The task suggestion changed after preview.',
    'project-task-default': 'Unset the default task before renaming or deleting it.',
    'project-task-dependent': 'Remove task dependencies before deleting it.',
    'project-task-recorded': 'Acknowledge that historical records retain this task name.',
    'task-suggestion-referenced': 'Acknowledge that records still use this suggestion name.',
  }
  sendResponse(res, statuses[error?.error] || 500, messages[error?.error] || fallback)
}

function jsonContent(req) {
  return typeof req.headers['content-type'] === 'string'
    && /^application\/json(?:\s*;\s*charset=utf-8)?\s*$/i.test(req.headers['content-type'])
}

function createProjectTaskGetHandler({ authorize, previewTask, sendResponse }) {
  return async (req, res) => {
    if (!methodGuard(req, res, sendResponse, 'GET', 'Project task preview')) return
    const user = await authorize(req, res); if (!user) return
    try {
      const taskId = singleRouteParameter(req._parsedUrl?.pathname, '/project/task/get')
      const result = await previewTask({ taskId, userId: user._id })
      res.setHeader('ETag', result.etag)
      sendResponse(res, 200, 'Returning project task.', result.payload)
    } catch (error) {
      sendTaskError(res, sendResponse, error, 'Project task could not be read.')
    }
  }
}

function createProjectTaskDetailsHandler({ authorize, readJson, editTask, sendResponse }) {
  return async (req, res) => {
    if (!methodGuard(req, res, sendResponse, 'PATCH', 'Project task update')) return
    const user = await authorize(req, res); if (!user) return
    if (req.headers['if-match'] == null) {
      sendResponse(res, 428, 'If-Match is required. Preview the project task first.'); return
    }
    if (!jsonContent(req)) {
      sendResponse(res, 415, 'Content-Type must be application/json with UTF-8 encoding.'); return
    }
    let taskId; let expectedRevision; let body
    try {
      taskId = singleRouteParameter(req._parsedUrl?.pathname, '/project/task/details')
      expectedRevision = parseResourceRevisionETag('project-task', req.headers['if-match'])
      body = await readJson(req, { limit: '64kb' })
      validateProjectTaskDetailsBody(body)
    } catch (error) {
      const tooLarge = error?.type === 'entity.too.large' || error?.status === 413
      sendResponse(
        res, tooLarge ? 413 : 400,
        tooLarge ? 'Project task request is too large.' : 'Invalid project task request.',
      ); return
    }
    try {
      const result = await editTask({ taskId, userId: user._id, body, expectedRevision })
      res.setHeader('ETag', result.etag)
      sendResponse(res, 200, 'Project task update completed.', result.payload)
    } catch (error) {
      sendTaskError(res, sendResponse, error, 'Project task could not be changed.')
    }
  }
}

function createProjectTaskDeleteHandler({ authorize, readJson, deleteTask, sendResponse }) {
  return async (req, res) => {
    if (!methodGuard(req, res, sendResponse, 'DELETE', 'Project task deletion')) return
    const user = await authorize(req, res); if (!user) return
    if (req.headers['if-match'] == null) {
      sendResponse(res, 428, 'If-Match is required. Preview the project task first.'); return
    }
    if (!jsonContent(req)) {
      sendResponse(res, 415, 'Content-Type must be application/json with UTF-8 encoding.'); return
    }
    let taskId; let expectedRevision; let body
    try {
      taskId = singleRouteParameter(req._parsedUrl?.pathname, '/project/task/delete')
      expectedRevision = parseResourceRevisionETag('project-task', req.headers['if-match'])
      body = await readJson(req, { limit: '64kb' })
      if (!body || typeof body !== 'object' || Array.isArray(body)
        || Object.keys(body).sort().join(',') !== 'acknowledgeRecordedEntries,expectedName'
        || typeof body.expectedName !== 'string'
        || typeof body.acknowledgeRecordedEntries !== 'boolean') throw new TypeError()
    } catch (error) {
      const tooLarge = error?.type === 'entity.too.large' || error?.status === 413
      sendResponse(
        res, tooLarge ? 413 : 400,
        tooLarge ? 'Project task deletion request is too large.'
          : 'Invalid project task deletion request.',
      ); return
    }
    try {
      const result = await deleteTask({ taskId, userId: user._id, expectedRevision, ...body })
      sendResponse(res, 200, 'Project task deleted.', result)
    } catch (error) {
      sendTaskError(res, sendResponse, error, 'Project task could not be deleted.')
    }
  }
}

function createTaskSuggestionListHandler({ authorize, listSuggestions, sendResponse }) {
  return async (req, res) => {
    if (!/^\/task-suggestions\/?$/.test(req._parsedUrl?.pathname || '')) {
      sendResponse(res, 404, 'Task suggestions route not found.')
      return
    }
    if (!methodGuard(req, res, sendResponse, 'GET', 'Task suggestions list')) return
    const user = await authorize(req, res); if (!user) return
    let limit; let cursor
    try {
      const query = new URL(req.url || req._parsedUrl?.pathname || '/', 'http://local.invalid').searchParams
      const queryKeys = [...query.keys()]
      if (queryKeys.some((key) => !['cursor', 'limit'].includes(key))
        || query.getAll('limit').length > 1 || query.getAll('cursor').length > 1) {
        throw new TypeError()
      }
      const rawLimit = query.get('limit')
      limit = rawLimit == null ? 100 : Number(rawLimit)
      cursor = query.get('cursor')
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500
        || (cursor != null
          && (cursor.length > MAX_TASK_SUGGESTION_CURSOR_LENGTH || !cursor))) throw new TypeError()
    } catch (error) {
      sendResponse(res, 400, 'Invalid task suggestions query.')
      return
    }
    try {
      const result = await listSuggestions({ userId: user._id, limit, cursor })
      sendResponse(res, 200, 'Returning personal task suggestions.', result)
    } catch (error) {
      sendTaskError(res, sendResponse, error, 'Task suggestions could not be read.')
    }
  }
}

function createTaskSuggestionGetHandler({ authorize, previewSuggestion, sendResponse }) {
  return async (req, res) => {
    if (!methodGuard(req, res, sendResponse, 'GET', 'Task suggestion preview')) return
    const user = await authorize(req, res); if (!user) return
    try {
      const suggestionId = singleRouteParameter(req._parsedUrl?.pathname, '/task-suggestions/get')
      const result = await previewSuggestion({ suggestionId, userId: user._id })
      res.setHeader('ETag', result.etag)
      sendResponse(res, 200, 'Returning task suggestion.', result.payload)
    } catch (error) {
      sendTaskError(res, sendResponse, error, 'Task suggestion could not be read.')
    }
  }
}

function createTaskSuggestionDeleteHandler({ authorize, readJson, deleteSuggestion, sendResponse }) {
  return async (req, res) => {
    if (!methodGuard(req, res, sendResponse, 'DELETE', 'Task suggestion deletion')) return
    const user = await authorize(req, res); if (!user) return
    if (req.headers['if-match'] == null) {
      sendResponse(res, 428, 'If-Match is required. Preview the task suggestion first.'); return
    }
    if (!jsonContent(req)) {
      sendResponse(res, 415, 'Content-Type must be application/json with UTF-8 encoding.'); return
    }
    let suggestionId; let expectedRevision; let body
    try {
      suggestionId = singleRouteParameter(req._parsedUrl?.pathname, '/task-suggestions/delete')
      expectedRevision = parseResourceRevisionETag('task-suggestion', req.headers['if-match'])
      body = await readJson(req, { limit: '64kb' })
      if (!body || typeof body !== 'object' || Array.isArray(body)
        || Object.keys(body).sort().join(',') !== 'acknowledgeReferencedRecords,expectedName'
        || typeof body.expectedName !== 'string'
        || typeof body.acknowledgeReferencedRecords !== 'boolean') throw new TypeError()
    } catch (error) {
      const tooLarge = error?.type === 'entity.too.large' || error?.status === 413
      sendResponse(
        res, tooLarge ? 413 : 400,
        tooLarge ? 'Task suggestion deletion request is too large.'
          : 'Invalid task suggestion deletion request.',
      ); return
    }
    try {
      const result = await deleteSuggestion({
        suggestionId, userId: user._id, expectedRevision, ...body,
      })
      sendResponse(res, 200, 'Task suggestion deleted.', result)
    } catch (error) {
      sendTaskError(res, sendResponse, error, 'Task suggestion could not be deleted.')
    }
  }
}

export {
  createProjectTaskDeleteHandler,
  createProjectTaskDetailsHandler,
  createProjectTaskGetHandler,
  createTaskSuggestionDeleteHandler,
  createTaskSuggestionGetHandler,
  createTaskSuggestionListHandler,
}
