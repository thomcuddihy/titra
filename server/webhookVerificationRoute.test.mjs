import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
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

const contractsUrl = moduleUrl('./APIv2Contracts.js')
const rateLimitUrl = moduleUrl('./apiRateLimit.js')
const securityUrl = moduleUrl('../imports/api/webhookverification/webhookSecurity.js')
const mappingUrl = moduleUrl('../imports/api/webhookverification/webhookMapping.js')
const bodyUrl = dataModule('export const getBuffer = (...args) => globalThis.__webhookGetBuffer(...args)')
const collectionUrl = dataModule(`export default {
  findOneAsync: (...args) => globalThis.__webhookFindInterface(...args)
}`)
const receiptUrl = dataModule(`export const createWebhookReceiptStore = () => ({
  claim: (...args) => globalThis.__webhookClaim(...args),
  complete: (...args) => globalThis.__webhookComplete(...args),
  fail: (...args) => globalThis.__webhookFail(...args)
})`)
const emptyReceiptCollectionUrl = dataModule('export default {}')
let receiptStoreSource = readFileSync(
  new URL('../imports/api/webhookreceipts/server/store.js', import.meta.url),
  'utf8',
)
receiptStoreSource = receiptStoreSource.replace(
  "'../webhookreceipts.js'", JSON.stringify(emptyReceiptCollectionUrl),
)
const receiptStore = await import(dataModule(receiptStoreSource))
const settingsUrl = dataModule(`export const getGlobalSettingAsync = (...args) => (
  globalThis.__webhookSetting(...args)
)`)

test('generated API documentation describes only the signed endpoint contract', () => {
  const source = readFileSync(new URL('./APIroutes.js', import.meta.url), 'utf8')
  assert.match(source, /@api \{post\} \/user\/action-verification\/webhook\/:endpointId/)
  assert.match(source, /X-Titra-Webhook-Signature/)
  assert.match(source, /HMAC-SHA256/)
  assert.doesNotMatch(source, /DomainNotAllowed|Sender domain not whitelisted/)
})
const meteorUrl = dataModule(`export const Meteor = {
  users: { updateAsync: (...args) => globalThis.Meteor.users.updateAsync(...args) }
}`)
const route = await import(moduleUrl('./webhookVerificationRoute.js', {
  'meteor/meteor': meteorUrl,
  './bodyparser.js': bodyUrl,
  '../imports/api/webhookverification/webhookverification.js': collectionUrl,
  '../imports/api/webhookverification/webhookMapping.js': mappingUrl,
  '../imports/api/webhookverification/webhookSecurity.js': securityUrl,
  '../imports/api/webhookreceipts/server/store.js': receiptUrl,
  '../imports/utils/server_method_helpers.js': settingsUrl,
  './APIv2Contracts.js': contractsUrl,
  './apiRateLimit.js': rateLimitUrl,
}))

const ENDPOINT = '0123456789abcdef0123456789abcdef'
const SECRET = Buffer.alloc(32, 19)
const NOW = new Date('2026-09-01T02:03:04.000Z')
const TIMESTAMP = String(Math.floor(NOW.getTime() / 1000))

function signedHeaders(body, overrides = {}, timestamp = TIMESTAMP) {
  const signature = createHmac('sha256', SECRET)
    .update(Buffer.from(`${timestamp}.`)).update(body).digest('hex')
  return {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
    'x-request-id': 'request_webhook_123',
    'x-titra-webhook-timestamp': timestamp,
    'x-titra-webhook-event-id': 'event-1',
    'x-titra-webhook-signature': `v1=${signature}`,
    ...overrides,
  }
}

function response() {
  return {
    headers: {}, writes: [],
    setHeader(name, value) { this.headers[name] = value },
    writeHead(status, headers) { this.status = status; Object.assign(this.headers, headers) },
    end(body) { this.writes.push(body == null ? undefined : JSON.parse(body)) },
  }
}

