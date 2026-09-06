import { createHash } from 'node:crypto'

const GOOGLE_OAUTH_STATE_LIFETIME_MS = 10 * 60 * 1000
const GOOGLE_OAUTH_CREDENTIAL_TOKEN = /^[A-Za-z0-9_-]{32,256}$/

class GoogleOAuthStateError extends Error {
  constructor(code) {
    super('Google authorization could not be completed.')
    this.name = 'GoogleOAuthStateError'
    this.code = code
  }
}

function credentialTokenDigest(credentialToken) {
  if (typeof credentialToken !== 'string'
    || !GOOGLE_OAUTH_CREDENTIAL_TOKEN.test(credentialToken)) {
    throw new GoogleOAuthStateError('google-oauth-state-invalid')
  }
  return createHash('sha256').update(credentialToken, 'utf8').digest('hex')
}

function validUserId(userId) {
  return typeof userId === 'string' && userId.length > 0 && userId.length <= 128
    && /^[A-Za-z0-9_-]+$/.test(userId)
}

function affectedExactlyOne(result) {
  if (result === 1) return true
  return result?.matchedCount === 1 || result?.deletedCount === 1
}

async function issueGoogleOAuthState({ userId }, dependencies) {
  if (!validUserId(userId)) {
    throw new GoogleOAuthStateError('google-oauth-authentication-required')
  }
  const {
    findActiveUser, generateCredentialToken, replaceBinding, now = () => new Date(),
  } = dependencies
  const activeUser = await findActiveUser(userId)
  if (!activeUser) {
    throw new GoogleOAuthStateError('google-oauth-authentication-required')
  }
  const credentialToken = generateCredentialToken()
  const tokenHash = credentialTokenDigest(credentialToken)
  const createdAt = now()
  if (!(createdAt instanceof Date) || Number.isNaN(createdAt.getTime())) {
    throw new TypeError('Google OAuth state clock returned an invalid date.')
  }
  const result = await replaceBinding({
    userId,
    tokenHash,
    createdAt,
    expiresAt: new Date(createdAt.getTime() + GOOGLE_OAUTH_STATE_LIFETIME_MS),
  })
  if (!affectedExactlyOne(result) && result?.upsertedCount !== 1) {
    throw new GoogleOAuthStateError('google-oauth-state-unavailable')
  }
  return credentialToken
}

async function consumeGoogleOAuthState({ credentialToken }, dependencies) {
  const {
    findBinding, removeBinding, findActiveUser, now = () => new Date(),
  } = dependencies
  const tokenHash = credentialTokenDigest(credentialToken)
  const consumedAt = now()
  if (!(consumedAt instanceof Date) || Number.isNaN(consumedAt.getTime())) {
    throw new TypeError('Google OAuth state clock returned an invalid date.')
  }
  const binding = await findBinding({ tokenHash, consumedAt })
  if (!binding || !validUserId(binding.userId)
    || !(binding.expiresAt instanceof Date) || binding.expiresAt <= consumedAt) {
    throw new GoogleOAuthStateError('google-oauth-state-invalid')
  }
  const removal = await removeBinding({
    bindingId: binding._id,
    tokenHash,
    consumedAt,
  })
  if (!affectedExactlyOne(removal)) {
    throw new GoogleOAuthStateError('google-oauth-state-invalid')
  }
  const activeUser = await findActiveUser(binding.userId)
  if (!activeUser) {
    throw new GoogleOAuthStateError('google-oauth-authentication-required')
  }
  return binding.userId
}

export {
  GOOGLE_OAUTH_CREDENTIAL_TOKEN,
  GOOGLE_OAUTH_STATE_LIFETIME_MS,
  GoogleOAuthStateError,
  affectedExactlyOne,
  consumeGoogleOAuthState,
  credentialTokenDigest,
  issueGoogleOAuthState,
  validUserId,
}
