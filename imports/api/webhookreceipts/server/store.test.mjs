import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const emptyCollectionUrl = `data:text/javascript;base64,${Buffer.from('export default {}').toString('base64')}`
let source = readFileSync(new URL('./store.js', import.meta.url), 'utf8')
source = source.replace("'../webhookreceipts.js'", JSON.stringify(emptyCollectionUrl))
const storeUrl = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
const {
  createWebhookReceiptStore,
  PROCESSING_LEASE_MS,
  RECEIPT_EXPIRY_GRACE_MS,
  RECEIPT_RETENTION_MS,
} = await import(storeUrl)

function matches(record, selector) {
  return Object.entries(selector).every(([key, condition]) => {
    if (key === '$or') return condition.some((branch) => matches(record, branch))
    if (condition && typeof condition === 'object' && !(condition instanceof Date)) {
      if (Object.hasOwn(condition, '$lte')) return record[key] <= condition.$lte
    }
    return record[key] === condition
  })
}

class FakeCollection {
  records = []

  async insertAsync(value) {
    if (this.records.some((item) => (
      item.interfaceId === value.interfaceId && item.eventId === value.eventId
    ))) throw Object.assign(new Error('duplicate'), { code: 11000 })
    this.records.push({ _id: `receipt-${this.records.length + 1}`, ...value })
  }

  async findOneAsync(selector) {
    return this.records.find((record) => matches(record, selector))
  }

  rawCollection() {
    return {
      updateOne: async (selector, modifier) => {
        const record = this.records.find((candidate) => matches(candidate, selector))
        if (!record) return { matchedCount: 0, modifiedCount: 0 }
        Object.assign(record, modifier.$set)
        Object.entries(modifier.$max || {}).forEach(([key, value]) => {
          if (record[key] == null || record[key] < value) record[key] = value
        })
        Object.keys(modifier.$unset || {}).forEach((key) => delete record[key])
        return { matchedCount: 1, modifiedCount: 1 }
      },
    }
  }
}

function fixture() {
  let now = new Date('2026-09-01T00:00:00Z')
  let token = 0
  const collection = new FakeCollection()
  const store = createWebhookReceiptStore(collection, {
    clock: () => new Date(now),
    tokenFactory: () => `lease-${++token}`,
  })
  const event = {
    interfaceId: 'interface-1', eventId: 'event-1',
    eventTimestamp: new Date('2026-09-01T00:00:00Z'), payloadDigest: 'd'.repeat(64),
    configurationRevision: 0,
  }
  return { collection, store, event, setNow(value) { now = new Date(value) } }
}

test('receipt claim is unique, bounded, non-payload and binds identity to the body', async () => {
  const f = fixture()
  assert.deepEqual(await f.store.claim(f.event), {
    status: 'claimed', leaseToken: 'lease-1', eventTimestamp: f.event.eventTimestamp,
  })
  assert.equal(f.collection.records.length, 1)
  const [receipt] = f.collection.records
  assert.equal(receipt.leaseUntil - receipt.createdAt, PROCESSING_LEASE_MS)
  assert.equal(PROCESSING_LEASE_MS, 60 * 1000)
  assert.ok(PROCESSING_LEASE_MS < 5 * 60 * 1000)
  assert.equal(
    receipt.expiresAt - receipt.createdAt,
    RECEIPT_RETENTION_MS + RECEIPT_EXPIRY_GRACE_MS,
  )
  assert.equal(RECEIPT_EXPIRY_GRACE_MS, 24 * 60 * 60 * 1000)
  assert.equal(Object.hasOwn(receipt, 'rawBody'), false)
  assert.deepEqual(await f.store.claim(f.event), { status: 'in_progress' })
  assert.deepEqual(await f.store.claim({ ...f.event, payloadDigest: 'e'.repeat(64) }), {
    status: 'event_conflict',
  })
  assert.deepEqual(await f.store.claim({
    ...f.event, eventTimestamp: new Date('2026-09-01T00:00:01Z'),
  }), { status: 'in_progress' })
})

test('completed receipt returns processed and cannot be completed by a wrong lease', async () => {
  const f = fixture()
  const claim = await f.store.claim(f.event)
  await assert.rejects(f.store.complete({
    interfaceId: f.event.interfaceId, eventId: f.event.eventId,
    leaseToken: 'wrong', outcome: 'applied',
  }), /lease was lost/)
  await f.store.complete({
    interfaceId: f.event.interfaceId, eventId: f.event.eventId,
    leaseToken: claim.leaseToken, outcome: 'ignored',
  })
  assert.equal(f.collection.records[0].outcome, 'ignored')
  assert.equal(Object.hasOwn(f.collection.records[0], 'leaseToken'), false)
  assert.deepEqual(await f.store.claim(f.event), { status: 'processed' })
})

