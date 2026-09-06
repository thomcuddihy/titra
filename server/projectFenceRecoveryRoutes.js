import { singleRouteParameter } from './APIrouteHelpers.js'

class ProjectFenceRecoveryRequestError extends Error {}

function sendRecoveryError(res, sendResponse, error) {
  const status = error?.error === 'not-authorized' ? 404
    : error?.error === 'project-recovery-invalid' ? 400
      : error?.error === 'project-recovery-conflict' ? 409
        : error?.error === 'project-recovery-disabled' ? 503 : 500
  const message = status === 404 ? 'Project not found.'
    : status === 400 ? 'Invalid project recovery request.'
      : status === 409 ? 'Project recovery state changed or is not safely recoverable.'
        : status === 503 ? 'Project fence recovery is disabled for this deployment.'
          : 'Project recovery could not be completed.'
  sendResponse(res, status, message)
}

function jsonRequest(req) {
  return typeof req.headers?.['content-type'] === 'string'
    && /^application\/json(?:\s*;\s*charset=utf-8)?\s*$/i.test(req.headers['content-type'])
}

function validateProjectFenceRecoveryBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).sort().join(',') !== 'acknowledgeStaleFence,recoveryId,type'
    || body.acknowledgeStaleFence !== true) {
    throw new ProjectFenceRecoveryRequestError('Invalid project recovery request.')
  }
  return body
}

function createProjectFenceRecoveryHandler({
  authorize, readJson, previewRecovery, recover, sendResponse,
}) {
  return async (req, res) => {
    const pathname = req._parsedUrl?.pathname || ''
    let projectId
    try {
      projectId = singleRouteParameter(pathname, '/project/recovery')
    } catch (error) {
      sendResponse(res, 404, 'Project recovery route not found.')
      return
    }
    if (req.method === 'OPTIONS') {
      res.setHeader('Allow', 'GET, POST, OPTIONS')
      sendResponse(res, 204, 'Project recovery preflight.')
      return
    }
    if (!['GET', 'POST'].includes(req.method)) {
      res.setHeader('Allow', 'GET, POST, OPTIONS')
      sendResponse(res, 405, 'Method not allowed. Use GET or POST.')
      return
    }
    const user = await authorize(req, res)
    if (!user) return
    if (req.method === 'GET') {
      try {
        const result = await previewRecovery({ projectId, userId: user._id })
        res.setHeader('ETag', result.etag)
        sendResponse(res, 200, 'Returning project recovery state.', result.payload)
      } catch (error) {
        sendRecoveryError(res, sendResponse, error)
      }
      return
    }
    if (req.headers?.['if-match'] == null) {
      sendResponse(res, 428, 'If-Match is required. Inspect recovery state first.')
      return
    }
    if (!jsonRequest(req)) {
      sendResponse(res, 415, 'Content-Type must be application/json with UTF-8 encoding.')
      return
    }
    let body
    try {
      body = await readJson(req, { limit: '16kb' })
    } catch (error) {
      if (error?.type === 'entity.too.large' || error?.status === 413) {
        sendResponse(res, 413, 'Project recovery request is too large.')
      } else if (error?.type === 'entity.parse.failed' || error instanceof SyntaxError) {
        sendResponse(res, 400, 'Invalid project recovery request.')
      } else {
        sendResponse(res, 500, 'Project recovery could not be completed.')
      }
      return
    }
    try {
      validateProjectFenceRecoveryBody(body)
    } catch (error) {
      if (error instanceof ProjectFenceRecoveryRequestError) {
        sendResponse(res, 400, 'Invalid project recovery request.')
        return
      }
      sendResponse(res, 500, 'Project recovery could not be completed.')
      return
    }
    try {
      const result = await recover({
        projectId,
        userId: user._id,
        expectedETag: req.headers['if-match'],
        type: body.type,
        recoveryId: body.recoveryId,
      })
      res.setHeader('ETag', result.etag)
      sendResponse(res, 200, 'Verified stale project fence cleared.', result.payload)
    } catch (error) {
      sendRecoveryError(res, sendResponse, error)
    }
  }
}

export {
  ProjectFenceRecoveryRequestError,
  createProjectFenceRecoveryHandler,
  validateProjectFenceRecoveryBody,
}
