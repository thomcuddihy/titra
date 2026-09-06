import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

function dataModule(source) {
  return `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
}

function moduleUrl(path, replacements = {}) {
  let source = readFileSync(new URL(path, import.meta.url), 'utf8')
  Object.entries(replacements).forEach(([from, to]) => {
    source = source.replaceAll(`'${from}'`, JSON.stringify(to))
  })
  return dataModule(source)
}

const checkUrl = dataModule(`
export const check = (value, type) => {
  if (type === String && typeof value !== 'string') throw new TypeError('String required')
  if (type === Boolean && typeof value !== 'boolean') throw new TypeError('Boolean required')
  if (type === Number && typeof value !== 'number') throw new TypeError('Number required')
  if (type === Object && (!value || typeof value !== 'object')) throw new TypeError('Object required')
}`)
const validatedUrl = dataModule(`export class ValidatedMethod {
  constructor(options) { Object.assign(this, options) }
}`)
const helpersUrl = dataModule(`
export const adminAuthenticationMixin = {}
export const authenticationMixin = {}
export const transactionLogMixin = {}
`)
const collectionUrl = dataModule(`export default {
  insertAsync: (...args) => globalThis.__methodCollection.insertAsync(...args),
  findOneAsync: (...args) => globalThis.__methodCollection.findOneAsync(...args),
  find: (...args) => globalThis.__methodCollection.find(...args),
  updateAsync: (...args) => globalThis.__methodCollection.updateAsync(...args),
}`)
const mappingUrl = moduleUrl('../webhookMapping.js')
const securityUrl = moduleUrl('../webhookSecurity.js')
globalThis.Meteor = {
  Error: class extends Error {
    constructor(code, reason) { super(reason); this.error = code; this.reason = reason }
  },
  users: undefined,
}
const methods = await import(moduleUrl('./methods.js', {
  'meteor/check': checkUrl,
  'meteor/mdg:validated-method': validatedUrl,
  '../../../utils/server_method_helpers': helpersUrl,
  '../webhookverification.js': collectionUrl,
  '../webhookMapping.js': mappingUrl,
  '../webhookSecurity.js': securityUrl,
}))

const rules = [{
  eventPointer: '/type', eventEquals: 'complete',
  userIdPointer: '/user/id', action: 'complete',
}]

const configuration = {
  name: 'Provider',
  description: 'Secure provider mapping',
  verificationPeriod: 30,
  serviceUrl: 'https://provider.example/verify',
  urlParam: 'client_reference_id',
  verificationType: 'subscription',
  mappingRules: rules,
  active: false,
}

class Collection {
  records = []

  async insertAsync(value) {
    this.records.push({ _id: `interface-${this.records.length + 1}`, ...value })
    return this.records.at(-1)._id
  }

  async findOneAsync(selector) {
    return this.records.find((record) => Object.entries(selector).every(([key, value]) => (
      value && typeof value === 'object' && Object.hasOwn(value, '$exists')
        ? Object.hasOwn(record, key) === value.$exists
        : record[key] === value
    )))
  }

  find(selector, options) {
    const records = this.records.filter((record) => Object.entries(selector).every(([key, value]) => (
      value && typeof value === 'object' && Object.hasOwn(value, '$exists')
        ? Object.hasOwn(record, key) === value.$exists
        : record[key] === value
    )))
    return { fetchAsync: async () => records.map((record) => {
      if (!options?.fields) return structuredClone(record)
      return Object.fromEntries(Object.entries(record).filter(([key]) => (
        key === '_id' || options.fields[key] === 1
      )))
    }) }
  }

  async updateAsync(selector, modifier) {
    const record = this.records.find((candidate) => Object.entries(selector).every(([key, value]) => (
      value && typeof value === 'object' && Object.hasOwn(value, '$exists')
        ? Object.hasOwn(candidate, key) === value.$exists
        : candidate[key] === value
    )))
    if (!record) return 0
    Object.assign(record, structuredClone(modifier.$set))
    Object.entries(modifier.$inc || {}).forEach(([key, value]) => {
      record[key] = (record[key] ?? 0) + value
    })
    Object.keys(modifier.$unset || {}).forEach((key) => delete record[key])
    return 1
  }
}

function setup(referenceCount = 0) {
  const collection = new Collection()
  globalThis.__methodCollection = collection
  globalThis.Meteor.users = {
    find: () => ({ countAsync: async () => referenceCount }),
    findOneAsync: async () => undefined,
  }
  return collection
}

test('configuration is exact, bounded, declarative and rejects hidden fields/nonfinite rules', () => {
  assert.deepEqual(methods.validateConfiguration(configuration), configuration)
  const invalid = [
    { ...configuration, secret: 'plaintext' },
    { ...configuration, allowedDomains: 'attacker.example' },
    { ...configuration, processData: 'return process.env' },
    { ...configuration, verificationPeriod: 0 },
    { ...configuration, verificationPeriod: 1.5 },
    { ...configuration, serviceUrl: 'http://provider.example' },
    { ...configuration, serviceUrl: 'https://user:pass@provider.example' },
    { ...configuration, urlParam: '../bad' },
    { ...configuration, mappingRules: [{ ...rules[0], eventEquals: Infinity }] },
    { ...configuration, mappingRules: [{ ...rules[0], eventEquals: 'x'.repeat(513) }] },
    { ...configuration, mappingRules: [{ ...rules[0], eventEquals: '\ud800' }] },
  ]
  invalid.forEach((value) => assert.throws(
    () => methods.validateConfiguration(value),
    (error) => error.error === 'webhook-invalid-configuration'
      || /mapping/.test(error.message),
  ))
})

test('insert creates only v6 metadata, never secret/script/domain fields, and begins inactive', async () => {
  const collection = setup()
  const result = await methods.webhookverificationinsert.run(configuration)
  assert.match(result.endpointId, /^[0-9a-f]{32}$/)
  assert.equal(result.active, false)
  assert.equal(result.configurationRevision, 0)
  assert.equal(result.secretEnvironmentVariable, `TITRA_WEBHOOK_SECRET_${result.endpointId.toUpperCase()}`)
  assert.deepEqual(collection.records[0].mappingRules, rules)
  assert.equal(collection.records[0].securityVersion, 2)
  assert.equal(collection.records[0].mappingVersion, 1)
  assert.equal(collection.records[0].configurationRevision, 0)
  for (const field of ['secret', 'allowedDomains', 'processData']) {
    assert.equal(Object.hasOwn(collection.records[0], field), false)
  }
})

test('active insert is refused before persistence because endpoint secret cannot exist yet', async () => {
  const collection = setup()
  await assert.rejects(
    methods.webhookverificationinsert.run({ ...configuration, active: true }),
    (error) => error.error === 'webhook-activation-requires-provisioning',
  )
  assert.equal(collection.records.length, 0)
})

test('legacy document remains fail-closed until explicit remap, which strips script/domain and stays inactive', async () => {
  const collection = setup()
  collection.records.push({
    _id: 'legacy-1', name: 'Legacy', active: true,
    allowedDomains: 'spoofable.example', processData: 'return process.env',
  })
  assert.deepEqual(methods.publicConfigurationStatus(collection.records[0]), {
    _id: 'legacy-1', endpointId: null, secretEnvironmentVariable: null,
    secureConfiguration: false, secretConfigured: false,
    active: true, operational: false, legacy: true,
  })
  const result = await methods.webhookverificationupdate.run({
    _id: 'legacy-1', expectedRevision: 0, ...configuration,
  })
  assert.match(result.endpointId, /^[0-9a-f]{32}$/)
  assert.equal(collection.records[0].active, false)
  assert.equal(Object.hasOwn(collection.records[0], 'allowedDomains'), false)
  assert.equal(Object.hasOwn(collection.records[0], 'processData'), false)
})

test('corrupt v2 endpoint identity is fail-closed and remapped like legacy data', async () => {
  const collection = setup()
  collection.records.push({
    _id: 'corrupt-1', name: 'Corrupt', active: true,
    endpointId: 'not-an-endpoint', securityVersion: 2, mappingVersion: 1,
  })
  assert.equal(methods.publicConfigurationStatus(collection.records[0]).operational, false)
  assert.equal(methods.publicConfigurationStatus(collection.records[0]).legacy, true)
  const result = await methods.webhookverificationupdate.run({
    _id: 'corrupt-1', expectedRevision: 0, ...configuration,
  })
  assert.match(result.endpointId, /^[0-9a-f]{32}$/)
  assert.equal(result.active, false)
})

test('admin update uses a revision compare-and-swap and rejects stale form saves', async () => {
  const collection = setup()
  const created = await methods.webhookverificationinsert.run(configuration)
  const first = await methods.webhookverificationupdate.run({
    _id: created._id,
    expectedRevision: 0,
    ...configuration,
    description: 'First administrator update',
  })
  assert.equal(first.configurationRevision, 1)
  assert.equal(collection.records[0].configurationRevision, 1)
  await assert.rejects(methods.webhookverificationupdate.run({
    _id: created._id,
    expectedRevision: 0,
    ...configuration,
    description: 'Stale administrator overwrite',
  }), (error) => error.error === 'webhook-write-conflict')
  assert.equal(collection.records[0].description, 'First administrator update')
  assert.equal(collection.records[0].configurationRevision, 1)
})

test('activation requires canonical environment secret and never stores it', async () => {
  const collection = setup()
  const created = await methods.webhookverificationinsert.run(configuration)
  const variable = created.secretEnvironmentVariable
  try {
    await assert.rejects(methods.webhookverificationupdate.run({
      _id: created._id, expectedRevision: 0, ...configuration, active: true,
    }), (error) => error.error === 'webhook-secret-not-configured')
    process.env[variable] = Buffer.alloc(32, 5).toString('base64url')
    await methods.webhookverificationupdate.run({
      _id: created._id, expectedRevision: 0, ...configuration, active: true,
    })
    assert.equal(collection.records[0].active, true)
    assert.equal(JSON.stringify(collection.records[0]).includes(process.env[variable]), false)
  } finally {
    delete process.env[variable]
  }
})

test('status reports legacy/security/secret and user-reference readiness without exposing values', async () => {
  const collection = setup(3)
  const created = await methods.webhookverificationinsert.run(configuration)
  process.env[created.secretEnvironmentVariable] = Buffer.alloc(32, 9).toString('base64url')
  try {
    const [status] = await methods.webhookverificationstatus.run()
    assert.equal(status.referencedUsers, 3)
    assert.equal(status.secretConfigured, true)
    assert.equal(status.operational, false)
    assert.doesNotMatch(JSON.stringify(status), new RegExp(process.env[created.secretEnvironmentVariable]))
  } finally {
    delete process.env[created.secretEnvironmentVariable]
  }
  assert.equal(collection.records.length, 1)
})

test('soft removal reports references, requires explicit acknowledgement and retains endpoint audit identity', async () => {
  const collection = setup(2)
  const created = await methods.webhookverificationinsert.run(configuration)
  await assert.rejects(methods.webhookverificationremove.run({
    _id: created._id, acknowledgeReferencedUsers: false,
  }), (error) => error.error === 'webhook-interface-referenced' && /2 user/.test(error.reason))
  assert.equal(Object.hasOwn(collection.records[0], 'removedAt'), false)
  assert.deepEqual(await methods.webhookverificationremove.run({
    _id: created._id, acknowledgeReferencedUsers: true,
  }), { _id: created._id, removed: true, referencedUsers: 2 })
  assert.equal(collection.records[0].active, false)
  assert.equal(collection.records[0].endpointId, created.endpointId)
  assert.ok(collection.records[0].removedAt instanceof Date)
})

test('ordinary-user method publishes minimal active display fields and no processing method exists', async () => {
  const collection = setup()
  const created = await methods.webhookverificationinsert.run(configuration)
  collection.records[0].active = true
  collection.records.push({
    _id: 'legacy-active', name: 'Legacy', verificationType: 'legacy', active: true,
  })
  const result = await methods.getWebhookVerification.run()
  assert.deepEqual(result, [{ _id: created._id, name: 'Provider', verificationType: 'subscription' }])
  assert.equal(Object.hasOwn(methods, 'processWebhookVerification'), false)
})

test('default type resolves only the signed-in user associated secure mapping', async () => {
  const collection = setup()
  const created = await methods.webhookverificationinsert.run(configuration)
  collection.records[0].active = true
  globalThis.Meteor.users.findOneAsync = async () => ({
    _id: 'user-1',
    actionVerification: { required: true, webhookInterfaceId: created._id },
  })
  assert.equal(await methods.getDefaultVerificationType.run.call({ userId: 'user-1' }), 'subscription')
  collection.records[0].mappingVersion = 0
  assert.equal(await methods.getDefaultVerificationType.run.call({ userId: 'user-1' }), '')
})
