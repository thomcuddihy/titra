import assert from 'node:assert/strict'
import test from 'node:test'

import { createPublicationReconciler } from '../../../utils/reactivePublication.js'
import {
  DEFAULT_ADMIN_USER_LIMIT,
  MAX_ADMIN_USER_LIMIT,
  MAX_ADMIN_USER_SEARCH_CHARS,
  adminUserListDocuments,
  adminUserListLimit,
  adminUserListSelector,
} from './adminUserListSecurity.js'

const sourceUsers = new Map([['listed-user', {
  _id: 'listed-user',
  profile: {
    name: 'Listed User', avatar: 'avatar-data', avatarColor: '#123456',
    apiToken: 'must-not-publish',
  },
  emails: [{ address: 'listed@example.test', verified: true }],
  isAdmin: false,
  inactive: false,
  createdAt: new Date('2026-09-01T00:00:00.000Z'),
  services: { password: { bcrypt: 'must-not-publish' } },
}]])

test('admin user rows contain only fields consumed by the administration UI', () => {
  const documents = adminUserListDocuments({
    user: { _id: 'admin', isAdmin: true }, userId: 'admin', documents: sourceUsers,
  })
  assert.deepEqual(documents.get('listed-user'), {
    profile: { name: 'Listed User', avatar: 'avatar-data', avatarColor: '#123456' },
    emails: [{ address: 'listed@example.test' }],
    isAdmin: false,
    inactive: false,
    createdAt: new Date('2026-09-01T00:00:00.000Z'),
  })
  const serialized = JSON.stringify([...documents])
  assert.equal(serialized.includes('apiToken'), false)
  assert.equal(serialized.includes('bcrypt'), false)
  assert.equal(serialized.includes('verified'), false)
})

test('live demotion and inactivity reconcile away every admin user row', () => {
  const events = []
  const reconciler = createPublicationReconciler({
    collectionName: 'users',
    added: (...args) => events.push(['added', ...args]),
    changed: (...args) => events.push(['changed', ...args]),
    removed: (...args) => events.push(['removed', ...args]),
  })
  const desired = (user) => adminUserListDocuments({
    user, userId: 'admin', documents: sourceUsers,
  })
  reconciler.reconcile(desired({ _id: 'admin', isAdmin: true }))
  reconciler.reconcile(desired({ _id: 'admin', isAdmin: false }))
  reconciler.reconcile(desired({ _id: 'admin', isAdmin: true, inactive: true }))
  assert.deepEqual(events.map(([kind, collection, id]) => [kind, collection, id]), [
    ['added', 'users', 'listed-user'],
    ['removed', 'users', 'listed-user'],
  ])
})

test('admin user list bounds limits and treats search input as literal text', () => {
  assert.equal(adminUserListLimit(undefined), DEFAULT_ADMIN_USER_LIMIT)
  assert.equal(adminUserListLimit(0), 1)
  assert.equal(adminUserListLimit(500), MAX_ADMIN_USER_LIMIT)
  assert.equal(adminUserListLimit(10.5), DEFAULT_ADMIN_USER_LIMIT)

  const malicious = '[a-z]+(x)?\\.*'.repeat(100)
  const selector = adminUserListSelector(malicious)
  const pattern = selector.$or[0]['profile.name'].$regex
  assert.ok(pattern.length <= MAX_ADMIN_USER_SEARCH_CHARS * 2)
  assert.doesNotThrow(() => new RegExp(pattern, 'i'))
  assert.equal(new RegExp(pattern, 'i').test(malicious.slice(0, MAX_ADMIN_USER_SEARCH_CHARS)), true)
  assert.deepEqual(adminUserListSelector(''), {})
})
