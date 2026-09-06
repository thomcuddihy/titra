import {
  applyObserverChange,
  createPublicationReconciler,
} from './reactivePublication.js'
import { createActivePublicationGate } from './activePublicationGate.js'

const DEFAULT_AUTHORIZED_PUBLICATION_DOCUMENTS = 1000
const authorizedCollectionGate = createActivePublicationGate({
  perUser: 30,
  perPeer: 75,
  total: 750,
})

function publicationLimitError(code, message) {
  return Object.assign(new Error(message), { error: code })
}

function acquireAuthorizedCollectionSlot(context) {
  const release = authorizedCollectionGate.acquire({
    userId: context.userId,
    peerAddress: context.connection?.clientAddress,
  })
  if (!release) {
    throw publicationLimitError(
      'subscription-limit',
      'Too many active collection subscriptions. Close another view and try again.',
    )
  }
  context.onStop(release)
}

function authorizedUser(user, userId, requireAdmin = false) {
  return user?._id === userId
    && user.inactive !== true
    && (!requireAdmin || user.isAdmin === true)
}

function exactDocumentFields(document, fields) {
  return Object.fromEntries(Object.keys(fields)
    .filter((field) => fields[field] === 1 && field !== '_id'
      && Object.prototype.hasOwnProperty.call(document || {}, field))
    .map((field) => [field, document[field]]))
}

function authorizedCollectionDocuments({
  documents,
  fields,
  user,
  userId,
  requireAdmin = false,
}) {
  if (!authorizedUser(user, userId, requireAdmin)) return new Map()
  return new Map([...documents].map(([id, document]) => [
    id, exactDocumentFields(document, fields),
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

/** Publish an exact collection projection while the current user remains active/authorized. */
async function publishAuthorizedCollection(context, {
  users,
  collection,
  collectionName,
  selector = {},
  fields,
  requireAdmin = false,
  cursorOptions = {},
  maxDocuments = DEFAULT_AUTHORIZED_PUBLICATION_DOCUMENTS,
}) {
  if (!Number.isSafeInteger(maxDocuments) || maxDocuments < 1
    || (cursorOptions.limit != null && (!Number.isSafeInteger(cursorOptions.limit)
      || cursorOptions.limit < 1 || cursorOptions.limit > maxDocuments))) {
    throw new TypeError('Invalid authorized publication limit.')
  }
  acquireAuthorizedCollectionSlot(context)
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
    reconciler.reconcile(authorizedCollectionDocuments({
      documents,
      fields,
      user: usersById.get(context.userId),
      userId: context.userId,
      requireAdmin,
    }))
  }
  context.onStop(() => {
    stopped = true
    if (userHandle) userHandle.stop()
    if (collectionHandle) collectionHandle.stop()
  })
  userHandle = await users.find({ _id: context.userId }, {
    fields: { inactive: 1, ...(requireAdmin ? { isAdmin: 1 } : {}) },
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
  if (!failed) context.ready()
  return undefined
}

export {
  authorizedCollectionDocuments,
  authorizedUser,
  DEFAULT_AUTHORIZED_PUBLICATION_DOCUMENTS,
  exactDocumentFields,
  publishAuthorizedCollection,
}
