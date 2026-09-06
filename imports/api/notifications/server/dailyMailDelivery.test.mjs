import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DAILY_MAIL_SCHEMA_VERSION,
  DailyMailStateError,
  RETENTION_DAYS_AFTER_UTC_DAY,
  canonicalRecipient,
  createMongoDailyMailStore,
  dailyMailIdentity,
  sendOncePerUtcDay,
  utcDayBounds,
} from './dailyMailDelivery.js'

function memoryStore({ legacy = false } = {}) {
  const documents = new Map()
  const calls = { legacy: [], complete: [], release: [] }
  return {
    documents,
    calls,
    async legacySent(...args) {
      calls.legacy.push(args)
      return legacy
    },
    async reserve(document) {
      if (documents.has(document._id)) return false
      documents.set(document._id, structuredClone(document))
      return true
    },
    async complete(documentId, reservationId, completedAt) {
      calls.complete.push([documentId, reservationId, completedAt])
      const document = documents.get(documentId)
      if (document?.state !== 'reserved' || document.reservationId !== reservationId) {
        return false
      }
      Object.assign(document, { state: 'sent', sentAt: completedAt, updatedAt: completedAt })
      delete document.reservationId
      return true
    },
    async release(documentId, reservationId) {
      calls.release.push([documentId, reservationId])
      const document = documents.get(documentId)
      if (document?.state !== 'reserved' || document.reservationId !== reservationId) {
        return false
      }
      return documents.delete(documentId)
    },
  }
}

function delivery(overrides = {}) {
  return {
    recipient: 'Recipient@Example.INVALID',
    reservationId: 'reservation-one',
    store: memoryStore(),
    send: async () => {},
    clock: () => new Date('2026-09-03T10:15:00.000Z'),
    ...overrides,
  }
}

test('recipient/day identity is normalized, private, deterministic and UTC-bound', () => {
  assert.equal(canonicalRecipient('  User@Example.INVALID  '), 'user@example.invalid')
  const first = dailyMailIdentity('User@Example.INVALID', '2026-09-03')
  const same = dailyMailIdentity(' user@example.invalid ', '2026-09-03')
  const nextDay = dailyMailIdentity('user@example.invalid', '2026-09-04')
  assert.deepEqual(first, same)
  assert.match(first.documentId, /^daily-mail-v2-[0-9a-f]{64}$/)
  assert.match(first.recipientDayHash, /^[0-9a-f]{64}$/)
  assert.equal(JSON.stringify(first).includes('user@example.invalid'), false)
  assert.notEqual(first.documentId, nextDay.documentId)

  const bounds = utcDayBounds(new Date('2026-09-03T23:59:59.999-07:00'))
  assert.equal(bounds.day, '2026-09-04')
  assert.equal(bounds.start.toISOString(), '2026-09-04T00:00:00.000Z')
  assert.equal(bounds.end.toISOString(), '2026-09-05T00:00:00.000Z')
  assert.equal(
    bounds.expiresAt.getTime() - bounds.end.getTime(),
    RETENTION_DAYS_AFTER_UTC_DAY * 24 * 60 * 60 * 1000,
  )
  assert.throws(() => canonicalRecipient('bad\n@example.invalid'), TypeError)
  assert.throws(() => dailyMailIdentity('valid@example.invalid', '03-09-2026'), TypeError)
  assert.throws(() => utcDayBounds(new Date(Number.NaN)), TypeError)
})

test('first delivery stores a private sent fence and same-day replay is suppressed', async () => {
  const store = memoryStore()
  let sends = 0
  const options = delivery({ store, send: async () => { sends += 1 } })
  assert.equal(await sendOncePerUtcDay(options), true)
  assert.equal(await sendOncePerUtcDay({
    ...options,
    recipient: ' recipient@example.invalid ',
    reservationId: 'reservation-two',
  }), false)
  assert.equal(sends, 1)
  assert.equal(store.documents.size, 1)
  const [stored] = store.documents.values()
  assert.equal(stored.schemaVersion, DAILY_MAIL_SCHEMA_VERSION)
  assert.equal(stored.day, '2026-09-03')
  assert.equal(stored.state, 'sent')
  assert.equal(stored.reservationId, undefined)
  assert.equal(JSON.stringify(stored).includes('recipient@example.invalid'), false)
})

test('concurrent callers reserve atomically and only one sends', async () => {
  const store = memoryStore()
  let sends = 0
  let releaseSend
  const sendGate = new Promise((resolve) => { releaseSend = resolve })
  const send = async () => {
    sends += 1
    await sendGate
  }
  const first = sendOncePerUtcDay(delivery({
    store, send, reservationId: 'concurrent-one',
  }))
  const second = sendOncePerUtcDay(delivery({
    store, send, reservationId: 'concurrent-two',
  }))
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(sends, 1)
  releaseSend()
  assert.deepEqual(await Promise.all([first, second]), [true, false])
  assert.equal([...store.documents.values()][0].state, 'sent')
})

