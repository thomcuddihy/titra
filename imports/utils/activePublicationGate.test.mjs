import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createActivePublicationGate,
  createAnonymousPublicationGate,
} from './activePublicationGate.js'

test('active publication gate enforces user, peer, and process bounds', () => {
  const gate = createActivePublicationGate({ perUser: 2, perPeer: 3, total: 4 })
  const one = gate.acquire({ userId: 'u1', peerAddress: '192.0.2.1' })
  const two = gate.acquire({ userId: 'u1', peerAddress: '192.0.2.1' })
  assert.equal(typeof one, 'function')
  assert.equal(typeof two, 'function')
  assert.equal(gate.acquire({ userId: 'u1', peerAddress: '192.0.2.2' }), null)
  const three = gate.acquire({ userId: 'u2', peerAddress: '192.0.2.1' })
  assert.equal(typeof three, 'function')
  assert.equal(gate.acquire({ userId: 'u3', peerAddress: '192.0.2.1' }), null)
  const four = gate.acquire({ userId: 'u3', peerAddress: '192.0.2.3' })
  assert.equal(typeof four, 'function')
  assert.equal(gate.acquire({ userId: 'u4', peerAddress: '192.0.2.4' }), null)
  one()
  one()
  assert.deepEqual(gate.snapshot(), { activeCount: 3, peers: 2, users: 3 })
  assert.equal(typeof gate.acquire({ userId: 'u4', peerAddress: '192.0.2.4' }), 'function')
})

test('active publication gate rejects invalid identities and configuration', () => {
  assert.throws(() => createActivePublicationGate({ perUser: 0 }), /Invalid/)
  const gate = createActivePublicationGate()
  assert.equal(gate.acquire({ userId: '', peerAddress: '192.0.2.1' }), null)
  assert.equal(gate.acquire({ userId: 'x'.repeat(129), peerAddress: '192.0.2.1' }), null)
})

test('anonymous gate independently bounds peers, resources, and total occupancy', () => {
  const gate = createAnonymousPublicationGate({ perPeer: 1, perResource: 2, total: 2 })
  const one = gate.acquire({ peerAddress: '192.0.2.1', resourceId: 'project-1' })
  assert.equal(typeof one, 'function')
  assert.equal(gate.acquire({ peerAddress: '192.0.2.1', resourceId: 'project-2' }), null)
  const two = gate.acquire({ peerAddress: '192.0.2.2', resourceId: 'project-1' })
  assert.equal(typeof two, 'function')
  assert.equal(gate.acquire({ peerAddress: '192.0.2.3', resourceId: 'project-2' }), null)
  one()
  one()
  assert.deepEqual(gate.snapshot(), { activeCount: 1, peers: 1, resources: 1 })
})
