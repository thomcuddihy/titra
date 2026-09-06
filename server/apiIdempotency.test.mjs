import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFAULT_PENDING_RETENTION_SECONDS,
  DEFAULT_RETENTION_SECONDS,
  IDEMPOTENCY_EXPIRY_GRACE_SECONDS,
  IdempotencyError,
  canonicalJSONString,
  createMongoIdempotencyStore,
  executeIdempotentCreate,
  idempotencyDocumentId,
  requestFingerprint,
  validateIdempotencyKey,
} from './apiIdempotency.js'

const KEY = '0123456789abcdef0123456789abcdef'

function memoryStore() {
  const documents = new Map()
  return {
    documents,
    async reserve(document) {
      if (documents.has(document._id)) return false
      documents.set(document._id, structuredClone(document))
      return true
    },
    async find(documentId) {
      const value = documents.get(documentId)
      return value ? structuredClone(value) : null
    },
    async complete(documentId, fingerprint, result, now, replayExpiresAt, expiresAt) {
      const value = documents.get(documentId)
      if (!value || value.fingerprint !== fingerprint || value.status !== 'reserved') {
        return value ? structuredClone(value) : null
      }
      Object.assign(value, {
        status: 'completed', result: structuredClone(result), updatedAt: now,
        replayExpiresAt, expiresAt,
      })
      return structuredClone(value)
    },
  }
}

function operation(overrides = {}) {
  return {
    key: KEY,
    userId: 'owner-1',
    operation: 'timeentry.create',
    normalizedRequest: {
      projectId: 'project-1', task: 'Work', date: '2026-09-01', hours: 1.25,
    },
    ...overrides,
  }
}

test('canonical request fingerprints are order-independent, typed and strict', () => {
  const left = { z: [1, true], a: { when: new Date('2026-09-01T00:00:00.000Z'), n: -0 } }
  const right = { a: { n: 0, when: new Date('2026-09-01T00:00:00.000Z') }, z: [1.0, true] }
  assert.equal(canonicalJSONString(left), canonicalJSONString(right))
  assert.equal(requestFingerprint(left), requestFingerprint(right))
  assert.notEqual(requestFingerprint({ value: '1' }), requestFingerprint({ value: 1 }))
  assert.throws(() => canonicalJSONString({ value: Number.NaN }), /non-finite/)
  const circular = {}
  circular.self = circular
  assert.throws(() => canonicalJSONString(circular), /circular/)
})

test('keys and operation IDs are bounded, user-scoped and never contain the raw key', () => {
  assert.equal(validateIdempotencyKey(KEY), KEY)
  assert.throws(() => validateIdempotencyKey('short'), IdempotencyError)
  assert.throws(() => validateIdempotencyKey(`${'x'.repeat(15)} `), IdempotencyError)
  const first = idempotencyDocumentId('owner-1', 'project.create', KEY)
  assert.match(first, /^[a-f0-9]{64}$/)
  assert.equal(first.includes(KEY), false)
  assert.notEqual(first, idempotencyDocumentId('owner-2', 'project.create', KEY))
  assert.notEqual(first, idempotencyDocumentId('owner-1', 'project-task.create', KEY))
})

test('first create persists a result and an exact replay performs no resource work', async () => {
  const store = memoryStore()
  const resources = new Map()
  let creates = 0
  const options = operation({
    store,
    generateResourceId: () => 'resource-1',
    create: async (resourceId) => {
      creates += 1
      resources.set(resourceId, { _id: resourceId })
      return { timecardId: resourceId }
    },
    recover: async (resourceId) => (
      resources.has(resourceId) ? { timecardId: resourceId } : null
    ),
  })
  const first = await executeIdempotentCreate(options)
  const replay = await executeIdempotentCreate({
    ...options,
    generateResourceId: () => 'must-not-be-used',
  })
  assert.deepEqual(first.result, { timecardId: 'resource-1' })
  assert.equal(first.replayed, false)
  assert.equal(replay.replayed, true)
  assert.deepEqual(replay.result, first.result)
  assert.equal(creates, 1)
  const stored = [...store.documents.values()][0]
  assert.equal(JSON.stringify(stored).includes(KEY), false)
  assert.equal(stored.status, 'completed')
})