function receiptMatches(record, selector) {
  return Object.entries(selector).every(([key, condition]) => {
    if (key === '$or') return condition.some((branch) => receiptMatches(record, branch))
    if (condition && typeof condition === 'object' && !(condition instanceof Date)) {
      if (Object.hasOwn(condition, '$lte')) return record[key] <= condition.$lte
    }
    return record[key] === condition
  })
}

class MemoryReceiptCollection {
  records = []

  async insertAsync(value) {
    if (this.records.some((item) => (
      item.interfaceId === value.interfaceId && item.eventId === value.eventId
    ))) throw Object.assign(new Error('duplicate'), { code: 11000 })
    this.records.push({ _id: `receipt-${this.records.length + 1}`, ...value })
  }

  async findOneAsync(selector) {
    return this.records.find((record) => receiptMatches(record, selector))
  }

  rawCollection() {
    return {
      updateOne: async (selector, modifier) => {
        const record = this.records.find((candidate) => receiptMatches(candidate, selector))
        if (!record) return { matchedCount: 0, modifiedCount: 0 }
        Object.assign(record, modifier.$set)
        Object.entries(modifier.$max || {}).forEach(([key, value]) => {
          if (record[key] == null || record[key] < value) record[key] = value
        })
        Object.keys(modifier.$unset || {}).forEach((key) => delete record[key])
        return { matchedCount: 1, modifiedCount: 1 }
      },
    }
  }
}

function fixture(payload = { type: 'complete', data: { userId: 'user-1' } }) {
  const body = Buffer.from(JSON.stringify(payload))
  const webhookInterface = {
    _id: 'interface-1', endpointId: ENDPOINT, securityVersion: 2, mappingVersion: 1,
    active: true, verificationPeriod: 30,
    mappingRules: [{
      eventPointer: '/type', eventEquals: 'complete',
      userIdPointer: '/data/userId', action: 'complete',
    }],
  }
  const calls = {
    peerLimits: 0, reads: [], claims: [], completes: [], failures: [], applied: [],
  }
  const state = {
    claim: {
      status: 'claimed', leaseToken: 'lease-1',
      eventTimestamp: new Date(Number(TIMESTAMP) * 1000),
    },
    applied: 1,
  }
  const dependencies = {
    consumePeer: () => { calls.peerLimits += 1; return { allowed: true } },
    readRawBody: async (_req, options) => { calls.reads.push(options); return body },
    featureEnabled: async () => true,
    findInterface: async (endpointId) => (endpointId === ENDPOINT ? webhookInterface : undefined),
    resolveSecret: async () => SECRET,
    claimReceipt: async (args) => { calls.claims.push(args); return state.claim },
    completeReceipt: async (args) => { calls.completes.push(args) },
    failReceipt: async (args) => { calls.failures.push(args) },
    applyResult: async (...args) => { calls.applied.push(args); return state.applied },
    now: () => NOW,
  }
  const req = {
    method: 'POST',
    headers: signedHeaders(body),
    _parsedUrl: { pathname: `${route.WEBHOOK_PATH}/${ENDPOINT}` },
  }
  return { body, webhookInterface, calls, state, dependencies, req }
}

test('path and secure selector accept only v6 endpoint identity, never legacy domain fields', () => {
  assert.equal(route.endpointFromPath(`${route.WEBHOOK_PATH}/${ENDPOINT}/`), ENDPOINT)
  for (const path of [route.WEBHOOK_PATH, `${route.WEBHOOK_PATH}/short`, `${route.WEBHOOK_PATH}/${ENDPOINT}/extra`, `${route.WEBHOOK_PATH}/${ENDPOINT.toUpperCase()}`]) {
    assert.equal(route.endpointFromPath(path), undefined)
  }
  assert.deepEqual(route.secureInterfaceSelector(ENDPOINT), {
    endpointId: ENDPOINT, securityVersion: 2, mappingVersion: 1,
    active: true, removedAt: { $exists: false },
  })
  assert.equal(route.webhookConfigurationRevision({}), 0)
  assert.equal(route.webhookConfigurationRevision({ configurationRevision: 7 }), 7)
  assert.throws(
    () => route.webhookConfigurationRevision({ configurationRevision: '7' }),
    /configuration revision/,
  )
})