test('failed and expired processing can be safely reclaimed with a new fencing token', async () => {
  const f = fixture()
  const first = await f.store.claim(f.event)
  await f.store.fail({
    interfaceId: f.event.interfaceId, eventId: f.event.eventId,
    leaseToken: first.leaseToken, errorCode: 'SAFE_CODE',
  })
  assert.deepEqual(await f.store.claim(f.event), {
    status: 'claimed', leaseToken: 'lease-2', eventTimestamp: f.event.eventTimestamp,
  })
  f.setNow('2026-09-01T00:01:01Z')
  assert.deepEqual(await f.store.claim(f.event), {
    status: 'claimed', leaseToken: 'lease-3', eventTimestamp: f.event.eventTimestamp,
  })
  await assert.rejects(f.store.complete({
    interfaceId: f.event.interfaceId, eventId: f.event.eventId,
    leaseToken: 'lease-2', outcome: 'applied',
  }), /lease was lost/)
})

test('freshly signed retry reclaims the exact body under the original event timestamp', async () => {
  const f = fixture()
  const first = await f.store.claim(f.event)
  await f.store.fail({
    interfaceId: f.event.interfaceId,
    eventId: f.event.eventId,
    leaseToken: first.leaseToken,
    errorCode: 'FIRST_ATTEMPT_FAILED',
  })
  f.setNow('2026-09-01T00:00:02Z')
  const freshDeliveryTimestamp = new Date('2026-09-01T00:00:02Z')
  const recovered = await f.store.claim({
    ...f.event,
    eventTimestamp: freshDeliveryTimestamp,
  })
  assert.deepEqual(recovered, {
    status: 'claimed',
    leaseToken: 'lease-2',
    eventTimestamp: f.event.eventTimestamp,
  })
  assert.equal(
    f.collection.records[0].eventTimestamp.getTime(),
    f.event.eventTimestamp.getTime(),
  )
  assert.notEqual(recovered.eventTimestamp.getTime(), freshDeliveryTimestamp.getTime())
})

test('failed recovery is configuration-bound while processed replay stays generic', async () => {
  const f = fixture()
  const first = await f.store.claim({ ...f.event, configurationRevision: 3 })
  await f.store.fail({
    interfaceId: f.event.interfaceId,
    eventId: f.event.eventId,
    leaseToken: first.leaseToken,
    errorCode: 'FIRST_ATTEMPT_FAILED',
  })
  f.setNow('2026-09-01T00:00:02Z')
  assert.deepEqual(await f.store.claim({
    ...f.event,
    eventTimestamp: new Date('2026-09-01T00:00:02Z'),
    configurationRevision: 4,
  }), { status: 'event_conflict' })

  const recovered = await f.store.claim({
    ...f.event,
    eventTimestamp: new Date('2026-09-01T00:00:02Z'),
    configurationRevision: 3,
  })
  await f.store.complete({
    interfaceId: f.event.interfaceId,
    eventId: f.event.eventId,
    leaseToken: recovered.leaseToken,
    outcome: 'applied',
  })
  assert.deepEqual(await f.store.claim({
    ...f.event,
    eventTimestamp: new Date('2026-09-01T00:00:03Z'),
    configurationRevision: 99,
  }), { status: 'processed' })
})

test('legacy receipt without a configuration revision is normalized to revision zero', async () => {
  const f = fixture()
  const first = await f.store.claim(f.event)
  await f.store.fail({
    interfaceId: f.event.interfaceId,
    eventId: f.event.eventId,
    leaseToken: first.leaseToken,
    errorCode: 'FIRST_ATTEMPT_FAILED',
  })
  delete f.collection.records[0].configurationRevision
  f.setNow('2026-09-01T00:00:02Z')
  assert.equal((await f.store.claim({
    ...f.event,
    eventTimestamp: new Date('2026-09-01T00:00:02Z'),
  })).status, 'claimed')
})

test('near-retention-expiry recovery extends both lease safety and replay protection', async () => {
  const f = fixture()
  const first = await f.store.claim(f.event)
  await f.store.fail({
    interfaceId: f.event.interfaceId, eventId: f.event.eventId,
    leaseToken: first.leaseToken, errorCode: 'PROCESS_CRASHED',
  })
  f.setNow('2026-09-07T23:59:59Z')
  const recovered = await f.store.claim(f.event)
  assert.deepEqual(recovered, {
    status: 'claimed', leaseToken: 'lease-2', eventTimestamp: f.event.eventTimestamp,
  })
  const [receipt] = f.collection.records
  const recoveryTime = new Date('2026-09-07T23:59:59Z')
  assert.equal(receipt.leaseUntil - recoveryTime, PROCESSING_LEASE_MS)
  assert.equal(
    receipt.expiresAt - recoveryTime,
    RECEIPT_RETENTION_MS + RECEIPT_EXPIRY_GRACE_MS,
  )
  assert.ok(receipt.expiresAt > receipt.leaseUntil)

  f.setNow('2026-09-08T00:00:00Z')
  await f.store.complete({
    interfaceId: f.event.interfaceId, eventId: f.event.eventId,
    leaseToken: recovered.leaseToken, outcome: 'applied',
  })
  const completedExpiry = new Date(receipt.expiresAt)
  f.setNow('2026-09-08T00:01:00Z')
  assert.deepEqual(await f.store.claim(f.event), { status: 'processed' })
  assert.ok(receipt.expiresAt > completedExpiry)
})

test('an insert error other than duplicate is never mistaken for replay', async () => {
  const f = fixture()
  f.collection.insertAsync = async () => { throw new Error('database unavailable') }
  await assert.rejects(f.store.claim(f.event), /database unavailable/)
})
