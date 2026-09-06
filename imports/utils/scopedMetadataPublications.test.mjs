import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

function dataModule(source) {
  return `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
}

function projected(document, fields = {}) {
  const result = { _id: document._id }
  Object.entries(fields).forEach(([field, include]) => {
    if (include === 1 && Object.hasOwn(document, field)) result[field] = document[field]
  })
  return result
}

function matches(document, selector = {}) {
  return Boolean(document) && Object.entries(selector)
    .every(([field, value]) => document[field] === value)
}

function fieldChanges(previous, current) {
  const result = {}
  new Set([...Object.keys(previous), ...Object.keys(current)]).forEach((field) => {
    if (field === '_id') return
    if (!Object.hasOwn(current, field)) result[field] = undefined
    else if (!Object.is(previous[field], current[field])) result[field] = current[field]
  })
  return result
}

class FakeCollection {
  constructor(documents = []) {
    this.documents = new Map(documents.map((document) => [document._id, { ...document }]))
    this.observers = new Set()
  }

  reset(documents = []) {
    assert.equal(this.observers.size, 0, 'fixture observer leaked between tests')
    this.documents = new Map(documents.map((document) => [document._id, { ...document }]))
  }

  document(id) { return this.documents.get(id) }

  find(selector = {}, options = {}) {
    const collection = this
    return {
      async observeChangesAsync(callbacks) {
        const observer = { selector, fields: options.fields || {}, callbacks }
        collection.observers.add(observer)
        collection.documents.forEach((document) => {
          if (!matches(document, selector)) return
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
        const changes = fieldChanges(
          projected(previous, observer.fields), projected(document, observer.fields),
        )
        if (Object.keys(changes).length) observer.callbacks.changed?.(document._id, changes)
      }
    })
  }
}

function publicationContext(userId) {
  const documents = new Map()
  const stopCallbacks = []
  return {
    userId,
    documents,
    readyCount: 0,
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
    ready() { this.readyCount += 1 },
    stop() { stopCallbacks.forEach((callback) => callback()) },
  }
}

class MeteorError extends Error {
  constructor(error, reason) {
    super(reason || error)
    this.error = error
    this.reason = reason
  }
}

const users = new FakeCollection()
const customFields = new FakeCollection()
const notifications = new FakeCollection()
const publications = new Map()
globalThis.__metadataUsers = users
globalThis.__customFields = customFields
globalThis.__notifications = notifications
globalThis.Meteor = {
  users,
  Error: MeteorError,
  publish(name, handler) { publications.set(name, handler) },
}

const checkModule = dataModule(`
  export function check(value, type) {
    if (type === String && typeof value !== 'string') throw new TypeError('Match error')
  }
`)
const authenticationModule = dataModule(`
  function current(context) { return globalThis.__metadataUsers.document(context.userId) }
  export async function checkAuthentication(context) {
    const user = current(context)
    if (!context.userId || !user || user.inactive === true) throw new Error('not-authenticated')
  }
  export async function checkAdminAuthentication(context) {
    const user = current(context)
    if (!context.userId || !user || user.inactive === true || user.isAdmin !== true) {
      throw new Error('not-admin')
    }
  }
`)
const meteorModule = dataModule('export const Meteor = globalThis.Meteor')
const customFieldsModule = dataModule('export default globalThis.__customFields')
const notificationsModule = dataModule('export default globalThis.__notifications')
const authorizedHelper = new URL('./authorizedCollectionPublication.js', import.meta.url).href
const customFieldSecurity = new URL(
  '../api/customfields/server/publicationSecurity.js', import.meta.url,
).href
const notificationSecurity = new URL(
  '../api/notifications/server/publicationSecurity.js', import.meta.url,
).href

async function loadPublication(path, replacements) {
  let source = readFileSync(new URL(path, import.meta.url), 'utf8')
  const modules = {
    'meteor/meteor': meteorModule,
    'meteor/check': checkModule,
    '../../../utils/server_method_helpers.js': authenticationModule,
    '../../../utils/authorizedCollectionPublication.js': authorizedHelper,
    ...replacements,
  }
  Object.entries(modules).forEach(([specifier, replacement]) => {
    source = source.replaceAll(`'${specifier}'`, JSON.stringify(replacement))
  })
  await import(dataModule(source))
}

await loadPublication('../api/customfields/server/publications.js', {
  '../customfields.js': customFieldsModule,
  './publicationSecurity.js': customFieldSecurity,
})
await loadPublication('../api/notifications/server/publications.js', {
  '../notifications.js': notificationsModule,
  './publicationSecurity.js': notificationSecurity,
})

function resetFixtures() {
  users.reset([
    { _id: 'admin', isAdmin: true },
    { _id: 'member', isAdmin: false },
    { _id: 'other', isAdmin: false },
  ])
  customFields.reset([
    {
      _id: 'field-project', classname: 'project', name: 'CostCentre',
      desc: 'Cost centre', type: 'text', possibleValues: ['A', 'B'], category: 'Work',
      createdAt: new Date(), internalSecret: 'never publish',
    },
    {
      _id: 'field-task', classname: 'task', name: 'Ticket', desc: 'Ticket', type: 'text',
    },
    {
      _id: 'field-global', classname: 'global_setting', name: 'Setting',
      desc: 'Setting', type: 'password', internalSecret: 'never publish',
    },
  ])
  notifications.reset([
    { _id: 'notice-self', userId: 'member', message: 'For member', internalSecret: 'hidden' },
    { _id: 'notice-other', userId: 'other', message: 'For other', internalSecret: 'hidden' },
  ])
}

test('customfields rejects anonymous callers while pre-login notifications stays empty', async () => {
  resetFixtures()
  for (const [name, argument] of [
    ['customfields', undefined],
    ['customfieldsForClass', { classname: 'project' }],
  ]) {
    const context = publicationContext(undefined)
    await assert.rejects(publications.get(name).call(context, argument), /not-authenticated|not-admin/)
    assert.equal(context.documents.size, 0)
  }
  const notificationsContext = publicationContext(undefined)
  await publications.get('mynotifications').call(notificationsContext)
  assert.equal(notificationsContext.documents.size, 0)
  assert.equal(notificationsContext.readyCount, 1)
  assert.equal(customFields.observers.size, 0)
  assert.equal(notifications.observers.size, 0)
})

test('all-fields customfields publication is admin-only', async () => {
  resetFixtures()
  const context = publicationContext('member')
  await assert.rejects(publications.get('customfields').call(context), /not-admin/)
  assert.equal(context.documents.size, 0)
  assert.equal(customFields.observers.size, 0)
})

test('admin customfields uses an exact allowlist and retracts on live demotion', async () => {
  resetFixtures()
  const context = publicationContext('admin')
  await publications.get('customfields').call(context)
  assert.deepEqual(context.documents.get('customfields:field-project'), {
    _id: 'field-project', classname: 'project', name: 'CostCentre',
    desc: 'Cost centre', type: 'text', possibleValues: ['A', 'B'], category: 'Work',
  })
  assert.equal(Object.hasOwn(
    context.documents.get('customfields:field-project'), 'internalSecret',
  ), false)
  assert.equal(Object.hasOwn(
    context.documents.get('customfields:field-project'), 'createdAt',
  ), false)
  users.replace({ _id: 'admin', isAdmin: false })
  assert.equal(context.documents.size, 0)
  customFields.replace({
    _id: 'field-project', classname: 'project', name: 'Hidden while demoted',
    desc: 'Hidden', type: 'text',
  })
  assert.equal(context.documents.size, 0)
  context.stop()
})

test('class publication accepts only product data classes and retracts on disablement', async () => {
  resetFixtures()
  for (const classname of ['global_setting', 'unknown', '', 'x'.repeat(1000)]) {
    const context = publicationContext('member')
    await publications.get('customfieldsForClass').call(context, { classname })
    assert.equal(context.documents.size, 0)
    assert.equal(context.readyCount, 1)
    assert.equal(customFields.observers.size, 0)
  }
  const context = publicationContext('member')
  await publications.get('customfieldsForClass').call(context, { classname: 'project' })
  assert.deepEqual([...context.documents.values()], [{
    _id: 'field-project', classname: 'project', name: 'CostCentre',
    desc: 'Cost centre', type: 'text', possibleValues: ['A', 'B'], category: 'Work',
  }])
  users.replace({ _id: 'member', isAdmin: false, inactive: true })
  assert.equal(context.documents.size, 0)
  customFields.replace({
    _id: 'field-project', classname: 'project', name: 'Hidden while inactive',
    desc: 'Hidden', type: 'text',
  })
  assert.equal(context.documents.size, 0)
  users.replace({ _id: 'member', isAdmin: false })
  assert.equal(context.documents.get('customfields:field-project').name, 'Hidden while inactive')
  context.stop()
})

test('notifications are exact, self-only and retract immediately on account disablement', async () => {
  resetFixtures()
  const context = publicationContext('member')
  await publications.get('mynotifications').call(context)
  assert.deepEqual([...context.documents.values()], [{
    _id: 'notice-self', userId: 'member', message: 'For member',
  }])
  assert.equal(context.documents.has('notifications:notice-other'), false)
  users.replace({ _id: 'member', isAdmin: false, inactive: true })
  assert.equal(context.documents.size, 0)
  notifications.replace({
    _id: 'notice-new', userId: 'member', message: 'Hidden while inactive',
    internalSecret: 'hidden',
  })
  assert.equal(context.documents.size, 0)
  users.replace({ _id: 'member', isAdmin: false })
  assert.deepEqual(context.documents.get('notifications:notice-new'), {
    _id: 'notice-new', userId: 'member', message: 'Hidden while inactive',
  })
  context.stop()
})
