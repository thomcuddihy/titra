import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

function dataModule(source) {
  return `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
}

function matchesCondition(actual, expected) {
  if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
    if (Object.hasOwn(expected, '$exists')) {
      return (actual !== undefined) === expected.$exists
    }
    if (Object.hasOwn(expected, '$regex')) {
      return new RegExp(expected.$regex, expected.$options || '').test(String(actual || ''))
    }
  }
  return actual === expected
}

function matches(document, selector = {}) {
  return Object.entries(selector).every(([field, expected]) => {
    if (field === '$or') return expected.some((part) => matches(document, part))
    return matchesCondition(document?.[field], expected)
  })
}

function projected(document, fields = {}) {
  const result = { _id: document._id }
  Object.entries(fields).forEach(([field, include]) => {
    if (include && Object.hasOwn(document, field)) result[field] = structuredClone(document[field])
  })
  return result
}

function fieldChanges(previous, current) {
  const result = {}
  new Set([...Object.keys(previous), ...Object.keys(current)]).forEach((field) => {
    if (field === '_id') return
    if (!Object.hasOwn(current, field)) result[field] = undefined
    else if (JSON.stringify(previous[field]) !== JSON.stringify(current[field])) {
      result[field] = structuredClone(current[field])
    }
  })
  return result
}

class FakeCollection {
  constructor(documents = []) {
    this.documents = new Map(documents.map((document) => [document._id, { ...document }]))
    this.observers = new Set()
    this.findCalls = []
  }

  document(id) { return this.documents.get(id) }

  selectedDocuments(selector, options) {
    let selected = [...this.documents.values()].filter((document) => matches(document, selector))
    const sort = Object.entries(options.sort || {})[0]
    if (sort) {
      const [field, direction] = sort
      selected.sort((left, right) => direction * (
        left[field] < right[field] ? -1 : left[field] > right[field] ? 1 : 0
      ))
    }
    if (options.limit) selected = selected.slice(0, options.limit)
    return new Map(selected.map((document) => [
      document._id, projected(document, options.fields),
    ]))
  }

  find(selector = {}, options = {}) {
    this.findCalls.push({ selector: structuredClone(selector), options: structuredClone(options) })
    const collection = this
    return {
      async observeChangesAsync(callbacks) {
        const observer = { selector, options, callbacks, snapshot: new Map() }
        collection.observers.add(observer)
        collection.reconcileObserver(observer)
        return { stop: () => collection.observers.delete(observer) }
      },
    }
  }

  reconcileObserver(observer) {
    const next = this.selectedDocuments(observer.selector, observer.options)
    observer.snapshot.forEach((_document, id) => {
      if (!next.has(id)) observer.callbacks.removed?.(id)
    })
    next.forEach((document, id) => {
      const fields = { ...document }
      delete fields._id
      if (!observer.snapshot.has(id)) observer.callbacks.added?.(id, fields)
      else {
        const changed = fieldChanges(observer.snapshot.get(id), document)
        if (Object.keys(changed).length) observer.callbacks.changed?.(id, changed)
      }
    })
    observer.snapshot = next
  }

  replace(document) {
    this.documents.set(document._id, { ...document })
    this.observers.forEach((observer) => this.reconcileObserver(observer))
  }
}

function publicationContext(userId) {
  const documents = new Map()
  const stopCallbacks = []
  return {
    userId,
    documents,
    added(collection, id, fields) {
      documents.set(`${collection}:${id}`, { _id: id, ...structuredClone(fields) })
    },
    changed(collection, id, fields) {
      const document = documents.get(`${collection}:${id}`)
      Object.entries(fields).forEach(([field, value]) => {
        if (value === undefined) delete document[field]
        else document[field] = structuredClone(value)
      })
    },
    removed(collection, id) { documents.delete(`${collection}:${id}`) },
    onStop(callback) { stopCallbacks.push(callback) },
    ready() { this.isReady = true },
    stop() { stopCallbacks.forEach((callback) => callback()) },
  }
}

const users = new FakeCollection()
const globalSettings = new FakeCollection()
const transactions = new FakeCollection()
const migrations = new FakeCollection()
const webhookVerification = new FakeCollection()
const publications = new Map()

globalThis.__adminSensitiveUsers = users
globalThis.__adminSensitiveGlobalSettings = globalSettings
globalThis.__adminSensitiveTransactions = transactions
globalThis.__adminSensitiveMigrations = migrations
globalThis.__adminSensitiveWebhookVerification = webhookVerification
globalThis.Meteor = {
  users,
  publish(name, handler) { publications.set(name, handler) },
}

const meteorModule = dataModule('export const Meteor = globalThis.Meteor')
const checkModule = dataModule(`
  export function check() {}
  export const Match = { Maybe: (value) => value, Optional: (value) => value }
`)
const authenticationModule = dataModule(`
  export async function checkAdminAuthentication(context) {
    const user = globalThis.__adminSensitiveUsers.document(context.userId)
    if (!user || user.inactive === true || user.isAdmin !== true) throw new Error('not-admin')
  }
`)
const helperModule = new URL('./adminCollectionPublication.js', import.meta.url).href
const globalSecurityModule = new URL(
  '../api/globalsettings/globalSettingSecurity.js', import.meta.url,
).href

async function loadPublication(path, replacements) {
  let source = readFileSync(new URL(path, import.meta.url), 'utf8')
  Object.entries(replacements).forEach(([specifier, replacement]) => {
    source = source.replaceAll(`'${specifier}'`, JSON.stringify(replacement))
  })
  return import(dataModule(source))
}

await loadPublication('../api/globalsettings/server/publications.js', {
  '../globalsettings.js': dataModule(
    'export const Globalsettings = globalThis.__adminSensitiveGlobalSettings',
  ),
  '../globalSettingSecurity.js': globalSecurityModule,
  '../../../utils/adminCollectionPublication.js': helperModule,
})
const transactionPublicationModule = await loadPublication(
  '../api/transactions/server/publications.js', {
    'meteor/check': checkModule,
    '../transactions.js': dataModule('export default globalThis.__adminSensitiveTransactions'),
    '../../../utils/server_method_helpers.js': authenticationModule,
    '../../../utils/adminCollectionPublication.js': helperModule,
    '../../../utils/transactionLogSecurity.js': new URL(
      './transactionLogSecurity.js', import.meta.url,
    ).href,
  },
)
await loadPublication('../api/timecarddatemigrations/server/publications.js', {
  'meteor/check': checkModule,
  'meteor/meteor': meteorModule,
  '../../../utils/server_method_helpers.js': authenticationModule,
  '../../../utils/adminCollectionPublication.js': helperModule,
  '../timecarddatemigrations.js': dataModule(
    'export const TimecardDateMigrationRuns = globalThis.__adminSensitiveMigrations',
  ),
})
await loadPublication('../api/webhookverification/server/publications.js', {
  'meteor/meteor': meteorModule,
  '../webhookverification.js': dataModule(
    'export default globalThis.__adminSensitiveWebhookVerification',
  ),
  '../../../utils/server_method_helpers.js': authenticationModule,
  '../../../utils/adminCollectionPublication.js': helperModule,
})

test('global settings publish secrets write-only and react to promotion, demotion, and inactivity', async () => {
  users.replace({ _id: 'viewer', isAdmin: false })
  globalSettings.replace({
    _id: 'unit', name: 'unit', description: 'Unit', type: 'text', value: 'hours',
    category: 'global', internal: 'hidden',
  })
  globalSettings.replace({
    _id: 'google', name: 'google_clientid', description: 'Google', type: 'text',
    value: 'never-publish-this-client-id', category: 'interfaces', restricted: false,
  })
  globalSettings.replace({
    _id: 'future', name: 'future', description: 'Future', type: 'password',
    value: 'never-publish-this-password', category: 'interfaces',
  })
  const context = publicationContext('viewer')
  await publications.get('globalsettings').call(context)
  assert.deepEqual(context.documents.get('globalsettings:unit'), {
    _id: 'unit', name: 'unit', description: 'Unit', type: 'text',
    value: 'hours', category: 'global',
  })
  assert.equal(context.documents.has('globalsettings:google'), false)
  assert.equal(context.documents.has('globalsettings:future'), false)

  users.replace({ _id: 'viewer', isAdmin: true })
  assert.deepEqual(context.documents.get('globalsettings:google'), {
    _id: 'google', name: 'google_clientid', description: 'Google', type: 'text',
    category: 'interfaces', restricted: false, configured: true,
  })
  assert.equal(JSON.stringify([...context.documents]).includes('never-publish-this'), false)

  users.replace({ _id: 'viewer', isAdmin: false })
  assert.deepEqual([...context.documents.keys()], ['globalsettings:unit'])
  users.replace({ _id: 'viewer', isAdmin: true, inactive: true })
  assert.deepEqual([...context.documents.keys()], ['globalsettings:unit'])
  context.stop()
})

test('anonymous global settings retain the public allowlist without secret values', async () => {
  const context = publicationContext(undefined)
  await publications.get('globalsettings').call(context)
  assert.deepEqual(context.documents.get('globalsettings:unit'), {
    _id: 'unit', name: 'unit', description: 'Unit', type: 'text',
    value: 'hours', category: 'global',
  })
  assert.equal(context.documents.has('globalsettings:google'), false)
  assert.equal(context.documents.has('globalsettings:future'), false)
  assert.equal(JSON.stringify([...context.documents]).includes('never-publish-this'), false)
  context.stop()
})

test('sensitive admin collections use exact fields and retract all rows live', async () => {
  users.replace({ _id: 'admin', isAdmin: true })
  transactions.replace({
    _id: 'tx',
    user: JSON.stringify({
      _id: 'admin', name: 'Admin', emails: [{ address: 'legacy@example.test' }],
      isAdmin: true,
    }),
    method: 'safe.method',
    args: JSON.stringify({
      configuration: { password: 'legacy-password-value' }, ordinary: 'visible',
    }),
    timestamp: new Date('2026-09-01T00:00:00.000Z'),
    rawSecret: 'hidden',
  })
  transactions.replace({
    _id: 'malformed-tx',
    user: '{malformed legacy user',
    method: 'legacy.method',
    args: '{"password":"unterminated-legacy-secret"',
    timestamp: new Date('2026-08-31T00:00:00.000Z'),
  })
  migrations.replace({
    _id: 'migration', status: 'prepared', createdAt: new Date('2026-09-01T00:00:00.000Z'),
    backupDocuments: [{ secret: 'hidden' }],
  })
  webhookVerification.replace({
    _id: 'webhook', name: 'Webhook', active: true, endpointId: 'endpoint',
    secret: 'hidden',
  })
  webhookVerification.replace({
    _id: 'removed-webhook', name: 'Removed', removedAt: new Date(), secret: 'hidden',
  })

  const contexts = new Map()
  for (const [name, options] of [
    ['allTransactions', { limit: 25 }],
    ['timecardDateMigrationRuns', { limit: 25 }],
    ['webhookverification', undefined],
  ]) {
    const context = publicationContext('admin')
    contexts.set(name, context)
    await publications.get(name).call(context, options)
  }

  assert.deepEqual(contexts.get('allTransactions').documents.get('transactions:tx'), {
    _id: 'tx',
    user: '{"_id":"admin","name":"Admin","isAdmin":true}',
    method: 'safe.method',
    args: '{"configuration":{"password":"[REDACTED]"},"ordinary":"visible"}',
    timestamp: new Date('2026-09-01T00:00:00.000Z'),
  })
  assert.deepEqual(
    contexts.get('allTransactions').documents.get('transactions:malformed-tx'),
    {
      _id: 'malformed-tx',
      user: '{"_id":"","name":"","isAdmin":false}',
      method: 'legacy.method',
      args: '{"redactedLegacyPayload":true}',
      timestamp: new Date('2026-08-31T00:00:00.000Z'),
    },
  )
  const publishedTransactions = JSON.stringify([
    ...contexts.get('allTransactions').documents.values(),
  ])
  assert.equal(publishedTransactions.includes('legacy@example.test'), false)
  assert.equal(publishedTransactions.includes('legacy-password-value'), false)
  assert.equal(publishedTransactions.includes('unterminated-legacy-secret'), false)
  assert.deepEqual(
    contexts.get('timecardDateMigrationRuns').documents.get(
      'timecardDateMigrationRuns:migration',
    ),
    {
      _id: 'migration', status: 'prepared',
      createdAt: new Date('2026-09-01T00:00:00.000Z'),
    },
  )
  assert.deepEqual(contexts.get('webhookverification').documents.get(
    'webhookverification:webhook',
  ), {
    _id: 'webhook', name: 'Webhook', active: true,
    endpointId: 'endpoint',
  })
  assert.equal(
    contexts.get('webhookverification').documents.has('webhookverification:removed-webhook'),
    false,
  )

  users.replace({ _id: 'admin', isAdmin: false })
  contexts.forEach((context) => assert.equal(context.documents.size, 0))
  users.replace({ _id: 'admin', isAdmin: true })
  contexts.forEach((context) => assert.ok(context.documents.size > 0))
  users.replace({ _id: 'admin', isAdmin: true, inactive: true })
  contexts.forEach((context) => assert.equal(context.documents.size, 0))
  contexts.forEach((context) => context.stop())
})

test('transaction filters are bounded literal text, never caller-controlled regular expressions', () => {
  const { literalTransactionFilter, MAX_TRANSACTION_FILTER_CHARS } = transactionPublicationModule
  const metacharacters = '[a-z]+(cat)?\\.*$^{}|'
  const literal = literalTransactionFilter(metacharacters)
  assert.doesNotThrow(() => new RegExp(literal, 'i'))
  assert.equal(new RegExp(literal).test(metacharacters), true)
  assert.equal(new RegExp(literal).test('aaaacat'), false)

  const oversized = `${'*'.repeat(MAX_TRANSACTION_FILTER_CHARS + 50)}ignored`
  const bounded = literalTransactionFilter(oversized)
  assert.equal(bounded, '\\*'.repeat(MAX_TRANSACTION_FILTER_CHARS))
  assert.ok(bounded.length <= MAX_TRANSACTION_FILTER_CHARS * 2)
})

test('unauthorized admin collection subscriptions fail closed before observing data', async () => {
  users.replace({ _id: 'ordinary', isAdmin: false })
  const transactionObserverCount = transactions.observers.size
  await assert.rejects(
    publications.get('allTransactions').call(publicationContext('ordinary'), {}),
    /not-admin/,
  )
  assert.equal(transactions.observers.size, transactionObserverCount)

  for (const [name, collection, options] of [
    ['timecardDateMigrationRuns', migrations, {}],
    ['webhookverification', webhookVerification, undefined],
  ]) {
    const observerCount = collection.observers.size
    const context = publicationContext('ordinary')
    await publications.get(name).call(context, options)
    assert.equal(context.isReady, true)
    assert.equal(context.documents.size, 0)
    assert.equal(collection.observers.size, observerCount)
  }
})
