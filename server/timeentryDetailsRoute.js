import { singleRouteParameter } from './APIrouteHelpers.js'
import { parseTimecardDateRevisionETag } from '../imports/utils/timecardRevision.js'
import { validateTimecardDetailsEditBody } from '../imports/api/timecards/server/detailsEdit.js'

function createTimeentryDetailsHandler({ authorize, readJson, editDetails, sendResponse }) {
  return async (req, res) => {
    if (req.method === 'OPTIONS') {
      res.setHeader('Allow', 'PATCH, OPTIONS')
      sendResponse(res, 204, 'Time entry details preflight.')
      return
    }
    if (req.method !== 'PATCH') {
      res.setHeader('Allow', 'PATCH, OPTIONS')
      sendResponse(res, 405, 'Method not allowed. Use PATCH.')
      return
    }
    const meteorUser = await authorize(req, res)
    if (!meteorUser) return
    if (typeof req.headers['content-type'] !== 'string'
      || !/^application\/json(?:\s*;\s*charset=utf-8)?\s*$/i.test(req.headers['content-type'])) {
      sendResponse(res, 415, 'Content-Type must be application/json with UTF-8 encoding.')
      return
    }
    let timecardId
    let expectedDateRevision
    let body
    try {
      timecardId = singleRouteParameter(req._parsedUrl?.pathname, '/timeentry/details')
      if (req.headers['if-match'] == null) {
        sendResponse(res, 428, 'If-Match is required. Preview the time entry before editing it.')
        return
      }
      expectedDateRevision = parseTimecardDateRevisionETag(req.headers['if-match'])
      body = await readJson(req, { limit: '64kb' })
      validateTimecardDetailsEditBody(body)
    } catch (error) {
      sendResponse(
        res,
        error?.type === 'entity.too.large' || error?.status === 413 ? 413 : 400,
        error?.type === 'entity.too.large' || error?.status === 413
          ? 'Time entry details request is too large.' : 'Invalid time entry details request.',
      )
      return
    }
    try {
      const result = await editDetails({
        timecardId, userId: meteorUser._id, body, expectedDateRevision,
      })
      res.setHeader('ETag', result.etag)
      sendResponse(
        res, 200,
        result.payload.changed ? 'Time entry details changed.' : 'Time entry details unchanged.',
        result.payload,
      )
    } catch (error) {
      const statuses = {
        'timecard-details-invalid': 400,
        'not-authorized': 404,
        'timecard-write-conflict': 409,
        'timecard-legacy-conversion-required': 409,
        'timecard-rule-blocked': 422,
        'notifications.timecard_migration_locked': 503,
      }
      const messages = {
        'timecard-details-invalid': 'Invalid time entry details request.',
        'not-authorized': 'Time entry not found.',
        'timecard-write-conflict': 'The time entry changed or its revision cannot advance.',
        'timecard-legacy-conversion-required': 'Preview and explicitly acknowledge conversion of this legacy date before changing it.',
        'timecard-rule-blocked': 'The configured time entry rule prevented this details change.',
        'notifications.timecard_migration_locked': 'Time entries are temporarily locked for date migration.',
      }
      sendResponse(res, statuses[error?.error] || 500, messages[error?.error] || 'Time entry details could not be changed.')
    }
  }
}

export { createTimeentryDetailsHandler }