test('valid signature maps one event, updates associated user and completes receipt', async () => {
  const f = fixture()
  const res = response()
  await route.createWebhookVerificationHandler(f.dependencies)(f.req, res)
  assert.equal(res.status, 202)
  assert.deepEqual(res.writes[0], { apiVersion: 2, payload: { accepted: true } })
  assert.deepEqual(f.calls.reads, [{ limit: '65536b' }])
  assert.equal(f.calls.peerLimits, 1)
  assert.equal(f.calls.claims.length, 1)
  assert.equal(f.calls.claims[0].payloadDigest.length, 64)
  assert.equal(f.calls.claims[0].configurationRevision, 0)
  assert.equal(Object.hasOwn(f.calls.claims[0], 'rawBody'), false)
  assert.deepEqual(f.calls.applied[0].slice(1), [
    { action: 'complete', userId: 'user-1' }, new Date(Number(TIMESTAMP) * 1000), 'event-1',
  ])
  assert.deepEqual(f.calls.completes, [{
    interfaceId: 'interface-1', eventId: 'event-1', leaseToken: 'lease-1', outcome: 'applied',
  }])
  assert.equal(f.calls.failures.length, 0)
})

test('peer rate limiting is terminal before body or database work', async () => {
  const f = fixture()
  f.dependencies.consumePeer = () => ({ allowed: false, retryAfterSeconds: 7 })
  const res = response()
  await route.createWebhookVerificationHandler(f.dependencies)(f.req, res)
  assert.equal(res.status, 429)
  assert.equal(res.headers['Retry-After'], '7')
  assert.equal(res.writes[0].error.code, 'RATE_LIMITED')
  assert.equal(f.calls.reads.length, 0)
  assert.equal(f.calls.claims.length, 0)
  assert.equal(f.calls.applied.length, 0)
})

test('no mapping and no associated user use identical generic response and ignored receipt outcome', async () => {
  for (const mode of ['unmapped', 'unassociated']) {
    const f = mode === 'unmapped' ? fixture({ type: 'other' }) : fixture()
    if (mode === 'unassociated') f.state.applied = 0
    const res = response()
    await route.createWebhookVerificationHandler(f.dependencies)(f.req, res)
    assert.equal(res.status, 202)
    assert.deepEqual(res.writes[0], { apiVersion: 2, payload: { accepted: true } })
    assert.equal(f.calls.completes[0].outcome, 'ignored')
    assert.equal(f.calls.applied.length, mode === 'unmapped' ? 0 : 1)
  }
})

test('processed replay returns the same acceptance without mapping or mutation', async () => {
  const f = fixture()
  f.state.claim = { status: 'processed' }
  const res = response()
  await route.createWebhookVerificationHandler(f.dependencies)(f.req, res)
  assert.equal(res.status, 202)
  assert.deepEqual(res.writes[0], { apiVersion: 2, payload: { accepted: true } })
  assert.equal(f.calls.applied.length + f.calls.completes.length, 0)
})

test('replay conflict and live processing have explicit safe errors', async () => {
  for (const [claim, status, code] of [
    [{ status: 'event_conflict' }, 409, 'WEBHOOK_REPLAY_CONFLICT'],
    [{ status: 'in_progress' }, 503, 'WEBHOOK_PROCESSING'],
  ]) {
    const f = fixture()
    f.state.claim = claim
    const res = response()
    await route.createWebhookVerificationHandler(f.dependencies)(f.req, res)
    assert.equal(res.status, status)
    assert.equal(res.writes[0].error.code, code)
    assert.equal(f.calls.applied.length, 0)
    if (status === 503) assert.equal(res.headers['Retry-After'], '5')
  }
})

