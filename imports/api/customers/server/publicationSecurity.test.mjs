import assert from 'node:assert/strict'
import test from 'node:test'
import { createPublicationReconciler } from '../../../utils/reactivePublication.js'
import {
  customerPublicationDocuments,
  normalizeProjectCustomerOptions,
  normalizeRequestedProjectIds,
} from './publicationSecurity.js'

test('project scopes accept exact all or bounded unique string IDs', () => {
  assert.equal(normalizeRequestedProjectIds('all'), null)
  assert.deepEqual(normalizeRequestedProjectIds('p1'), ['p1'])
  assert.deepEqual(normalizeRequestedProjectIds(['p1', 'p2']), ['p1', 'p2'])
  assert.equal(normalizeRequestedProjectIds(['p1', 'p1']), undefined)
  assert.equal(normalizeRequestedProjectIds(['all']), undefined)
  assert.equal(normalizeRequestedProjectIds(['p1', 2]), undefined)
  assert.equal(normalizeRequestedProjectIds([]), undefined)
  assert.equal(
    normalizeRequestedProjectIds(Array.from({ length: 1001 }, (_, i) => `p${i}`)),
    undefined,
  )
  assert.equal(normalizeRequestedProjectIds('x'.repeat(129)), undefined)
})

test('project customer options are exact before publication work starts', () => {
  assert.deepEqual(normalizeProjectCustomerOptions({ projectId: 'p1' }), ['p1'])
  for (const options of [
    undefined,
    {},
    { projectId: 'p1', extra: true },
    { projectId: Array.from({ length: 1001 }, (_, index) => `p${index}`) },
  ]) assert.equal(normalizeProjectCustomerOptions(options), undefined)
})

test('customer names require current project access and active caller', () => {
  const projects = new Map([
    ['owned', { _id: 'owned', userId: 'caller', customer: 'Alpha' }],
    ['administered', { _id: 'administered', admins: ['caller'], customer: 'Beta' }],
    ['team', { _id: 'team', team: ['caller'], customer: 'Alpha' }],
    ['public', { _id: 'public', public: true, customer: 'Public' }],
    ['private', { _id: 'private', userId: 'other', customer: 'Secret' }],
    ['oversized', { _id: 'oversized', userId: 'caller', customer: 'x'.repeat(501) }],
  ])
  const active = customerPublicationDocuments({
    projects, user: { _id: 'caller' }, userId: 'caller',
  })
  assert.deepEqual([...active], [
    ['Alpha', { name: 'Alpha' }],
    ['Beta', { name: 'Beta' }],
  ])
  assert.deepEqual(customerPublicationDocuments({
    projects, user: { _id: 'caller', inactive: true }, userId: 'caller',
  }), new Map())
})

test('membership/customer changes retract synthetic customer rows', () => {
  const events = []
  const reconciler = createPublicationReconciler({
    collectionName: 'customers',
    added: (...args) => events.push(['added', ...args]),
    changed: (...args) => events.push(['changed', ...args]),
    removed: (...args) => events.push(['removed', ...args]),
  })
  const projects = new Map([['p1', {
    _id: 'p1', team: ['caller'], customer: 'Visible',
  }]])
  const desired = () => customerPublicationDocuments({
    projects, user: { _id: 'caller' }, userId: 'caller',
  })
  reconciler.reconcile(desired())
  projects.set('p1', { _id: 'p1', team: [], customer: 'Visible' })
  reconciler.reconcile(desired())
  projects.set('p1', { _id: 'p1', team: ['caller'], customer: 'Renamed' })
  reconciler.reconcile(desired())
  assert.deepEqual(events, [
    ['added', 'customers', 'Visible', { name: 'Visible' }],
    ['removed', 'customers', 'Visible'],
    ['added', 'customers', 'Renamed', { name: 'Renamed' }],
  ])
})
