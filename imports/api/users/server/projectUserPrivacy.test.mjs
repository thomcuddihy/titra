import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ADMIN_USER_LIST_FIELDS,
  allowedProjectResourceUserIds,
  canViewDashboardResource,
  dashboardUserPublicationDocuments,
  projectResourcesPublicationDocuments,
  projectRole,
  projectTeamPublicationDocuments,
  projectUsersPublicationDocuments,
  publicNameOnlyUser,
  userSelectorForProjectAudience,
} from './projectUserPrivacy.js'
import { createPublicationReconciler } from '../../../utils/reactivePublication.js'

test('admin user list projection retains UI fields but no profile tokens or services', () => {
  assert.equal(ADMIN_USER_LIST_FIELDS['profile.name'], 1)
  assert.equal(ADMIN_USER_LIST_FIELDS['profile.avatar'], 1)
  assert.equal(ADMIN_USER_LIST_FIELDS['profile.avatarColor'], 1)
  assert.equal(ADMIN_USER_LIST_FIELDS['emails.address'], 1)
  assert.equal(ADMIN_USER_LIST_FIELDS.profile, undefined)
  assert.equal(ADMIN_USER_LIST_FIELDS['profile.APItoken'], undefined)
  assert.equal(ADMIN_USER_LIST_FIELDS.services, undefined)
})

const project = {
  userId: 'owner', admins: ['admin'], team: ['member'], public: true,
}

test('project audience distinguishes administrators, members and public viewers', () => {
  assert.equal(projectRole(project, 'owner'), 'owner')
  assert.equal(projectRole(project, 'admin'), 'admin')
  assert.equal(projectRole(project, 'member'), 'member')
  assert.equal(projectRole(project, 'viewer'), 'public')
  assert.equal(projectRole({ ...project, public: false }, 'viewer'), 'none')
  assert.deepEqual(userSelectorForProjectAudience(project, 'member')._id.$in.sort(),
    ['admin', 'member', 'owner'])
  assert.deepEqual(userSelectorForProjectAudience(project, 'viewer'), {
    _id: 'viewer', inactive: { $ne: true },
  })
})

test('resource identities follow each project audience and never widen public access', () => {
  const projects = [
    { _id: 'owned', userId: 'caller', team: [], admins: [] },
    { _id: 'member', userId: 'owner', team: ['caller'], admins: [] },
    { _id: 'public', userId: 'elsewhere', team: [], admins: [], public: true },
  ]
  const cards = [
    { projectId: 'owned', userId: 'any-active-user' },
    { projectId: 'member', userId: 'owner' },
    { projectId: 'member', userId: 'public-outsider' },
    { projectId: 'public', userId: 'caller' },
    { projectId: 'public', userId: 'private-person' },
  ]
  assert.deepEqual(allowedProjectResourceUserIds(projects, cards, 'caller').sort(),
    ['any-active-user', 'caller', 'owner'])
})

test('user projection contains only ID and display name', () => {
  assert.deepEqual(publicNameOnlyUser({
    _id: 'u1', profile: { name: 'Ada', apiToken: 'secret', timezone: 'UTC' },
    services: { password: { bcrypt: 'secret' } }, emails: [{ address: 'secret@example.test' }],
  }), { _id: 'u1', profile: { name: 'Ada' } })
  assert.equal(publicNameOnlyUser({ _id: 'u1', inactive: true, profile: { name: 'Ada' } }), null)
})

test('dashboard resource names require dashboard-project membership', () => {
  const dashboard = { projectId: 'p1', resourceId: 'resource' }
  const project = {
    _id: 'p1', userId: 'owner', admins: ['admin'], team: ['member'], public: true,
  }
  assert.equal(canViewDashboardResource(dashboard, project, 'owner'), true)
  assert.equal(canViewDashboardResource(dashboard, project, 'member'), true)
  assert.equal(canViewDashboardResource(dashboard, project, 'public-viewer'), false)
  assert.equal(canViewDashboardResource({ ...dashboard, projectId: 'other' }, project, 'owner'), false)
  assert.equal(canViewDashboardResource({ ...dashboard, resourceId: undefined }, project, 'owner'), false)
})