test('a claimed receipt without its stored event timestamp fails before mutation', async () => {
  const f = fixture()
  f.state.claim = { status: 'claimed', leaseToken: 'lease-without-time' }
  const res = response()
  await route.createWebhookVerificationHandler(f.dependencies)(f.req, res)
  assert.equal(res.status, 500)
  assert.equal(res.writes[0].error.code, 'INTERNAL_ERROR')
  assert.equal(f.calls.applied.length, 0)
  assert.equal(f.calls.completes.length, 0)
})

test('delayed fresh signature retries through the receipt store with original action time', async () => {
  const f = fixture()
  f.webhookInterface.configurationRevision = 11
  const collection = new MemoryReceiptCollection()
  let clock = new Date(NOW)
  let token = 0
  const store = receiptStore.createWebhookReceiptStore(collection, {
    clock: () => new Date(clock),
    tokenFactory: () => `cross-layer-lease-${++token}`,
  })
  f.dependencies.claimReceipt = (args) => store.claim(args)
  f.dependencies.completeReceipt = (args) => store.complete(args)
  f.dependencies.failReceipt = (args) => store.fail(args)
  f.dependencies.now = () => new Date(clock)
  const actionTimes = []
  let failFirstAction = true
  f.dependencies.applyResult = async (_interface, _result, eventTimestamp) => {
    actionTimes.push(new Date(eventTimestamp))
    if (failFirstAction) {
      failFirstAction = false
      throw new Error('synthetic crash before action')
    }
    return 1
  }
  const handler = route.createWebhookVerificationHandler(f.dependencies)
  const first = response()
  await handler(f.req, first)
  assert.equal(first.status, 500)
  assert.equal(first.writes[0].error.code, 'WRITE_OUTCOME_UNKNOWN')

  clock = new Date(NOW.getTime() + 2000)
  const freshTimestamp = String(Math.floor(clock.getTime() / 1000))
  f.req.headers = signedHeaders(f.body, {}, freshTimestamp)
  const retried = response()
  await handler(f.req, retried)
  assert.equal(retried.status, 202)
  assert.equal(Number(freshTimestamp) - Number(TIMESTAMP), 2)
  assert.deepEqual(actionTimes.map((value) => value.toISOString()), [
    NOW.toISOString(),
    NOW.toISOString(),
  ])
  assert.equal(collection.records.length, 1)
  assert.equal(collection.records[0].configurationRevision, 11)
  assert.equal(collection.records[0].eventTimestamp.toISOString(), NOW.toISOString())
  assert.equal(collection.records[0].status, 'processed')
})

test('configuration change after a failed attempt cannot remap the same event body', async () => {
  const f = fixture()
  f.webhookInterface.configurationRevision = 3
  const collection = new MemoryReceiptCollection()
  let clock = new Date(NOW)
  let token = 0
  const store = receiptStore.createWebhookReceiptStore(collection, {
    clock: () => new Date(clock),
    tokenFactory: () => `configuration-lease-${++token}`,
  })
  f.dependencies.claimReceipt = (args) => store.claim(args)
  f.dependencies.completeReceipt = (args) => store.complete(args)
  f.dependencies.failReceipt = (args) => store.fail(args)
  f.dependencies.now = () => new Date(clock)
  let actionCalls = 0
  f.dependencies.applyResult = async () => {
    actionCalls += 1
    throw new Error('synthetic crash before action')
  }
  const handler = route.createWebhookVerificationHandler(f.dependencies)
  const first = response()
  await handler(f.req, first)
  assert.equal(first.status, 500)
  assert.equal(actionCalls, 1)

  clock = new Date(NOW.getTime() + 2000)
  f.webhookInterface.configurationRevision = 4
  f.webhookInterface.mappingRules = [{
    eventPointer: '/type', eventEquals: 'complete',
    userIdPointer: '/data/userId', action: 'revoke',
  }]
  f.req.headers = signedHeaders(
    f.body, {}, String(Math.floor(clock.getTime() / 1000)),
  )
  const retried = response()
  await handler(f.req, retried)
  assert.equal(retried.status, 409)
  assert.equal(retried.writes[0].error.code, 'WEBHOOK_REPLAY_CONFLICT')
  assert.equal(actionCalls, 1)
  assert.equal(collection.records[0].configurationRevision, 3)
  assert.equal(collection.records[0].status, 'failed')
})