test('definite send failure releases only its reservation and permits a retry', async () => {
  const store = memoryStore()
  const error = new Error('synthetic SMTP rejection')
  await assert.rejects(sendOncePerUtcDay(delivery({
    store,
    send: async () => { throw error },
  })), (value) => value === error)
  assert.equal(store.documents.size, 0)
  assert.equal(store.calls.release.length, 1)

  let sends = 0
  assert.equal(await sendOncePerUtcDay(delivery({
    store,
    reservationId: 'retry-reservation',
    send: async () => { sends += 1 },
  })), true)
  assert.equal(sends, 1)
})

test('failed rollback retains the fence and preserves the delivery error', async () => {
  const store = memoryStore()
  store.release = async () => { throw new Error('synthetic cleanup failure') }
  const deliveryError = new Error('synthetic SMTP rejection')
  await assert.rejects(sendOncePerUtcDay(delivery({
    store,
    send: async () => { throw deliveryError },
  })), (value) => value === deliveryError)
  assert.equal(store.documents.size, 1)

  let retried = false
  assert.equal(await sendOncePerUtcDay(delivery({
    store,
    reservationId: 'must-not-own-existing-fence',
    send: async () => { retried = true },
  })), false)
  assert.equal(retried, false)
})

test('completion failure never releases a possibly delivered reservation', async () => {
  const store = memoryStore()
  store.complete = async () => false
  let sends = 0
  await assert.rejects(sendOncePerUtcDay(delivery({
    store,
    send: async () => { sends += 1 },
  })), DailyMailStateError)
  assert.equal(sends, 1)
  assert.equal(store.calls.release.length, 0)
  assert.equal([...store.documents.values()][0].state, 'reserved')

  assert.equal(await sendOncePerUtcDay(delivery({
    store,
    reservationId: 'completion-retry',
    send: async () => { sends += 1 },
  })), false)
  assert.equal(sends, 1)
})

test('legacy row from the current UTC day suppresses before reservation', async () => {
  const store = memoryStore({ legacy: true })
  let sends = 0
  assert.equal(await sendOncePerUtcDay(delivery({
    store,
    send: async () => { sends += 1 },
  })), false)
  assert.equal(sends, 0)
  assert.equal(store.documents.size, 0)
  assert.deepEqual(store.calls.legacy[0], [
    'Recipient@Example.INVALID',
    new Date('2026-09-03T00:00:00.000Z'),
    new Date('2026-09-04T00:00:00.000Z'),
  ])
})

test('a new UTC day gets a distinct fence and permits another message', async () => {
  const store = memoryStore()
  let sends = 0
  assert.equal(await sendOncePerUtcDay(delivery({
    store,
    send: async () => { sends += 1 },
  })), true)
  assert.equal(await sendOncePerUtcDay(delivery({
    store,
    reservationId: 'next-day',
    clock: () => new Date('2026-09-04T00:00:00.000Z'),
    send: async () => { sends += 1 },
  })), true)
  assert.equal(sends, 2)
  assert.equal(store.documents.size, 2)
})

test('Mongo store suppresses only duplicate keys and uses owned state transitions', async () => {
  const calls = { find: [], insert: [], update: [], delete: [] }
  let insertError = Object.assign(new Error('duplicate'), { code: 11000 })
  const raw = {
    async findOne(...args) { calls.find.push(args); return null },
    async insertOne(document) {
      calls.insert.push(document)
      if (insertError) throw insertError
    },
    async updateOne(...args) { calls.update.push(args); return { matchedCount: 1 } },
    async deleteOne(...args) { calls.delete.push(args); return { deletedCount: 1 } },
  }
  const store = createMongoDailyMailStore({ rawCollection: () => raw })
  const start = new Date('2026-09-03T00:00:00.000Z')
  const end = new Date('2026-09-04T00:00:00.000Z')
  assert.equal(await store.legacySent('Case@Example.invalid', start, end), false)
  assert.deepEqual(calls.find[0], [{
    email: 'Case@Example.invalid', timestamp: { $gte: start, $lt: end },
  }, { projection: { _id: 1 } }])
  assert.equal(await store.reserve({ _id: 'document' }), false)
  insertError = Object.assign(new Error('database unavailable'), { code: 91 })
  await assert.rejects(store.reserve({ _id: 'document' }), /database unavailable/)

  const completedAt = new Date('2026-09-03T10:16:00.000Z')
  assert.equal(await store.complete('document', 'owned-reservation', completedAt), true)
  assert.deepEqual(calls.update[0][0], {
    _id: 'document',
    schemaVersion: DAILY_MAIL_SCHEMA_VERSION,
    state: 'reserved',
    reservationId: 'owned-reservation',
  })
  assert.equal(await store.release('document', 'owned-reservation'), true)
  assert.deepEqual(calls.delete[0][0], {
    _id: 'document',
    schemaVersion: DAILY_MAIL_SCHEMA_VERSION,
    state: 'reserved',
    reservationId: 'owned-reservation',
  })
})

test('invalid dependencies fail before any mail work', async () => {
  await assert.rejects(sendOncePerUtcDay(delivery({ store: {} })), TypeError)
  await assert.rejects(sendOncePerUtcDay(delivery({ send: null })), TypeError)
  await assert.rejects(sendOncePerUtcDay(delivery({ clock: null })), TypeError)
  await assert.rejects(sendOncePerUtcDay(delivery({ reservationId: 'bad\nvalue' })), TypeError)
})
