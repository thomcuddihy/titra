import assert from 'node:assert/strict'
import test from 'node:test'

import {
  PERSONAL_SUGGESTION_FIELDS,
  PUBLIC_PROJECT_TASK_FIELDS,
  canViewProject,
  changedTaskFields,
  projectTaskFields,
  taskSearchPublicationDocuments,
  taskFieldsForCaller,
} from './publicationPrivacy.js'
import { createPublicationReconciler } from '../../../utils/reactivePublication.js'

test('public project tasks and personal suggestions have explicit allowlists', () => {
  assert.deepEqual(Object.keys(PUBLIC_PROJECT_TASK_FIELDS).sort(), [
    '_id', 'dependencies', 'end', 'estimatedHours', 'isDefaultTask', 'name',
    'projectId', 'start',
  ])
  assert.deepEqual(Object.keys(PERSONAL_SUGGESTION_FIELDS).sort(), [
    '_id', 'lastUsed', 'name', 'userId',
  ])
})

test('global public-project policy blocks non-members without blocking members', () => {
  const project = { _id: 'p1', userId: 'owner', team: ['member'], public: true }
  assert.equal(canViewProject(project, 'outsider'), true)
  assert.equal(canViewProject(project, 'outsider', true), false)
  assert.equal(canViewProject(project, 'member', true), true)
  const tasks = new Map([['task', { _id: 'task', projectId: 'p1', name: 'Plan' }]])
  assert.equal(taskSearchPublicationDocuments({
    tasks,
    project,
    projectId: 'p1',
    userId: 'outsider',
    publicDisabled: true,
  }).size, 0)
})

test('public task serialization strips custom fields and membership downgrade removes them', () => {
  const task = {
    _id: 't1', projectId: 'p1', name: 'Plan', start: new Date(),
    ticket: 'private-ticket', arbitraryFutureSecret: 'hidden',
  }
  const project = { userId: 'owner', team: ['caller'], public: true }
  const member = taskFieldsForCaller(task, project, 'caller', ['ticket'])
  assert.equal(member.ticket, 'private-ticket')
  assert.equal(member.arbitraryFutureSecret, undefined)
  const publicOnly = taskFieldsForCaller(task, { ...project, team: [] }, 'caller', ['ticket'])
  assert.equal(publicOnly.ticket, undefined)
  const changes = changedTaskFields(member, publicOnly)
  assert.equal(Object.prototype.hasOwnProperty.call(changes, 'ticket'), true)
  assert.equal(changes.ticket, undefined)
})

test('configured task fields accept only safe flattened names', () => {
  const fields = projectTaskFields({
    member: true, customFieldNames: ['ticket_id', 'nested.value', '$secret'],
  })
  assert.equal(fields.ticket_id, 1)
  assert.equal(fields['nested.value'], undefined)
  assert.equal(fields.$secret, undefined)
})

test('mytasks keeps personal rows while downgrading then revoking project tasks', () => {
  const events = []
  const reconciler = createPublicationReconciler({
    collectionName: 'tasks',
    added: (...args) => events.push(['added', ...args]),
    changed: (...args) => events.push(['changed', ...args]),
    removed: (...args) => events.push(['removed', ...args]),
  })
  const tasks = new Map([
    ['personal', { _id: 'personal', userId: 'caller', name: 'Remember me' }],
    ['project-task', {
      _id: 'project-task', projectId: 'p1', name: 'Private work', ticket: 'secret',
    }],
  ])
  let project = { _id: 'p1', userId: 'owner', team: ['caller'], public: true }
  const reconcile = () => reconciler.reconcile(taskSearchPublicationDocuments({
    tasks, project, projectId: 'p1', userId: 'caller', customFieldNames: ['ticket'],
  }))

  reconcile()
  project = { ...project, team: [] }
  reconcile()
  project = { ...project, public: false }
  reconcile()
  tasks.set('late-project-task', {
    _id: 'late-project-task', projectId: 'p1', name: 'Must not leak', ticket: 'late-secret',
  })
  reconcile()

  assert.deepEqual(events, [
    ['added', 'tasks', 'personal', { userId: 'caller', name: 'Remember me' }],
    ['added', 'tasks', 'project-task', {
      projectId: 'p1', name: 'Private work', ticket: 'secret',
    }],
    ['changed', 'tasks', 'project-task', { ticket: undefined }],
    ['removed', 'tasks', 'project-task'],
  ])
})
