const RESOURCE_KINDS = new Set([
  'project',
  'project-task',
  'task-suggestion',
  'timer',
])
const REVISION_FIELDS = {
  project: 'projectRevision',
  'project-task': 'projectTaskRevision',
  'task-suggestion': 'taskSuggestionRevision',
  timer: 'timerRevision',
}

function assertKind(kind) {
  if (!RESOURCE_KINDS.has(kind)) {
    throw new TypeError('Unsupported revision resource kind')
  }
}

function revisionFieldFor(kind) {
  assertKind(kind)
  return REVISION_FIELDS[kind]
}

function resourceRevisionETag(kind, resource) {
  assertKind(kind)
  const field = revisionFieldFor(kind)
  if (!resource || !Object.prototype.hasOwnProperty.call(resource, field)) {
    return `"titra-${kind}-revision-legacy"`
  }
  const revision = resource[field]
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new TypeError(`${kind} has an invalid revision`)
  }
  return `"titra-${kind}-revision-${revision}"`
}

function parseResourceRevisionETag(kind, value) {
  assertKind(kind)
  if (typeof value !== 'string') {
    throw new TypeError(`If-Match must contain one Titra ${kind} revision ETag`)
  }
  const normalized = value.trim()
  if (normalized === `"titra-${kind}-revision-legacy"`) return null
  const escapedKind = kind.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = normalized.match(new RegExp(`^"titra-${escapedKind}-revision-(0|[1-9]\\d*)"$`))
  if (!match) {
    throw new TypeError(`If-Match must contain one Titra ${kind} revision ETag`)
  }
  const revision = Number(match[1])
  if (!Number.isSafeInteger(revision)) {
    throw new TypeError(`If-Match ${kind} revision is too large`)
  }
  return revision
}

function matchesResourceRevision(kind, resource, expectedRevision) {
  const field = revisionFieldFor(kind)
  if (expectedRevision === null) {
    return Boolean(resource) && !Object.prototype.hasOwnProperty.call(resource, field)
  }
  return Boolean(resource)
    && Object.prototype.hasOwnProperty.call(resource, field)
    && resource[field] === expectedRevision
}

export {
  matchesResourceRevision,
  parseResourceRevisionETag,
  resourceRevisionETag,
  revisionFieldFor,
}
