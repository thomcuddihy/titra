import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

function dataModule(source) {
  return `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
}

globalThis.__oidcConfiguration = {
  _id: 'configuration-id',
  service: 'oidc',
  disableDefaultLoginForm: false,
  autoInitiateLogin: false,
  clientId: 'titra-client',
  secret: 'sealed:client-secret',
  serverUrl: 'https://identity.example.test',
  authorizationEndpoint: '/authorize',
  tokenEndpoint: '/token',
  userinfoEndpoint: '/userinfo',
  idTokenWhitelistFields: ['groups'],
  requestPermissions: 'openid,profile,email',
  loginStyle: 'redirect',
}
globalThis.__oidcCallback = undefined
globalThis.__oidcFetch = undefined
globalThis.Accounts = { oauth: { registerService() {} } }

const fetchModule = dataModule(`
  export const fetch = (...args) => globalThis.__oidcFetch(...args)
`)
const meteorModule = dataModule(`
  export const Meteor = {
    release: 'TEST',
    Error: class MeteorError extends Error {
      constructor(error, reason) {
        super(reason)
        this.error = error
        this.reason = reason
      }
    },
  }
`)
const oauthModule = dataModule(`
  export const OAuth = {
    openSecret(value) { return value.replace(/^sealed:/, '') },
    sealSecret(value) { return { sealed: value } },
    _redirectUri() { return 'https://titra.example.test/_oauth/oidc' },
    registerService(name, version, urls, callback) {
      globalThis.__oidcCallback = callback
    },
  }
`)
const configurationModule = dataModule(`
  export class ConfigError extends Error {}
  export const ServiceConfiguration = {
    ConfigError,
    configurations: {
      async findOneAsync() { return structuredClone(globalThis.__oidcConfiguration) },
    },
  }
`)
const securityModule = new URL('./oidcSecurity.js', import.meta.url).href

let source = readFileSync(new URL('./oidc_server.js', import.meta.url), 'utf8')
for (const [specifier, replacement] of Object.entries({
  'meteor/fetch': fetchModule,
  'meteor/meteor': meteorModule,
  'meteor/oauth': oauthModule,
  'meteor/service-configuration': configurationModule,
  './oidcSecurity.js': securityModule,
})) source = source.replaceAll(`'${specifier}'`, JSON.stringify(replacement))

const { registerOidc } = await import(dataModule(source))

function response(body, { status = 200, contentType = 'application/json' } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': contentType },
  })
}

test('server exchanges code then uses userinfo identity and seals both credentials', async () => {
  const requests = []
  globalThis.__oidcFetch = async (url, options) => {
    requests.push({ url, options })
    if (url.endsWith('/token')) {
      return response({
        access_token: 'access-token',
        refresh_token: 'refresh-token',
        expires_in: 3600,
        token_type: 'Bearer',
        // This deliberately unverified payload must never become identity data.
        id_token: 'header.unverified-payload.signature',
      })
    }
    return response({
      sub: 'stable-subject',
      email: 'person@example.test',
      email_verified: true,
      name: 'Example Person',
      groups: ['staff'],
    })
  }

  await registerOidc()
  const result = await globalThis.__oidcCallback({
    code: 'authorization-code', state: 'opaque-state-not-forwarded',
  })

  assert.equal(requests.length, 2)
  assert.equal(requests[0].url, 'https://identity.example.test/token')
  assert.equal(requests[0].options.body.get('code'), 'authorization-code')
  assert.equal(requests[0].options.body.get('client_secret'), 'client-secret')
  assert.equal(requests[0].options.body.has('state'), false)
  assert.equal(requests[1].url, 'https://identity.example.test/userinfo')
  assert.equal(requests[1].options.headers.Authorization, 'Bearer access-token')
  assert.deepEqual(result, {
    serviceData: {
      id: 'stable-subject',
      username: 'person@example.test',
      accessToken: { sealed: 'access-token' },
      email: 'person@example.test',
      expiresAt: result.serviceData.expiresAt,
      refreshToken: { sealed: 'refresh-token' },
      emailVerified: true,
      groups: ['staff'],
    },
    options: {
      profile: { name: 'Example Person' },
      emails: [{ address: 'person@example.test', verified: true }],
    },
  })
  assert.equal(Number.isSafeInteger(result.serviceData.expiresAt), true)
})

test('provider and validation failures expose one fixed public error', async () => {
  for (const providerResponse of [
    response({ error: 'sensitive-provider-detail' }),
    response({ access_token: 'access-token' }, { contentType: 'text/html' }),
  ]) {
    globalThis.__oidcFetch = async () => providerResponse.clone()
    await assert.rejects(
      () => globalThis.__oidcCallback({ code: 'authorization-code' }),
      (error) => error.error === 'oidc-authentication-failed'
        && error.reason === 'OpenID Connect authentication could not be completed.'
        && !JSON.stringify(error).includes('sensitive-provider-detail'),
    )
  }
})
