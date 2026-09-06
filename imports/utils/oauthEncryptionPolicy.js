const OAUTH_SECRET_KEY_ENV = 'TITRA_OAUTH_SECRET_KEY'

class OAuthEncryptionConfigurationError extends Error {
  constructor() {
    super('OAuth credential encryption is not configured.')
    this.name = 'OAuthEncryptionConfigurationError'
    this.code = 'oauth-encryption-required'
  }
}

function normalizeOAuthSecretKey(value) {
  if (value === undefined || value === '') return undefined
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]{22}==$/.test(value)) {
    throw new OAuthEncryptionConfigurationError()
  }
  let decoded
  try {
    decoded = Buffer.from(value, 'base64')
  } catch {
    throw new OAuthEncryptionConfigurationError()
  }
  if (decoded.length !== 16 || decoded.toString('base64') !== value) {
    throw new OAuthEncryptionConfigurationError()
  }
  return value
}

function runtimeEnvironment() {
  return typeof process === 'undefined' || !process.env ? {} : process.env
}

function oauthEncryptionKey(environment = runtimeEnvironment()) {
  return normalizeOAuthSecretKey(environment?.[OAUTH_SECRET_KEY_ENV])
}

function oauthEncryptionConfigured(environment = runtimeEnvironment()) {
  return oauthEncryptionKey(environment) !== undefined
}

function requireOAuthEncryptionConfigured(environment = runtimeEnvironment()) {
  const key = oauthEncryptionKey(environment)
  if (!key) throw new OAuthEncryptionConfigurationError()
  return key
}

export {
  OAUTH_SECRET_KEY_ENV,
  OAuthEncryptionConfigurationError,
  normalizeOAuthSecretKey,
  oauthEncryptionConfigured,
  oauthEncryptionKey,
  requireOAuthEncryptionConfigured,
}
