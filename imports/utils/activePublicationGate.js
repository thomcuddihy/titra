const DEFAULT_ACTIVE_PUBLICATIONS_PER_USER = 10
const DEFAULT_ACTIVE_PUBLICATIONS_PER_PEER = 30
const DEFAULT_ACTIVE_PUBLICATIONS_TOTAL = 300

function validBound(value) {
  return Number.isSafeInteger(value) && value >= 1
}

/**
 * Bound retained reactive server state independently of DDP start-rate rules.
 * A returned release callback is idempotent so it is safe to register directly
 * with a publication's onStop lifecycle.
 */
function createActivePublicationGate({
  perUser = DEFAULT_ACTIVE_PUBLICATIONS_PER_USER,
  perPeer = DEFAULT_ACTIVE_PUBLICATIONS_PER_PEER,
  total = DEFAULT_ACTIVE_PUBLICATIONS_TOTAL,
} = {}) {
  if (![perUser, perPeer, total].every(validBound)) {
    throw new TypeError('Invalid active publication bound')
  }
  const userCounts = new Map()
  const peerCounts = new Map()
  let activeCount = 0

  function acquire({ userId, peerAddress }) {
    if (typeof userId !== 'string' || !userId || userId.length > 128) return null
    const peer = typeof peerAddress === 'string' && peerAddress && peerAddress.length <= 256
      ? peerAddress : 'unknown'
    if (activeCount >= total
      || (userCounts.get(userId) || 0) >= perUser
      || (peerCounts.get(peer) || 0) >= perPeer) return null

    activeCount += 1
    userCounts.set(userId, (userCounts.get(userId) || 0) + 1)
    peerCounts.set(peer, (peerCounts.get(peer) || 0) + 1)
    let active = true
    return () => {
      if (!active) return
      active = false
      activeCount -= 1
      const userCount = (userCounts.get(userId) || 1) - 1
      const peerCount = (peerCounts.get(peer) || 1) - 1
      if (userCount) userCounts.set(userId, userCount)
      else userCounts.delete(userId)
      if (peerCount) peerCounts.set(peer, peerCount)
      else peerCounts.delete(peer)
    }
  }

  return {
    acquire,
    snapshot: () => ({
      activeCount,
      peers: peerCounts.size,
      users: userCounts.size,
    }),
  }
}

function createAnonymousPublicationGate({ perPeer = 10, perResource = 50, total = 200 } = {}) {
  if (![perPeer, perResource, total].every(validBound)) {
    throw new TypeError('Invalid anonymous publication bound')
  }
  const peerCounts = new Map()
  const resourceCounts = new Map()
  let activeCount = 0

  function acquire({ peerAddress, resourceId }) {
    if (typeof resourceId !== 'string' || !resourceId || resourceId.length > 256) return null
    const peer = typeof peerAddress === 'string' && peerAddress && peerAddress.length <= 256
      ? peerAddress : 'unknown'
    if (activeCount >= total
      || (peerCounts.get(peer) || 0) >= perPeer
      || (resourceCounts.get(resourceId) || 0) >= perResource) return null
    activeCount += 1
    peerCounts.set(peer, (peerCounts.get(peer) || 0) + 1)
    resourceCounts.set(resourceId, (resourceCounts.get(resourceId) || 0) + 1)
    let active = true
    return () => {
      if (!active) return
      active = false
      activeCount -= 1
      const peerCount = (peerCounts.get(peer) || 1) - 1
      const resourceCount = (resourceCounts.get(resourceId) || 1) - 1
      if (peerCount) peerCounts.set(peer, peerCount)
      else peerCounts.delete(peer)
      if (resourceCount) resourceCounts.set(resourceId, resourceCount)
      else resourceCounts.delete(resourceId)
    }
  }

  return { acquire, snapshot: () => ({ activeCount, peers: peerCounts.size, resources: resourceCounts.size }) }
}

export {
  DEFAULT_ACTIVE_PUBLICATIONS_PER_PEER,
  DEFAULT_ACTIVE_PUBLICATIONS_PER_USER,
  DEFAULT_ACTIVE_PUBLICATIONS_TOTAL,
  createActivePublicationGate,
  createAnonymousPublicationGate,
}
