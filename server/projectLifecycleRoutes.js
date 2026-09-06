import { singleRouteParameter } from './APIrouteHelpers.js'
import { parseResourceRevisionETag } from '../imports/utils/resourceRevision.js'
import { validateProjectDetailsBody } from '../imports/api/projects/server/projectLifecycle.js'

function preflightOrMethod(req, res, sendResponse, method, label) {
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

function projectRouteError(res, sendResponse, error, fallback) {
  const statuses = {
    'project-invalid': 400,
    'not-authorized': 404,
    'project-write-conflict': 409,
    'project-not-empty': 409,
  }
  const messages = {
    'project-invalid': 'Invalid project lifecycle request.',
    'not-authorized': 'Project not found.',
    'project-write-conflict': 'The project changed after it was previewed.',
    'project-not-empty': 'Only an empty project can be deleted. Archive it instead.',
  }
  sendResponse(res, statuses[error?.error] || 500, messages[error?.error] || fallback)
}

function jsonContent(req) {
  return typeof req.headers['content-type'] === 'string'
    && /^application\/json(?:\s*;\s*charset=utf-8)?\s*$/i.test(req.headers['content-type'])
}

function createProjectGetHandler({ authorize, previewProject, sendResponse }) {
  return async (req, res) => {
    if (!preflightOrMethod(req, res, sendResponse, 'GET', 'Project preview')) return
    const user = await authorize(req, res); if (!user) return
    try {
      const projectId = singleRouteParameter(req._parsedUrl?.pathname, '/project/get')
      const result = await previewProject({ projectId, userId: user._id })
      res.setHeader('ETag', result.etag)
      sendResponse(res, 200, 'Returning project.', result.payload)
    } catch (error) {
      projectRouteError(res, sendResponse, error, 'Project could not be read.')
    }
  }
}

function conditionalJsonHandler({
  method, prefix, label, authorize, readJson, validateBody, operation, sendResponse,
}) {
  return async (req, res) => {
    if (!preflightOrMethod(req, res, sendResponse, method, label)) return
    const user = await authorize(req, res); if (!user) return
    if (req.headers['if-match'] == null) {
      sendResponse(res, 428, 'If-Match is required. Preview the project first.')
      return
    }
    if (!jsonContent(req)) {
      sendResponse(res, 415, 'Content-Type must be application/json with UTF-8 encoding.')
      return
    }
    let projectId; let expectedRevision; let body
    try {
      projectId = singleRouteParameter(req._parsedUrl?.pathname, prefix)
      expectedRevision = parseResourceRevisionETag('project', req.headers['if-match'])
      body = await readJson(req, { limit: '64kb' })
      validateBody(body)
    } catch (error) {
      const tooLarge = error?.type === 'entity.too.large' || error?.status === 413
      sendResponse(
        res, tooLarge ? 413 : 400,
        tooLarge ? 'Project lifecycle request is too large.' : 'Invalid project lifecycle request.',
      )
      return
    }
    try {
      const result = await operation({ projectId, userId: user._id, expectedRevision, body })
      if (result.etag) res.setHeader('ETag', result.etag)
      sendResponse(res, 200, `${label} completed.`, result.payload ?? result)
    } catch (error) {
      projectRouteError(res, sendResponse, error, `${label} could not be completed.`)
    }
  }
}

function createProjectDetailsHandler(deps) {
  return conditionalJsonHandler({
    ...deps, method: 'PATCH', prefix: '/project/details', label: 'Project details update',
    validateBody: validateProjectDetailsBody,
    operation: ({ projectId, userId, expectedRevision, body }) => deps.editProject({
      projectId, userId, expectedRevision, body,
    }),
  })
}

function createProjectArchiveHandler(deps) {
  return conditionalJsonHandler({
    ...deps, method: 'PATCH', prefix: '/project/archive', label: 'Project archive update',
    validateBody: (body) => {
      if (!body || typeof body !== 'object' || Array.isArray(body)
        || Object.keys(body).sort().join(',') !== 'archived,expectedArchived'
        || typeof body.archived !== 'boolean' || typeof body.expectedArchived !== 'boolean') throw new TypeError()
    },
    operation: ({ projectId, userId, expectedRevision, body }) => deps.archiveProject({
      projectId, userId, expectedRevision, ...body,
    }),
  })
}

function createProjectDeleteHandler(deps) {
  return conditionalJsonHandler({
    ...deps, method: 'DELETE', prefix: '/project/delete', label: 'Empty project deletion',
    validateBody: (body) => {
      if (!body || typeof body !== 'object' || Array.isArray(body)
        || Object.keys(body).join(',') !== 'expectedName' || typeof body.expectedName !== 'string') {
        throw new TypeError()
      }
    },
    operation: ({ projectId, userId, expectedRevision, body }) => deps.deleteProject({
      projectId, userId, expectedRevision, expectedName: body.expectedName,
    }),
  })
}

export {
  createProjectArchiveHandler,
  createProjectDeleteHandler,
  createProjectDetailsHandler,
  createProjectGetHandler,
}