test('legacy/missing interface, disabled feature, missing secret and forged signature fail identically', async () => {
  const variants = [
    (f) => { f.dependencies.findInterface = async () => undefined },
    (f) => { f.dependencies.featureEnabled = async () => false },
    (f) => { f.dependencies.resolveSecret = async () => undefined },
    (f) => { f.req.headers['x-titra-webhook-signature'] = `v1=${'0'.repeat(64)}` },
    (f) => { f.req.headers['x-titra-webhook-event-id'] = ['event-1', 'event-2'] },
    (f) => { f.req.headers['x-titra-webhook-timestamp'] = String(Number(TIMESTAMP) - 301) },
  ]
  for (const alter of variants) {
    const f = fixture()
    alter(f)
    const res = response()
    await route.createWebhookVerificationHandler(f.dependencies)(f.req, res)
    assert.equal(res.status, 401)
    assert.equal(res.writes[0].error.code, 'WEBHOOK_AUTHENTICATION_FAILED')
    assert.equal(f.calls.claims.length, 0)
  }
})

test('Host, X-Forwarded-Host and X-Forwarded-For are ignored for signed authentication', async () => {
  const f = fixture()
  Object.assign(f.req.headers, {
    host: 'attacker.example',
    'x-forwarded-host': 'allowed.example',
    'x-forwarded-for': '203.0.113.66, 127.0.0.1',
  })
  const res = response()
  await route.createWebhookVerificationHandler(f.dependencies)(f.req, res)
  assert.equal(res.status, 202)
  assert.doesNotMatch(JSON.stringify(f.calls), /attacker|allowed|203\.0\.113/)
})

test('strict path, method, media, size and JSON/UTF8 checks are terminal before claims', async () => {
  const variants = [
    [404, (f) => { f.req._parsedUrl.pathname += '/extra' }],
    [405, (f) => { f.req.method = 'GET' }],
    [415, (f) => { f.req.headers['content-type'] = 'text/plain' }],
    [413, (f) => { f.req.headers['content-length'] = '65537' }],
    [413, (f) => { f.dependencies.readRawBody = async () => { throw Object.assign(new Error('large'), { type: 'entity.too.large' }) } }],
    [400, (f) => { f.dependencies.readRawBody = async () => { throw new Error('socket parse error') } }],
    [400, (f) => {
      const value = Buffer.from([0xff])
      f.dependencies.readRawBody = async () => value
      f.req.headers = signedHeaders(value)
    }],
    [400, (f) => {
      const value = Buffer.from('[]')
      f.dependencies.readRawBody = async () => value
      f.req.headers = signedHeaders(value)
    }],
    [413, (f) => { f.dependencies.readRawBody = async () => Buffer.alloc(65537) }],
  ]
  for (const [status, alter] of variants) {
    const f = fixture()
    alter(f)
    const res = response()
    await route.createWebhookVerificationHandler(f.dependencies)(f.req, res)
    assert.equal(res.status, status)
    assert.equal(res.writes.length, 1)
    assert.equal(f.calls.claims.length, 0)
  }
})

test('OPTIONS is bodyless and unauthenticated; wrong methods advertise POST only', async () => {
  for (const [method, status] of [['OPTIONS', 204], ['PUT', 405], ['DELETE', 405]]) {
    const f = fixture()
    let featureCalls = 0
    f.dependencies.featureEnabled = async () => { featureCalls += 1; return true }
    f.req.method = method
    const res = response()
    await route.createWebhookVerificationHandler(f.dependencies)(f.req, res)
    assert.equal(res.status, status)
    assert.equal(res.headers.Allow, 'POST, OPTIONS')
    assert.equal(featureCalls, 0)
    assert.equal(f.calls.reads.length, 0)
    if (status === 204) assert.deepEqual(res.writes, [undefined])
  }
})

