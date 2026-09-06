import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  MAX_RESPONSE_BYTES,
  OidcSecurityError,
  fetchOidcJson,
  normalizeClaimWhitelist,
  normalizeEmail,
  normalizeOidcClientConfiguration,
  normalizeOidcConfiguration,
  normalizeTokenResponse,
  normalizeUserinfo,
  parseOidcScopes,
  readOidcJsonResponse,
  resolveOidcEndpoint,
  shouldLinkExistingOidcAccount,
} from './oidcSecurity.js'

const BASE_CONFIGURATION = Object.freeze({
  service: 'oidc',
  disableDefaultLoginForm: false,
  autoInitiateLogin: false,
  clientId: 'titra-client',
  secret: 'a-secret-value',
  serverUrl: 'https://identity.example.test/realm',
  authorizationEndpoint: '/oauth/authorize',
  tokenEndpoint: '/oauth/token',
  userinfoEndpoint: '/oauth/userinfo',
  idTokenWhitelistFields: ['groups'],
  requestPermissions: '"openid", "profile", "email"',
  loginStyle: 'redirect',
})

function jsonResponse(body, {
  ok = true,
  contentType = 'application/json; charset=utf-8',
  contentLength,
} = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  return {
    ok,
    headers: {
      get(name) {
        if (name.toLowerCase() === 'content-type') return contentType
        if (name.toLowerCase() === 'content-length') return contentLength
        return null
      },
    },
    async text() { return text },
  }
}

function isOidcError(error, code) {
  return error instanceof OidcSecurityError && (!code || error.code === code)
}

test('configuration accepts only exact fields and normalizes all three required endpoints', () => {
  const result = normalizeOidcConfiguration(BASE_CONFIGURATION)
  assert.equal(result.serverUrl, 'https://identity.example.test/realm')
  assert.equal(result.authorizationEndpoint, 'https://identity.example.test/realm/oauth/authorize')
  assert.equal(result.tokenEndpoint, 'https://identity.example.test/realm/oauth/token')
  assert.equal(result.userinfoEndpoint, 'https://identity.example.test/realm/oauth/userinfo')
  assert.equal(result.requestPermissions, 'openid,profile,email')
  assert.deepEqual(result.idTokenWhitelistFields, ['groups'])
  assert.equal(result.insecureLoopbackAllowed, false)

  assert.throws(
    () => normalizeOidcConfiguration({ ...BASE_CONFIGURATION, unexpected: true }),
    (error) => isOidcError(error, 'oidc-invalid-configuration'),
  )
  for (const missing of ['authorizationEndpoint', 'tokenEndpoint', 'userinfoEndpoint']) {
    const configuration = { ...BASE_CONFIGURATION }
    delete configuration[missing]
    assert.throws(
      () => normalizeOidcConfiguration(configuration),
      (error) => isOidcError(error, 'oidc-invalid-configuration'),
      missing,
    )
  }
})

test('configuration enforces exact scalar types and bounded credentials', () => {
  for (const change of [
    { clientId: ['client'] },
    { clientId: '' },
    { secret: { plaintext: 'secret' } },
    { secret: 'x'.repeat(4097) },
    { autoInitiateLogin: 'true' },
    { disableDefaultLoginForm: 0 },
    { loginStyle: 'silent' },
    { idTokenWhitelistFields: 'groups' },
  ]) {
    assert.throws(
      () => normalizeOidcConfiguration({ ...BASE_CONFIGURATION, ...change }),
      (error) => isOidcError(error, 'oidc-invalid-configuration'),
      JSON.stringify(change),
    )
  }

  const preserved = { ciphertext: 'already-sealed' }
  const withoutSecret = { ...BASE_CONFIGURATION }
  delete withoutSecret.secret
  assert.equal(
    normalizeOidcConfiguration(withoutSecret, { preservedSecret: preserved }).secret,
    preserved,
  )
})

test('HTTPS is mandatory unless an exact opt-in is used for loopback development only', () => {
  for (const url of [
    'http://identity.example.test/token',
    'ftp://identity.example.test/token',
    'https://user:password@identity.example.test/token',
    'https://identity.example.test/token#fragment',
    '//identity.example.test/token',
  ]) assert.throws(() => resolveOidcEndpoint(url), isOidcError)

  const environment = { TITRA_OIDC_ALLOW_INSECURE_LOOPBACK: 'true' }
  assert.equal(
    resolveOidcEndpoint('http://127.0.0.1:8080/token', '', environment),
    'http://127.0.0.1:8080/token',
  )
  assert.equal(
    resolveOidcEndpoint('http://login.localhost/token', '', environment),
    'http://login.localhost/token',
  )
  assert.throws(
    () => resolveOidcEndpoint(
      'http://identity.example.test/token', '', environment,
    ),
    isOidcError,
  )
  assert.throws(
    () => resolveOidcEndpoint(
      'http://127.0.0.1/token', '', { TITRA_OIDC_ALLOW_INSECURE_LOOPBACK: 'TRUE' },
    ),
    isOidcError,
  )
})

