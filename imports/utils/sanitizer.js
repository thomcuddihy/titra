const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor'])

// Utility function for slug sanitization
function sanitizeSlug(input) {
  if (!input || typeof input !== 'string') return ''
  return input
    .toLowerCase()
    .trim()
    // Replace spaces with dashes
    .replace(/\s+/g, '-')
    // Remove special characters but KEEP letters, numbers, AND DASHES
    .replace(/[^a-z0-9\-]/g, '') // This keeps dashes!
    // Replace multiple dashes with single dash
    .replace(/-+/g, '-')
    // Remove dashes from start and end
    .replace(/^-/g, '')
    // Limit length
    .substring(0, 100)
}

function buildSafePayload(payload, allowedKeys = null, forbiddenKeys = DANGEROUS_KEYS) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return {}
  }

  const allowedKeySet = allowedKeys instanceof Set ? allowedKeys : new Set(allowedKeys || [])
  const forbiddenKeySet = forbiddenKeys instanceof Set ? forbiddenKeys : new Set(forbiddenKeys || [])
  const safePayload = {}

  for (const [key, value] of Object.entries(payload)) {
    if (forbiddenKeySet.has(key) || key === '__proto__' || key === 'prototype' || key === 'constructor') {
      continue
    }
    if (allowedKeys && !allowedKeySet.has(key)) {
      continue
    }
    if (Object.prototype.hasOwnProperty.call(safePayload, key)) {
      continue
    }
    safePayload[key] = value
  }

  return safePayload
}

function sanitizeObject(object, forbiddenKeys = new Set()) {
  if (!object || typeof object !== 'object' || Array.isArray(object)) {
    return {}
  }

  return buildSafePayload(object, null, new Set([...DANGEROUS_KEYS, ...(forbiddenKeys || [])]))
}

export {
  sanitizeSlug,
  sanitizeObject,
  buildSafePayload,
}
