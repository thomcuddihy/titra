import { createHash, randomBytes } from 'node:crypto'

const IDEMPOTENCY_VERSION = 1
const DEFAULT_RETENTION_SECONDS = 7 * 24 * 60 * 60
const DEFAULT_PENDING_RETENTION_SECONDS = 30 * 24 * 60 * 60
// Mongo TTL deletion is asynchronous and clocks can differ slightly. Keep the
// private tombstone beyond the public replay deadline so a boundary retry can
// never recreate a resource after the advertised window still said it was safe.
const IDEMPOTENCY_EXPIRY_GRACE_SECONDS = 24 * 60 * 60
const MIN_IDEMPOTENCY_KEY_LENGTH = 16
const MAX_IDEMPOTENCY_KEY_LENGTH = 128
const KEY_PATTERN = /^[\x21-\x7e]+$/
const OPERATION_PATTERN = /^[a-z][a-z0-9.:-]{0,63}$/

class IdempotencyError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'IdempotencyError'
    this.code = code
    this.error = code
  }
}

function validateIdempotencyKey(value) {
  if (typeof value !== 'string'
    || value.length < MIN_IDEMPOTENCY_KEY_LENGTH
    || value.length > MAX_IDEMPOTENCY_KEY_LENGTH
    || !KEY_PATTERN.test(value)) {
    throw new IdempotencyError(
      'invalid-idempotency-key',
      `Idempotency-Key must contain ${MIN_IDEMPOTENCY_KEY_LENGTH} to ${MAX_IDEMPOTENCY_KEY_LENGTH} visible ASCII characters.`,
    )
  }
  return value
}

function validateOperation(value) {
  if (typeof value !== 'string' || !OPERATION_PATTERN.test(value)) {
    throw new TypeError('Invalid idempotency operation name.')
  }
  return value
}

function normalizeCanonicalValue(value, ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Canonical JSON does not support non-finite numbers.')
    return Object.is(value, -0) ? 0 : value
  }
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new TypeError('Canonical JSON does not support invalid dates.')
    return { $date: value.toISOString() }
  }
  if (typeof value !== 'object' || value === undefined) {
    throw new TypeError(`Canonical JSON does not support ${typeof value}.`)
  }
  if (ancestors.has(value)) throw new TypeError('Canonical JSON does not support circular values.')
  ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      return value.map((entry) => normalizeCanonicalValue(entry, ancestors))
    }
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('Canonical JSON supports only plain objects.')
    }
    return Object.keys(value).sort().reduce((result, key) => {
      const entry = value[key]
      if (entry !== undefined) result[key] = normalizeCanonicalValue(entry, ancestors)
      return result
    }, {})
  } finally {
    ancestors.delete(value)
  }
}

function canonicalJSONString(value) {
  return JSON.stringify(normalizeCanonicalValue(value))
}

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function requestFingerprint(value) {
  return sha256(`titra-api-request-v${IDEMPOTENCY_VERSION}\0${canonicalJSONString(value)}`)
}

function idempotencyDocumentId(userId, operation, key) {
  if (typeof userId !== 'string' || !userId) throw new TypeError('A user ID is required.')
  validateOperation(operation)
  validateIdempotencyKey(key)
  return sha256(`titra-api-idempotency-v${IDEMPOTENCY_VERSION}\0${userId}\0${operation}\0${key}`)
}

function createResourceId() {
  return randomBytes(16).toString('hex')
}

function addSeconds(value, seconds) {
  return new Date(value.getTime() + seconds * 1000)
}

function validateReservation(document, { documentId, userId, operation, fingerprint }) {
  if (!document) {
    throw new IdempotencyError(
      'idempotency-state-invalid',
      'The stored idempotency operation is missing and cannot be resumed safely.',
    )
  }
  if (document._id !== documentId
    || document.version !== IDEMPOTENCY_VERSION
    || document.userId !== userId
    || document.operation !== operation
    || document.fingerprint !== fingerprint
    || typeof document.resourceId !== 'string'
    || !document.resourceId) {
    if (document.fingerprint !== fingerprint) {
      throw new IdempotencyError(
        'idempotency-key-reused',
        'This Idempotency-Key was already used with a different request.',
      )
    }
    throw new IdempotencyError(
      'idempotency-state-invalid',
      'The stored idempotency operation is inconsistent and cannot be resumed safely.',
    )
  }
  if (!['reserved', 'completed'].includes(document.status)) {
    throw new IdempotencyError(
      'idempotency-state-invalid',
      'The stored idempotency operation has an unsupported state.',
    )
  }
  if (document.status === 'completed'
    && (!(document.replayExpiresAt instanceof Date)
      || Number.isNaN(document.replayExpiresAt.getTime())
      || !(document.expiresAt instanceof Date)
      || Number.isNaN(document.expiresAt.getTime())
      || document.expiresAt <= document.replayExpiresAt)) {
    throw new IdempotencyError(
      'idempotency-state-invalid',
      'The stored idempotency expiry state is invalid and cannot be replayed safely.',
    )
  }
  return document
}