test('completed replay bypasses mutable guards without performing resource work', async () => {
  const store = memoryStore()
  let guardAllowed = true
  let guards = 0
  let creates = 0
  let recovers = 0
  const options = operation({
    store,
    generateResourceId: () => 'resource-guarded',
    beforeCreate: async () => {
      guards += 1
      if (!guardAllowed) throw new Error('current policy denied the create')
    },
    create: async (resourceId) => {
      creates += 1
      return { timecardId: resourceId }
    },
    recover: async () => {
      recovers += 1
      return null
    },
  })
  const first = await executeIdempotentCreate(options)
  guardAllowed = false
  const replay = await executeIdempotentCreate(options)

  assert.equal(first.replayed, false)
  assert.equal(replay.replayed, true)
  assert.deepEqual(replay.result, first.result)
  assert.equal(guards, 1)
  assert.equal(creates, 1)
  assert.equal(recovers, 1)
})

test('reserved exact resource recovery bypasses changed mutable guards', async () => {
  const store = memoryStore()
  const complete = store.complete.bind(store)
  let loseCompletion = true
  store.complete = async (...args) => {
    if (loseCompletion) {
      loseCompletion = false
      throw new Error('completion acknowledgement lost')
    }
    return complete(...args)
  }
  const resources = new Set()
  let guardAllowed = true
  let guards = 0
  let creates = 0
  const options = operation({
    store,
    generateResourceId: () => 'resource-reserved',
    beforeCreate: async () => {
      guards += 1
      if (!guardAllowed) throw new Error('current policy denied the create')
    },
    create: async (resourceId) => {
      creates += 1
      resources.add(resourceId)
      return { timecardId: resourceId }
    },
    recover: async (resourceId) => (
      resources.has(resourceId) ? { timecardId: resourceId } : null
    ),
  })

  await assert.rejects(executeIdempotentCreate(options), /acknowledgement lost/)
  guardAllowed = false
  const replay = await executeIdempotentCreate(options)
  assert.deepEqual(replay.result, { timecardId: 'resource-reserved' })
  assert.equal(replay.replayed, true)
  assert.equal(guards, 1)
  assert.equal(creates, 1)
  assert.equal([...store.documents.values()][0].status, 'completed')
})

test('brand-new denials create no receipt and reserved-absent retries fail closed', async () => {
  const deniedStore = memoryStore()
  let generated = 0
  let created = 0
  await assert.rejects(executeIdempotentCreate(operation({
    store: deniedStore,
    beforeCreate: async () => { throw new Error('new create denied') },
    generateResourceId: () => { generated += 1; return 'must-not-be-reserved' },
    recover: async () => null,
    create: async () => { created += 1; return { timecardId: 'forbidden' } },
  })), /new create denied/)
  assert.equal(deniedStore.documents.size, 0)
  assert.equal(generated, 0)
  assert.equal(created, 0)

  const reservedStore = memoryStore()
  let guardAllowed = true
  const reservedOptions = operation({
    store: reservedStore,
    beforeCreate: async () => {
      if (!guardAllowed) throw new Error('reserved retry denied')
    },
    generateResourceId: () => 'reserved-without-resource',
    recover: async () => null,
    create: async () => { throw new Error('initial create failed before insert') },
  })
  await assert.rejects(
    executeIdempotentCreate(reservedOptions), /initial create failed before insert/,
  )
  guardAllowed = false
  await assert.rejects(
    executeIdempotentCreate(reservedOptions),
    (error) => error instanceof IdempotencyError
      && error.code === 'idempotency-outcome-unknown',
  )
  assert.equal(reservedStore.documents.size, 1)
  assert.equal([...reservedStore.documents.values()][0].status, 'reserved')
})

test('reserved create cannot resurrect an exact resource after deliberate deletion', async () => {
  const store = memoryStore()
  const complete = store.complete.bind(store)
  let loseCompletion = true
  store.complete = async (...args) => {
    if (loseCompletion) {
      loseCompletion = false
      throw new Error('completion acknowledgement lost')
    }
    return complete(...args)
  }
  const resources = new Set()
  let creates = 0
  const options = operation({
    operation: 'project.create',
    normalizedRequest: {
      userId: 'owner-1', name: 'Disposable project', projectRevision: 0,
    },
    store,
    generateResourceId: () => 'project-resurrection-guard',
    create: async (resourceId) => {
      creates += 1
      resources.add(resourceId)
      return { projectId: resourceId }
    },
    recover: async (resourceId) => (
      resources.has(resourceId) ? { projectId: resourceId } : null
    ),
  })

  await assert.rejects(executeIdempotentCreate(options), /acknowledgement lost/)
  assert.equal(resources.delete('project-resurrection-guard'), true)
  await assert.rejects(
    executeIdempotentCreate(options),
    (error) => error instanceof IdempotencyError
      && error.code === 'idempotency-outcome-unknown',
  )
  assert.equal(resources.size, 0)
  assert.equal(creates, 1)
  assert.equal([...store.documents.values()][0].status, 'reserved')
})

