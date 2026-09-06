import assert from 'node:assert/strict'
import test from 'node:test'

import {
  TokenBucketLimiter,
  boundedRate,
  createAPIRateLimits,
  requestPeerAddress,
} from './apiRateLimit.js'

test('rate configuration is bounded and rejects ambiguous values', () => {
  assert.equal(boundedRate('300', 10), 300)
  for (const invalid of [undefined, '', '09', '1e3', '-1', '60001', 300]) {
    assert.equal(boundedRate(invalid, 77), 77, String(invalid))
  }
})

test('peer identity comes only from the transport and ignores forwarded headers', () => {
  assert.equal(requestPeerAddress({
    socket: { remoteAddress: '127.0.0.1' },
    headers: { 'x-forwarded-for': '203.0.113.7' },
  }), '127.0.0.1')
  assert.equal(requestPeerAddress({ connection: { remoteAddress: '::1' } }), '::1')
  assert.equal(requestPeerAddress({ headers: { 'x-forwarded-for': '203.0.113.7' } }), 'unknown-peer')
})

test('token bucket has a bounded burst, refills, and reports a retry delay', () => {
  let now = 0
  const limiter = new TokenBucketLimiter({ ratePerMinute: 60, now: () => now })
  for (let index = 0; index < 60; index += 1) {
    assert.deepEqual(limiter.consume('peer'), { allowed: true })
  }
  assert.deepEqual(limiter.consume('peer'), { allowed: false, retryAfterSeconds: 1 })
  now = 1000
  assert.deepEqual(limiter.consume('peer'), { allowed: true })
})

test('tracked identities are bounded with deterministic oldest-key eviction', () => {
  let now = 0
  const limiter = new TokenBucketLimiter({ ratePerMinute: 10, maxKeys: 2, now: () => now })
  limiter.consume('first')
  now = 1
  limiter.consume('second')
  now = 2
  limiter.consume('third')
  assert.deepEqual([...limiter.buckets.keys()], ['second', 'third'])
})

test('peer and authenticated-user buckets are independent', () => {
  let now = 0
  const limits = createAPIRateLimits({
    TITRA_API_UNAUTHENTICATED_RATE_PER_MINUTE: '10',
    TITRA_API_AUTHENTICATED_RATE_PER_MINUTE: '10',
  }, () => now)
  const req = { socket: { remoteAddress: 'proxy' } }
  for (let index = 0; index < 10; index += 1) limits.consumePeer(req)
  assert.equal(limits.consumePeer(req).allowed, false)
  assert.equal(limits.consumeUser('user-1').allowed, true)
  assert.equal(limits.consumeUser('user-2').allowed, true)
})
