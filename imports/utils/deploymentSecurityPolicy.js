function exactRuntimeBoolean(value) {
  return value === true || value === 'true'
}

function normalizeFrameAncestorOrigin(value) {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string' || value !== value.trim()) {
    throw new TypeError('Invalid frame ancestor origin.')
  }
  let parsed
  try {
    parsed = new URL(value)
  } catch {
    throw new TypeError('Invalid frame ancestor origin.')
  }
  if (
    !['http:', 'https:'].includes(parsed.protocol)
    || parsed.username !== ''
    || parsed.password !== ''
    || parsed.pathname !== '/'
    || parsed.search !== ''
    || parsed.hash !== ''
    || parsed.origin === 'null'
  ) throw new TypeError('Invalid frame ancestor origin.')
  return parsed.origin
}

export { exactRuntimeBoolean, normalizeFrameAncestorOrigin }
