import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

function dataModule(source) {
  return `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
}

function valueAt(document, path) {
  return path.split('.').reduce((value, key) => value?.[key], document)
}

function matchesCondition(value, condition) {
  if (!condition || typeof condition !== 'object' || Array.isArray(condition)) {
    return Array.isArray(value) ? value.includes(condition) : value === condition
  }
  if (Object.hasOwn(condition, '$in')) return condition.$in.includes(value)
  if (Object.hasOwn(condition, '$ne')) {
    return Array.isArray(value) ? !value.includes(condition.$ne) : value !== condition.$ne
  }
  if (Object.hasOwn(condition, '$exists')) return (value !== undefined) === condition.$exists
  if (Object.hasOwn(condition, '$size')) return Array.isArray(value) && value.length === condition.$size
  return false
}

function matches(document, selector = {}) {
  return Object.entries(selector).every(([field, condition]) => {
    if (field === '$or') return condition.some((entry) => matches(document, entry))
    if (field === '$and') return condition.every((entry) => matches(document, entry))
    if (field === '$nor') return !condition.some((entry) => matches(document, entry))
    return matchesCondition(valueAt(document, field), condition)
  })
}

function projected(document, fields = {}) {
  if (!document) return null
  const result = { _id: document._id }
  Object.entries(fields).forEach(([field, include]) => {
    if (!include || field === '_id') return
    const value = valueAt(document, field)
    if (value === undefined) return
    const keys = field.split('.')
    let target = result
    keys.forEach((key, index) => {
      if (index === keys.length - 1) target[key] = value
      else {
        target[key] ||= {}
        target = target[key]
      }
    })
  })
  return result
}

function changedFields(previous, current) {
  const changes = {}
  for (const key of new Set([...Object.keys(previous || {}), ...Object.keys(current || {})])) {
    if (key === '_id') continue
    if (!Object.hasOwn(current, key)) changes[key] = undefined
    else if (JSON.stringify(previous?.[key]) !== JSON.stringify(current[key])) {
      changes[key] = current[key]
    }
  }
  return changes
}

class FakeCollection {
  constructor(documents = []) {
    this.documents = new Map(documents.map((document) => [document._id, structuredClone(document)]))
    this.observers = new Set()
    this.observerDelays = []
  }

  delayNextObserver(delay) {
    this.observerDelays.push(delay)
  }

  find(selector = {}, options = {}) {
    const collection = this
    return {
      async fetchAsync() {
        return [...collection.documents.values()].filter((document) => matches(document, selector))
          .map((document) => projected(document, options.fields || Object.fromEntries(
            Object.keys(document).map((field) => [field, 1]),
          )))
      },
      async observeChangesAsync(callbacks) {
        const observer = { selector, fields: options.fields || {}, callbacks }
        collection.observers.add(observer)
        for (const document of collection.documents.values()) {
          if (matches(document, selector)) {
            const fields = projected(document, observer.fields)
            delete fields._id
            callbacks.added?.(document._id, fields)
          }
        }
        const delay = collection.observerDelays.shift()
        if (delay !== undefined) {
          if (typeof delay === 'function') await delay()
          else await new Promise((resolve) => { setTimeout(resolve, delay) })
        }
        return { stop: () => collection.observers.delete(observer) }
      },
    }
  }

  rawCollection() {
    const collection = this
    return {
      aggregate(pipeline) {
        return {
          async toArray() {
            const match = pipeline.find((stage) => stage.$match)?.$match || {}
            const maximum = pipeline.find((stage) => stage.$limit)?.$limit
              || Number.MAX_SAFE_INTEGER
            const grouped = new Map()
            for (const document of collection.documents.values()) {
              if (!matches(document, match)) continue
              const key = `${document.projectId}\u0000${document.userId}`
              grouped.set(key, { projectId: document.projectId, userId: document.userId })
            }
            return [...grouped.values()]
              .sort((left, right) => left.projectId.localeCompare(right.projectId)
                || left.userId.localeCompare(right.userId))
              .slice(0, maximum)
          },
        }
      },
    }
  }

  async findOneAsync(selector, options = {}) {
    const document = [...this.documents.values()].find((entry) => matches(entry, selector))
    return projected(document, options.fields || Object.fromEntries(
      Object.keys(document || {}).map((field) => [field, 1]),
    ))
  }

  replace(document) {
    const previous = this.documents.get(document._id)
    this.documents.set(document._id, structuredClone(document))
    for (const observer of this.observers) {
      const before = previous && matches(previous, observer.selector)
      const after = matches(document, observer.selector)
      if (before && !after) observer.callbacks.removed?.(document._id)
      else if (!before && after) {
        const fields = projected(document, observer.fields)
        delete fields._id
        observer.callbacks.added?.(document._id, fields)
      } else if (before && after) {
        const changes = changedFields(
          projected(previous, observer.fields), projected(document, observer.fields),
        )
        if (Object.keys(changes).length) observer.callbacks.changed?.(document._id, changes)
      }
    }
  }
}

function context(userId) {
  const documents = new Map()
  const events = []
  const stops = []
  return {
    userId,
    documents,
    events,
    added(collection, id, fields) {
      documents.set(`${collection}:${id}`, structuredClone(fields))
      events.push(['added', collection, id, structuredClone(fields)])
    },
    changed(collection, id, fields) {
      const key = `${collection}:${id}`
      const current = documents.get(key) || {}
      Object.entries(fields).forEach(([field, value]) => {
        if (value === undefined) delete current[field]
        else current[field] = structuredClone(value)
      })
      documents.set(key, current)
      events.push(['changed', collection, id, structuredClone(fields)])
    },
    removed(collection, id) {
      documents.delete(`${collection}:${id}`)
      events.push(['removed', collection, id])
    },
    ready() { this.isReady = true },
    onStop(callback) { stops.push(callback) },
    stop() { stops.forEach((callback) => callback()) },
    error(error) { throw error },
  }
}

async function settle() {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await new Promise((resolve) => { setTimeout(resolve, 0) })
  }
}

const collections = {
  projects: new FakeCollection(),
  timecards: new FakeCollection(),
  dashboards: new FakeCollection(),
  users: new FakeCollection(),
}
const publications = new Map()
globalThis.__titraPublicationCollections = collections
globalThis.Meteor = {
  users: collections.users,
  publish(name, handler) { publications.set(name, handler) },
}
globalThis.check = () => {}

const sourcePath = new URL('./publications.js', import.meta.url)
let source = readFileSync(sourcePath, 'utf8')
const replacements = {
  'meteor/check': dataModule('export const Match={OneOf(){return true},Maybe(){return true}}'),
  'meteor/ddp-rate-limiter': dataModule('export const DDPRateLimiter={addRule(){}}'),
  '../../timecards/timecards.js': dataModule('export default globalThis.__titraPublicationCollections.timecards'),
  '../../projects/projects.js': dataModule('export default globalThis.__titraPublicationCollections.projects'),
  '../../dashboards/dashboards': dataModule('export const Dashboards=globalThis.__titraPublicationCollections.dashboards'),
  '../../../utils/server_method_helpers.js': dataModule(`
    export async function checkAuthentication() {}
    export async function checkAdminAuthentication() {}
  `),
  './projectUserPrivacy.js': new URL('./projectUserPrivacy.js', import.meta.url).href,
  './signedInUserPrivacy.js': dataModule('export const SIGNED_IN_USER_FIELDS={}'),
  '../../../utils/reactivePublication.js': new URL('../../../utils/reactivePublication.js', import.meta.url).href,
  '../../../utils/adminCollectionPublication.js': new URL(
    '../../../utils/adminCollectionPublication.js', import.meta.url,
  ).href,
  './adminUserListSecurity.js': new URL(
    './adminUserListSecurity.js', import.meta.url,
  ).href,
  '../../projects/server/publicAccessServer.js': dataModule(`
    export async function currentPublicProjectsDisabled() { return false }
    export async function stopPublicationOnPublicAccessDisable() {}
  `),
  '../../projects/server/publicAccessPolicy.js': new URL(
    '../../projects/server/publicAccessPolicy.js', import.meta.url,
  ).href,
  '../../../utils/resourceLimits.js': new URL(
    '../../../utils/resourceLimits.js', import.meta.url,
  ).href,
  '../../../utils/activePublicationGate.js': new URL(
    '../../../utils/activePublicationGate.js', import.meta.url,
  ).href,
}
Object.entries(replacements).forEach(([specifier, replacement]) => {
  source = source.replaceAll(`'${specifier}'`, JSON.stringify(replacement))
})
await import(dataModule(source))

test('projectUsers and projectResources reconcile real observer events through revoke', async () => {
  collections.projects.replace({
    _id: 'p1', userId: 'owner', admins: [], team: ['caller'], public: true,
  })
  collections.timecards.replace({ _id: 'c1', projectId: 'p1', userId: 'owner' })
  collections.timecards.replace({ _id: 'c2', projectId: 'p1', userId: 'caller' })
  collections.users.replace({ _id: 'owner', profile: { name: 'Owner' } })
  collections.users.replace({ _id: 'caller', profile: { name: 'Caller' } })

  const usersContext = context('caller')
  const resourcesContext = context('caller')
  await publications.get('projectUsers').call(usersContext, { projectId: 'p1' })
  await publications.get('projectResources').call(resourcesContext, { projectId: 'p1' })
  assert.equal(usersContext.documents.get('projectUsers:p1').users.length, 2)
  assert.deepEqual([...resourcesContext.documents.keys()].sort(), [
    'projectResources:caller', 'projectResources:owner',
  ])

  collections.users.replace({ _id: 'owner', profile: { name: 'Renamed owner' } })
  await settle()
  assert.equal(resourcesContext.documents.get('projectResources:owner').name, 'Renamed owner')

  collections.projects.replace({
    _id: 'p1', userId: 'owner', admins: [], team: [], public: true,
  })
  await settle()
  assert.deepEqual(usersContext.documents.get('projectUsers:p1').users.map((user) => user._id), [
    'caller',
  ])
  assert.deepEqual([...resourcesContext.documents.keys()], ['projectResources:caller'])

  collections.projects.replace({
    _id: 'p1', userId: 'owner', admins: [], team: [], public: false,
  })
  await settle()
  assert.equal(usersContext.documents.has('projectUsers:p1'), false)
  assert.equal(resourcesContext.documents.size, 0)
  collections.users.replace({ _id: 'caller', profile: { name: 'Changed after revoke' } })
  await settle()
  assert.equal(usersContext.documents.size, 0)
  assert.equal(resourcesContext.documents.size, 0)
  usersContext.stop()
  resourcesContext.stop()
})

test('projectTeam and dashboardUser remove previously published names on team removal', async () => {
  collections.projects.replace({
    _id: 'p2', userId: 'owner2', admins: [], team: ['caller2', 'resource2'], public: true,
  })
  collections.dashboards.replace({
    _id: 'd2', projectId: 'p2', resourceId: 'resource2',
  })
  collections.users.replace({ _id: 'resource2', profile: { name: 'Resource' } })
  const teamContext = context('caller2')
  const dashboardContext = context('caller2')
  await publications.get('projectTeam').call(teamContext, { userIds: ['resource2'] })
  // Model a real Mongo observer whose initial callbacks arrive before its
  // observeChangesAsync promise resolves. dashboardUser must not announce
  // ready until that pending snapshot has been committed and reconciled.
  collections.users.delayNextObserver(20)
  await publications.get('dashboardUser').call(dashboardContext, { _id: 'd2' })
  assert.equal(dashboardContext.isReady, true)
  assert.equal(teamContext.documents.get('users:resource2').profile.name, 'Resource')
  assert.equal(dashboardContext.documents.get('users:resource2').profile.name, 'Resource')

  collections.users.replace({ _id: 'resource2', profile: { name: 'Renamed resource' } })
  await settle()
  assert.equal(teamContext.documents.get('users:resource2').profile.name, 'Renamed resource')
  assert.equal(dashboardContext.documents.get('users:resource2').profile.name, 'Renamed resource')

  collections.projects.replace({
    _id: 'p2', userId: 'owner2', admins: [], team: ['resource2'], public: true,
  })
  await settle()
  assert.equal(teamContext.documents.size, 0)
  assert.equal(dashboardContext.documents.size, 0)
  collections.users.replace({ _id: 'resource2', profile: { name: 'Late name' } })
  await settle()
  assert.equal(teamContext.documents.size, 0)
  assert.equal(dashboardContext.documents.size, 0)
  teamContext.stop()
  dashboardContext.stop()
})

test('dashboardUser drains authorization changes before ready without transient disclosure', async () => {
  collections.projects.replace({
    _id: 'p3', userId: 'owner3', admins: [], team: ['caller3'], public: false,
  })
  collections.dashboards.replace({
    _id: 'd3', projectId: 'p3', resourceId: 'resource3',
  })
  collections.users.replace({ _id: 'resource3', profile: { name: 'Private resource' } })
  const dashboardContext = context('caller3')

  collections.users.delayNextObserver(async () => {
    collections.dashboards.replace({ _id: 'd3', projectId: 'p3' })
    await Promise.resolve()
  })
  await publications.get('dashboardUser').call(dashboardContext, { _id: 'd3' })

  assert.equal(dashboardContext.isReady, true)
  assert.equal(dashboardContext.documents.size, 0)
  assert.deepEqual(dashboardContext.events, [])
  dashboardContext.stop()
})
