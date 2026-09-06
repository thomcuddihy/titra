const SERVICE_NAME = 'oidc'
const MAX_URL_LENGTH = 2048
const MAX_CLIENT_ID_LENGTH = 512
const MAX_CLIENT_SECRET_LENGTH = 4096
const MAX_TOKEN_LENGTH = 16384
const MAX_RESPONSE_BYTES = 64 * 1024
const HTTP_TIMEOUT_MS = 10 * 1000
const INSECURE_LOOPBACK_ENV = 'TITRA_OIDC_ALLOW_INSECURE_LOOPBACK'
const VERIFIED_EMAIL_LINKING_ENV = 'TITRA_OIDC_ALLOW_VERIFIED_EMAIL_LINKING'

const CONFIGURATION_KEYS = Object.freeze([
  'service',
  'disableDefaultLoginForm',
  'autoInitiateLogin',
  'clientId',
  'secret',
  'serverUrl',
  'authorizationEndpoint',
  'tokenEndpoint',
  'userinfoEndpoint',
  'idTokenWhitelistFields',
  'requestPermissions',
  'loginStyle',
])
const STORED_CONFIGURATION_KEYS = Object.freeze([
  ...CONFIGURATION_KEYS,
  'insecureLoopbackAllowed',
])

const CONFIGURATION_KEY_SET = new Set(CONFIGURATION_KEYS)
const STORED_CONFIGURATION_KEY_SET = new Set(STORED_CONFIGURATION_KEYS)
const PROTECTED_SERVICE_DATA_FIELDS = new Set([
  'id',
  'username',
  'accessToken',
  'refreshToken',
  'expiresAt',
  'email',
  'emailVerified',
])
const FORBIDDEN_OBJECT_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
const CLAIM_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/
const SCOPE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:._/-]{0,127}$/
const EMAIL_LOCAL_PATTERN = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+$/
const DOMAIN_LABEL_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/

class OidcSecurityError extends Error {
  constructor(code = 'oidc-invalid-response') {
    super('OpenID Connect operation could not be completed.')
    this.name = 'OidcSecurityError'
    this.code = code
  }
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function hasOwn(object, property) {
  return Object.prototype.hasOwnProperty.call(object, property)
}

function configurationError() {
  return new OidcSecurityError('oidc-invalid-configuration')
}

function exactEnvironmentFlag(name, environment = {}) {
  return environment?.[name] === 'true'
}

function runtimeEnvironment() {
  return typeof process === 'undefined' || !process.env ? {} : process.env
}

function isLoopbackHostname(hostname) {
  const normalized = String(hostname || '').toLowerCase()
  if (normalized === 'localhost' || normalized.endsWith('.localhost')) return true
  if (normalized === '[::1]' || normalized === '::1') return true
  const match = normalized.match(/^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  return Boolean(match && match.slice(1).every((part) => Number(part) <= 255))
}

function assertSecureUrl(parsedUrl, environment) {
  if (parsedUrl.protocol === 'https:') return
  const insecureLoopbackEnabled = exactEnvironmentFlag(
    INSECURE_LOOPBACK_ENV, environment,
  )
  if (
    parsedUrl.protocol !== 'http:'
    || !insecureLoopbackEnabled
    || !isLoopbackHostname(parsedUrl.hostname)
  ) throw configurationError()
}

function parseAbsoluteUrl(value, environment, { allowQuery = true } = {}) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_URL_LENGTH) {
    throw configurationError()
  }
  let parsedUrl
  try {
    parsedUrl = new URL(value)
  } catch {
    throw configurationError()
  }
  if (
    parsedUrl.username
    || parsedUrl.password
    || parsedUrl.hash
    || (!allowQuery && parsedUrl.search)
  ) throw configurationError()
  assertSecureUrl(parsedUrl, environment)
  return parsedUrl
}

function normalizeServerUrl(serverUrl, environment) {
  if (serverUrl === undefined || serverUrl === null || serverUrl === '') return ''
  const parsedUrl = parseAbsoluteUrl(serverUrl, environment, { allowQuery: false })
  return parsedUrl.toString().replace(/\/$/, '')
}

