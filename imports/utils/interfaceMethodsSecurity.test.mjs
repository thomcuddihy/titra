import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  SIGNED_IN_PROFILE_FIELDS,
} from '../api/users/server/signedInUserPrivacy.js'
import {
  MEMBER_PROJECT_FIELDS,
} from '../api/projects/server/publicationPrivacy.js'

function dataModule(source) {
  return `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
}

function matches(document, selector = {}) {
  if (!document) return false
  return Object.entries(selector).every(([field, value]) => {
    if (field === '$or') return value.some((candidate) => matches(document, candidate))
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      if (Object.hasOwn(value, '$ne')) return document[field] !== value.$ne
      if (Object.hasOwn(value, '$type')) return typeof document[field] === value.$type
    }
    if (Array.isArray(document[field])) return document[field].includes(value)
    return document[field] === value
  })
}

function project(document, fields = {}) {
  if (!document) return {}
  const result = { _id: document._id }
  Object.entries(fields).forEach(([path, include]) => {
    if (include !== 1 || path === '_id') return
    const parts = path.split('.')
    let source = document
    for (const part of parts) source = source?.[part]
    if (source === undefined) return
    let target = result
    parts.slice(0, -1).forEach((part) => {
      target[part] ||= {}
      target = target[part]
    })
    target[parts.at(-1)] = structuredClone(source)
  })
  return result
}

class FakeCollection {
  constructor(name) {
    this.name = name
    this.documents = []
    this.calls = []
  }

  reset(documents = []) {
    this.documents = documents.map((document) => structuredClone(document))
    this.calls = []
  }

  async findOneAsync(selector, options = {}) {
    globalThis.__interfaceCallOrder.push(this.name)
    this.calls.push({ operation: 'findOneAsync', selector, options })
    const document = this.documents.find((candidate) => matches(candidate, selector))
    return document ? project(document, options.fields || {}) : undefined
  }

  find(selector, options = {}) {
    this.calls.push({ operation: 'find', selector, options })
    return {
      fetchAsync: async () => this.documents
        .filter((document) => matches(document, selector))
        .map((document) => project(document, options.fields || {})),
    }
  }

  async insertAsync() {}

  async updateAsync() {}

  async removeAsync() {}
}

const inboundInterfaces = new FakeCollection('inbound')
const outboundInterfaces = new FakeCollection('outbound')
const projects = new FakeCollection('projects')
const users = new FakeCollection('users')
const methods = new Map()

globalThis.__inboundInterfaces = inboundInterfaces
globalThis.__outboundInterfaces = outboundInterfaces
globalThis.__interfaceProjects = projects
globalThis.__interfaceUsers = users
globalThis.__interfaceMethods = methods
globalThis.__interfaceCallOrder = []
globalThis.__interfaceVmOptions = []
globalThis.__interfaceVmRun = async () => []
globalThis.__unsafeLegacyScriptsAllowed = true

class MeteorError extends Error {
  constructor(error, reason) {
    super(reason || error)
    this.error = error
    this.reason = reason
  }
}

globalThis.Meteor = { users, Error: MeteorError }

const checkModule = dataModule(`
  export const Match = { Maybe: (type) => ({ maybe: type }) }
  export function check() {}
`)
const fetchModule = dataModule(`
  export const fetch = (...args) => globalThis.fetch?.(...args)
  export class Headers {}
`)
const validatedMethodModule = dataModule(`
  export class ValidatedMethod {
    constructor(options) {
      globalThis.__interfaceMethods.set(options.name, options)
      Object.assign(this, options)
    }
  }
`)
const vmModule = dataModule(`
  export class NodeVM {
    constructor(options) {
      this.options = options
      globalThis.__interfaceVmOptions.push(options)
    }
    run(script) { return globalThis.__interfaceVmRun(script, this.options) }
  }
`)
const legacyScriptPolicyModule = dataModule(`
  export function legacyScriptDecision() {
    return { allowed: globalThis.__unsafeLegacyScriptsAllowed, execute: true }
  }
`)
const helpersModule = dataModule(`
  export const adminAuthenticationMixin = (options) => options
  export const authenticationMixin = (options) => options
  export const transactionLogMixin = (options) => options
`)
const inboundCollectionModule = dataModule(
  'export default globalThis.__inboundInterfaces',
)
const outboundCollectionModule = dataModule(
  'export default globalThis.__outboundInterfaces',
)
const projectsModule = dataModule('export default globalThis.__interfaceProjects')
const publicAccessModule = dataModule(`
  export async function currentProjectAudienceClauses(userId) {
    return [{ userId }, { admins: userId }, { team: userId }, { public: true }]
  }
`)
const userPrivacyModule = new URL(
  '../api/users/server/signedInUserPrivacy.js', import.meta.url,
).href
const projectPrivacyModule = new URL(
  '../api/projects/server/publicationPrivacy.js', import.meta.url,
).href

async function loadMethods(path, replacements) {
  let source = readFileSync(new URL(path, import.meta.url), 'utf8')
  const common = {
    'meteor/check': checkModule,
    'meteor/fetch': fetchModule,
    'meteor/mdg:validated-method': validatedMethodModule,
    '../../../utils/vm_sandbox.js': vmModule,
    '../../../utils/legacyScriptPolicy.js': legacyScriptPolicyModule,
    '../../../utils/server_method_helpers': helpersModule,
    '../../users/server/signedInUserPrivacy.js': userPrivacyModule,
    '../../projects/projects.js': projectsModule,
    '../../projects/server/publicationPrivacy.js': projectPrivacyModule,
    '../../projects/server/publicAccessServer.js': publicAccessModule,
    ...replacements,
  }
  Object.entries(common).forEach(([specifier, replacement]) => {
    source = source
      .replaceAll(`'${specifier}'`, JSON.stringify(replacement))
      .replaceAll(`"${specifier}"`, JSON.stringify(replacement))
  })
  await import(dataModule(source))
}

await loadMethods('../api/inboundinterfaces/server/methods.js', {
  '../inboundinterfaces.js': inboundCollectionModule,
})
await loadMethods('../api/outboundinterfaces/server/methods.js', {
  '../outboundinterfaces.js': outboundCollectionModule,
})

function resetFixtures() {
  globalThis.__unsafeLegacyScriptsAllowed = true
  users.reset([{
    _id: 'member',
    profile: {
      name: 'Member',
      gitlaburl: 'https://gitlab.example/',
      gitlabtoken: 'legacy-browser-token',
      APItoken: 'server-api-secret',
      timerStopReceipt: { tokenHash: 'receipt-secret' },
      futureSecret: 'future-secret',
    },
  }])
  projects.reset([{
    _id: 'project-1',
    name: 'Visible project',
    description: 'Visible description',
    userId: 'owner',
    team: ['member'],
    admins: [],
    public: false,
    rate: 190,
    gitlabquery: 'projects/1/issues',
    serverSecret: 'never-pass-to-interface',
  }])
  inboundInterfaces.reset([{
    _id: 'inbound-1', active: true, processData: 'return tasks',
    credentials: 'never-pass-to-caller', name: 'Inbound', description: 'Tasks',
  }])
  outboundInterfaces.reset([{
    _id: 'outbound-1', active: true, processData: 'return exportData',
    credentials: 'never-pass-to-caller', name: 'Outbound', description: 'Export',
    faIcon: 'fa-download',
  }])
  globalThis.__interfaceCallOrder = []
  globalThis.__interfaceVmOptions = []
  globalThis.__interfaceVmRun = async () => []
}

test('inbound execution requires live access and passes exact browser-safe context', async () => {
  resetFixtures()
  globalThis.__interfaceVmRun = async () => [{
    name: 'Ticket 1', description: 'Description', ignoredSecret: 'strip me',
  }]
  const result = await methods.get('inboundinterfaces.getTasks').run.call(
    { userId: 'member' },
    { _id: 'inbound-1', projectId: 'project-1' },
  )
  assert.deepEqual(result, [{ name: 'Ticket 1', description: 'Description' }])
  assert.deepEqual(globalThis.__interfaceCallOrder, ['users', 'projects', 'inbound'])
  assert.deepEqual(users.calls[0], {
    operation: 'findOneAsync',
    selector: { _id: 'member', inactive: { $ne: true } },
    options: { fields: SIGNED_IN_PROFILE_FIELDS },
  })
  assert.deepEqual(projects.calls[0].selector, {
    _id: 'project-1',
    $or: [
      { userId: 'member' }, { admins: 'member' },
      { team: 'member' }, { public: true },
    ],
  })
  assert.deepEqual(projects.calls[0].options, { fields: MEMBER_PROJECT_FIELDS })
  assert.deepEqual(inboundInterfaces.calls[0], {
    operation: 'findOneAsync',
    selector: {
      _id: 'inbound-1', active: true, processData: { $type: 'string' },
    },
    options: { fields: { processData: 1 } },
  })
  const sandbox = globalThis.__interfaceVmOptions[0].sandbox
  assert.equal(Object.hasOwn(sandbox, 'getGlobalSettingAsync'), false)
  assert.deepEqual(sandbox.user, {
    name: 'Member',
    gitlaburl: 'https://gitlab.example/',
  })
  assert.equal(Object.hasOwn(sandbox.user, 'gitlabtoken'), false)
  assert.equal(Object.hasOwn(sandbox.user, 'APItoken'), false)
  assert.equal(Object.hasOwn(sandbox.user, 'timerStopReceipt'), false)
  assert.deepEqual(sandbox.project, {
    _id: 'project-1',
    name: 'Visible project',
    description: 'Visible description',
    userId: 'owner',
    team: ['member'],
    admins: [],
    public: false,
    rate: 190,
    gitlabquery: 'projects/1/issues',
  })
  assert.equal(Object.hasOwn(sandbox.project, 'serverSecret'), false)
})

test('inbound execution rejects invisible projects and disabled interfaces without running code', async () => {
  resetFixtures()
  projects.reset([{ _id: 'private-project', userId: 'other', public: false }])
  await assert.rejects(
    methods.get('inboundinterfaces.getTasks').run.call(
      { userId: 'member' }, { _id: 'inbound-1', projectId: 'private-project' },
    ),
    (error) => error.error === 'not-authorized'
      && !/secret/i.test(`${error.message} ${error.reason}`),
  )
  assert.equal(inboundInterfaces.calls.length, 0)
  assert.equal(globalThis.__interfaceVmOptions.length, 0)

  resetFixtures()
  inboundInterfaces.documents[0].active = false
  await assert.rejects(
    methods.get('inboundinterfaces.getTasks').run.call(
      { userId: 'member' }, { _id: 'inbound-1', projectId: 'project-1' },
    ),
    (error) => error.error === 'not-authorized',
  )
  assert.equal(globalThis.__interfaceVmOptions.length, 0)
})

test('interface execution errors are fixed and never reflect stored/upstream secrets', async () => {
  resetFixtures()
  globalThis.__interfaceVmRun = async () => {
    throw new Error('upstream said token=very-secret')
  }
  await assert.rejects(
    methods.get('inboundinterfaces.getTasks').run.call(
      { userId: 'member' }, { _id: 'inbound-1', projectId: 'project-1' },
    ),
    (error) => error.error === 'interface-execution-failed'
      && error.reason === 'Interface execution failed.'
      && !/very-secret/.test(`${error.message} ${error.reason}`),
  )
  globalThis.__interfaceVmOptions = []
  await assert.rejects(
    methods.get('outboundinterfaces.run').run.call(
      { userId: 'member' }, { _id: 'outbound-1', data: [] },
    ),
    (error) => error.error === 'interface-execution-failed'
      && error.reason === 'Interface execution failed.'
      && !/very-secret/.test(`${error.message} ${error.reason}`),
  )
})

test('outbound execution runs only an active string script with no inherited console', async () => {
  resetFixtures()
  const input = [{ hours: 1 }]
  assert.equal(await methods.get('outboundinterfaces.run').run.call(
    { userId: 'member' }, { _id: 'outbound-1', data: input },
  ), 'notifications.success')
  assert.deepEqual(outboundInterfaces.calls[0], {
    operation: 'findOneAsync',
    selector: {
      _id: 'outbound-1', active: true, processData: { $type: 'string' },
    },
    options: { fields: { processData: 1 } },
  })
  assert.equal(globalThis.__interfaceVmOptions[0].console, undefined)
  assert.deepEqual(globalThis.__interfaceVmOptions[0].sandbox.data, input)
  assert.notEqual(globalThis.__interfaceVmOptions[0].sandbox.data, input)

  resetFixtures()
  outboundInterfaces.documents[0].active = false
  await assert.rejects(
    methods.get('outboundinterfaces.run').run.call(
      { userId: 'member' }, { _id: 'outbound-1', data: [] },
    ),
    (error) => error.error === 'not-authorized'
      && error.reason === 'Interface is not available.',
  )
  assert.equal(globalThis.__interfaceVmOptions.length, 0)
})

test('outbound execution rejects non-JSON, dangerous and oversized input before VM execution', async () => {
  const cyclic = []
  cyclic.push(cyclic)
  const prototypePollution = JSON.parse('[{"__proto__":{"polluted":true}}]')
  const customPrototype = Object.assign(Object.create({ inherited: true }), { value: 1 })
  const getter = {}
  Object.defineProperty(getter, 'value', { enumerable: true, get: () => 'secret' })
  const invalidInputs = [
    [Number.NaN],
    [Number.POSITIVE_INFINITY],
    [undefined],
    [1n],
    [new Date()],
    cyclic,
    prototypePollution,
    [customPrototype],
    [getter],
    Array.from({ length: 10001 }, () => null),
    ['x'.repeat((5 * 1024 * 1024) + 1)],
  ]
  for (const data of invalidInputs) {
    resetFixtures()
    await assert.rejects(
      methods.get('outboundinterfaces.run').run.call(
        { userId: 'member' }, { _id: 'outbound-1', data },
      ),
      (error) => error.error === 'interface-invalid-data'
        && error.reason === 'Interface data is invalid.',
    )
    assert.equal(globalThis.__interfaceVmOptions.length, 0)
  }
})

test('authenticated interface listings use future-safe inclusion projections', async () => {
  resetFixtures()
  assert.deepEqual(await methods.get('inboundinterfaces.get').run.call({ userId: 'member' }), [{
    _id: 'inbound-1', name: 'Inbound', description: 'Tasks', active: true,
  }])
  assert.deepEqual(inboundInterfaces.calls[0].options.fields, {
    name: 1, description: 1, active: 1,
  })
  assert.deepEqual(await methods.get('outboundinterfaces.get').run.call({ userId: 'member' }), [{
    _id: 'outbound-1', name: 'Outbound', description: 'Export',
    faIcon: 'fa-download', active: true,
  }])
  assert.deepEqual(outboundInterfaces.calls[0].options.fields, {
    name: 1, description: 1, faIcon: 1, active: 1,
  })
})

test('legacy script interfaces are unavailable and cannot be activated without opt-in', async () => {
  resetFixtures()
  globalThis.__unsafeLegacyScriptsAllowed = false

  assert.deepEqual(
    await methods.get('inboundinterfaces.get').run.call({ userId: 'member' }),
    [],
  )
  assert.deepEqual(
    await methods.get('outboundinterfaces.get').run.call({ userId: 'member' }),
    [],
  )
  for (const [name, args] of [
    ['inboundinterfaces.getTasks', { _id: 'inbound-1', projectId: 'project-1' }],
    ['outboundinterfaces.run', { _id: 'outbound-1', data: [] }],
    ['inboundinterfaces.insert', {
      name: 'Blocked', description: '', processData: 'return []', active: true,
    }],
    ['outboundinterfaces.insert', {
      name: 'Blocked', description: '', processData: 'return true', active: true,
    }],
  ]) {
    await assert.rejects(
      methods.get(name).run.call({ userId: 'member' }, args),
      (error) => error.error === 'unsafe-legacy-script-disabled',
      name,
    )
  }
  assert.equal(globalThis.__interfaceVmOptions.length, 0)
  assert.equal(inboundInterfaces.calls.length, 0)
  assert.equal(outboundInterfaces.calls.length, 0)
})