test('claim/storage failure is sanitized; mutation or completion uncertainty fences receipt and reports unknown', async () => {
  const claimFailure = fixture()
  claimFailure.dependencies.claimReceipt = async () => { throw new Error('private DB credentials') }
  let res = response()
  await route.createWebhookVerificationHandler(claimFailure.dependencies)(claimFailure.req, res)
  assert.equal(res.status, 500)
  assert.equal(res.writes[0].error.code, 'INTERNAL_ERROR')
  assert.doesNotMatch(JSON.stringify(res.writes), /private|credentials/)

  for (const phase of ['apply', 'complete']) {
    const f = fixture()
    if (phase === 'apply') f.dependencies.applyResult = async () => { throw new Error('private user') }
    else f.dependencies.completeReceipt = async () => { throw new Error('lost acknowledgement') }
    res = response()
    await route.createWebhookVerificationHandler(f.dependencies)(f.req, res)
    assert.equal(res.status, 500)
    assert.equal(res.writes[0].error.code, 'WRITE_OUTCOME_UNKNOWN')
    assert.equal(f.calls.failures.length, 1)
    assert.deepEqual(f.calls.failures[0], {
      interfaceId: 'interface-1', eventId: 'event-1', leaseToken: 'lease-1',
      errorCode: 'WEBHOOK_PROCESSING_FAILED',
    })
  }
})

test('default dependencies force exact Buffer reading and deterministic interface-associated updates', async () => {
  let bufferOptions
  globalThis.__webhookGetBuffer = async (_req, options) => { bufferOptions = options; return Buffer.alloc(0) }
  globalThis.__webhookSetting = async () => true
  globalThis.__webhookFindInterface = async () => undefined
  globalThis.__webhookClaim = async () => undefined
  globalThis.__webhookComplete = async () => undefined
  globalThis.__webhookFail = async () => undefined
  let update
  globalThis.Meteor = {
    users: {
      updateAsync: async (...args) => { update = args; return 1 },
    },
  }
  const defaults = route.createDefaultWebhookDependencies()
  await defaults.readRawBody({}, { limit: '65536b' })
  assert.deepEqual(bufferOptions, { limit: '65536b', encoding: null })
  const eventTime = new Date('2026-09-01T02:03:04Z')
  const webhookInterface = { _id: 'interface-1', verificationPeriod: 30 }
  assert.equal(await defaults.applyResult(
    webhookInterface, { action: 'complete', userId: 'user-1' }, eventTime, 'event-1',
  ), 1)
  assert.deepEqual(update[0], {
    _id: 'user-1',
    'actionVerification.required': true,
    'actionVerification.webhookInterfaceId': 'interface-1',
    ...route.webhookEventOrderSelector('interface-1', eventTime, 'event-1'),
  })
  assert.deepEqual(update[1].$set, {
    'actionVerification.completed': true,
    'actionVerification.completedAt': eventTime,
    ...route.webhookEventMetadata('interface-1', eventTime, 'event-1'),
  })
  await defaults.applyResult(
    webhookInterface, { action: 'revoke', userId: 'user-1' }, eventTime, 'event-2',
  )
  assert.equal(
    update[1].$set['actionVerification.deadline'].getTime(),
    eventTime.getTime() + 30 * 24 * 60 * 60 * 1000,
  )
})

function valueAt(document, path) {
  return path.split('.').reduce((value, key) => value?.[key], document)
}

function equalValue(left, right) {
  return left instanceof Date && right instanceof Date
    ? left.getTime() === right.getTime() : left === right
}

function matchesSelector(document, selector) {
  return Object.entries(selector).every(([key, condition]) => {
    if (key === '$or') return condition.some((branch) => matchesSelector(document, branch))
    if (key === '$and') return condition.every((branch) => matchesSelector(document, branch))
    const value = valueAt(document, key)
    if (condition && typeof condition === 'object' && !(condition instanceof Date)) {
      if (Object.hasOwn(condition, '$exists')) {
        return (value !== undefined) === condition.$exists
      }
      if (Object.hasOwn(condition, '$ne')) return !equalValue(value, condition.$ne)
      if (Object.hasOwn(condition, '$lt')) return value < condition.$lt
      if (Object.hasOwn(condition, '$lte')) return value <= condition.$lte
    }
    return equalValue(value, condition)
  })
}

