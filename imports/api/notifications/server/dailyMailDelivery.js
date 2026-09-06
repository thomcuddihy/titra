import { createHash } from 'node:crypto'

const DAILY_MAIL_SCHEMA_VERSION = 2
const DAY_MS = 24 * 60 * 60 * 1000
const RETENTION_DAYS_AFTER_UTC_DAY = 7

class DailyMailStateError extends Error {
  constructor(message) {
    super(message)
    this.name = 'DailyMailStateError'
  }
}

function validDate(value, label) {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new TypeError(`${label} must be a valid Date.`)
  }
  return value
}

function canonicalRecipient(value) {
  if (typeof value !== 'string') throw new TypeError('Mail recipient must be a string.')
  const normalized = value.trim().normalize('NFKC').toLowerCase()
  if (!normalized || normalized.length > 512 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new TypeError('Mail recipient is invalid.')
  }
  return normalized
}

function utcDayBounds(value) {
  const date = validDate(value, 'Mail reservation time')
  const start = new Date(Date.UTC(
    date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(),
  ))
  return {
    day: start.toISOString().slice(0, 10),
    start,
    end: new Date(start.getTime() + DAY_MS),
    expiresAt: new Date(
      start.getTime() + (RETENTION_DAYS_AFTER_UTC_DAY + 1) * DAY_MS,
    ),
  }
}

function dailyMailIdentity(recipient, day) {
  const canonical = canonicalRecipient(recipient)
  if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    throw new TypeError('Mail reservation day is invalid.')
  }
  const digest = createHash('sha256')
    .update(canonical)
    .update('\0')
    .update(day)
    .digest('hex')
  return {
    documentId: `daily-mail-v2-${digest}`,
    recipientDayHash: digest,
  }
}

function isDuplicateKeyError(error) {
  return error?.code === 11000 || error?.code === 11001
}

function matchedExactlyOne(result) {
  return result === 1 || result?.matchedCount === 1 || result?.modifiedCount === 1
}

function deletedExactlyOne(result) {
  return result === 1 || result?.deletedCount === 1
}

function createMongoDailyMailStore(collection) {
  if (!collection?.rawCollection) throw new TypeError('A Mongo collection is required.')
  const raw = collection.rawCollection()
  return {
    async legacySent(recipient, start, end) {
      return Boolean(await raw.findOne({
        email: recipient,
        timestamp: { $gte: start, $lt: end },
      }, { projection: { _id: 1 } }))
    },
    async reserve(document) {
      try {
        await raw.insertOne(document)
        return true
      } catch (error) {
        if (isDuplicateKeyError(error)) return false
        throw error
      }
    },
    async complete(documentId, reservationId, completedAt) {
      const result = await raw.updateOne({
        _id: documentId,
        schemaVersion: DAILY_MAIL_SCHEMA_VERSION,
        state: 'reserved',
        reservationId,
      }, {
        $set: { state: 'sent', sentAt: completedAt, updatedAt: completedAt },
        $unset: { reservationId: '' },
      })
      return matchedExactlyOne(result)
    },
    async release(documentId, reservationId) {
      const result = await raw.deleteOne({
        _id: documentId,
        schemaVersion: DAILY_MAIL_SCHEMA_VERSION,
        state: 'reserved',
        reservationId,
      })
      return deletedExactlyOne(result)
    },
  }
}

function validateDeliveryDependencies({ store, send, clock, reservationId }) {
  if (!store || typeof store.legacySent !== 'function'
    || typeof store.reserve !== 'function' || typeof store.complete !== 'function'
    || typeof store.release !== 'function') {
    throw new TypeError('A complete daily-mail store is required.')
  }
  if (typeof send !== 'function' || typeof clock !== 'function') {
    throw new TypeError('Daily-mail send and clock callbacks are required.')
  }
  if (typeof reservationId !== 'string' || !reservationId
    || reservationId.length > 128 || /[\u0000-\u001f\u007f]/.test(reservationId)) {
    throw new TypeError('Daily-mail reservation ID is invalid.')
  }
}

async function sendOncePerUtcDay({
  recipient,
  reservationId,
  store,
  send,
  clock = () => new Date(),
}) {
  validateDeliveryDependencies({ store, send, clock, reservationId })
  const reservedAt = validDate(clock(), 'Mail reservation clock result')
  const canonical = canonicalRecipient(recipient)
  const bounds = utcDayBounds(reservedAt)

  // Preserve the original daily suppression rule during an upgrade day. Old
  // rows are read only; every new reservation uses the atomic v2 identity.
  if (await store.legacySent(recipient, bounds.start, bounds.end)) return false

  const identity = dailyMailIdentity(canonical, bounds.day)
  const reserved = await store.reserve({
    _id: identity.documentId,
    schemaVersion: DAILY_MAIL_SCHEMA_VERSION,
    recipientDayHash: identity.recipientDayHash,
    day: bounds.day,
    state: 'reserved',
    reservationId,
    createdAt: reservedAt,
    updatedAt: reservedAt,
    expiresAt: bounds.expiresAt,
  })
  if (!reserved) return false

  try {
    await send()
  } catch (error) {
    // Delete only this caller's still-reserved row. If cleanup itself fails,
    // leave the fence in place and preserve the original delivery failure.
    try {
      await store.release(identity.documentId, reservationId)
    } catch {
      // A retained reservation safely suppresses a potentially ambiguous retry.
    }
    throw error
  }

  const completedAt = validDate(clock(), 'Mail completion clock result')
  if (!await store.complete(identity.documentId, reservationId, completedAt)) {
    // The SMTP server may already have accepted the message. Never release the
    // reservation after this point, even when completion persistence fails.
    throw new DailyMailStateError('Sent mail reservation could not be completed.')
  }
  return true
}

export {
  DAILY_MAIL_SCHEMA_VERSION,
  DailyMailStateError,
  RETENTION_DAYS_AFTER_UTC_DAY,
  canonicalRecipient,
  createMongoDailyMailStore,
  dailyMailIdentity,
  deletedExactlyOne,
  isDuplicateKeyError,
  matchedExactlyOne,
  sendOncePerUtcDay,
  utcDayBounds,
}