function resolveOidcEndpoint(endpoint, serverUrl = '', environment = {}) {
  if (typeof endpoint !== 'string') throw configurationError()
  const trimmedEndpoint = endpoint.trim()
  if (trimmedEndpoint.length === 0 || trimmedEndpoint.length > MAX_URL_LENGTH) {
    throw configurationError()
  }

  let absoluteValue = trimmedEndpoint
  try {
    // Do not treat protocol-relative values as relative paths.
    if (trimmedEndpoint.startsWith('//')) throw configurationError()
    const directlyParsed = new URL(trimmedEndpoint)
    absoluteValue = directlyParsed.toString()
  } catch (error) {
    if (error instanceof OidcSecurityError) throw error
    const normalizedServerUrl = normalizeServerUrl(serverUrl, environment)
    if (!normalizedServerUrl) throw configurationError()
    const suffix = trimmedEndpoint.startsWith('/') ? trimmedEndpoint : `/${trimmedEndpoint}`
    absoluteValue = `${normalizedServerUrl}${suffix}`
  }

  return parseAbsoluteUrl(absoluteValue, environment).toString()
}

function normalizeRequiredString(value, maximumLength) {
  if (typeof value !== 'string') throw configurationError()
  const normalized = value.trim()
  if (normalized.length === 0 || normalized.length > maximumLength) throw configurationError()
  if (/[\u0000-\u001f\u007f]/u.test(normalized)) throw configurationError()
  return normalized
}

function normalizeOidcClientSecret(value) {
  return normalizeRequiredString(value, MAX_CLIENT_SECRET_LENGTH)
}

function normalizeBoolean(value, fallback = false) {
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') throw configurationError()
  return value
}

function normalizeScopeToken(scope) {
  if (typeof scope !== 'string') throw configurationError()
  let normalized = scope.trim()
  if (
    normalized.length >= 2
    && ((normalized.startsWith('"') && normalized.endsWith('"'))
      || (normalized.startsWith("'") && normalized.endsWith("'")))
  ) normalized = normalized.slice(1, -1).trim()
  if (!SCOPE_PATTERN.test(normalized)) throw configurationError()
  return normalized
}

function parseOidcScopes(value = 'openid,profile,email') {
  if (typeof value !== 'string' || value.length > 2048) throw configurationError()
  const tokens = value.split(/[\s,]+/u).filter(Boolean).map(normalizeScopeToken)
  const uniqueTokens = [...new Set(tokens)]
  if (uniqueTokens.length === 0 || uniqueTokens.length > 20 || !uniqueTokens.includes('openid')) {
    throw configurationError()
  }
  return uniqueTokens
}

function normalizeClaimWhitelist(value = []) {
  if (!Array.isArray(value) || value.length > 20) throw configurationError()
  const result = []
  for (const item of value) {
    if (typeof item !== 'string' || item.length > 2048) throw configurationError()
    const claims = item.split(/[\s,]+/u).filter(Boolean)
    for (const claim of claims) {
      if (
        !CLAIM_NAME_PATTERN.test(claim)
        || PROTECTED_SERVICE_DATA_FIELDS.has(claim)
        || FORBIDDEN_OBJECT_KEYS.has(claim)
      ) throw configurationError()
      if (!result.includes(claim)) result.push(claim)
      if (result.length > 20) throw configurationError()
    }
  }
  return result
}

function assertExactConfigurationKeys(configuration) {
  if (!isPlainObject(configuration)) throw configurationError()
  if (Object.keys(configuration).some((key) => !CONFIGURATION_KEY_SET.has(key))) {
    throw configurationError()
  }
}

function assertExactStoredConfigurationKeys(configuration) {
  if (!isPlainObject(configuration)) throw configurationError()
  if (Object.keys(configuration).some(
    (key) => key !== '_id' && !STORED_CONFIGURATION_KEY_SET.has(key),
  )) throw configurationError()
}