test('browser configuration validates its public subset without needing the secret', () => {
  const result = normalizeOidcClientConfiguration({
    clientId: BASE_CONFIGURATION.clientId,
    serverUrl: BASE_CONFIGURATION.serverUrl,
    authorizationEndpoint: BASE_CONFIGURATION.authorizationEndpoint,
    requestPermissions: BASE_CONFIGURATION.requestPermissions,
    loginStyle: BASE_CONFIGURATION.loginStyle,
  })
  assert.equal(result.authorizationEndpoint, 'https://identity.example.test/realm/oauth/authorize')
  assert.deepEqual(result.requestPermissions, ['openid', 'profile', 'email'])

  assert.equal(normalizeOidcClientConfiguration({
    clientId: 'local-client',
    authorizationEndpoint: 'http://localhost:3000/authorize',
    requestPermissions: 'openid,email',
    loginStyle: 'popup',
    insecureLoopbackAllowed: true,
  }).authorizationEndpoint, 'http://localhost:3000/authorize')
  assert.throws(() => normalizeOidcClientConfiguration({
    clientId: 'local-client',
    authorizationEndpoint: 'http://localhost:3000/authorize',
    requestPermissions: 'openid,email',
    loginStyle: 'popup',
    insecureLoopbackAllowed: false,
  }), isOidcError)
})

test('scopes require openid and custom claim names cannot override identity or token fields', () => {
  assert.deepEqual(parseOidcScopes('openid profile,email email'), ['openid', 'profile', 'email'])
  for (const scopes of ['', 'profile,email', 'openid,bad scope?', 42]) {
    assert.throws(() => parseOidcScopes(scopes), isOidcError, String(scopes))
  }
  assert.deepEqual(normalizeClaimWhitelist(['groups,department', '', 'groups']), [
    'groups', 'department',
  ])
  for (const claim of [
    'id', 'email', 'emailVerified', 'accessToken', 'refreshToken', 'expiresAt',
    '__proto__', 'constructor', 'a.b', '$where',
  ]) assert.throws(() => normalizeClaimWhitelist([claim]), isOidcError, claim)
})

test('token responses require a bounded bearer access token and sane expiry', () => {
  assert.deepEqual(
    normalizeTokenResponse({
      access_token: 'access', refresh_token: 'refresh', token_type: 'Bearer', expires_in: '3600',
    }, 1000),
    { accessToken: 'access', refreshToken: 'refresh', expiresAt: 3601000 },
  )
  for (const response of [
    {},
    { access_token: 'x', token_type: 'mac' },
    { access_token: 'x', expires_in: '-1' },
    { access_token: 'x', expires_in: '999999999' },
    { access_token: `x\nsecret` },
  ]) assert.throws(() => normalizeTokenResponse(response), isOidcError)
})

test('userinfo is the sole identity source, requires stable sub and valid email, and seals tokens', () => {
  const result = normalizeUserinfo({
    sub: 'provider-subject-123',
    email: 'person@example.test',
    email_verified: true,
    preferred_username: 'person',
    name: 'Example Person',
    groups: ['staff', 'research'],
    accessToken: 'attempted override',
  }, {
    accessToken: 'access-secret',
    refreshToken: 'refresh-secret',
    expiresAt: 123456,
    claimWhitelist: ['groups'],
    sealSecret: (value) => `sealed:${value}`,
  })
  assert.deepEqual(result, {
    serviceData: {
      id: 'provider-subject-123',
      username: 'person',
      accessToken: 'sealed:access-secret',
      email: 'person@example.test',
      expiresAt: 123456,
      refreshToken: 'sealed:refresh-secret',
      emailVerified: true,
      groups: ['staff', 'research'],
    },
    options: {
      profile: { name: 'Example Person' },
      emails: [{ address: 'person@example.test', verified: true }],
    },
  })

  for (const response of [
    { email: 'person@example.test' },
    { sub: '', email: 'person@example.test' },
    { sub: 'subject', email: 'not-an-email' },
    { sub: 'subject', email: 'person@example.test', groups: { constructor: 'bad' } },
  ]) assert.throws(
    () => normalizeUserinfo(response, {
      accessToken: 'access', claimWhitelist: response.groups ? ['groups'] : [],
    }),
    isOidcError,
  )
})