function recorder(collectionName) {
  const events = []
  const reconciler = createPublicationReconciler({
    collectionName,
    added: (...args) => events.push(['added', ...args]),
    changed: (...args) => events.push(['changed', ...args]),
    removed: (...args) => events.push(['removed', ...args]),
  })
  return { events, reconciler }
}

test('projectUsers updates names, downgrades member identities, then retracts on revoke', () => {
  const { events, reconciler } = recorder('projectUsers')
  const projects = new Map([['p1', {
    _id: 'p1', userId: 'owner', team: ['caller'], admins: [], public: true,
  }]])
  const cards = new Map([
    ['c1', { projectId: 'p1', userId: 'owner' }],
    ['c2', { projectId: 'p1', userId: 'caller' }],
  ])
  const users = new Map([
    ['owner', { _id: 'owner', profile: { name: 'Owner' } }],
    ['caller', { _id: 'caller', profile: { name: 'Caller' } }],
  ])
  const reconcile = () => reconciler.reconcile(projectUsersPublicationDocuments({
    publicationId: 'p1', projects, timecards: cards, users, callerUserId: 'caller',
  }))

  reconcile()
  users.set('owner', { _id: 'owner', profile: { name: 'Renamed owner' } })
  reconcile()
  projects.set('p1', { ...projects.get('p1'), team: [] })
  reconcile()
  projects.set('p1', { ...projects.get('p1'), public: false })
  reconcile()

  assert.deepEqual(events.map(([event, , id]) => [event, id]), [
    ['added', 'p1'], ['changed', 'p1'], ['changed', 'p1'], ['removed', 'p1'],
  ])
  assert.deepEqual(events[1][3].users.map((user) => user.profile.name), [
    'Caller', 'Renamed owner',
  ])
  assert.deepEqual(events[2][3].users.map((user) => user._id), ['caller'])
})

test('projectResources removes inactive names and cannot re-add after access revocation', () => {
  const { events, reconciler } = recorder('projectResources')
  const projects = new Map([['p1', {
    _id: 'p1', userId: 'owner', admins: ['caller'], team: [], public: false,
  }]])
  const cards = new Map([['c1', { projectId: 'p1', userId: 'worker' }]])
  const users = new Map([['worker', { _id: 'worker', profile: { name: 'Worker' } }]])
  const reconcile = () => reconciler.reconcile(projectResourcesPublicationDocuments({
    projects, timecards: cards, users, callerUserId: 'caller',
  }))

  reconcile()
  users.set('worker', { _id: 'worker', inactive: true, profile: { name: 'Worker' } })
  reconcile()
  users.set('worker', { _id: 'worker', profile: { name: 'Changed while hidden' } })
  projects.set('p1', { ...projects.get('p1'), admins: [] })
  reconcile()

  assert.deepEqual(events, [
    ['added', 'projectResources', 'worker', { name: 'Worker' }],
    ['removed', 'projectResources', 'worker'],
  ])
})

test('projectTeam and dashboardUser reconcile user changes and membership revocation', () => {
  const team = recorder('users')
  const dashboard = recorder('users')
  const projects = new Map([['p1', {
    _id: 'p1', userId: 'owner', admins: [], team: ['caller', 'resource'], public: true,
  }]])
  const users = new Map([['resource', {
    _id: 'resource', profile: { name: 'Resource' },
  }]])
  const dashboardRow = { _id: 'd1', projectId: 'p1', resourceId: 'resource' }
  const reconcile = () => {
    team.reconciler.reconcile(projectTeamPublicationDocuments({
      projects, users, requestedUserIds: ['resource'], callerUserId: 'caller',
    }))
    dashboard.reconciler.reconcile(dashboardUserPublicationDocuments({
      dashboard: dashboardRow, project: projects.get('p1'), users,
      callerUserId: 'caller',
    }))
  }

  reconcile()
  users.set('resource', { _id: 'resource', profile: { name: 'Renamed' } })
  reconcile()
  projects.set('p1', { ...projects.get('p1'), team: ['resource'] })
  reconcile()

  for (const events of [team.events, dashboard.events]) {
    assert.deepEqual(events, [
      ['added', 'users', 'resource', { profile: { name: 'Resource' } }],
      ['changed', 'users', 'resource', { profile: { name: 'Renamed' } }],
      ['removed', 'users', 'resource'],
    ])
  }
})
