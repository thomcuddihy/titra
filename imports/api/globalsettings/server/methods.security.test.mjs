import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

function dataModule(source) {
  return `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
}

class FakeSettings {
  constructor(documents) {
    this.documents = new Map(documents.map((document) => [document._id, { ...document }]))
    this.updates = []
  }

  async findOneAsync(selector) {
    return [...this.documents.values()].find((document) => document.name === selector.name)
  }

  async updateAsync(selector, modifier) {
    this.updates.push({ selector: { ...selector }, modifier: structuredClone(modifier) })
    const document = this.documents.get(selector._id)
    if (document) Object.assign(document, modifier.$set)
  }
}

class FakeServiceConfigurations {
  constructor() {
    this.document = undefined
    this.upserts = []
  }

  async findOneAsync() {
    return this.document ? structuredClone(this.document) : undefined
  }

  async upsertAsync(selector, modifier) {
    this.upserts.push({ selector: structuredClone(selector), modifier: structuredClone(modifier) })
    this.document = { ...(this.document || {}), ...modifier.$set }
    for (const key of Object.keys(modifier.$unset || {})) delete this.document[key]
  }
}

const settings = new FakeSettings([
  { _id: 'public', name: 'unit', type: 'text', value: 'hours' },
  {
    _id: 'known', name: 'google_clientid', type: 'text', restricted: false,
    value: 'stored-google-value',
  },
  {
    _id: 'future', name: 'futureCredential', type: 'password',
    value: 'stored-future-value',
  },
  {
    _id: 'google-secret', name: 'google_secret', type: 'password', restricted: true,
    value: 'legacy-google-secret',
  },
  {
    _id: 'openai-secret', name: 'openai_apikey', type: 'password', restricted: true,
    value: 'legacy-openai-key',
  },
])
globalThis.__globalSettingsMethodCollection = settings
globalThis.__oidcServiceConfigurations = new FakeServiceConfigurations()
globalThis.__oidcRegistered = false
globalThis.check = () => {}
globalThis.Match = { OneOf: (...values) => values }
globalThis.Meteor = {
  Error: class MeteorError extends Error {
    constructor(error, reason) {
      super(reason)
      this.error = error
      this.reason = reason
    }
  },
}
globalThis.Accounts = {
  oauth: { serviceNames: () => (globalThis.__oidcRegistered ? ['oidc'] : []) },
}

const validatedMethodModule = dataModule(`
  export class ValidatedMethod {
    constructor(options) {
      this.name = options.name
      this.validate = options.validate
      this.run = options.run
    }
  }
`)
const oauthModule = dataModule(`
  export const OAuth = { sealSecret(value) { return { sealed: value } } }
`)
const serviceConfigurationModule = dataModule(`
  export const ServiceConfiguration = {
    configurations: globalThis.__oidcServiceConfigurations,
  }
`)
const settingsModule = dataModule(`
  export const defaultSettings = []
  export const Globalsettings = globalThis.__globalSettingsMethodCollection
`)
const mixinsModule = dataModule(`
  export const adminAuthenticationMixin = (options) => options
  export const transactionLogMixin = (options) => options
`)
const oidcModule = dataModule(`
  export async function registerOidc() { globalThis.__oidcRegistered = true }
`)
const sandboxModule = dataModule('export function validateSandboxCode() {}')
const legacyScriptPolicyModule = dataModule(`
  export function isLiteralTimeEntryRule(value) {
    return value === 'return true;' || value === 'return false;'
  }
  export function unsafeLegacyScriptsEnabled() { return false }
`)
const oauthEncryptionPolicyModule = dataModule(`
  export function requireOAuthEncryptionConfigured() {
    return 'MDEyMzQ1Njc4OWFiY2RlZg=='
  }
`)
const securityModule = new URL('../globalSettingSecurity.js', import.meta.url).href
const oidcSecurityModule = new URL('../../../utils/oidc/oidcSecurity.js', import.meta.url).href

let source = readFileSync(new URL('./methods.js', import.meta.url), 'utf8')
for (const [specifier, replacement] of Object.entries({
  'meteor/mdg:validated-method': validatedMethodModule,
  'meteor/oauth': oauthModule,
  'meteor/service-configuration': serviceConfigurationModule,
  '../globalsettings.js': settingsModule,
  '../../../utils/server_method_helpers.js': mixinsModule,
  '../../../utils/oidc/oidc_server.js': oidcModule,
  '../../../utils/vm_sandbox.js': sandboxModule,
  '../../../utils/legacyScriptPolicy.js': legacyScriptPolicyModule,
  '../globalSettingSecurity.js': securityModule,
  '../../../utils/oidc/oidcSecurity.js': oidcSecurityModule,
  '../../../utils/oauthEncryptionPolicy.js': oauthEncryptionPolicyModule,
})) source = source.replaceAll(`'${specifier}'`, JSON.stringify(replacement))

const methods = await import(dataModule(source))

test('blank secret placeholders preserve stored values and explicit replacements update them', async () => {
  await methods.updateGlobalSettings.run([
    { name: 'google_clientid', value: '   ' },
    { name: 'futureCredential', value: '' },
  ])
  assert.equal(settings.updates.length, 0)
  assert.equal(settings.documents.get('known').value, 'stored-google-value')
  assert.equal(settings.documents.get('future').value, 'stored-future-value')

  await methods.updateGlobalSettings.run([
    { name: 'google_clientid', value: 'replacement-google-value' },
    { name: 'futureCredential', value: 'replacement-future-value' },
  ])
  assert.equal(settings.documents.get('known').value, 'replacement-google-value')
  assert.equal(settings.documents.get('future').value, 'replacement-future-value')
})

test('public settings retain ordinary blank-update behavior and unknown names remain no-ops', async () => {
  settings.updates.length = 0
  await methods.updateGlobalSettings.run([
    { name: 'unit', value: '' },
    { name: 'unknown', value: 'ignored' },
  ])
  assert.equal(settings.documents.get('public').value, '')
  assert.deepEqual(settings.updates, [{
    selector: { _id: 'public' }, modifier: { $set: { value: '' } },
  }])
})

test('known bearer and client secrets are sealed on replacement', async () => {
  settings.updates.length = 0
  await methods.updateGlobalSettings.run([
    { name: 'google_secret', value: 'replacement-google-secret' },
    { name: 'openai_apikey', value: 'replacement-openai-key' },
  ])
  assert.deepEqual(settings.documents.get('google-secret').value, {
    sealed: 'replacement-google-secret',
  })
  assert.deepEqual(settings.documents.get('openai-secret').value, {
    sealed: 'replacement-openai-key',
  })
})

test('client-provided setting metadata cannot turn a public value into a preserved secret', async () => {
  settings.updates.length = 0
  await methods.updateGlobalSettings.run([{
    name: 'unit', value: 'days', restricted: true, type: 'password',
  }])
  assert.equal(settings.documents.get('public').value, 'days')
  assert.equal(settings.updates.length, 1)
})

test('custom executable time-entry rules are rejected when unsafe compatibility is off', async () => {
  await assert.rejects(
    methods.updateGlobalSettings.run([{ name: 'timeEntryRule', value: 'return user.isAdmin;' }]),
    (error) => error.error === 'unsafe-legacy-script-disabled',
  )
  await assert.doesNotReject(
    methods.updateGlobalSettings.run([{ name: 'timeEntryRule', value: 'return true;' }]),
  )
  await assert.doesNotReject(
    methods.updateGlobalSettings.run([{ name: 'timeEntryRule', value: 'return false;' }]),
  )
})

function oidcConfiguration(overrides = {}) {
  return {
    service: 'oidc',
    disableDefaultLoginForm: false,
    autoInitiateLogin: false,
    clientId: 'titra-client',
    secret: 'new-client-secret',
    serverUrl: 'https://identity.example.test/realm',
    authorizationEndpoint: '/authorize',
    tokenEndpoint: '/token',
    userinfoEndpoint: '/userinfo',
    idTokenWhitelistFields: ['groups'],
    requestPermissions: 'openid,profile,email',
    loginStyle: 'redirect',
    ...overrides,
  }
}

test('OIDC settings are exact, normalized, atomically saved, and new secrets are sealed', async () => {
  const collection = globalThis.__oidcServiceConfigurations
  collection.document = undefined
  collection.upserts.length = 0
  globalThis.__oidcRegistered = false

  await methods.updateOidcSettings.run({ configuration: oidcConfiguration() })

  assert.equal(collection.upserts.length, 1)
  assert.deepEqual(collection.upserts[0].selector, { service: 'oidc' })
  assert.deepEqual(collection.document.secret, { sealed: 'new-client-secret' })
  assert.equal(
    collection.document.authorizationEndpoint,
    'https://identity.example.test/realm/authorize',
  )
  assert.equal(collection.document.tokenEndpoint, 'https://identity.example.test/realm/token')
  assert.equal(collection.document.userinfoEndpoint, 'https://identity.example.test/realm/userinfo')
  assert.equal(collection.document.requestPermissions, 'openid,profile,email')
  assert.equal(globalThis.__oidcRegistered, true)
})

test('blank OIDC secret placeholder preserves the sealed stored secret', async () => {
  const collection = globalThis.__oidcServiceConfigurations
  const storedSecret = collection.document.secret
  await methods.updateOidcSettings.run({
    configuration: oidcConfiguration({ secret: '   ', loginStyle: 'popup' }),
  })
  assert.deepEqual(collection.document.secret, storedSecret)
  assert.equal(collection.document.loginStyle, 'popup')
})

test('invalid, incomplete, insecure, and extended OIDC settings fail closed before storage', async () => {
  const collection = globalThis.__oidcServiceConfigurations
  const priorUpserts = collection.upserts.length
  const configurations = [
    oidcConfiguration({ arbitraryServerField: 'value' }),
    oidcConfiguration({ tokenEndpoint: 'http://identity.example.test/token' }),
    oidcConfiguration({ userinfoEndpoint: '' }),
    oidcConfiguration({ idTokenWhitelistFields: ['accessToken'] }),
  ]
  for (const configuration of configurations) {
    await assert.rejects(
      methods.updateOidcSettings.run({ configuration }),
      (error) => error.error === 'invalid-oidc-configuration'
        && !error.reason.includes('identity.example.test'),
    )
  }
  assert.equal(collection.upserts.length, priorUpserts)
})