function validateResult(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new TypeError('An idempotent create callback must return an object result.')
  }
  return result
}

function isDuplicateKeyError(error) {
  return error?.code === 11000 || error?.code === 11001
}

function createMongoIdempotencyStore(collection) {
  if (!collection?.rawCollection) throw new TypeError('A Mongo collection is required.')
  const raw = collection.rawCollection()
  return {
    async reserve(document) {
      try {
        await raw.insertOne(document)
        return true
      } catch (error) {
        if (isDuplicateKeyError(error)) return false
        throw error
      }
    },
    async find(documentId) {
      return raw.findOne({ _id: documentId })
    },
    async complete(documentId, fingerprint, result, now, replayExpiresAt, expiresAt) {
      const response = await raw.findOneAndUpdate(
        { _id: documentId, fingerprint, status: 'reserved' },
        {
          $set: {
            status: 'completed', result, updatedAt: now, replayExpiresAt, expiresAt,
          },
        },
        { returnDocument: 'after' },
      )
      return response?.value || response || null
    },
  }
}

async function executeIdempotentCreate({
  key,
  userId,
  operation,
  normalizedRequest,
  store,
  create,
  recover,
  beforeCreate = async () => {},
  now = () => new Date(),
  generateResourceId = createResourceId,
  retentionSeconds = DEFAULT_RETENTION_SECONDS,
  pendingRetentionSeconds = DEFAULT_PENDING_RETENTION_SECONDS,
}) {
  validateIdempotencyKey(key)
  validateOperation(operation)
  if (!store || typeof store.reserve !== 'function' || typeof store.find !== 'function'
    || typeof store.complete !== 'function') {
    throw new TypeError('A complete idempotency store is required.')
  }
  if (typeof create !== 'function' || typeof recover !== 'function'
    || typeof beforeCreate !== 'function') {
    throw new TypeError('Create, recovery and pre-create callbacks are required.')
  }
  if (!Number.isSafeInteger(retentionSeconds) || retentionSeconds < 1
    || !Number.isSafeInteger(pendingRetentionSeconds)
    || pendingRetentionSeconds < retentionSeconds) {
    throw new TypeError('Invalid idempotency retention settings.')
  }

  const fingerprint = requestFingerprint(normalizedRequest)
  const documentId = idempotencyDocumentId(userId, operation, key)
  const reservationIdentity = { documentId, userId, operation, fingerprint }

  function completedResponse(reservation) {
    return {
      result: validateResult(reservation.result),
      replayed: true,
      resourceId: reservation.resourceId,
      expiresAt: reservation.replayExpiresAt,
    }
  }

  async function completeReservation(result, replayed) {
    const validatedResult = validateResult(result)
    const completedAt = now()
    if (!(completedAt instanceof Date) || Number.isNaN(completedAt.getTime())) {
      throw new TypeError('The idempotency clock returned an invalid date.')
    }
    const replayExpiresAt = addSeconds(completedAt, retentionSeconds)
    const expiresAt = addSeconds(
      replayExpiresAt, IDEMPOTENCY_EXPIRY_GRACE_SECONDS,
    )
    const completed = await store.complete(
      documentId, fingerprint, validatedResult, completedAt, replayExpiresAt, expiresAt,
    )
    const stored = validateReservation(completed || await store.find(documentId), {
      documentId, userId, operation, fingerprint,
    })
    if (stored.status !== 'completed') {
      throw new IdempotencyError(
        'idempotency-outcome-unknown',
        'The resource was created but its idempotency result could not be confirmed.',
      )
    }
    return {
      result: validateResult(stored.result),
      replayed,
      resourceId: stored.resourceId,
      expiresAt: stored.replayExpiresAt,
    }
  }

  async function resumeReservation(
    reservation, { allowCreate = false, guardPassed = false, replayed = true } = {},
  ) {
    if (reservation.status === 'completed') return completedResponse(reservation)

    // Recovery is deliberately first. A resource committed before a lost
    // acknowledgement remains authoritative even when mutable permissions,
    // rules, migration locks, or dependencies have changed since creation.
    let result = await recover(reservation.resourceId)
    if (result == null) {
      // Only the request that inserted this reservation may begin resource
      // creation. Once another request can observe the receipt, absence is
      // ambiguous: the original write might still arrive, or it may have
      // committed and then been deliberately deleted. Recreating could
      // duplicate work or resurrect a deleted resource. Keep the reservation
      // as a durable tombstone and fail closed. A later retry can still recover
      // the exact deterministic resource if it appears.
      if (!allowCreate) {
        throw new IdempotencyError(
          'idempotency-outcome-unknown',
          'A previous create attempt has no recoverable resource and cannot be repeated safely.',
        )
      }
      if (!guardPassed) await beforeCreate()
      try {
        result = await create(reservation.resourceId)
      } catch (error) {
        // A duplicate-key error, process interruption, or driver error may occur
        // after the target insert became visible. One authoritative read decides
        // whether this reserved operation can be completed safely.
        result = await recover(reservation.resourceId)
        if (result == null) throw error
      }
    }
    return completeReservation(result, replayed)
  }

  // Probe before mutable authorization. Exact completed operations and
  // already-created reserved resources must remain recoverable after policy or
  // project state changes. The receipt is scoped by authenticated user,
  // operation and key, and validateReservation also binds its fingerprint.
  const existing = await store.find(documentId)
  if (existing) {
    return resumeReservation(validateReservation(existing, reservationIdentity))
  }

  try {
    // A rejected brand-new request must not be able to accumulate durable
    // receipt rows. Reserve only after all current mutable guards pass.
    await beforeCreate()
  } catch (guardError) {
    // A concurrent identical request may have completed while this request was
    // checking mutable state. Permit only an exact completed/resource replay;
    // never create under a guard failure.
    const raced = await store.find(documentId)
    if (!raced) throw guardError
    const reservation = validateReservation(raced, reservationIdentity)
    if (reservation.status === 'completed') return completedResponse(reservation)
    const recovered = await recover(reservation.resourceId)
    if (recovered == null) throw guardError
    return completeReservation(recovered, true)
  }

  const reservedAt = now()
  if (!(reservedAt instanceof Date) || Number.isNaN(reservedAt.getTime())) {
    throw new TypeError('The idempotency clock returned an invalid date.')
  }
  const candidate = {
    _id: documentId,
    version: IDEMPOTENCY_VERSION,
    userId,
    operation,
    fingerprint,
    resourceId: generateResourceId(),
    status: 'reserved',
    createdAt: reservedAt,
    updatedAt: reservedAt,
    expiresAt: addSeconds(
      reservedAt, pendingRetentionSeconds + IDEMPOTENCY_EXPIRY_GRACE_SECONDS,
    ),
  }
  if (typeof candidate.resourceId !== 'string' || !candidate.resourceId) {
    throw new TypeError('The generated resource ID is invalid.')
  }

  const inserted = await store.reserve(candidate)
  const reservation = validateReservation(
    inserted ? candidate : await store.find(documentId), reservationIdentity,
  )
  return resumeReservation(reservation, {
    allowCreate: inserted, guardPassed: true, replayed: !inserted,
  })
}

export {
  DEFAULT_PENDING_RETENTION_SECONDS,
  DEFAULT_RETENTION_SECONDS,
  IDEMPOTENCY_EXPIRY_GRACE_SECONDS,
  IDEMPOTENCY_VERSION,
  IdempotencyError,
  MAX_IDEMPOTENCY_KEY_LENGTH,
  MIN_IDEMPOTENCY_KEY_LENGTH,
  canonicalJSONString,
  createMongoIdempotencyStore,
  executeIdempotentCreate,
  idempotencyDocumentId,
  isDuplicateKeyError,
  requestFingerprint,
  validateIdempotencyKey,
}