test('only the literal boolean true marks provider email as verified', () => {
  for (const providerValue of [false, 'true', 1, null, undefined]) {
    const result = normalizeUserinfo({
      sub: 'provider-subject', email: 'person@example.test', email_verified: providerValue,
    }, { accessToken: 'access' })
    assert.equal(result.serviceData.emailVerified, undefined)
    assert.equal(result.options.emails[0].verified, false)
  }
})

test('email validation is bounded and rejects controls or malformed domains', () => {
  assert.equal(normalizeEmail('person+tag@example.test'), 'person+tag@example.test')
  for (const email of [
    ' person@example.test',
    'person@@example.test',
    '.person@example.test',
    'person..name@example.test',
    'person@-example.test',
    `person@example.test\nsecond@example.test`,
    `${'a'.repeat(65)}@example.test`,
  ]) assert.equal(normalizeEmail(email), undefined, email)
})

test('JSON responses require success and JSON content type and are byte bounded', async () => {
  assert.deepEqual(await readOidcJsonResponse(jsonResponse({ sub: 'subject' })), { sub: 'subject' })
  for (const response of [
    jsonResponse({}, { ok: false }),
    jsonResponse({}, { contentType: 'text/html' }),
    jsonResponse('not-json'),
    jsonResponse('x'.repeat(MAX_RESPONSE_BYTES + 1)),
    jsonResponse('{}', { contentLength: String(MAX_RESPONSE_BYTES + 1) }),
  ]) await assert.rejects(() => readOidcJsonResponse(response), isOidcError)
})

test('OIDC fetch supplies an abort signal and maps transport failures to generic errors', async () => {
  let receivedOptions
  const result = await fetchOidcJson(async (url, options) => {
    assert.equal(url, 'https://identity.example.test/userinfo')
    receivedOptions = options
    return jsonResponse({ sub: 'subject' })
  }, 'https://identity.example.test/userinfo', { method: 'GET' }, { timeoutMs: 100 })
  assert.deepEqual(result, { sub: 'subject' })
  assert.equal(receivedOptions.signal instanceof AbortSignal, true)
  assert.equal(receivedOptions.redirect, 'error')

  await assert.rejects(
    () => fetchOidcJson(async () => { throw new Error('provider leaked a token') },
      'https://identity.example.test/token', {}, { timeoutMs: 100 }),
    (error) => isOidcError(error) && !error.message.includes('token'),
  )
})

test('existing-account email linking requires both explicit server opt-in and verified provider email', () => {
  const attempt = {
    serviceName: 'oidc',
    serviceData: { email: 'person@example.test', emailVerified: true },
  }
  assert.equal(shouldLinkExistingOidcAccount(attempt, {}), false)
  assert.equal(shouldLinkExistingOidcAccount(attempt, {
    TITRA_OIDC_ALLOW_VERIFIED_EMAIL_LINKING: 'TRUE',
  }), false)
  assert.equal(shouldLinkExistingOidcAccount(attempt, {
    TITRA_OIDC_ALLOW_VERIFIED_EMAIL_LINKING: 'true',
  }), true)
  assert.equal(shouldLinkExistingOidcAccount({
    ...attempt, serviceData: { ...attempt.serviceData, emailVerified: false },
  }, { TITRA_OIDC_ALLOW_VERIFIED_EMAIL_LINKING: 'true' }), false)
  assert.equal(shouldLinkExistingOidcAccount({
    ...attempt, serviceData: { ...attempt.serviceData, email: 'invalid' },
  }, { TITRA_OIDC_ALLOW_VERIFIED_EMAIL_LINKING: 'true' }), false)
})

test('OIDC wiring contains no sensitive debug logging or unverified JWT parsing fallback', () => {
  const server = readFileSync(new URL('./oidc_server.js', import.meta.url), 'utf8')
  const client = readFileSync(new URL('./oidc_client.js', import.meta.url), 'utf8')
  const accounts = readFileSync(
    new URL('../../startup/server/useraccounts-configuration.js', import.meta.url), 'utf8',
  )
  const methods = readFileSync(
    new URL('../../api/globalsettings/server/methods.js', import.meta.url), 'utf8',
  )
  for (const source of [server, client]) {
    assert.doesNotMatch(source, /debugLog|console\.(?:debug|info|log|warn|error)/u)
  }
  assert.doesNotMatch(server, /Buffer\.from|\.id_token|tokenContent|getTokenContent/u)
  assert.match(server, /configuration\.userinfoEndpoint/u)
  assert.match(server, /OAuth\.sealSecret/u)
  assert.doesNotMatch(methods, /console\.(?:debug|info|log|warn|error)/u)
  assert.match(accounts, /shouldLinkExistingOidcAccount\(attempt\)/u)
  assert.doesNotMatch(accounts, /serviceName === ['"]oidc['"][\s\S]*findUserByEmail/u)
})
