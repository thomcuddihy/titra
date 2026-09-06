import assert from 'node:assert/strict'
import test from 'node:test'

import { perCallerDdpRule } from './ddpRateLimitPolicy.js'

test('general DDP limits retain caller dimensions instead of one global bucket', () => {
  const rule = perCallerDdpRule('method', 'safeMethod')
  assert.equal(rule.type, 'method')
  assert.equal(rule.name, 'safeMethod')
  assert.equal(rule.userId('user-a'), true)
  assert.equal(rule.connectionId('connection-a'), true)
  assert.equal(rule.clientAddress('192.0.2.1'), true)
  assert.throws(() => perCallerDdpRule('route', 'name'), TypeError)
  assert.throws(() => perCallerDdpRule('method', ''), TypeError)
})
