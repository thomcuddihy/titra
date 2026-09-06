import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  ACTION_VERIFICATION_RECOVERY_METHODS,
  actionVerificationBlocksAccess,
  authorizeMethodAuthentication,
  authorizedAuthenticationUser,
  guardPublicationAuthentication,
  isActionVerificationRecoveryMethod,
  isPublicationContext,
} from './publicationAuthentication.js'

function projectedDocument(document, fields) {
  const projected = {}
  Object.entries(fields).forEach(([path, included]) => {
    if (included !== 1) return
    const parts = path.split('.')
    let value = document
    for (const part of parts) value = value?.[part]
    if (value === undefined) return
    let target = projected
    parts.forEach((part, index) => {
      if (index === parts.length - 1) target[part] = structuredClone(value)
      else {
        target[part] ??= {}
        target = target[part]
      }
    })
  })
  return projected
}

class FakeUsers {
  constructor(user) {
    this.user = user
    this.findCalls = []
    this.findOneCalls = []
    this.observers = new Set()
    this.attachError = undefined
    this.beforeAttachReturns = undefined
  }

  async findOneAsync(selector, options) {
    this.findOneCalls.push({ selector, options })
    if (this.user?._id !== selector._id) return undefined
    return projectedDocument(this.user, options.fields)
  }

  find(selector, options) {
    this.findCalls.push({ selector, options })
    return {
      observeChangesAsync: async (callbacks) => {
        if (this.attachError) throw this.attachError
        const observer = { callbacks }
        this.observers.add(observer)
        if (this.user && this.user._id === selector._id) {
          const { _id } = this.user
          callbacks.added(_id, {
            ...projectedDocument(this.user, options.fields),
          })
        }
        if (this.beforeAttachReturns) await this.beforeAttachReturns(this)
        return { stop: () => this.observers.delete(observer) }
      },
    }
  }

  replace(user) {
    const previous = this.user
    this.user = user
    this.observers.forEach(({ callbacks }) => {
      if (!previous && user) callbacks.added(user._id, user)
      else if (previous && !user) callbacks.removed(previous._id)
      else callbacks.changed(user._id, {
        inactive: user.inactive,
        isAdmin: user.isAdmin,
        actionVerification: user.actionVerification,
      })
    })
  }
}

function publicationContext(userId) {
  const stopCallbacks = []
  return {
    userId,
    stopCalls: 0,
    onStopCalls: 0,
    onStop(callback) {
      this.onStopCalls += 1
      stopCallbacks.push(callback)
    },
    async stop() {
      if (this.stopped) return
      this.stopped = true
      this.stopCalls += 1
      await Promise.all(stopCallbacks.map((callback) => callback()))
    },
  }
}

test('authorization requires an existing exact active user and the requested role', () => {
  assert.equal(authorizedAuthenticationUser(undefined, 'user'), false)
  assert.equal(authorizedAuthenticationUser({ _id: 'other' }, 'user'), false)
  assert.equal(authorizedAuthenticationUser({ _id: 'user', inactive: true }, 'user'), false)
  assert.equal(authorizedAuthenticationUser({ _id: 'user' }, 'user'), true)
  assert.equal(authorizedAuthenticationUser({ _id: 'user' }, 'user', true), false)
  assert.equal(authorizedAuthenticationUser({ _id: 'user', isAdmin: true }, 'user', true), true)
})

test('verification policy allows pending and completed users but blocks overdue or malformed state', () => {
  const now = new Date('2026-09-03T00:00:00.000Z')
  for (const user of [
    { _id: 'user' },
    { _id: 'user', actionVerification: { required: false } },
    {
      _id: 'user',
      actionVerification: {
        required: true, completed: false, deadline: new Date('2026-09-03T00:00:00.001Z'),
      },
    },
    {
      _id: 'user',
      actionVerification: {
        required: true, completed: true, deadline: new Date('2020-01-01T00:00:00.000Z'),
      },
    },
  ]) assert.equal(actionVerificationBlocksAccess(user, now), false)

  for (const actionVerification of [
    { required: true, completed: false, deadline: new Date('2026-09-02T23:59:59.999Z') },
    { required: true, completed: false, deadline: '2026-09-02T23:59:59.999Z' },
    { required: true, completed: false },
    { required: true, completed: 'true', deadline: new Date(Number.NaN) },
  ]) {
    assert.equal(actionVerificationBlocksAccess({ _id: 'user', actionVerification }, now), true)
  }
})