function normalizeOidcConfiguration(configuration, {
  environment = {},
  preservedSecret,
} = {}) {
  assertExactConfigurationKeys(configuration)
  if (configuration.service !== undefined && configuration.service !== SERVICE_NAME) {
    throw configurationError()
  }

  let secret = preservedSecret
  if (hasOwn(configuration, 'secret') && configuration.secret !== '') {
    secret = normalizeOidcClientSecret(configuration.secret)
  }
  if (secret === undefined || secret === null || secret === '') throw configurationError()

  const serverUrl = normalizeServerUrl(configuration.serverUrl || '', environment)
  const requestPermissions = parseOidcScopes(configuration.requestPermissions).join(',')
  const loginStyle = configuration.loginStyle === undefined ? 'popup' : configuration.loginStyle
  if (loginStyle !== 'popup' && loginStyle !== 'redirect') throw configurationError()

  return {
    service: SERVICE_NAME,
    disableDefaultLoginForm: normalizeBoolean(configuration.disableDefaultLoginForm),
    autoInitiateLogin: normalizeBoolean(configuration.autoInitiateLogin),
    clientId: normalizeRequiredString(configuration.clientId, MAX_CLIENT_ID_LENGTH),
    secret,
    serverUrl,
    authorizationEndpoint: resolveOidcEndpoint(
      configuration.authorizationEndpoint, serverUrl, environment,
    ),
    tokenEndpoint: resolveOidcEndpoint(configuration.tokenEndpoint, serverUrl, environment),
    userinfoEndpoint: resolveOidcEndpoint(configuration.userinfoEndpoint, serverUrl, environment),
    idTokenWhitelistFields: normalizeClaimWhitelist(configuration.idTokenWhitelistFields),
    requestPermissions,
    loginStyle,
    insecureLoopbackAllowed: exactEnvironmentFlag(
      INSECURE_LOOPBACK_ENV, environment,
    ),
  }
}

function mergeOidcConfiguration(configuration, existingConfiguration = {}) {
  assertExactConfigurationKeys(configuration)
  if (!isPlainObject(existingConfiguration)) throw configurationError()
  const merged = {}
  for (const key of CONFIGURATION_KEYS) {
    if (key === 'secret') continue
    if (hasOwn(configuration, key)) merged[key] = configuration[key]
    else if (hasOwn(existingConfiguration, key)) merged[key] = existingConfiguration[key]
  }
  return merged
}

function normalizeOidcClientConfiguration(configuration, { environment = {} } = {}) {
  assertExactStoredConfigurationKeys(configuration)
  const clientEnvironment = configuration.insecureLoopbackAllowed === true
    ? { ...environment, [INSECURE_LOOPBACK_ENV]: 'true' }
    : environment
  const serverUrl = normalizeServerUrl(configuration.serverUrl || '', clientEnvironment)
  const loginStyle = configuration.loginStyle === undefined ? 'popup' : configuration.loginStyle
  if (loginStyle !== 'popup' && loginStyle !== 'redirect') throw configurationError()
  return {
    clientId: normalizeRequiredString(configuration.clientId, MAX_CLIENT_ID_LENGTH),
    authorizationEndpoint: resolveOidcEndpoint(
      configuration.authorizationEndpoint, serverUrl, clientEnvironment,
    ),
    requestPermissions: parseOidcScopes(configuration.requestPermissions),
    loginStyle,
  }
}

function normalizeOpaqueToken(value, required = false) {
  if (value === undefined || value === null || value === '') {
    if (required) throw new OidcSecurityError()
    return undefined
  }
  if (
    typeof value !== 'string'
    || value.length > MAX_TOKEN_LENGTH
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) throw new OidcSecurityError()
  return value
}

function normalizeTokenResponse(response, now = Date.now()) {
  if (!isPlainObject(response)) throw new OidcSecurityError()
  const accessToken = normalizeOpaqueToken(response.access_token, true)
  const refreshToken = normalizeOpaqueToken(response.refresh_token)
  if (
    response.token_type !== undefined
    && (typeof response.token_type !== 'string' || response.token_type.toLowerCase() !== 'bearer')
  ) throw new OidcSecurityError()

  let expiresAt
  if (response.expires_in !== undefined) {
    const rawExpiry = response.expires_in
    if (
      (typeof rawExpiry !== 'number' && typeof rawExpiry !== 'string')
      || !/^\d{1,9}$/u.test(String(rawExpiry))
    ) throw new OidcSecurityError()
    const expiresIn = Number(rawExpiry)
    if (!Number.isSafeInteger(expiresIn) || expiresIn < 1 || expiresIn > 366 * 24 * 60 * 60) {
      throw new OidcSecurityError()
    }
    expiresAt = now + (expiresIn * 1000)
  }

  return { accessToken, refreshToken, expiresAt }
}

