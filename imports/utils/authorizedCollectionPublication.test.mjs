import assert from 'node:assert/strict'
import test from 'node:test'
import { createPublicationReconciler } from './reactivePublication.js'
import {
  authorizedCollectionDocuments,
  authorizedUser,
} from './authorizedCollectionPublication.js'
import { CUSTOM_FIELD_CLIENT_FIELDS, userCustomFieldClass } from '../api/customfields/server/publicationSecurity.js'
import { NOTIFICATION_CLIENT_FIELDS } from '../api/notifications/server/publicationSecurity.js'

test('authorization requires the exact active user and optional live admin role', () => {
  assert.equal(authorizedUser({ _id: 'u1' }, 'u1'), true)
  assert.equal(authorizedUser({ _id: 'u1', inactive: true }, 'u1'), false)
  assert.equal(authorizedUser({ _id: 'other', isAdmin: true }, 'u1', true), false)
  assert.equal(authorizedUser({ _id: 'u1' }, 'u1', true), false)
  assert.equal(authorizedUser({ _id: 'u1', isAdmin: true }, 'u1', true), true)
})

test('exact projection excludes future collection fields', () => {
  const documents = new Map([['n1', {
    _id: 'n1', userId: 'u1', message: 'hello', futureSecret: 'hidden',
  }]])
  const visible = authorizedCollectionDocuments({
    documents,
    fields: NOTIFICATION_CLIENT_FIELDS,
    user: { _id: 'u1' },
    userId: 'u1',
  })
  assert.deepEqual(visible, new Map([['n1', { userId: 'u1', message: 'hello' }]]))

  const defensive = authorizedCollectionDocuments({
    documents,
    fields: {
      userId: 1, message: true, futureSecret: 2, excluded: 0,
    },
    user: { _id: 'u1' },
    userId: 'u1',
  })
  assert.deepEqual(defensive, new Map([['n1', { userId: 'u1' }]]))
})

test('live inactivity/demotion removes previously published documents', () => {
  const events = []
  const reconciler = createPublicationReconciler({
    collectionName: 'customfields',
    added: (...args) => events.push(['added', ...args]),
    changed: (...args) => events.push(['changed', ...args]),
    removed: (...args) => events.push(['removed', ...args]),
  })
  const documents = new Map([['field', {
    _id: 'field', classname: 'project', name: 'Code', secret: 'hidden',
  }]])
  const desired = (user) => authorizedCollectionDocuments({
    documents,
    fields: CUSTOM_FIELD_CLIENT_FIELDS,
    user,
    userId: 'admin',
    requireAdmin: true,
  })
  reconciler.reconcile(desired({ _id: 'admin', isAdmin: true }))
  reconciler.reconcile(desired({ _id: 'admin', isAdmin: false }))
  assert.deepEqual(events, [
    ['added', 'customfields', 'field', { classname: 'project', name: 'Code' }],
    ['removed', 'customfields', 'field'],
  ])
})

test('ordinary custom-field subscriptions cannot request global-setting metadata', () => {
  for (const classname of ['project', 'task', 'time_entry']) {
    assert.equal(userCustomFieldClass(classname), true)
  }
  for (const classname of ['global_setting', 'users', '', undefined]) {
    assert.equal(userCustomFieldClass(classname), false)
  }
})
