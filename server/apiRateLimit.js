const DEFAULT_UNAUTHENTICATED_REQUESTS_PER_MINUTE = 300
const DEFAULT_AUTHENTICATED_REQUESTS_PER_MINUTE = 1200
const MAX_TRACKED_KEYS = 10000

function boundedRate(value, fallback) {
  if (typeof value !== 'string' || !/^\d{1,6}$/.test(value)) return fallback
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 10 && parsed <= 60000 ? parsed : fallback
}

function requestPeerAddress(req) {
  const value = req?.socket?.remoteAddress ?? req?.connection?.remoteAddress
  return typeof value === 'string' && value.length > 0 && value.length <= 128
    ? value : 'unknown-peer'
}

class TokenBucketLimiter {
  constructor({ ratePerMinute, maxKeys = MAX_TRACKED_KEYS, now = () => Date.now() }) {
    this.ratePerMinute = ratePerMinute
    this.capacity = ratePerMinute
    this.maxKeys = maxKeys
    this.now = now
    this.buckets = new Map()
  }

  evictIfNecessary(now) {
    if (this.buckets.size < this.maxKeys) return
    let oldestKey
    let oldestSeen = Number.POSITIVE_INFINITY
    this.buckets.forEach((bucket, key) => {
      if (bucket.lastSeen < oldestSeen) {
        oldestKey = key
        oldestSeen = bucket.lastSeen
      }
    })
    if (oldestKey !== undefined) this.buckets.delete(oldestKey)
  }

  consume(key) {
    const now = this.now()
    const normalizedKey = typeof key === 'string' && key.length <= 256 ? key : 'invalid-key'
    let bucket = this.buckets.get(normalizedKey)
    if (!bucket) {
      this.evictIfNecessary(now)
      bucket = { tokens: this.capacity, lastRefill: now, lastSeen: now }
      this.buckets.set(normalizedKey, bucket)
    }
    const elapsed = Math.max(0, now - bucket.lastRefill)
    bucket.tokens = Math.min(
      this.capacity,
      bucket.tokens + ((elapsed * this.ratePerMinute) / 60000),
    )
    bucket.lastRefill = now
    bucket.lastSeen = now
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1
      return { allowed: true }
    }
    const missing = 1 - bucket.tokens
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((missing * 60) / this.ratePerMinute)),
    }
  }
}

function createAPIRateLimits(environment = globalThis.process?.env, now) {
  const unauthenticated = new TokenBucketLimiter({
    ratePerMinute: boundedRate(
      environment?.TITRA_API_UNAUTHENTICATED_RATE_PER_MINUTE,
      DEFAULT_UNAUTHENTICATED_REQUESTS_PER_MINUTE,
    ),
    now,
  })
  const authenticated = new TokenBucketLimiter({
    ratePerMinute: boundedRate(
      environment?.TITRA_API_AUTHENTICATED_RATE_PER_MINUTE,
      DEFAULT_AUTHENTICATED_REQUESTS_PER_MINUTE,
    ),
    now,
  })
  return {
    consumePeer: (req) => unauthenticated.consume(requestPeerAddress(req)),
    consumeUser: (userId) => authenticated.consume(String(userId || 'missing-user')),
  }
}

export {
  DEFAULT_AUTHENTICATED_REQUESTS_PER_MINUTE,
  DEFAULT_UNAUTHENTICATED_REQUESTS_PER_MINUTE,
  MAX_TRACKED_KEYS,
  TokenBucketLimiter,
  boundedRate,
  createAPIRateLimits,
  requestPeerAddress,
}
