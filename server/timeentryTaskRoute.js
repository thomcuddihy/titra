import { singleRouteParameter } from './APIrouteHelpers.js'
import { parseTimecardDateRevisionETag } from '../imports/utils/timecardRevision.js'
import { validateTimecardTaskEditBody } from '../imports/api/timecards/server/taskEdit.js'

function createTimeentryTaskHandler({
  authorize, readJson, editTask, sendResponse,
}) {
  return async (req, res) => {
    if (req.method === 'OPTIONS') {
      res.setHeader('Allow', 'PATCH, OPTIONS')
      sendResponse(res, 204, 'Task edit preflight.')
      return
    }
    if (req.method !== 'PATCH') {
      res.setHeader('Allow', 'PATCH, OPTIONS')
      sendResponse(res, 405, 'Method not allowed. Use PATCH.')
      return
    }
    const meteorUser = await authorize(req, res)
    if (!meteorUser) return
    let timecardId
    try {
      timecardId = singleRouteParameter(req._parsedUrl?.pathname, '/timeentry/task')
    } catch (error) {
      sendResponse(res, 400, 'Invalid time entry ID.')
      return
    }
    const ifMatch = req.headers['if-match']
    if (ifMatch == null) {
      sendResponse(res, 428, 'If-Match is required. Preview the time entry before editing it.')
      return
    }
    if (typeof req.headers['content-type'] !== 'string'
      || !/^application\/json(?:\s*;\s*charset=utf-8)?\s*$/i.test(req.headers['content-type'])) {
      sendResponse(res, 415, 'Content-Type must be application/json with UTF-8 encoding.')
      return
    }
    let expectedDateRevision
    let json
    try {
      expectedDateRevision = parseTimecardDateRevisionETag(ifMatch)
      json = await readJson(req, { limit: '64kb' })
      validateTimecardTaskEditBody(json)
    } catch (error) {
      sendResponse(
        res,
        error?.type === 'entity.too.large' || error?.status === 413 ? 413 : 400,
        error?.type === 'entity.too.large' || error?.status === 413
          ? 'Task edit request is too large.'
          : 'Invalid task edit request. Supply application/json with only task and expectedTask, and one valid If-Match ETag.',
      )
      return
    }
    try {
      const result = await editTask(
        timecardId, meteorUser._id, json.task, json.expectedTask, expectedDateRevision,
      )
      res.setHeader('ETag', result.etag)
      sendResponse(res, 200, result.payload.changed ? 'Time entry task changed.' : 'Time entry task unchanged.', result.payload)
    } catch (error) {
      const statuses = {
        'timecard-task-invalid': 400,
        'not-authorized': 404,
        'timecard-write-conflict': 409,
        'notifications.timecard_migration_locked': 503,
        'timecard-rule-blocked': 422,
      }
      const messages = {
        'timecard-task-invalid': 'Invalid task edit request.',
        'not-authorized': 'Time entry not found.',
        'timecard-write-conflict': 'The time entry changed or its revision cannot advance. Reload and confirm it again.',
        'notifications.timecard_migration_locked': 'Time entries are temporarily locked for date migration.',
        'timecard-rule-blocked': 'The configured time entry rule prevented this task change.',
      }
      // Do not return raw database/rule errors or request contents to clients.
      sendResponse(res, statuses[error?.error] || 500, messages[error?.error] || 'Time entry task could not be changed.')
    }
  }
}

function createCapabilitiesHandler({ authorize, sendResponse }) {
  return async (req, res) => {
    if (!/^\/capabilities\/?$/.test(req._parsedUrl?.pathname || '')) {
      sendResponse(res, 404, 'API capability route not found.')
      return
    }
    if (req.method === 'OPTIONS') {
      res.setHeader('Allow', 'GET, OPTIONS')
      sendResponse(res, 204, 'API capabilities preflight.')
      return
    }
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET, OPTIONS')
      sendResponse(res, 405, 'Method not allowed. Use GET.')
      return
    }
    if (!await authorize(req, res)) return
    sendResponse(res, 200, 'Returning API capabilities.', {
      apiVersion: 1,
      features: {
        timeEntryTaskUpdate: true,
        idempotentCreate: true,
        timeEntryPagination: true,
      },
      taskUpdate: {
        requiresIfMatch: true,
        requiresExpectedTask: true,
        maxTaskLength: 1000,
        preservesOtherFields: true,
      },
      idempotency: {
        version: 1,
        header: 'Idempotency-Key',
        minKeyLength: 16,
        maxKeyLength: 128,
        retentionSeconds: 7 * 24 * 60 * 60,
        operations: ['timeentry.create', 'project.create', 'project-task.create'],
      },
      timeEntryPagination: {
        version: 1,
        defaultLimit: 200,
        maxLimit: 500,
        consistency: 'live-keyset',
        ownerPath: 'timeentry/daterange-page',
        projectPath: 'project/timeentriesfordaterange-page',
      },
    })
  }
}

export { createCapabilitiesHandler, createTimeentryTaskHandler }
