import { Meteor } from 'meteor/meteor'
import { DDPRateLimiter } from 'meteor/ddp-rate-limiter'
import Projects from '../../projects/projects.js'
import { checkAuthentication } from '../../../utils/server_method_helpers.js'
import {
  applyObserverChange,
  createPublicationReconciler,
} from '../../../utils/reactivePublication.js'
import {
  customerPublicationDocuments,
  normalizeProjectCustomerOptions,
} from './publicationSecurity.js'
import { createActivePublicationGate } from '../../../utils/activePublicationGate.js'
import {
  MAX_CUSTOMER_PROJECTS,
  customerProjectFields,
} from './customerReadLimits.js'

const customerPublicationGate = createActivePublicationGate({
  perUser: 20,
  perPeer: 50,
  total: 500,
})

DDPRateLimiter.addRule({
  type: 'subscription',
  name: 'projectCustomers',
  userId(userId) { return typeof userId === 'string' && userId.length > 0 },
}, 60, 60 * 1000)
DDPRateLimiter.addRule({
  type: 'subscription',
  name: 'projectCustomers',
  clientAddress(clientAddress) {
    return typeof clientAddress === 'string' && clientAddress.length > 0
  },
}, 120, 60 * 1000)

function acquireCustomerPublicationSlot(context) {
  const release = customerPublicationGate.acquire({
    userId: context.userId,
    peerAddress: context.connection?.clientAddress,
  })
  if (!release) {
    throw new Meteor.Error(
      'subscription-limit',
      'Too many active customer subscriptions. Close another view and try again.',
    )
  }
  context.onStop(release)
}

function observerCallbacks(documents, reconcile) {
  return {
    added(id, fields) {
      documents.set(id, { _id: id, ...fields })
      reconcile()
    },
    changed(id, fields) {
      applyObserverChange(documents, id, fields)
      reconcile()
    },
    removed(id) {
      documents.delete(id)
      reconcile()
    },
  }
}

/**
 * Publish unique customer names only from the requested projects the active
 * caller can currently view. Access/customer changes retract stale names.
 */
Meteor.publish('projectCustomers', async function projectCustomers(options = {}) {
  const requestedIds = normalizeProjectCustomerOptions(options)
  if (requestedIds === undefined) {
    throw new Meteor.Error('invalid-project-scope', 'Project scope is invalid')
  }
  await checkAuthentication(this)
  acquireCustomerPublicationSlot(this)
  const users = new Map()
  const projects = new Map()
  const reconciler = createPublicationReconciler({
    collectionName: 'customers',
    added: (...args) => this.added(...args),
    changed: (...args) => this.changed(...args),
    removed: (...args) => this.removed(...args),
  })
  let initialized = false
  let stopped = false
  let failed = false
  let userHandle
  let projectHandle
  const failPublication = () => {
    if (stopped || failed) return
    failed = true
    reconciler.removeAll()
    this.error(new Meteor.Error(
      'customer-project-limit',
      `Customer subscriptions may not span more than ${MAX_CUSTOMER_PROJECTS} projects.`,
    ))
  }
  const reconcile = () => {
    if (!initialized || stopped || failed) return
    if (projects.size > MAX_CUSTOMER_PROJECTS) {
      failPublication()
      return
    }
    const exactScopeVisible = requestedIds === null || projects.size === requestedIds.length
    reconciler.reconcile(exactScopeVisible ? customerPublicationDocuments({
      projects,
      user: users.get(this.userId),
      userId: this.userId,
    }) : new Map())
  }
  this.onStop(() => {
    stopped = true
    if (userHandle) userHandle.stop()
    if (projectHandle) projectHandle.stop()
  })
  userHandle = await Meteor.users.find({ _id: this.userId }, {
    fields: { inactive: 1 },
    limit: 1,
  }).observeChangesAsync(observerCallbacks(users, reconcile))
  if (stopped || failed) {
    userHandle.stop()
    return undefined
  }
  const requestedSelector = requestedIds === null ? {} : { _id: { $in: requestedIds } }
  projectHandle = await Projects.find({
    ...requestedSelector,
    $or: [
      { userId: this.userId },
      { admins: this.userId },
      { team: this.userId },
    ],
  }, {
    fields: customerProjectFields,
    sort: { _id: 1 },
    limit: MAX_CUSTOMER_PROJECTS + 1,
  }).observeChangesAsync(observerCallbacks(projects, reconcile))
  if (stopped || failed) {
    userHandle.stop()
    projectHandle.stop()
    return undefined
  }
  initialized = true
  reconcile()
  if (!failed) return this.ready()
  return undefined
})