function normalizeEmail(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 254) return undefined
  if (value !== value.trim() || /[\u0000-\u0020\u007f]/u.test(value)) return undefined
  const at = value.lastIndexOf('@')
  if (at < 1 || at !== value.indexOf('@')) return undefined
  const local = value.slice(0, at)
  const domain = value.slice(at + 1)
  if (
    local.length > 64
    || !EMAIL_LOCAL_PATTERN.test(local)
    || local.startsWith('.')
    || local.endsWith('.')
    || local.includes('..')
    || domain.length > 253
  ) return undefined
  const labels = domain.split('.')
  if (!labels.every((label) => DOMAIN_LABEL_PATTERN.test(label))) return undefined
  return value
}

function normalizeSubject(value) {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > 255
    || value !== value.trim()
    || !/^[\x21-\x7e]+$/u.test(value)
  ) throw new OidcSecurityError()
  return value
}

function normalizeOptionalText(value, maximumLength) {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string') return undefined
  const normalized = value.trim()
  if (
    normalized.length === 0
    || normalized.length > maximumLength
    || /[\u0000-\u001f\u007f-\u009f]/u.test(normalized)
  ) return undefined
  return normalized
}

function sanitizeClaimValue(value, depth = 0) {
  if (depth > 4) throw new OidcSecurityError()
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new OidcSecurityError()
    return value
  }
  if (typeof value === 'string') {
    if (value.length > 4096 || /\u0000/u.test(value)) throw new OidcSecurityError()
    return value
  }
  if (Array.isArray(value)) {
    if (value.length > 64) throw new OidcSecurityError()
    return value.map((item) => sanitizeClaimValue(item, depth + 1))
  }
  if (!isPlainObject(value)) throw new OidcSecurityError()
  const entries = Object.entries(value)
  if (entries.length > 32) throw new OidcSecurityError()
  const safeEntries = entries.map(([key, childValue]) => {
    if (!CLAIM_NAME_PATTERN.test(key) || FORBIDDEN_OBJECT_KEYS.has(key)) {
      throw new OidcSecurityError()
    }
    return [key, sanitizeClaimValue(childValue, depth + 1)]
  })
  return Object.fromEntries(safeEntries)
}

function normalizeUserinfo(response, {
  accessToken,
  refreshToken,
  expiresAt,
  claimWhitelist = [],
  sealSecret = (value) => value,
} = {}) {
  if (!isPlainObject(response)) throw new OidcSecurityError()
  const id = normalizeSubject(response.sub)
  const email = normalizeEmail(response.email)
  if (!email) throw new OidcSecurityError()
  const normalizedAccessToken = normalizeOpaqueToken(accessToken, true)
  const normalizedRefreshToken = normalizeOpaqueToken(refreshToken)
  const username = normalizeOptionalText(
    response.preferred_username || response.username, 128,
  ) || email
  const name = normalizeOptionalText(response.name, 256) || username
  const whitelist = normalizeClaimWhitelist(claimWhitelist)

  let sealedAccessToken
  let sealedRefreshToken
  try {
    sealedAccessToken = sealSecret(normalizedAccessToken)
    if (normalizedRefreshToken) sealedRefreshToken = sealSecret(normalizedRefreshToken)
  } catch {
    throw new OidcSecurityError()
  }

  const serviceData = {
    id,
    username,
    accessToken: sealedAccessToken,
    email,
  }
  if (Number.isSafeInteger(expiresAt) && expiresAt > 0) serviceData.expiresAt = expiresAt
  if (sealedRefreshToken !== undefined) serviceData.refreshToken = sealedRefreshToken
  if (response.email_verified === true) serviceData.emailVerified = true

  for (const claim of whitelist) {
    if (hasOwn(response, claim)) serviceData[claim] = sanitizeClaimValue(response[claim])
  }

  return {
    serviceData,
    options: {
      profile: { name },
      emails: [{ address: email, verified: response.email_verified === true }],
    },
  }
}