function setAt(document, path, value) {
  const keys = path.split('.')
  const leaf = keys.pop()
  const target = keys.reduce((current, key) => (current[key] ||= {}), document)
  target[leaf] = value
}

function unsetAt(document, path) {
  const keys = path.split('.')
  const leaf = keys.pop()
  const target = keys.reduce((current, key) => current?.[key], document)
  if (target) delete target[leaf]
}

test('atomic event ordering converges on the newest signed event under concurrency', async () => {
  for (const reverse of [false, true]) {
    const user = {
      _id: 'user-1',
      actionVerification: {
        required: true, webhookInterfaceId: 'interface-1', completed: false,
      },
    }
    globalThis.Meteor.users.updateAsync = async (selector, modifier) => {
      await Promise.resolve()
      if (!matchesSelector(user, selector)) return 0
      Object.entries(modifier.$set || {}).forEach(([path, value]) => setAt(user, path, value))
      Object.keys(modifier.$unset || {}).forEach((path) => unsetAt(user, path))
      return 1
    }
    const defaults = route.createDefaultWebhookDependencies()
    const webhookInterface = { _id: 'interface-1', verificationPeriod: 30 }
    const older = () => defaults.applyResult(
      webhookInterface,
      { action: 'complete', userId: 'user-1' },
      new Date('2026-09-01T02:03:03Z'),
      'event-z',
    )
    const newer = () => defaults.applyResult(
      webhookInterface,
      { action: 'revoke', userId: 'user-1' },
      new Date('2026-09-01T02:03:04Z'),
      'event-a',
    )
    await Promise.all(reverse ? [newer(), older()] : [older(), newer()])
    assert.equal(user.actionVerification.completed, false)
    assert.equal(
      user.actionVerification.webhookEventTimestamp.toISOString(),
      '2026-09-01T02:03:04.000Z',
    )
    assert.equal(user.actionVerification.webhookEventId, 'event-a')
    assert.equal(await defaults.applyResult(
      webhookInterface,
      { action: 'revoke', userId: 'user-1' },
      new Date('2026-09-01T02:03:04Z'),
      'event-a',
    ), 1)
  }

  const sameSecond = {
    _id: 'user-1',
    actionVerification: { required: true, webhookInterfaceId: 'interface-1' },
  }
  globalThis.Meteor.users.updateAsync = async (selector, modifier) => {
    await Promise.resolve()
    if (!matchesSelector(sameSecond, selector)) return 0
    Object.entries(modifier.$set || {}).forEach(([path, value]) => setAt(sameSecond, path, value))
    Object.keys(modifier.$unset || {}).forEach((path) => unsetAt(sameSecond, path))
    return 1
  }
  const defaults = route.createDefaultWebhookDependencies()
  const webhookInterface = { _id: 'interface-1', verificationPeriod: 30 }
  const eventTime = new Date('2026-09-01T02:03:04Z')
  await Promise.all([
    defaults.applyResult(
      webhookInterface, { action: 'complete', userId: 'user-1' }, eventTime, 'event-a',
    ),
    defaults.applyResult(
      webhookInterface, { action: 'revoke', userId: 'user-1' }, eventTime, 'event-b',
    ),
  ])
  assert.equal(sameSecond.actionVerification.completed, false)
  assert.equal(sameSecond.actionVerification.webhookEventId, 'event-b')
})

test('raw JSON parser preserves exact values and rejects invalid Unicode, arrays and scalars', () => {
  assert.deepEqual(route.parseJSONBody(Buffer.from('{"x":"🧬"}')), { x: '🧬' })
  for (const body of [Buffer.from([0xff]), Buffer.from('[]'), Buffer.from('null'), Buffer.from('"x"')]) {
    assert.throws(() => route.parseJSONBody(body))
  }
})