test('only verification-screen recovery methods bypass an overdue deadline', async () => {
  assert.deepEqual(ACTION_VERIFICATION_RECOVERY_METHODS, [
    'getUserVerificationStatus',
    'getUserVerificationUrl',
    'webhookverification.getdefaulttype',
  ])
  ACTION_VERIFICATION_RECOVERY_METHODS.forEach((name) => {
    assert.equal(isActionVerificationRecoveryMethod(name), true)
  })
  assert.equal(isActionVerificationRecoveryMethod('updateProfile'), false)

  const users = new FakeUsers({
    _id: 'user',
    actionVerification: {
      required: true,
      completed: false,
      deadline: new Date('2000-01-01T00:00:00.000Z'),
    },
  })
  assert.equal(await authorizeMethodAuthentication({
    context: { userId: 'user' }, users,
  }), false)
  assert.equal(await authorizeMethodAuthentication({
    context: { userId: 'user' },
    users,
    allowActionVerificationRecovery: true,
  }), true)
})

test('method authentication rejects a deleted user and uses least-privilege lookups', async () => {
  const users = new FakeUsers(undefined)
  assert.equal(await authorizeMethodAuthentication({
    context: { userId: 'deleted' }, users,
  }), false)
  assert.deepEqual(users.findOneCalls, [{
    selector: { _id: 'deleted' },
    options: {
      fields: {
        _id: 1,
        inactive: 1,
        'actionVerification.required': 1,
        'actionVerification.completed': 1,
        'actionVerification.deadline': 1,
      },
    },
  }])

  users.user = { _id: 'admin', inactive: false, isAdmin: true, services: { secret: true } }
  assert.equal(await authorizeMethodAuthentication({
    context: { userId: 'admin' }, users, requireAdmin: true,
  }), true)
  assert.deepEqual(users.findOneCalls[1], {
    selector: { _id: 'admin' },
    options: {
      fields: {
        _id: 1,
        inactive: 1,
        isAdmin: 1,
        'actionVerification.required': 1,
        'actionVerification.completed': 1,
        'actionVerification.deadline': 1,
      },
    },
  })
})

test('overdue and malformed verification states stop ordinary publications', async () => {
  for (const deadline of [
    new Date('2000-01-01T00:00:00.000Z'),
    'not-a-date',
    undefined,
  ]) {
    const users = new FakeUsers({
      _id: 'user',
      actionVerification: { required: true, completed: false, deadline },
    })
    const context = publicationContext('user')
    assert.equal(await guardPublicationAuthentication({ context, users }), false)
    assert.equal(context.stopCalls, 1)
    assert.equal(users.observers.size, 0)
  }
})

test('an active publication is revoked when its verification deadline becomes overdue', async () => {
  const users = new FakeUsers({
    _id: 'user',
    actionVerification: {
      required: true,
      completed: false,
      deadline: new Date('2999-01-01T00:00:00.000Z'),
    },
  })
  const context = publicationContext('user')
  assert.equal(await guardPublicationAuthentication({ context, users }), true)
  users.replace({
    _id: 'user',
    actionVerification: {
      required: true,
      completed: false,
      deadline: new Date('2000-01-01T00:00:00.000Z'),
    },
  })
  assert.equal(context.stopCalls, 1)
  assert.equal(users.observers.size, 0)
})

test('active publication is stopped and its observer cleaned up on inactivity or removal', async () => {
  for (const replacement of [{ _id: 'user', inactive: true }, undefined]) {
    const users = new FakeUsers({ _id: 'user', inactive: false })
    const context = publicationContext('user')
    assert.equal(await guardPublicationAuthentication({ context, users }), true)
    assert.equal(users.observers.size, 1)
    users.replace(replacement)
    assert.equal(context.stopCalls, 1)
    assert.equal(users.observers.size, 0)
  }
})

