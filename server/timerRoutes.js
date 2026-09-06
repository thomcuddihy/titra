import { parseResourceRevisionETag } from '../imports/utils/resourceRevision.js'
import { validateOperationId } from '../imports/api/users/server/timerTransitions.js'

function guard(req, res, sendResponse, method, label, expectedPath) {
  const pathname = req._parsedUrl?.pathname || ''
  if (pathname !== expectedPath && pathname !== `${expectedPath}/`) {
    sendResponse(res, 404, 'Timer route not found.')
    return false
  }
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

function sendTimerError(res, sendResponse, error, fallback) {
  const statuses = {
    'timer-invalid': 400,
    'not-authorized': 404,
    'timer-not-found': 404,
    'timer-write-conflict': 409,
    'timer-operation-consumed': 409,
  }
  const messages = {
    'timer-invalid': 'Invalid timer transition request.',
    'not-authorized': 'Timer user not found.',
    'timer-not-found': 'No running timer found.',
    'timer-write-conflict': 'The timer state changed. Reload it before continuing.',
    'timer-operation-consumed': 'This timer start operation was already used.',
  }
  const payload = error?.error === 'timer-operation-consumed'
    ? { code: 'timer-operation-consumed' } : undefined
  sendResponse(
    res, statuses[error?.error] || 500, messages[error?.error] || fallback, payload,
  )
}

function jsonRequest(req) {
  return typeof req.headers['content-type'] === 'string'
    && /^application\/json(?:\s*;\s*charset=utf-8)?\s*$/i.test(req.headers['content-type'])
}

function explicitlyEmptyBody(req) {
  return req.headers['content-length'] === '0'
    && req.headers['transfer-encoding'] == null
}

function requestFailureStatus(error, req) {
  if (error?.type === 'entity.too.large' || error?.status === 413) return 413
  if (req.headers['content-type'] != null && !jsonRequest(req)) return 415
  return 400
}

function createTimerGetHandler({ authorize, getTimer, sendResponse }) {
  return async (req, res) => {
    if (!guard(req, res, sendResponse, 'GET', 'Timer status', '/timer/get')) return
    const user = await authorize(req, res); if (!user) return
    try {
      const result = await getTimer({ userId: user._id })
      res.setHeader('ETag', result.etag)
      sendResponse(res, 200, 'Running timer received.', result.payload)
    } catch (error) {
      sendTimerError(res, sendResponse, error, 'Timer could not be read.')
    }
  }
}

function createTimerStartHandler({
  authorize, readJson, startTimer, sendResponse,
  makeOperationId = () => globalThis.crypto.randomUUID(),
}) {
  return async (req, res) => {
    if (!guard(req, res, sendResponse, 'POST', 'Timer start', '/timer/start')) return
    const user = await authorize(req, res); if (!user) return
    let operationId
    try {
      // Legacy clients sent POST with no body or `{}`. Keep that workflow while
      // assigning a server-generated stable ID; v6 clients send operationId so
      // a lost response can be attributed to their own start request.
      let body = {}
      if (jsonRequest(req) && !explicitlyEmptyBody(req)) {
        body = await readJson(req, { limit: '8kb' })
      }
      else if (req.headers['content-type'] != null
        && !jsonRequest(req)) throw new TypeError()
      else if (![undefined, '0'].includes(req.headers['content-length'])) throw new TypeError()
      if (!body || typeof body !== 'object' || Array.isArray(body)
        || Object.keys(body).some((key) => key !== 'operationId')) throw new TypeError()
      operationId = body.operationId ?? `legacy:${makeOperationId()}`
      validateOperationId(operationId)
    } catch (error) {
      const status = requestFailureStatus(error, req)
      sendResponse(
        res, status,
        status === 413 ? 'Timer start request is too large.' : 'Invalid timer start request.',
      ); return
    }
    try {
      const result = await startTimer({ userId: user._id, operationId })
      res.setHeader('ETag', result.etag)
      sendResponse(res, 200, result.payload.changed ? 'New timer started.' : 'Existing timer returned.', result.payload)
    } catch (error) {
      sendTimerError(res, sendResponse, error, 'Timer could not be started.')
    }
  }
}

function createTimerStopHandler({ authorize, readJson, getTimer, stopTimer, sendResponse }) {
  return async (req, res) => {
    if (!guard(req, res, sendResponse, 'POST', 'Timer stop', '/timer/stop')) return
    const user = await authorize(req, res); if (!user) return
    let timerId; let expectedRevision
    if (req.headers['if-match'] == null) {
      try {
        let body = {}
        if (jsonRequest(req) && !explicitlyEmptyBody(req)) {
          body = await readJson(req, { limit: '8kb' })
        }
        else if (req.headers['content-type'] != null
          && !jsonRequest(req)) throw new TypeError()
        else if (![undefined, '0'].includes(req.headers['content-length'])) throw new TypeError()
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new TypeError()
        if (Object.keys(body).length) {
          sendResponse(res, 428, 'If-Match is required. Read the timer before stopping it.')
          return
        }
      } catch (error) {
        const status = requestFailureStatus(error, req)
        sendResponse(
          res, status,
          status === 413 ? 'Timer stop request is too large.' : 'Invalid legacy timer stop request.',
        )
        return
      }
      try {
        // Compatibility for v5 clients: perform the missing read on their
        // behalf, then use exactly the same timer ID + revision CAS as v6.
        // A replacement between these two operations produces a 409; this is
        // never a blind profile.timer unset.
        const current = await getTimer({ userId: user._id })
        expectedRevision = parseResourceRevisionETag('timer', current.etag)
        timerId = current.payload.timerId
      } catch (error) {
        sendTimerError(res, sendResponse, error, 'Timer could not be read before stopping it.')
        return
      }
    } else {
      try {
        expectedRevision = parseResourceRevisionETag('timer', req.headers['if-match'])
        if (!jsonRequest(req)) {
          sendResponse(res, 415, 'Content-Type must be application/json with UTF-8 encoding.')
          return
        }
        const body = await readJson(req, { limit: '8kb' })
        if (!body || typeof body !== 'object' || Array.isArray(body)
          || Object.keys(body).join(',') !== 'timerId'
          || (body.timerId !== null && typeof body.timerId !== 'string')) throw new TypeError()
        timerId = body.timerId
        if (timerId !== null) validateOperationId(timerId)
      } catch (error) {
        const tooLarge = error?.type === 'entity.too.large' || error?.status === 413
        sendResponse(
          res, tooLarge ? 413 : 400,
          tooLarge ? 'Timer stop request is too large.' : 'Invalid timer stop request.',
        ); return
      }
    }
    try {
      const result = await stopTimer({ userId: user._id, timerId, expectedRevision })
      res.setHeader('ETag', result.etag)
      sendResponse(res, 200, 'Running timer stopped.', result.payload)
    } catch (error) {
      sendTimerError(res, sendResponse, error, 'Timer could not be stopped.')
    }
  }
}

export { createTimerGetHandler, createTimerStartHandler, createTimerStopHandler }