test('same key with a different normalized payload conflicts before resource work', async () => {
  const store = memoryStore()
  let creates = 0
  const callbacks = {
    store,
    create: async (resourceId) => { creates += 1; return { projectId: resourceId } },
    recover: async () => null,
    generateResourceId: () => 'project-1',
  }
  await executeIdempotentCreate(operation({ operation: 'project.create', ...callbacks }))
  await assert.rejects(
    executeIdempotentCreate(operation({
      operation: 'project.create',
      normalizedRequest: { name: 'Different project' },
      ...callbacks,
    })),
    (error) => error instanceof IdempotencyError && error.code === 'idempotency-key-reused',
  )
  assert.equal(creates, 1)
})

test('a target made visible before a lost response is recovered without duplication', async () => {
  const store = memoryStore()
  const resources = new Map()
  let attempts = 0
  const options = operation({
    store,
    generateResourceId: () => 'record-1',
    create: async (resourceId) => {
      attempts += 1
      resources.set(resourceId, { _id: resourceId })
      throw new Error('connection disappeared after insert')
    },
    recover: async (resourceId) => (
      resources.has(resourceId) ? { timecardId: resourceId } : null
    ),
  })
  const result = await executeIdempotentCreate(options)
  assert.deepEqual(result.result, { timecardId: 'record-1' })
  assert.equal(attempts, 1)
  assert.equal(resources.size, 1)
})

test('a completion-write failure remains recoverable with the reserved resource ID', async () => {
  const store = memoryStore()
  const complete = store.complete.bind(store)
  let failCompletion = true
  store.complete = async (...args) => {
    if (failCompletion) {
      failCompletion = false
      throw new Error('completion acknowledgement lost')
    }
    return complete(...args)
  }
  const resources = new Map()
  let creates = 0
  const options = operation({
    store,
    generateResourceId: () => 'record-1',
    create: async (resourceId) => {
      creates += 1
      resources.set(resourceId, true)
      return { timecardId: resourceId }
    },
    recover: async (resourceId) => (
      resources.has(resourceId) ? { timecardId: resourceId } : null
    ),
  })
  await assert.rejects(executeIdempotentCreate(options), /acknowledgement lost/)
  const recovered = await executeIdempotentCreate(options)
  assert.deepEqual(recovered.result, { timecardId: 'record-1' })
  assert.equal(recovered.replayed, true)
  assert.equal(creates, 1)
})

test('concurrent requests create at most one resource and an in-flight peer fails closed', async () => {
  const store = memoryStore()
  const resources = new Map()
  let creates = 0
  const options = operation({
    store,
    generateResourceId: () => `candidate-${Math.random()}`,
    recover: async (resourceId) => (
      resources.has(resourceId) ? { taskId: resourceId } : null
    ),
    create: async (resourceId) => {
      await Promise.resolve()
      if (!resources.has(resourceId)) {
        creates += 1
        resources.set(resourceId, true)
      }
      return { taskId: resourceId }
    },
  })
  const outcomes = await Promise.allSettled([
    executeIdempotentCreate(options), executeIdempotentCreate(options),
  ])
  const fulfilled = outcomes.filter((item) => item.status === 'fulfilled')
  const rejected = outcomes.filter((item) => item.status === 'rejected')
  assert.equal(fulfilled.length, 1)
  assert.equal(rejected.length, 1)
  assert.equal(rejected[0].reason.code, 'idempotency-outcome-unknown')
  const replay = await executeIdempotentCreate(options)
  assert.deepEqual(replay.result, fulfilled[0].value.result)
  assert.equal(replay.replayed, true)
  assert.equal(resources.size, 1)
  assert.equal(creates, 1)
})