function isJsonContentType(value) {
  if (typeof value !== 'string') return false
  const mediaType = value.split(';', 1)[0].trim().toLowerCase()
  return mediaType === 'application/json'
    || (mediaType.startsWith('application/') && mediaType.endsWith('+json'))
}

function byteLength(value) {
  return new TextEncoder().encode(value).byteLength
}

async function readBoundedResponseText(response, maximumBytes) {
  const contentLength = response.headers?.get?.('content-length')
  if (contentLength && /^\d+$/u.test(contentLength) && Number(contentLength) > maximumBytes) {
    throw new OidcSecurityError()
  }

  if (response.body?.getReader) {
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let received = 0
    let text = ''
    while (true) {
      // eslint-disable-next-line no-await-in-loop
      const { done, value } = await reader.read()
      if (done) break
      received += value.byteLength
      if (received > maximumBytes) {
        await reader.cancel().catch(() => {})
        throw new OidcSecurityError()
      }
      text += decoder.decode(value, { stream: true })
    }
    return text + decoder.decode()
  }

  const text = await response.text()
  if (byteLength(text) > maximumBytes) throw new OidcSecurityError()
  return text
}

async function readOidcJsonResponse(response, { maximumBytes = MAX_RESPONSE_BYTES } = {}) {
  if (!response || response.ok !== true) throw new OidcSecurityError()
  if (!isJsonContentType(response.headers?.get?.('content-type'))) throw new OidcSecurityError()
  const text = await readBoundedResponseText(response, maximumBytes)
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new OidcSecurityError()
  }
  if (!isPlainObject(parsed)) throw new OidcSecurityError()
  return parsed
}

async function fetchOidcJson(fetchImplementation, url, options, {
  timeoutMs = HTTP_TIMEOUT_MS,
  maximumBytes = MAX_RESPONSE_BYTES,
} = {}) {
  if (typeof fetchImplementation !== 'function') throw new OidcSecurityError()
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30000) {
    throw new OidcSecurityError()
  }
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImplementation(url, {
      ...options,
      redirect: 'error',
      signal: controller.signal,
    })
    return await readOidcJsonResponse(response, { maximumBytes })
  } catch (error) {
    if (error instanceof OidcSecurityError) throw error
    throw new OidcSecurityError()
  } finally {
    clearTimeout(timeout)
  }
}

function oidcVerifiedEmailLinkingEnabled(environment = runtimeEnvironment()) {
  return exactEnvironmentFlag(VERIFIED_EMAIL_LINKING_ENV, environment)
}

function shouldLinkExistingOidcAccount(
  { serviceName, serviceData } = {}, environment = runtimeEnvironment(),
) {
  return serviceName === SERVICE_NAME
    && oidcVerifiedEmailLinkingEnabled(environment)
    && isPlainObject(serviceData)
    && serviceData.emailVerified === true
    && normalizeEmail(serviceData.email) !== undefined
}

export {
  CONFIGURATION_KEYS,
  INSECURE_LOOPBACK_ENV,
  STORED_CONFIGURATION_KEYS,
  VERIFIED_EMAIL_LINKING_ENV,
  MAX_RESPONSE_BYTES,
  OidcSecurityError,
  exactEnvironmentFlag,
  fetchOidcJson,
  isJsonContentType,
  isLoopbackHostname,
  mergeOidcConfiguration,
  normalizeClaimWhitelist,
  normalizeEmail,
  normalizeOidcClientConfiguration,
  normalizeOidcClientSecret,
  normalizeOidcConfiguration,
  normalizeTokenResponse,
  normalizeUserinfo,
  oidcVerifiedEmailLinkingEnabled,
  parseOidcScopes,
  readOidcJsonResponse,
  resolveOidcEndpoint,
  shouldLinkExistingOidcAccount,
}
