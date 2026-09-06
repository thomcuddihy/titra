import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'

function sourceModule(path) {
  return `data:text/javascript;base64,${Buffer.from(readFileSync(new URL(path, import.meta.url))).toString('base64')}`
}

const security = await import(sourceModule('./webhookSecurity.js'))
const mapping = await import(sourceModule('./webhookMapping.js'))

const SECRET_TEXT = Buffer.alloc(32, 7).toString('base64url')
const SECRET = Buffer.from(SECRET_TEXT, 'base64url')
const NOW = new Date('2026-09-01T01:02:03.000Z')
const TIMESTAMP = String(Math.floor(NOW.getTime() / 1000))
const BODY = Buffer.from('{ "type":"ok", "user":{"id":"u1"} }', 'utf8')

function headers(body = BODY, timestamp = TIMESTAMP) {
  const signature = createHmac('sha256', SECRET)
    .update(Buffer.from(`${timestamp}.`)).update(body).digest('hex')
  return {
    'x-titra-webhook-timestamp': timestamp,
    'x-titra-webhook-event-id': 'provider:event-1',
    'x-titra-webhook-signature': `v1=${signature}`,
  }
}

test('secret environment names and strict canonical base64url decoding never expose secret text', () => {
  const endpoint = '0123456789abcdef0123456789abcdef'
  assert.equal(
    security.webhookSecretEnvironmentVariable(endpoint),
    'TITRA_WEBHOOK_SECRET_0123456789ABCDEF0123456789ABCDEF',
  )
  assert.deepEqual(security.decodeWebhookSecret(SECRET_TEXT), SECRET)
  for (const value of [undefined, '', 'x'.repeat(43), `${SECRET_TEXT}=`, SECRET_TEXT.slice(0, 42)]) {
    assert.equal(security.decodeWebhookSecret(value), undefined)
  }
  // Non-canonical trailing bits can decode to the same bytes but are rejected.
  const noncanonical = `${SECRET_TEXT.slice(0, -1)}${SECRET_TEXT.endsWith('c') ? 'd' : 'c'}`
  assert.equal(security.decodeWebhookSecret(noncanonical), undefined)
  assert.equal(security.resolveWebhookSecret(endpoint, {
    [security.webhookSecretEnvironmentVariable(endpoint)]: SECRET_TEXT,
  }).toString('hex'), SECRET.toString('hex'))
  assert.throws(() => security.webhookSecretEnvironmentVariable('../secret'), /Invalid/)
})

test('HMAC validates exact raw bytes, event ID and timestamp without trusting other headers', () => {
  assert.deepEqual(security.verifyWebhookAuthentication({
    headers: { ...headers(), host: 'forged', 'x-forwarded-host': 'forged' },
    rawBody: BODY,
    secret: SECRET,
    now: NOW,
  }), { eventId: 'provider:event-1', eventTimestamp: new Date(Number(TIMESTAMP) * 1000) })
  const normalizedBody = Buffer.from(JSON.stringify(JSON.parse(BODY)))
  assert.equal(security.verifyWebhookAuthentication({
    headers: headers(), rawBody: normalizedBody, secret: SECRET, now: NOW,
  }), undefined)
})

test('HMAC fails closed for malformed, duplicate, stale, future, oversized and wrong credentials', () => {
  const cases = [
    { headers: {}, rawBody: BODY, secret: SECRET, now: NOW },
    { headers: headers(), rawBody: BODY, secret: Buffer.alloc(31), now: NOW },
    { headers: headers(), rawBody: BODY, secret: Buffer.alloc(32, 8), now: NOW },
    { headers: { ...headers(), 'x-titra-webhook-event-id': ['one', 'two'] }, rawBody: BODY, secret: SECRET, now: NOW },
    { headers: { ...headers(), 'x-titra-webhook-event-id': '../bad' }, rawBody: BODY, secret: SECRET, now: NOW },
    { headers: { ...headers(), 'x-titra-webhook-signature': `v2=${'0'.repeat(64)}` }, rawBody: BODY, secret: SECRET, now: NOW },
    { headers: headers(BODY, String(Number(TIMESTAMP) - 301)), rawBody: BODY, secret: SECRET, now: NOW },
    { headers: headers(BODY, String(Number(TIMESTAMP) + 301)), rawBody: BODY, secret: SECRET, now: NOW },
    { headers: headers(BODY), rawBody: BODY, secret: SECRET, now: new Date(Number.NaN) },
    { headers: headers(), rawBody: Buffer.alloc(security.MAX_WEBHOOK_BODY_BYTES + 1), secret: SECRET, now: NOW },
  ]
  cases.forEach((value) => assert.equal(security.verifyWebhookAuthentication(value), undefined))
})

const rules = [{
  eventPointer: '/type', eventEquals: 'ok', userIdPointer: '/user/id', action: 'complete',
}, {
  eventPointer: '/escaped~1name', eventEquals: 4, userIdPointer: '/nested/~0id', action: 'revoke',
}]

test('declarative mapping returns only bounded action/user ID and supports RFC6901 escapes', () => {
  assert.deepEqual(mapping.mapWebhookPayload({ type: 'ok', user: { id: 'u1' } }, rules), {
    action: 'complete', userId: 'u1',
  })
  assert.deepEqual(mapping.mapWebhookPayload({
    'escaped/name': 4, nested: { '~id': 'u2' },
  }, rules), { action: 'revoke', userId: 'u2' })
  assert.equal(mapping.mapWebhookPayload({ type: 'other', user: { id: 'u1' } }, rules), null)
  assert.equal(mapping.mapWebhookPayload({ type: 'ok', user: { id: '' } }, rules), null)
  assert.equal(mapping.mapWebhookPayload({ type: 'ok', user: { id: '\ud800' } }, rules), null)
})

test('mapping rejects executable, inherited, nonfinite, overly deep and prototype paths', () => {
  for (const invalid of [
    [],
    [{ eventPointer: '/type', eventEquals: Infinity, userIdPointer: '/id', action: 'complete' }],
    [{ eventPointer: '/type', eventEquals: NaN, userIdPointer: '/id', action: 'complete' }],
    [{ eventPointer: '/type', eventEquals: 'ok', userIdPointer: '/id', action: 'execute' }],
    [{ eventPointer: '/constructor', eventEquals: 'ok', userIdPointer: '/id', action: 'complete' }],
    [{ eventPointer: '/bad~2escape', eventEquals: 'ok', userIdPointer: '/id', action: 'complete' }],
    [{ eventPointer: `/${'x/'.repeat(65)}x`, eventEquals: 'ok', userIdPointer: '/id', action: 'complete' }],
    [{ eventPointer: '/type', eventEquals: 'ok', userIdPointer: '/id', action: 'complete', script: 'return process.env' }],
  ]) assert.throws(() => mapping.validateWebhookMappingRules(invalid))
  const inherited = Object.create({ type: 'ok' })
  inherited.user = { id: 'u1' }
  assert.throws(() => mapping.mapWebhookPayload(inherited, rules), /JSON object/)
})
