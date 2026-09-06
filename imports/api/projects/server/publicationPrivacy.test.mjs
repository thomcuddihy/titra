import assert from 'node:assert/strict'
import test from 'node:test'

import {
  changedProjectFields,
  PUBLIC_PROJECT_FIELDS,
  projectFields,
  projectFieldsForCaller,
  projectMembershipSelector,
  projectStatsForCaller,
  projectStatsPublicationDocuments,
  publicNonmemberSelector,
} from './publicationPrivacy.js'
import { createPublicationReconciler } from '../../../utils/reactivePublication.js'

test('public DDP project projection matches the least-disclosure contract', () => {
  assert.deepEqual(Object.keys(PUBLIC_PROJECT_FIELDS).sort(), [
    '_id', 'archived', 'color', 'desc', 'description', 'endDate', 'name',
    'notbillable', 'public', 'startDate',
  ])
  const fields = projectFields({ member: false, customFieldNames: ['secret'] })
  for (const hidden of [
    'userId', 'team', 'admins', 'customer', 'budget', 'target', 'rate', 'rates',
    'defaultTask', 'priority', 'selectedWekanList', 'selectedWekanSwimlanes',
    'wekanurl', 'gitlabquery', 'projectRevision', 'secret',
  ]) assert.equal(fields[hidden], undefined)
})

test('public serialization strips secrets and a membership downgrade removes prior fields', () => {
  const memberProject = {
    _id: 'p1', userId: 'owner', team: ['caller'], public: true,
    name: 'Visible', color: '#abcdef', customer: 'Secret customer', rate: 400,
    rates: { caller: 500 }, wekanurl: 'https://example/?authToken=secret',
    gitlabquery: 'private query', cost_code: 'ABC', lifecycleLock: { lockId: 'hidden' },
  }
  const member = projectFieldsForCaller(memberProject, 'caller', ['cost_code'])
  assert.equal(member.wekanurl, undefined)
  assert.equal(member.cost_code, 'ABC')
  assert.equal(member.lifecycleLock, undefined)

  const publicOnly = projectFieldsForCaller({ ...memberProject, team: [] }, 'caller', ['cost_code'])
  assert.deepEqual(publicOnly, { name: 'Visible', color: '#abcdef', public: true })
  const changes = changedProjectFields(member, publicOnly)
  assert.equal(changes.wekanurl, undefined)
  assert.equal(Object.prototype.hasOwnProperty.call(changes, 'wekanurl'), false)
  assert.equal(changes.rate, undefined)
  assert.equal(changes.name, undefined)
  assert.equal(Object.prototype.hasOwnProperty.call(changes, 'name'), false)
})

test('member projection retains fields used by existing clients and safe configured fields', () => {
  const fields = projectFields({
    member: true, customFieldNames: ['cost_code', 'nested.value', '$private'],
  })
  for (const required of [
    'userId', 'team', 'admins', 'customer', 'target', 'rate', 'rates',
    'defaultTask', 'selectedWekanList', 'selectedWekanSwimlanes',
    'gitlabquery', 'projectRevision', 'cost_code',
  ]) assert.equal(fields[required], 1)
  assert.equal(fields.wekanurl, undefined)
  assert.equal(fields['nested.value'], undefined)
  assert.equal(fields.$private, undefined)
  assert.equal(fields.lifecycleLock, undefined)
  assert.equal(fields.lifecycleWriters, undefined)
})

test('member and public selectors are deliberately disjoint', () => {
  assert.deepEqual(projectMembershipSelector('u1'), {
    $or: [{ userId: 'u1' }, { admins: 'u1' }, { team: 'u1' }],
  })
  assert.deepEqual(publicNonmemberSelector('u1'), {
    public: true,
    $nor: [{ userId: 'u1' }, { admins: 'u1' }, { team: 'u1' }],
  })
})

test('public project statistics omit billing totals while members retain them', () => {
  const totals = { totalHours: 8, totalRevenue: 1600, currentMonthHours: 8 }
  const project = { userId: 'owner', team: ['member'], public: true }
  assert.deepEqual(projectStatsForCaller(totals, project, 'public-viewer'), {
    totalHours: 8, currentMonthHours: 8,
  })
  assert.deepEqual(projectStatsForCaller(totals, project, 'member'), totals)
})

test('projectStats clears revenue on downgrade and retracts all stats on revocation', () => {
  const events = []
  const reconciler = createPublicationReconciler({
    collectionName: 'projectStats',
    added: (...args) => events.push(['added', ...args]),
    changed: (...args) => events.push(['changed', ...args]),
    removed: (...args) => events.push(['removed', ...args]),
  })
  const totals = { totalHours: 8, totalRevenue: 1600, currentMonthHours: 8 }
  const monthNames = { currentMonthName: 'Sep' }
  let project = { _id: 'p1', userId: 'owner', team: ['caller'], public: true }
  const reconcile = () => reconciler.reconcile(projectStatsPublicationDocuments({
    projectId: 'p1', project, totals, userId: 'caller', monthNames,
  }))

  reconcile()
  project = { ...project, team: [] }
  reconcile()
  project = { ...project, public: false }
  reconcile()
  totals.totalHours = 9
  totals.totalRevenue = 1800
  reconcile()

  assert.deepEqual(events, [
    ['added', 'projectStats', 'p1', {
      totalHours: 8, totalRevenue: 1600, currentMonthHours: 8,
      currentMonthName: 'Sep',
    }],
    ['changed', 'projectStats', 'p1', { totalRevenue: undefined }],
    ['removed', 'projectStats', 'p1'],
  ])
})
