import { randomBytes } from 'node:crypto'
import WebhookReceipts from '../webhookreceipts.js'

const RECEIPT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000
// Keep the receipt beyond the advertised retry boundary so client/server clock
// skew and asynchronous TTL deletion cannot briefly turn a safe retry into a
// new event. Clients still stop retrying at their stricter advertised cutoff.
const RECEIPT_EXPIRY_GRACE_MS = 24 * 60 * 60 * 1000
// Leave several authenticated retry opportunities inside the five-minute
// signature window after a worker dies while holding a pending receipt.
const PROCESSING_LEASE_MS = 60 * 1000

function affected(result) {
  return result === 1 || result?.matchedCount === 1 || result?.modifiedCount === 1
}

function validDate(value) {
  return value instanceof Date && !Number.isNaN(value.getTime())
}

function receiptExpiry(now) {
  return new Date(
    now.getTime() + RECEIPT_RETENTION_MS + RECEIPT_EXPIRY_GRACE_MS,
  )
}

function sameSignedEvent(existing, payloadDigest) {
  return existing.payloadDigest === payloadDigest
    && validDate(existing.eventTimestamp)
}

function storedConfigurationRevision(existing) {
  if (!Object.hasOwn(existing, 'configurationRevision')) return 0
  return Number.isSafeInteger(existing.configurationRevision)
    && existing.configurationRevision >= 0
    ? existing.configurationRevision
    : undefined
}

function createWebhookReceiptStore(collection = WebhookReceipts, {
  clock = () => new Date(),
  tokenFactory = () => randomBytes(16).toString('hex'),
} = {}) {
  return {
    async claim({
      interfaceId, eventId, eventTimestamp, payloadDigest, configurationRevision,
    }) {
      const now = clock()
      const leaseToken = tokenFactory()
      if (typeof interfaceId !== 'string' || !interfaceId
        || typeof eventId !== 'string' || !eventId
        || !validDate(eventTimestamp)
        || !/^[0-9a-f]{64}$/.test(payloadDigest)
        || !Number.isSafeInteger(configurationRevision)
        || configurationRevision < 0
        || !validDate(now)
        || typeof leaseToken !== 'string' || !leaseToken) {
        throw new TypeError('Invalid webhook receipt claim')
      }
      const expiresAt = receiptExpiry(now)
      const receipt = {
        interfaceId,
        eventId,
        eventTimestamp,
        payloadDigest,
        configurationRevision,
        status: 'pending',
        leaseToken,
        leaseUntil: new Date(now.getTime() + PROCESSING_LEASE_MS),
        createdAt: now,
        updatedAt: now,
        expiresAt,
      }
      try {
        await collection.insertAsync(receipt)
        return { status: 'claimed', leaseToken, eventTimestamp: new Date(eventTimestamp) }
      } catch (error) {
        if (error?.code !== 11000) throw error
      }
      const existing = await collection.findOneAsync({ interfaceId, eventId })
      if (!existing) throw new Error('Webhook replay receipt disappeared after conflict')
      // The signature timestamp authenticates this delivery and therefore may
      // be fresh on retry. Event identity is the endpoint/event ID plus exact
      // body digest. All recovered work remains bound to the first accepted
      // delivery timestamp stored in this receipt.
      if (!sameSignedEvent(existing, payloadDigest)) {
        return { status: 'event_conflict' }
      }
      const originalEventTimestamp = new Date(existing.eventTimestamp)
      if (existing.status === 'processed') {
        await collection.rawCollection().updateOne({
          _id: existing._id, interfaceId, eventId, payloadDigest,
          eventTimestamp: existing.eventTimestamp, status: 'processed',
        }, {
          $set: { updatedAt: now }, $max: { expiresAt },
        })
        return { status: 'processed' }
      }
      if (storedConfigurationRevision(existing) !== configurationRevision) {
        return { status: 'event_conflict' }
      }
      if (existing.status === 'pending' && existing.leaseUntil > now) {
        await collection.rawCollection().updateOne({
          _id: existing._id, interfaceId, eventId, payloadDigest,
          eventTimestamp: existing.eventTimestamp,
          status: 'pending', leaseToken: existing.leaseToken,
        }, {
          $set: { updatedAt: now }, $max: { expiresAt },
        })
        return { status: 'in_progress' }
      }
      const result = await collection.rawCollection().updateOne({
        _id: existing._id,
        interfaceId,
        eventId,
        payloadDigest,
        eventTimestamp: existing.eventTimestamp,
        $or: [
          { status: 'failed' },
          { status: 'pending', leaseUntil: { $lte: now } },
        ],
      }, {
        $set: {
          status: 'pending', leaseToken,
          leaseUntil: new Date(now.getTime() + PROCESSING_LEASE_MS),
          updatedAt: now, expiresAt,
        },
        $unset: { completedAt: '', outcome: '', errorCode: '' },
      })
      return affected(result)
        ? { status: 'claimed', leaseToken, eventTimestamp: originalEventTimestamp }
        : { status: 'in_progress' }
    },

    async complete({ interfaceId, eventId, leaseToken, outcome }) {
      const now = clock()
      if (!validDate(now)) throw new TypeError('Invalid webhook receipt clock')
      const result = await collection.rawCollection().updateOne({
        interfaceId, eventId, status: 'pending', leaseToken,
      }, {
        $set: { status: 'processed', outcome, completedAt: now, updatedAt: now },
        $max: { expiresAt: receiptExpiry(now) },
        $unset: { leaseToken: '', leaseUntil: '', errorCode: '' },
      })
      if (!affected(result)) throw new Error('Webhook processing lease was lost')
    },

    async fail({ interfaceId, eventId, leaseToken, errorCode }) {
      const now = clock()
      if (!validDate(now)) throw new TypeError('Invalid webhook receipt clock')
      await collection.rawCollection().updateOne({
        interfaceId, eventId, status: 'pending', leaseToken,
      }, {
        $set: { status: 'failed', errorCode, updatedAt: now },
        $max: { expiresAt: receiptExpiry(now) },
        $unset: { leaseToken: '', leaseUntil: '' },
      })
    },
  }
}

export {
  RECEIPT_EXPIRY_GRACE_MS,
  PROCESSING_LEASE_MS,
  RECEIPT_RETENTION_MS,
  createWebhookReceiptStore,
  sameSignedEvent,
  storedConfigurationRevision,
}
