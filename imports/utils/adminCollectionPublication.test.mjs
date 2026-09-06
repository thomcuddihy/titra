import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import {
  DEFAULT_REACTIVE_PUBLICATION_DOCUMENTS,
  publishReactiveCollection,
} from './adminCollectionPublication.js'
import {
  DEFAULT_AUTHORIZED_PUBLICATION_DOCUMENTS,
  publishAuthorizedCollection,
} from './authorizedCollectionPublication.js'

function dataModule(source) {
  return `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
}

function projected(document, fields = {}) {
  const result = { _id: document._id }
  Object.entries(fields).forEach(([field, include]) => {
    if (include && Object.hasOwn(document, field)) result[field] = document[field]
  })
  return result
}

function matches(document, selector = {}) {
  return Object.entries(selector).every(([field, value]) => document?.[field] === value)
}

function changes(previous, current) {
  const fields = {}
  new Set([...Object.keys(previous), ...Object.keys(current)]).forEach((field) => {
    if (field === '_id') return
    if (!Object.hasOwn(current, field)) fields[field] = undefined
    else if (!Object.is(previous[field], current[field])) fields[field] = current[field]
  })
  return fields
}

class FakeCollection {
  constructor(documents = []) {
    this.documents = new Map(documents.map((document) => [document._id, { ...document }]))
    this.observers = new Set()
    this.findCalls = []
  }

  document(id) {
    return this.documents.get(id)
  }

  find(selector = {}, options = {}) {
    this.findCalls.push({ selector: structuredClone(selector), options: structuredClone(options) })
    const collection = this
    return {
      async observeChangesAsync(callbacks) {
        const observer = { selector, fields: options.fields || {}, callbacks }
        collection.observers.add(observer)
        let selected = [...collection.documents.values()]
          .filter((document) => matches(document, selector))
        const [sort] = Object.entries(options.sort || {})
        if (sort) {
          const [field, direction] = sort
          selected.sort((left, right) => direction * (
            left[field] < right[field] ? -1 : left[field] > right[field] ? 1 : 0
          ))
        }
        if (options.limit) selected = selected.slice(0, options.limit)
        selected.forEach((document) => {
          const fields = projected(document, observer.fields)
          delete fields._id
          callbacks.added?.(document._id, fields)
        })
        return { stop: () => collection.observers.delete(observer) }
      },
    }
  }

  replace(document) {
    const previous = this.documents.get(document._id)
    this.documents.set(document._id, { ...document })
    this.observers.forEach((observer) => {
      const matchedBefore = matches(previous, observer.selector)
      const matchesAfter = matches(document, observer.selector)
      if (matchedBefore && !matchesAfter) observer.callbacks.removed?.(document._id)
      else if (!matchedBefore && matchesAfter) {
        const fields = projected(document, observer.fields)
        delete fields._id
        observer.callbacks.added?.(document._id, fields)
      } else if (matchedBefore && matchesAfter) {
        const changed = changes(
          projected(previous, observer.fields), projected(document, observer.fields),
        )
        if (Object.keys(changed).length) observer.callbacks.changed?.(document._id, changed)
      }
    })
  }
}

function publicationContext(userId, peerAddress = '192.0.2.10') {
  const documents = new Map()
  const stopCallbacks = []
  let stopped = false
  return {
    userId,
    connection: { clientAddress: peerAddress },
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
    error(error) {
      this.publicationError = error
      this.stop()
    },
    stop() {
      if (stopped) return
      stopped = true
      stopCallbacks.forEach((callback) => callback())
    },
  }
}

const users = new FakeCollection()
const inbound = new FakeCollection()
const outbound = new FakeCollection()
const publications = new Map()
globalThis.__adminUsers = users
globalThis.__inboundInterfaces = inbound
globalThis.__outboundInterfaces = outbound
globalThis.Meteor = {
  users,
  publish(name, handler) { publications.set(name, handler) },
}

const authenticationModule = dataModule(`
  export async function checkAdminAuthentication(context) {
    const user = globalThis.__adminUsers.document(context.userId)
    if (!user || user.inactive === true || user.isAdmin !== true) throw new Error('not-admin')
  }
`)
const publicationHelper = new URL('./adminCollectionPublication.js', import.meta.url).href

async function loadPublication(path, collectionSpecifier, collectionModule) {
  let source = readFileSync(new URL(path, import.meta.url), 'utf8')
  source = source
    .replaceAll(`'${collectionSpecifier}'`, JSON.stringify(collectionModule))
    .replaceAll(
      `'../../../utils/server_method_helpers.js'`, JSON.stringify(authenticationModule),
    )
    .replaceAll(
      `'../../../utils/adminCollectionPublication.js'`, JSON.stringify(publicationHelper),
    )
  await import(dataModule(source))
}

await loadPublication(
  '../api/inboundinterfaces/server/publications.js',
  '../inboundinterfaces.js',
  dataModule('export default globalThis.__inboundInterfaces'),
)
await loadPublication(
  '../api/outboundinterfaces/server/publications.js',
  '../outboundinterfaces.js',
  dataModule('export default globalThis.__outboundInterfaces'),
)

test('interface publications fail closed before observing for unauthenticated or non-admin users', async () => {
  users.replace({ _id: 'ordinary', isAdmin: false })
  for (const [name, collection] of [
    ['inboundinterfaces', inbound], ['outboundinterfaces', outbound],
  ]) {
    const observerCount = collection.observers.size
    await assert.rejects(
      publications.get(name).call(publicationContext(undefined)), /not-admin/,
    )
    await assert.rejects(
      publications.get(name).call(publicationContext('ordinary')), /not-admin/,
    )
    assert.equal(collection.observers.size, observerCount)
  }
})

test('admin interface publications use exact UI fields and retract them on live demotion', async () => {
  users.replace({ _id: 'admin', isAdmin: true })
  inbound.replace({
    _id: 'in-1', name: 'Inbound', description: 'Admin editor', processData: 'return 1',
    active: true, prepareRequest: 'secret executable', credentials: 'secret',
  })
  outbound.replace({
    _id: 'out-1', name: 'Outbound', description: 'Admin editor', processData: 'return 2',
    active: true, faIcon: 'fa-download', credentials: 'secret',
  })
  const inboundContext = publicationContext('admin')
  const outboundContext = publicationContext('admin')
  await publications.get('inboundinterfaces').call(inboundContext)
  await publications.get('outboundinterfaces').call(outboundContext)
  assert.deepEqual(inboundContext.documents.get('inboundinterfaces:in-1'), {
    _id: 'in-1', name: 'Inbound', description: 'Admin editor',
    processData: 'return 1', active: true,
  })
  assert.deepEqual(outboundContext.documents.get('outboundinterfaces:out-1'), {
    _id: 'out-1', name: 'Outbound', description: 'Admin editor',
    processData: 'return 2', active: true, faIcon: 'fa-download',
  })

  users.replace({ _id: 'admin', isAdmin: false })
  assert.equal(inboundContext.documents.size, 0)
  assert.equal(outboundContext.documents.size, 0)
  inbound.replace({
    _id: 'in-1', name: 'Changed while demoted', description: 'Hidden',
    processData: 'return 3', active: true,
  })
  assert.equal(inboundContext.documents.size, 0)

  users.replace({ _id: 'admin', isAdmin: true })
  assert.equal(
    inboundContext.documents.get('inboundinterfaces:in-1').name,
    'Changed while demoted',
  )
  users.replace({ _id: 'admin', isAdmin: true, inactive: true })
  assert.equal(inboundContext.documents.size, 0)
  assert.equal(outboundContext.documents.size, 0)
  inboundContext.stop()
  outboundContext.stop()
})

function publicationFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = `${directory}/${entry.name}`
    if (entry.isDirectory()) return publicationFiles(path)
    return entry.name === 'publications.js' ? [path] : []
  })
}

test('every async publication authentication helper call is awaited', () => {
  const apiDirectory = fileURLToPath(new URL('../api', import.meta.url)).replaceAll('\\', '/')
  publicationFiles(apiDirectory).forEach((path) => {
    readFileSync(path, 'utf8').split(/\r?\n/).forEach((line, index) => {
      if (!/check(?:Admin)?Authentication\(this\)/.test(line)) return
      assert.match(line, /\bawait\s+check(?:Admin)?Authentication\(this\)/, `${path}:${index + 1}`)
    })
  })
})

test('small-collection helpers use a 1000+1 sentinel and retract an oversized result', async () => {
  assert.equal(DEFAULT_REACTIVE_PUBLICATION_DOCUMENTS, 1000)
  assert.equal(DEFAULT_AUTHORIZED_PUBLICATION_DOCUMENTS, 1000)
  const source = new FakeCollection([
    { _id: 'a', name: 'A' },
    { _id: 'b', name: 'B' },
    { _id: 'c', name: 'C' },
  ])
  const publicContext = publicationContext(undefined, '192.0.2.20')
  await publishReactiveCollection(publicContext, {
    users: new FakeCollection(),
    collection: source,
    collectionName: 'bounded-public',
    fields: { name: 1 },
    maxDocuments: 2,
    documentsForUser: ({ documents }) => new Map(
      [...documents].map(([id, document]) => [id, { name: document.name }]),
    ),
  })
  assert.equal(source.findCalls.at(-1).options.limit, 3)
  assert.deepEqual(source.findCalls.at(-1).options.sort, { _id: 1 })
  assert.equal(publicContext.publicationError?.error, 'publication-result-limit')
  assert.equal(publicContext.documents.size, 0)
  assert.notEqual(publicContext.isReady, true)

  const authorizedUsers = new FakeCollection([{ _id: 'member', inactive: false }])
  const authorizedContext = publicationContext('member', '192.0.2.21')
  await publishAuthorizedCollection(authorizedContext, {
    users: authorizedUsers,
    collection: source,
    collectionName: 'bounded-authorized',
    fields: { name: 1 },
    maxDocuments: 2,
  })
  assert.equal(source.findCalls.at(-1).options.limit, 3)
  assert.equal(authorizedContext.publicationError?.error, 'publication-result-limit')
  assert.equal(authorizedContext.documents.size, 0)
  assert.notEqual(authorizedContext.isReady, true)
})

test('shared helpers bound retained anonymous and authenticated subscriptions', async () => {
  const source = new FakeCollection([{ _id: 'only', name: 'Only' }])
  const usersForPublic = new FakeCollection()
  const anonymousContexts = []
  try {
    for (let index = 0; index < 20; index += 1) {
      const context = publicationContext(undefined, '192.0.2.30')
      anonymousContexts.push(context)
      await publishReactiveCollection(context, {
        users: usersForPublic,
        collection: source,
        collectionName: 'public-resource',
        fields: { name: 1 },
        documentsForUser: ({ documents }) => documents,
      })
    }
    await assert.rejects(
      publishReactiveCollection(publicationContext(undefined, '192.0.2.30'), {
        users: usersForPublic,
        collection: source,
        collectionName: 'public-resource',
        fields: { name: 1 },
        documentsForUser: ({ documents }) => documents,
      }),
      (error) => error?.error === 'subscription-limit',
    )
  } finally {
    anonymousContexts.forEach((context) => context.stop())
  }

  const authenticatedUsers = new FakeCollection([{ _id: 'member', inactive: false }])
  const authenticatedContexts = []
  try {
    for (let index = 0; index < 30; index += 1) {
      const context = publicationContext('member', '192.0.2.31')
      authenticatedContexts.push(context)
      await publishAuthorizedCollection(context, {
        users: authenticatedUsers,
        collection: source,
        collectionName: 'member-resource',
        fields: { name: 1 },
      })
    }
    await assert.rejects(
      publishAuthorizedCollection(publicationContext('member', '192.0.2.31'), {
        users: authenticatedUsers,
        collection: source,
        collectionName: 'member-resource',
        fields: { name: 1 },
      }),
      (error) => error?.error === 'subscription-limit',
    )
  } finally {
    authenticatedContexts.forEach((context) => context.stop())
  }
})
