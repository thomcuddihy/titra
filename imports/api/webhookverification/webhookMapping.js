const FORBIDDEN_POINTER_PARTS = new Set(['__proto__', 'prototype', 'constructor'])
const ACTIONS = new Set(['complete', 'revoke'])
const MAX_EVENT_EQUALS_CODE_POINTS = 512

function decodePointer(pointer) {
  if (typeof pointer !== 'string' || !pointer.startsWith('/') || pointer.length > 512) {
    throw new TypeError('Webhook mapping pointers must be bounded RFC 6901 pointers')
  }
  const parts = pointer.slice(1).split('/')
  if (parts.length > 64) throw new TypeError('Webhook mapping pointer is too deep')
  return parts.map((part) => {
    if (/~(?:[^01]|$)/.test(part)) throw new TypeError('Invalid RFC 6901 escape')
    const decoded = part.replaceAll('~1', '/').replaceAll('~0', '~')
    if (!decoded || FORBIDDEN_POINTER_PARTS.has(decoded)) {
      throw new TypeError('Unsafe webhook mapping pointer')
    }
    return decoded
  })
}

function scalar(value) {
  return value === null
    || (typeof value === 'string' && value.isWellFormed()
      && [...value].length <= MAX_EVENT_EQUALS_CODE_POINTS)
    || typeof value === 'boolean'
    || (typeof value === 'number' && Number.isFinite(value))
}

function validateWebhookMappingRules(rules) {
  if (!Array.isArray(rules) || rules.length < 1 || rules.length > 32) {
    throw new TypeError('Webhook mapping requires 1–32 rules')
  }
  rules.forEach((rule) => {
    if (!rule || Object.getPrototypeOf(rule) !== Object.prototype
      || Object.keys(rule).length !== 4
      || !Object.hasOwn(rule, 'eventPointer')
      || !Object.hasOwn(rule, 'eventEquals')
      || !Object.hasOwn(rule, 'userIdPointer')
      || !Object.hasOwn(rule, 'action')
      || !scalar(rule.eventEquals)
      || !ACTIONS.has(rule.action)) {
      throw new TypeError('Invalid webhook mapping rule')
    }
    decodePointer(rule.eventPointer)
    decodePointer(rule.userIdPointer)
  })
  return rules
}

function readPointer(payload, pointer) {
  let value = payload
  for (const part of decodePointer(pointer)) {
    if (value == null || typeof value !== 'object'
      || !Object.hasOwn(value, part)) return undefined
    value = value[part]
  }
  return value
}

function mapWebhookPayload(payload, rules) {
  validateWebhookMappingRules(rules)
  if (!payload || Object.getPrototypeOf(payload) !== Object.prototype) {
    throw new TypeError('Webhook payload must be a JSON object')
  }
  for (const rule of rules) {
    if (Object.is(readPointer(payload, rule.eventPointer), rule.eventEquals)) {
      const userId = readPointer(payload, rule.userIdPointer)
      if (typeof userId !== 'string' || !userId || userId.length > 128
        || !userId.isWellFormed()) return null
      return { action: rule.action, userId }
    }
  }
  return null
}

export {
  MAX_EVENT_EQUALS_CODE_POINTS,
  mapWebhookPayload,
  readPointer,
  validateWebhookMappingRules,
}
