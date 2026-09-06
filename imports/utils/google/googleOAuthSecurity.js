const MAX_AUTHORIZATION_CODE_LENGTH = 4096
const MAX_TOKEN_LENGTH = 16384
const MAX_SCOPE_LENGTH = 8192
const MAX_TOKEN_LIFETIME_SECONDS = 366 * 24 * 60 * 60

class GoogleOAuthSecurityError extends Error {
  constructor(code = 'google-oauth-token-exchange-failed') {
    super('Google authorization could not be completed.')
    this.name = 'GoogleOAuthSecurityError'
    this.code = code
  }
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function normalizeBoundedOpaqueString(value, maximumLength, required = true) {
  if (value === undefined || value === null || value === '') {
    if (required) throw new GoogleOAuthSecurityError()
    return undefined
  }
  if (
    typeof value !== 'string'
    || value.length > maximumLength
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) throw new GoogleOAuthSecurityError()
  return value
}

function normalizeGoogleAuthorizationCode(value) {
  return normalizeBoundedOpaqueString(value, MAX_AUTHORIZATION_CODE_LENGTH)
}

function normalizeStoredGoogleAccessToken(value) {
  return normalizeBoundedOpaqueString(value, MAX_TOKEN_LENGTH)
}

function normalizeGrantedScopes(value) {
  const scope = normalizeBoundedOpaqueString(value, MAX_SCOPE_LENGTH)
  const scopes = [...new Set(scope.split(/\s+/u).filter(Boolean))]
  if (
    scopes.length === 0
    || scopes.length > 100
    || scopes.some((item) => item.length > 512 || !/^[\x21-\x7e]+$/u.test(item))
  ) throw new GoogleOAuthSecurityError()
  return scopes
}

function normalizeGoogleTokenResponse(response, now = Date.now()) {
  if (!isPlainObject(response) || response.error !== undefined) {
    throw new GoogleOAuthSecurityError()
  }
  const accessToken = normalizeBoundedOpaqueString(response.access_token, MAX_TOKEN_LENGTH)
  const refreshToken = normalizeBoundedOpaqueString(
    response.refresh_token, MAX_TOKEN_LENGTH, false,
  )
  if (
    response.token_type !== undefined
    && (typeof response.token_type !== 'string'
      || response.token_type.toLowerCase() !== 'bearer')
  ) throw new GoogleOAuthSecurityError()
  if (!/^\d{1,9}$/u.test(String(response.expires_in))) {
    throw new GoogleOAuthSecurityError()
  }
  const expiresIn = Number(response.expires_in)
  if (
    !Number.isSafeInteger(expiresIn)
    || expiresIn < 1
    || expiresIn > MAX_TOKEN_LIFETIME_SECONDS
  ) throw new GoogleOAuthSecurityError()
  return {
    accessToken,
    refreshToken,
    scopes: normalizeGrantedScopes(response.scope),
    expiresAt: now + expiresIn * 1000,
  }
}

function sealGoogleServiceData(tokens, userId, sealSecret) {
  if (typeof userId !== 'string' || !userId || typeof sealSecret !== 'function') {
    throw new GoogleOAuthSecurityError()
  }
  try {
    const serviceData = {
      id: userId,
      accessToken: sealSecret(tokens.accessToken),
      scope: [...tokens.scopes],
      expiresAt: tokens.expiresAt,
    }
    if (tokens.refreshToken) serviceData.refreshToken = sealSecret(tokens.refreshToken)
    return serviceData
  } catch {
    throw new GoogleOAuthSecurityError()
  }
}

export {
  GoogleOAuthSecurityError,
  MAX_AUTHORIZATION_CODE_LENGTH,
  MAX_SCOPE_LENGTH,
  MAX_TOKEN_LENGTH,
  normalizeGoogleAuthorizationCode,
  normalizeGoogleTokenResponse,
  normalizeStoredGoogleAccessToken,
  normalizeGrantedScopes,
  sealGoogleServiceData,
}
