function changedPublicationFields(previous, current) {
  const changes = {}
  const keys = new Set([
    ...Object.keys(previous || {}),
    ...Object.keys(current || {}),
  ])
  keys.forEach((key) => {
    if (!Object.prototype.hasOwnProperty.call(current, key)) changes[key] = undefined
    else if (!Object.is(previous?.[key], current[key])) changes[key] = current[key]
  })
  return changes
}

/**
 * Reconcile a manually published collection against a complete desired set.
 * Missing fields are explicitly cleared so an access downgrade cannot leave a
 * previously published private field in the client's minimongo document.
 */
function createPublicationReconciler({ collectionName, added, changed, removed }) {
  const published = new Map()

  function reconcile(desiredDocuments) {
    const desired = desiredDocuments instanceof Map
      ? desiredDocuments
      : new Map(desiredDocuments || [])

    published.forEach((_fields, id) => {
      if (!desired.has(id)) {
        removed(collectionName, id)
        published.delete(id)
      }
    })

    desired.forEach((fields, id) => {
      const safeFields = { ...fields }
      if (!published.has(id)) added(collectionName, id, safeFields)
      else {
        const updates = changedPublicationFields(published.get(id), safeFields)
        if (Object.keys(updates).length) changed(collectionName, id, updates)
      }
      published.set(id, safeFields)
    })
  }

  return {
    reconcile,
    removeAll() {
      reconcile(new Map())
    },
    snapshot() {
      return new Map([...published].map(([id, fields]) => [id, { ...fields }]))
    },
  }
}

function applyObserverChange(documents, id, fields) {
  const document = documents.get(id) || { _id: id }
  Object.entries(fields).forEach(([field, value]) => {
    if (value === undefined) delete document[field]
    else document[field] = value
  })
  documents.set(id, document)
}

/**
 * Replace a Mongo observer when its authorization scope changes. A generation
 * token makes callbacks from stopped/replaced observers inert, while the old
 * snapshot remains available until the replacement has completed its initial
 * observe pass.
 */
function createRestartableDocumentObserver({ cursorForScope, documentsChanged }) {
  let activeHandle
  let documents = new Map()
  let generation = 0
  let stopped = false

  async function restart(scope) {
    generation += 1
    const currentGeneration = generation
    if (activeHandle) activeHandle.stop()
    activeHandle = undefined

    const cursor = cursorForScope(scope)
    if (!cursor) {
      documents = new Map()
      documentsChanged(documents)
      return true
    }

    const pendingDocuments = new Map()
    let initializing = true
    let candidateHandle
    const callbacks = {
      added(id, fields) {
        if (stopped || currentGeneration !== generation) return
        const target = initializing ? pendingDocuments : documents
        target.set(id, { _id: id, ...fields })
        if (!initializing) documentsChanged(documents)
      },
      changed(id, fields) {
        if (stopped || currentGeneration !== generation) return
        applyObserverChange(initializing ? pendingDocuments : documents, id, fields)
        if (!initializing) documentsChanged(documents)
      },
      removed(id) {
        if (stopped || currentGeneration !== generation) return
        const target = initializing ? pendingDocuments : documents
        target.delete(id)
        if (!initializing) documentsChanged(documents)
      },
    }

    try {
      candidateHandle = await cursor.observeChangesAsync(callbacks)
    } catch (error) {
      if (stopped || currentGeneration !== generation) return false
      documents = new Map()
      throw error
    }

    if (stopped || currentGeneration !== generation) {
      candidateHandle.stop()
      return false
    }
    documents = pendingDocuments
    activeHandle = candidateHandle
    initializing = false
    documentsChanged(documents)
    return true
  }

  return {
    documents: () => documents,
    restart,
    stop() {
      if (stopped) return
      stopped = true
      generation += 1
      if (activeHandle) activeHandle.stop()
      activeHandle = undefined
      documents = new Map()
    },
  }
}

export {
  applyObserverChange,
  changedPublicationFields,
  createPublicationReconciler,
  createRestartableDocumentObserver,
}
