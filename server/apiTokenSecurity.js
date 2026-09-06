import { createHash, timingSafeEqual } from 'node:crypto'

const API_TOKEN_HASH_VERSION = 1
const API_TOKEN_MIN_LENGTH = 16
const API_TOKEN_MAX_LENGTH = 512
const NEW_API_TOKEN = /^[A-Za-z0-9._~-]+$/
const HASH_PREFIX = 'titra-api-token-v1\0'

function apiTokenDigest(token) {
  if (typeof token !== 'string' || token.length < 1 || token.length > API_TOKEN_MAX_LENGTH
    || !token.isWellFormed() || /[\s,]/u.test(token)) return null
  return createHash('sha256').update(HASH_PREFIX).update(token, 'utf8').digest('hex')
}

function validNewAPIToken(token) {
  return typeof token === 'string'
    && token.length >= API_TOKEN_MIN_LENGTH
    && token.length <= API_TOKEN_MAX_LENGTH
    && NEW_API_TOKEN.test(token)
}

function constantTimeEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false
  const leftBuffer = Buffer.from(left)
  const rightBuffer = Buffer.from(right)
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer)
}

function tokenHashDocument(token, now = new Date()) {
  if (!validNewAPIToken(token)) throw new TypeError('API token is invalid')
  return {
    version: API_TOKEN_HASH_VERSION,
    sha256: apiTokenDigest(token),
    updatedAt: now,
  }
}

function userHasTokenDigest(user, digest) {
  return user?.services?.titraApiToken?.version === API_TOKEN_HASH_VERSION
    && constantTimeEqual(user.services.titraApiToken.sha256, digest)
}

function userHasLegacyToken(user, token) {
  return constantTimeEqual(user?.profile?.APItoken, token)
}

async function findUserForAPIToken(token, {
  findUser,
  migrateLegacyToken,
}) {
  const digest = apiTokenDigest(token)
  if (!digest || typeof findUser !== 'function') return false

  const activeSelector = { inactive: { $ne: true } }
  const hashedUser = await findUser({
    ...activeSelector,
    'services.titraApiToken.version': API_TOKEN_HASH_VERSION,
    'services.titraApiToken.sha256': digest,
  })
  if (hashedUser && !hashedUser.inactive && userHasTokenDigest(hashedUser, digest)) {
    return hashedUser
  }

  const legacyUser = await findUser({
    ...activeSelector,
    'profile.APItoken': token,
  })
  if (!legacyUser || legacyUser.inactive || !userHasLegacyToken(legacyUser, token)) return false
  if (typeof migrateLegacyToken !== 'function') return legacyUser

  const migrated = await migrateLegacyToken({
    userId: legacyUser._id,
    token,
    digest,
    version: API_TOKEN_HASH_VERSION,
  })
  if (migrated) return legacyUser

  // A simultaneous request may have completed the same migration first.  Only
  // accept that race when the resulting digest still belongs to this user.
  const reconciled = await findUser({
    _id: legacyUser._id,
    ...activeSelector,
    'services.titraApiToken.version': API_TOKEN_HASH_VERSION,
    'services.titraApiToken.sha256': digest,
  })
  return reconciled && reconciled._id === legacyUser._id
    && !reconciled.inactive && userHasTokenDigest(reconciled, digest)
    ? reconciled : false
}

export {
  API_TOKEN_HASH_VERSION,
  API_TOKEN_MAX_LENGTH,
  API_TOKEN_MIN_LENGTH,
  apiTokenDigest,
  constantTimeEqual,
  findUserForAPIToken,
  tokenHashDocument,
  userHasLegacyToken,
  userHasTokenDigest,
  validNewAPIToken,
}