test('administrator publication stops immediately on live demotion', async () => {
  const users = new FakeUsers({ _id: 'admin', isAdmin: true })
  const context = publicationContext('admin')
  assert.equal(await guardPublicationAuthentication({
    context, users, requireAdmin: true,
  }), true)
  users.replace({ _id: 'admin', isAdmin: false })
  assert.equal(context.stopCalls, 1)
  assert.equal(users.observers.size, 0)
})

test('authorization changes during observer attachment fail closed without leaking a handle', async () => {
  const users = new FakeUsers({ _id: 'user', inactive: false })
  users.beforeAttachReturns = async (collection) => {
    collection.replace({ _id: 'user', inactive: true })
  }
  const context = publicationContext('user')
  assert.equal(await guardPublicationAuthentication({ context, users }), false)
  assert.equal(context.stopCalls, 1)
  assert.equal(users.observers.size, 0)
})

test('initially missing, inactive, and non-admin publication users fail closed', async () => {
  for (const { user, requireAdmin = false } of [
    { user: undefined },
    { user: { _id: 'user', inactive: true } },
    { user: { _id: 'user', isAdmin: false }, requireAdmin: true },
  ]) {
    const users = new FakeUsers(user)
    const context = publicationContext('user')
    assert.equal(await guardPublicationAuthentication({
      context, users, requireAdmin,
    }), false)
    assert.equal(context.stopCalls, 1)
    assert.equal(users.observers.size, 0)
  }
})

test('observer startup rejection stops the publication and preserves the database error', async () => {
  const users = new FakeUsers({ _id: 'user' })
  users.attachError = new Error('observer failed')
  const context = publicationContext('user')
  await assert.rejects(
    guardPublicationAuthentication({ context, users }),
    /observer failed/,
  )
  assert.equal(context.stopCalls, 1)
  assert.equal(users.observers.size, 0)
})

test('unsubscribe during observer startup stops the late handle', async () => {
  let releaseAttach
  const attachPending = new Promise((resolve) => { releaseAttach = resolve })
  const users = new FakeUsers({ _id: 'user' })
  users.beforeAttachReturns = () => attachPending
  const context = publicationContext('user')
  const authorization = guardPublicationAuthentication({ context, users })
  await Promise.resolve()
  assert.equal(users.observers.size, 1)
  await context.stop()
  releaseAttach()
  assert.equal(await authorization, false)
  assert.equal(users.observers.size, 0)
})

test('method contexts remain one-shot and never allocate a publication observer', async () => {
  const users = new FakeUsers({ _id: 'user' })
  const methodContext = { userId: 'user', connection: {} }
  assert.equal(isPublicationContext(methodContext), false)
  assert.equal(await guardPublicationAuthentication({
    context: methodContext, users,
  }), undefined)
  assert.equal(users.findCalls.length, 0)

  const helpers = readFileSync(new URL('./server_method_helpers.js', import.meta.url), 'utf8')
  assert.match(helpers, /guardPublicationAuthentication/)
  assert.match(helpers, /authorizeMethodAuthentication/)
  assert.match(helpers, /isActionVerificationRecoveryMethod\(methodOptions\.name\)/)
  assert.match(helpers, /allowActionVerificationRecovery/)
})

test('repeated and upgraded checks install exactly one bounded observer per subscription', async () => {
  const users = new FakeUsers({ _id: 'admin', isAdmin: true })
  const context = publicationContext('admin')
  assert.deepEqual(await Promise.all([
    guardPublicationAuthentication({ context, users }),
    guardPublicationAuthentication({ context, users, requireAdmin: true }),
    guardPublicationAuthentication({ context, users }),
  ]), [true, true, true])
  assert.equal(users.findCalls.length, 1)
  assert.deepEqual(users.findCalls[0], {
    selector: { _id: 'admin' },
    options: {
      fields: {
        inactive: 1,
        isAdmin: 1,
        'actionVerification.required': 1,
        'actionVerification.completed': 1,
        'actionVerification.deadline': 1,
      },
    },
  })
  assert.equal(context.onStopCalls, 1)
  assert.equal(users.observers.size, 1)
  await context.stop()
  assert.equal(users.observers.size, 0)
})
