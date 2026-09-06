import { actionVerificationBlocksAccess } from '../imports/utils/publicationAuthentication.js'
import { findUserForAPIToken } from './apiTokenSecurity.js'

function routeParameters(pathname, routePrefix, expectedCount) {
  if (!Number.isSafeInteger(expectedCount) || expectedCount < 0 || expectedCount > 16) {
    throw new TypeError('Expected route parameter count is invalid')
  }
  const pathParts = String(pathname || '').split('/').filter(Boolean)
  const prefixParts = String(routePrefix || '').split('/').filter(Boolean)
  const prefixMatches = prefixParts.every((part, index) => pathParts[index] === part)
  if (!prefixMatches || pathParts.length !== prefixParts.length + expectedCount) {
    throw new Error(`Expected exactly ${expectedCount} route parameter(s)`)
  }
  return pathParts.slice(prefixParts.length).map((part) => {
    const value = decodeURIComponent(part)
    if (!value || value.length > 128 || !value.isWellFormed()) {
      throw new Error('Route parameter is empty, malformed, or too long')
    }
    return value
  })
}

function singleRouteParameter(pathname, routePrefix) {
  return routeParameters(pathname, routePrefix, 1)[0]
}

const CANONICAL_UTC_MILLISECOND_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

/**
 * Parse only the canonical UTC timestamp shape emitted by Date#toISOString.
 * The exact round trip rejects JavaScript Date's otherwise-valid normalization
 * of impossible calendar values such as 24:00 or 30 February.
 */
function parseCanonicalUTCMillisecondTimestamp(value) {
  if (typeof value !== 'string' || !CANONICAL_UTC_MILLISECOND_TIMESTAMP.test(value)) {
    throw new TypeError('Expected a canonical UTC timestamp with millisecond precision')
  }
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new TypeError('Expected a canonical UTC timestamp with millisecond precision')
  }
  return parsed
}

function publicUserIdentity(user) {
  return {
    _id: user._id,
    name: typeof user.profile?.name === 'string' && user.profile.name.trim()
      ? user.profile.name
      : null,
  }
}

async function authenticatedAPIUser(authorization, findUser, migrateLegacyToken) {
  if (typeof authorization !== 'string') return false
  const match = authorization.match(/^(?:Bearer|Token)[ \t]+([^\s,]+)$/i)
  if (!match) return false
  return findUserForAPIToken(match[1], {
    findUser,
    migrateLegacyToken,
  })
}

const EXPECTED_USER_ID = /^[A-Za-z0-9_-]{1,128}$/
/**
 * Bind an authenticated request to the caller identity observed beforehand.
 * The header is optional for compatibility, but an invalid or stale pin fails
 * closed before route code can read data, reserve idempotency state or change data.
 */
function expectedAPIUserPrecondition(method, headers, actualUserId) {
  if (String(method || '').toUpperCase() === 'OPTIONS') return true
  const expected = headers?.['x-titra-expected-user-id']
  if (expected == null) return true
  return typeof expected === 'string'
    && EXPECTED_USER_ID.test(expected)
    && expected === String(actualUserId)
}

async function authorizeAPIRequest(req, findUser, migrateLegacyToken) {
  const user = await authenticatedAPIUser(
    req?.headers?.authorization,
    findUser,
    migrateLegacyToken,
  )
  if (!user) return { status: 'unauthenticated' }
  if (!expectedAPIUserPrecondition(req?.method, req?.headers, user._id)) {
    return { status: 'precondition_failed' }
  }
  if (actionVerificationBlocksAccess(user)) {
    return { status: 'action_verification_required' }
  }
  return { status: 'authorized', user }
}

export {
  authenticatedAPIUser,
  authorizeAPIRequest,
  expectedAPIUserPrecondition,
  parseCanonicalUTCMillisecondTimestamp,
  publicUserIdentity,
  routeParameters,
  singleRouteParameter,
}
