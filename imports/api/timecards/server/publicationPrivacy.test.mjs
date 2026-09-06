import assert from 'node:assert/strict'
import test from 'node:test'

import {
  PUBLIC_TIMECARD_FIELDS,
  partitionVisibleProjectIds,
  projectIdsFromTimecardSelector,
  scopeSelectorToProjects,
  timecardCountPublicationDocuments,
  timecardFields,
  timecardFieldsForCaller,
  timecardPublicationDocuments,
  visibleProjectIds,
} from './publicationPrivacy.js'
import { createPublicationReconciler } from '../../../utils/reactivePublication.js'

function recordPublication(collectionName) {
  const events = []
  return {
    events,
    reconciler: createPublicationReconciler({
      collectionName,
      added: (...args) => events.push(['added', ...args]),
      changed: (...args) => events.push(['changed', ...args]),
      removed: (...args) => events.push(['removed', ...args]),
    }),
  }
}

test('public timecard projection is an exact least-disclosure allowlist', () => {
  assert.deepEqual(Object.keys(PUBLIC_TIMECARD_FIELDS).sort(), [
    '_id', 'date', 'hours', 'projectId', 'task', 'userId',
  ])
  assert.equal(timecardFields({ member: false }).taskRate, undefined)
  assert.equal(timecardFields({ member: false }).state, undefined)
  assert.equal(timecardFields({ member: false, customFieldNames: ['secret'] }).secret, undefined)
})

test('member projection includes documented billing and configured safe custom fields only', () => {
  const fields = timecardFields({
    member: true,
    customFieldNames: ['ticket', '$unsafe', 'nested.value', 'ok_field'],
  })
  assert.equal(fields.taskRate, 1)
  assert.equal(fields.state, 1)
  assert.equal(fields.ticket, 1)
  assert.equal(fields.ok_field, 1)
  assert.equal(fields.$unsafe, undefined)
  assert.equal(fields['nested.value'], undefined)
})

test('live access downgrade removes member-only timecard fields', () => {
  const timecard = {
    _id: 'tc1', projectId: 'p1', userId: 'someone-else', hours: 2,
    taskRate: 300, state: 'billed', ticket: 'private-ticket', futureSecret: true,
  }
  const memberProject = { _id: 'p1', userId: 'owner', team: ['caller'], public: true }
  const member = timecardFieldsForCaller(
    timecard, memberProject, 'caller', ['ticket'], false,
  )
  assert.equal(member.taskRate, 300)
  assert.equal(member.ticket, 'private-ticket')

  const publicOnly = timecardFieldsForCaller(
    timecard, { ...memberProject, team: [] }, 'caller', ['ticket'], false,
  )
  assert.deepEqual(publicOnly, {
    userId: 'someone-else', projectId: 'p1', hours: 2,
  })
  assert.equal(publicOnly.taskRate, undefined)
  assert.equal(publicOnly.ticket, undefined)
  assert.equal(publicOnly.futureSecret, undefined)
})

test('projects are partitioned without widening public nonmembers', () => {
  assert.deepEqual(partitionVisibleProjectIds([
    { _id: 'owned', userId: 'caller', public: true },
    { _id: 'admin', userId: 'other', admins: ['caller'] },
    { _id: 'team', userId: 'other', team: ['caller'] },
    { _id: 'public', userId: 'other', public: true },
    { _id: 'private', userId: 'other' },
  ], 'caller'), {
    member: ['owned', 'admin', 'team'], publicOnly: ['public'],
  })
})

test('selector project IDs can be extracted and safely intersected', () => {
  const selector = { $and: [{ projectId: { $in: ['p1', 'p2'] }, state: 'new' }, { task: 'x' }] }
  assert.deepEqual(projectIdsFromTimecardSelector(selector), ['p1', 'p2'])
  assert.deepEqual(scopeSelectorToProjects(selector, ['p1']), {
    $and: [selector, { projectId: { $in: ['p1'] } }],
  })
})

test('mixed private/public requests scope both data and counts to visible project IDs', () => {
  const requested = ['private', 'public', 'member']
  const projects = [
    { _id: 'private', userId: 'someone-else' },
    { _id: 'public', userId: 'someone-else', public: true },
    { _id: 'member', userId: 'owner', team: ['caller'] },
  ]
  const visible = visibleProjectIds(projects, 'caller')
  assert.deepEqual(visible.sort(), ['member', 'public'])
  const selector = scopeSelectorToProjects({ projectId: { $in: requested } }, visible)
  const rows = requested.filter((projectId) => selector.$and
    .every((part) => part.projectId.$in.includes(projectId)))
  assert.deepEqual(rows.sort(), ['member', 'public'])
  assert.equal(rows.length, 2, 'the count observes the same scoped selector as the data cursor')
})

test('live rows, count and single-record state reconcile downgrade and revocation', () => {
  const projects = new Map([['p1', {
    _id: 'p1', userId: 'owner', team: ['caller'], public: true,
  }]])
  const timecards = new Map([['tc1', {
    _id: 'tc1', projectId: 'p1', userId: 'other', hours: 2,
    taskRate: 300, ticket: 'member-only',
  }]])
  const rows = recordPublication('timecards')
  const single = recordPublication('timecards')
  const count = recordPublication('counts')
  const reconcile = () => {
    const options = {
      timecards, projects, userId: 'caller', customFieldNames: ['ticket'],
    }
    rows.reconciler.reconcile(timecardPublicationDocuments(options))
    single.reconciler.reconcile(timecardPublicationDocuments({
      ...options, includeOwnedRecords: true,
    }))
    count.reconciler.reconcile(timecardCountPublicationDocuments({
      timecards, projects, userId: 'caller', countsId: 'p1',
    }))
  }

  reconcile()
  projects.set('p1', { ...projects.get('p1'), team: [] })
  reconcile()
  projects.set('p1', { ...projects.get('p1'), public: false })
  reconcile()
  timecards.set('tc2', {
    _id: 'tc2', projectId: 'p1', userId: 'other', hours: 1, ticket: 'late-secret',
  })
  reconcile()

  for (const publication of [rows, single]) {
    assert.deepEqual(publication.events, [
      ['added', 'timecards', 'tc1', {
        projectId: 'p1', userId: 'other', hours: 2,
        taskRate: 300, ticket: 'member-only',
      }],
      ['changed', 'timecards', 'tc1', { taskRate: undefined, ticket: undefined }],
      ['removed', 'timecards', 'tc1'],
    ])
  }
  assert.deepEqual(count.events, [
    ['added', 'counts', 'p1', { count: 1 }],
    ['changed', 'counts', 'p1', { count: 0 }],
  ])
})