test('completed result survives target deletion for the advertised retention window', async () => {
  const store = memoryStore()
  const resources = new Set()
  let creates = 0
  const options = operation({
    store,
    generateResourceId: () => 'record-1',
    create: async (resourceId) => {
      creates += 1
      resources.add(resourceId)
      return { timecardId: resourceId }
    },
    recover: async (resourceId) => (
      resources.has(resourceId) ? { timecardId: resourceId } : null
    ),
  })
  await executeIdempotentCreate(options)
  resources.clear()
  const replay = await executeIdempotentCreate(options)
  assert.deepEqual(replay.result, { timecardId: 'record-1' })
  assert.equal(creates, 1)
})

test('retention dates use long pending and bounded completed lifetimes', async () => {
  const store = memoryStore()
  let reserved
  const reserve = store.reserve.bind(store)
  store.reserve = async (document) => {
    reserved = structuredClone(document)
    return reserve(document)
  }
  const instants = [
    new Date('2026-09-01T00:00:00.000Z'), new Date('2026-09-01T00:00:05.000Z'),
  ]
  await executeIdempotentCreate(operation({
    store,
    now: () => instants.shift(),
    generateResourceId: () => 'record-1',
    recover: async () => null,
    create: async (resourceId) => ({ timecardId: resourceId }),
  }))
  const stored = [...store.documents.values()][0]
  assert.equal(
    stored.replayExpiresAt.toISOString(),
    new Date('2026-09-08T00:00:05.000Z').toISOString(),
  )
  assert.equal(
    stored.expiresAt.toISOString(),
    new Date('2026-09-09T00:00:05.000Z').toISOString(),
  )
  assert.equal(IDEMPOTENCY_EXPIRY_GRACE_SECONDS, 24 * 60 * 60)
  assert.ok(DEFAULT_PENDING_RETENTION_SECONDS > DEFAULT_RETENTION_SECONDS)
  assert.equal(
    reserved.expiresAt.getTime() - reserved.createdAt.getTime(),
    (DEFAULT_PENDING_RETENTION_SECONDS + IDEMPOTENCY_EXPIRY_GRACE_SECONDS) * 1000,
  )
})

test('public replay expiry remains seven days while the private TTL has a grace day', async () => {
  const store = memoryStore()
  const instants = [
    new Date('2026-09-01T00:00:00.000Z'),
    new Date('2026-09-01T00:00:05.000Z'),
  ]
  const result = await executeIdempotentCreate(operation({
    store,
    now: () => instants.shift(),
    generateResourceId: () => 'record-boundary',
    recover: async () => null,
    create: async (resourceId) => ({ timecardId: resourceId }),
  }))
  const stored = [...store.documents.values()][0]
  assert.equal(result.expiresAt.getTime(), stored.replayExpiresAt.getTime())
  assert.equal(
    stored.expiresAt.getTime() - result.expiresAt.getTime(),
    IDEMPOTENCY_EXPIRY_GRACE_SECONDS * 1000,
  )

  const replay = await executeIdempotentCreate(operation({
    store,
    now: () => new Date('2026-09-08T00:00:04.000Z'),
    generateResourceId: () => 'must-not-be-used',
    recover: async () => { throw new Error('must not recover a completed operation') },
    create: async () => { throw new Error('must not recreate a completed operation') },
  }))
  assert.equal(replay.replayed, true)
  assert.equal(replay.expiresAt.getTime(), result.expiresAt.getTime())
})

test('Mongo store handles duplicate reservations and current driver result shapes', async () => {
  const documents = new Map()
  const raw = {
    async insertOne(document) {
      if (documents.has(document._id)) throw Object.assign(new Error('duplicate'), { code: 11000 })
      documents.set(document._id, structuredClone(document))
    },
    async findOne(selector) { return structuredClone(documents.get(selector._id) || null) },
    async findOneAndUpdate(selector, modifier) {
      const value = documents.get(selector._id)
      if (!value || value.status !== selector.status || value.fingerprint !== selector.fingerprint) {
        return null
      }
      Object.assign(value, modifier.$set)
      return structuredClone(value)
    },
  }
  const store = createMongoIdempotencyStore({ rawCollection: () => raw })
  const document = { _id: 'one', status: 'reserved', fingerprint: 'hash' }
  assert.equal(await store.reserve(document), true)
  assert.equal(await store.reserve(document), false)
  assert.deepEqual(await store.find('one'), document)
  const completed = await store.complete(
    'one', 'hash', { projectId: 'p1' }, new Date(), new Date(), new Date(),
  )
  assert.equal(completed.status, 'completed')
})
