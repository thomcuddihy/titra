import {
  applyObserverChange,
  createPublicationReconciler,
} from './reactivePublication.js'
import {
  createActivePublicationGate,
  createAnonymousPublicationGate,
} from './activePublicationGate.js'

const DEFAULT_REACTIVE_PUBLICATION_DOCUMENTS = 1000
const authenticatedCollectionGate = createActivePublicationGate({
  perUser: 30,
  perPeer: 75,
  total: 750,
})
const anonymousCollectionGate = createAnonymousPublicationGate({
  perPeer: 20,
  perResource: 100,
  total: 500,
})

// processData is executable server-side code. It remains visible only in these
// administrator-only publications because the existing administration editor
// must load it for an explicit edit. All other and future document fields stay
// excluded; a future write-only editor can remove this compatibility exception.
const INBOUND_ADMIN_INTERFACE_FIELDS = Object.freeze({
  name: 1,
  description: 1,
  processData: 1,
  active: 1,
})

const OUTBOUND_ADMIN_INTERFACE_FIELDS = Object.freeze({
  ...INBOUND_ADMIN_INTERFACE_FIELDS,
  faIcon: 1,
})

function publicationLimitError(code, message) {
  return Object.assign(new Error(message), { error: code })
}

function acquireReactiveCollectionSlot(context, collectionName) {
  const request = { peerAddress: context.connection?.clientAddress }
  const release = typeof context.userId === 'string' && context.userId
    ? authenticatedCollectionGate.acquire({ ...request, userId: context.userId })
    : anonymousCollectionGate.acquire({ ...request, resourceId: collectionName })
  if (!release) {
    throw publicationLimitError(
      'subscription-limit',
      'Too many active collection subscriptions. Close another view and try again.',
    )
  }
  context.onStop(release)
}

function activeAdministrator(user, userId) {
  return user?._id === userId && user.isAdmin === true && user.inactive !== true
}

function exactPublishedFields(document, fields) {
  return Object.keys(fields).reduce((result, field) => {
    if (fields[field] === 1 && Object.hasOwn(document || {}, field)) {
      result[field] = document[field]
    }
    return result
  }, {})
}

function adminCollectionDocuments({
  user, userId, documents, fields, transformDocument,
}) {
  if (!activeAdministrator(user, userId)) return new Map()
  return new Map([...documents].map(([id, document]) => [
    id, transformDocument
      ? transformDocument(exactPublishedFields(document, fields))
      : exactPublishedFields(document, fields),
  ]))
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
 * Manually publish a collection whose desired documents depend on the live
 * user record. This is deliberately small: callers retain control of the
 * exact source projection and the function that maps that projection to the
 * fields a subscriber may see.
 */
async function publishReactiveCollection(context, {
  users,
  collection,
  collectionName,
  fields,
  selector = {},
  cursorOptions = {},
  documentsForUser,
  maxDocuments = DEFAULT_REACTIVE_PUBLICATION_DOCUMENTS,
}) {
  if (!Number.isSafeInteger(maxDocuments) || maxDocuments < 1
    || (cursorOptions.limit != null && (!Number.isSafeInteger(cursorOptions.limit)
      || cursorOptions.limit < 1 || cursorOptions.limit > maxDocuments))) {
    throw new TypeError('Invalid reactive publication limit.')
  }
  acquireReactiveCollectionSlot(context, collectionName)
  const usersById = new Map()
  const documents = new Map()
  const reconciler = createPublicationReconciler({
    collectionName,
    added: (...args) => context.added(...args),
    changed: (...args) => context.changed(...args),
    removed: (...args) => context.removed(...args),
  })
  let initialized = false
  let stopped = false
  let failed = false
  let userHandle
  let collectionHandle
  const fail = () => {
    if (stopped || failed) return
    failed = true
    reconciler.removeAll()
    const error = publicationLimitError(
      'publication-result-limit',
      `${collectionName} subscriptions may not exceed ${maxDocuments} documents.`,
    )
    if (typeof context.error === 'function') context.error(error)
    else throw error
  }
  const reconcile = () => {
    if (!initialized || stopped || failed) return
    if (documents.size > maxDocuments) {
      fail()
      return
    }
    reconciler.reconcile(documentsForUser({
      user: usersById.get(context.userId),
      userId: context.userId,
      documents,
    }))
  }

  context.onStop(() => {
    stopped = true
    if (userHandle) userHandle.stop()
    if (collectionHandle) collectionHandle.stop()
  })
  userHandle = await users.find({ _id: context.userId }, {
    fields: { isAdmin: 1, inactive: 1 },
    limit: 1,
  }).observeChangesAsync(observerCallbacks(usersById, reconcile))
  if (stopped || failed) {
    userHandle.stop()
    return undefined
  }
  collectionHandle = await collection.find(selector, {
    ...cursorOptions,
    fields,
    sort: cursorOptions.sort || { _id: 1 },
    limit: cursorOptions.limit ?? maxDocuments + 1,
  }).observeChangesAsync(
    observerCallbacks(documents, reconcile),
  )
  if (stopped || failed) {
    userHandle.stop()
    collectionHandle.stop()
    return undefined
  }
  initialized = true
  reconcile()
  if (!stopped && !failed) context.ready()
  return undefined
}

/**
 * Manually publish an admin collection so losing the administrator flag or
 * becoming inactive retracts every previously published document immediately.
 */
async function publishAdminCollection(context, {
  users,
  collection,
  collectionName,
  fields,
  selector = {},
  cursorOptions = {},
  transformDocument,
  maxDocuments = DEFAULT_REACTIVE_PUBLICATION_DOCUMENTS,
}) {
  return publishReactiveCollection(context, {
    users,
    collection,
    collectionName,
    fields,
    selector,
    cursorOptions,
    maxDocuments,
    documentsForUser: ({ user, userId, documents }) => adminCollectionDocuments({
      user,
      userId,
      documents,
      fields,
      transformDocument,
    }),
  })
}

export {
  DEFAULT_REACTIVE_PUBLICATION_DOCUMENTS,
  INBOUND_ADMIN_INTERFACE_FIELDS,
  OUTBOUND_ADMIN_INTERFACE_FIELDS,
  activeAdministrator,
  adminCollectionDocuments,
  publishAdminCollection,
  publishReactiveCollection,
}
