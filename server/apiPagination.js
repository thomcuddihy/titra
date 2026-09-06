import { createHash } from 'node:crypto'

const PAGINATION_VERSION = 1
const DEFAULT_PAGE_LIMIT = 200
const MAX_PAGE_LIMIT = 500
const MAX_LEGACY_RESULT_LIMIT = 500
const MAX_DATE_RANGE_DAYS = 366
const READ_AGGREGATION_MAX_TIME_MS = 5000
const MAX_CURSOR_LENGTH = 2048
const CURSOR_PATTERN = /^[A-Za-z0-9_-]+$/
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000

class PaginationError extends Error {
  constructor(code, message, options) {
    super(message, options)
    this.name = 'PaginationError'
    this.code = code
    this.error = code
  }
}

function stableObject(value) {
  if (value === null || ['string', 'boolean'].includes(typeof value)) return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Invalid pagination scope number.')
    return Object.is(value, -0) ? 0 : value
  }
  if (Array.isArray(value)) return value.map(stableObject)
  if (!value || typeof value !== 'object') throw new TypeError('Invalid pagination scope.')
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError('Pagination scope must use plain objects.')
  }
  return Object.keys(value).sort().reduce((result, key) => {
    result[key] = stableObject(value[key])
    return result
  }, {})
}

function scopeDigest(scope) {
  return createHash('sha256')
    .update(
      `titra-page-scope-v${PAGINATION_VERSION}\0${JSON.stringify(stableObject(scope))}`, 'utf8',
    )
    .digest('hex')
}

function encodeCursor({ scope, date, id }) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new TypeError('Cursor date must be valid.')
  }
  if (typeof id !== 'string' || !id || id.length > 128) {
    throw new TypeError('Cursor ID must contain 1 to 128 characters.')
  }
  return Buffer.from(JSON.stringify({
    v: PAGINATION_VERSION,
    q: scopeDigest(scope),
    d: date.toISOString(),
    i: id,
  }), 'utf8').toString('base64url')
}

function decodeCursor(value, scope) {
  if (typeof value !== 'string' || !value || value.length > MAX_CURSOR_LENGTH
    || !CURSOR_PATTERN.test(value)) {
    throw new PaginationError('invalid-cursor', 'The page cursor is invalid.')
  }
  let parsed
  try {
    const decoded = Buffer.from(value, 'base64url')
    if (decoded.toString('base64url') !== value) throw new Error('Non-canonical cursor')
    parsed = JSON.parse(decoded.toString('utf8'))
  } catch (error) {
    throw new PaginationError(
      'invalid-cursor', 'The page cursor is invalid.', { cause: error },
    )
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
    || Object.keys(parsed).sort().join(',') !== 'd,i,q,v'
    || parsed.v !== PAGINATION_VERSION
    || parsed.q !== scopeDigest(scope)
    || typeof parsed.d !== 'string'
    || typeof parsed.i !== 'string'
    || !parsed.i
    || parsed.i.length > 128) {
    throw new PaginationError(
      'cursor-query-mismatch',
      'The page cursor is invalid or belongs to a different query.',
    )
  }
  const date = new Date(parsed.d)
  if (Number.isNaN(date.getTime()) || date.toISOString() !== parsed.d) {
    throw new PaginationError('invalid-cursor', 'The page cursor contains an invalid date.')
  }
  return { date, id: parsed.i }
}

function queryValues(query, name) {
  if (query instanceof URLSearchParams) return query.getAll(name)
  const value = query?.[name]
  if (value == null) return []
  return Array.isArray(value) ? value.map(String) : [String(value)]
}

function queryKeys(query) {
  if (query == null) return []
  if (query instanceof URLSearchParams) return [...new Set(query.keys())]
  if (typeof query !== 'object' || Array.isArray(query)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(query))) {
    throw new TypeError('Page options must use URLSearchParams or a plain object.')
  }
  return Object.keys(query)
}

function parsePageOptions(query, scope, {
  defaultLimit = DEFAULT_PAGE_LIMIT, maxLimit = MAX_PAGE_LIMIT,
} = {}) {
  if (!Number.isSafeInteger(defaultLimit) || defaultLimit < 1
    || !Number.isSafeInteger(maxLimit) || maxLimit < defaultLimit) {
    throw new TypeError('Invalid page limit configuration.')
  }
  // Validate every scope even when this is a one-page result that will not
  // otherwise need to encode or decode a cursor.
  scopeDigest(scope)
  const unknown = queryKeys(query).filter((key) => !['cursor', 'limit'].includes(key))
  if (unknown.length) {
    throw new PaginationError(
      'invalid-page-options', `Unknown page option: ${unknown.sort()[0]}.`,
    )
  }
  const limits = queryValues(query, 'limit')
  const cursors = queryValues(query, 'cursor')
  if (limits.length > 1 || cursors.length > 1) {
    throw new PaginationError('invalid-page-options', 'Page options must not be repeated.')
  }
  let limit = defaultLimit
  if (limits.length) {
    if (!/^[1-9][0-9]*$/.test(limits[0])) {
      throw new PaginationError('invalid-page-limit', 'Page limit must be a positive integer.')
    }
    limit = Number(limits[0])
    if (!Number.isSafeInteger(limit) || limit > maxLimit) {
      throw new PaginationError(
        'invalid-page-limit', `Page limit must be between 1 and ${maxLimit}.`,
      )
    }
  }
  return {
    limit,
    after: cursors.length ? decodeCursor(cursors[0], scope) : null,
  }
}

function selectorAfter(baseSelector, after) {
  if (!after) return baseSelector
  return {
    $and: [
      baseSelector,
      {
        $or: [
          { date: { $gt: after.date } },
          { date: after.date, _id: { $gt: after.id } },
        ],
      },
    ],
  }
}

function assertPositiveLimit(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive safe integer.`)
  }
}

/**
 * Enforces the maximum calendar span accepted by an API date-range read.
 * The dateOnlyRange helper supplies an inclusive end-of-day value, but this
 * also works with midnight bounds and is deliberately independent of locale.
 */
function assertDateRangeLimit(
  { startDate, endDate }, maxDays = MAX_DATE_RANGE_DAYS,
) {
  assertPositiveLimit(maxDays, 'Maximum date range')
  if (!(startDate instanceof Date) || Number.isNaN(startDate.getTime())
    || !(endDate instanceof Date) || Number.isNaN(endDate.getTime())
    || startDate > endDate) {
    throw new TypeError('A valid ordered date range is required.')
  }
  const days = Math.floor((endDate.getTime() - startDate.getTime()) / MILLISECONDS_PER_DAY) + 1
  if (days > maxDays) {
    throw new PaginationError(
      'date-range-too-large',
      `Date ranges may contain at most ${maxDays} calendar days.`,
    )
  }
  return days
}

/**
 * Keeps legacy array response contracts without silently truncating them.
 * Callers query one sentinel row beyond the public ceiling; oversized reads
 * are rejected and clients can move to an advertised paginated route.
 */
async function fetchBoundedLegacyList({
  find,
  baseSelector,
  sort,
  maxLimit = MAX_LEGACY_RESULT_LIMIT,
}) {
  if (typeof find !== 'function') throw new TypeError('A bounded query callback is required.')
  assertPositiveLimit(maxLimit, 'Legacy result limit')
  if (!sort || typeof sort !== 'object' || Array.isArray(sort)) {
    throw new TypeError('A stable bounded-query sort is required.')
  }
  const documents = await find(baseSelector, { sort, limit: maxLimit + 1 })
  if (!Array.isArray(documents)) throw new TypeError('A bounded query must return an array.')
  if (documents.length > maxLimit) {
    throw new PaginationError(
      'legacy-result-too-large',
      `The result exceeds the legacy limit of ${maxLimit} records.`,
    )
  }
  return documents
}

/**
 * Applies the same sentinel ceiling to a Mongo aggregation and supplies a
 * short server-side execution deadline. Disk spilling stays disabled so a
 * token-authenticated request cannot create an unbounded temporary workload.
 */
async function fetchBoundedAggregationList({
  aggregate,
  pipeline,
  maxLimit = MAX_LEGACY_RESULT_LIMIT,
  maxTimeMS = READ_AGGREGATION_MAX_TIME_MS,
}) {
  if (typeof aggregate !== 'function') {
    throw new TypeError('A bounded aggregation callback is required.')
  }
  if (!Array.isArray(pipeline)) throw new TypeError('An aggregation pipeline is required.')
  assertPositiveLimit(maxLimit, 'Aggregation result limit')
  assertPositiveLimit(maxTimeMS, 'Aggregation execution limit')
  const documents = await aggregate(
    [...pipeline, { $limit: maxLimit + 1 }],
    { allowDiskUse: false, maxTimeMS },
  )
  if (!Array.isArray(documents)) throw new TypeError('A bounded aggregation must return an array.')
  if (documents.length > maxLimit) {
    throw new PaginationError(
      'legacy-result-too-large',
      `The result exceeds the legacy limit of ${maxLimit} records.`,
    )
  }
  return documents
}

async function fetchTimeentryPage({
  find,
  baseSelector,
  scope,
  query,
  defaultLimit = DEFAULT_PAGE_LIMIT,
  maxLimit = MAX_PAGE_LIMIT,
}) {
  if (typeof find !== 'function') throw new TypeError('A page query callback is required.')
  const { limit, after } = parsePageOptions(query, scope, { defaultLimit, maxLimit })
  const documents = await find(
    selectorAfter(baseSelector, after),
    { sort: { date: 1, _id: 1 }, limit: limit + 1 },
  )
  if (!Array.isArray(documents)) throw new TypeError('Page query callback must return an array.')
  const hasMore = documents.length > limit
  const items = documents.slice(0, limit)
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]
    if (!item || typeof item._id !== 'string' || !(item.date instanceof Date)
      || Number.isNaN(item.date.getTime())) {
      throw new TypeError('A paginated time entry has an invalid date or ID.')
    }
    if (index > 0) {
      const previous = items[index - 1]
      const ordered = previous.date < item.date
        || (previous.date.getTime() === item.date.getTime() && previous._id < item._id)
      if (!ordered) throw new TypeError('Page query returned time entries out of order.')
    }
  }
  const last = items.at(-1)
  return {
    items,
    page: {
      version: PAGINATION_VERSION,
      limit,
      returned: items.length,
      complete: !hasMore,
      nextCursor: hasMore && last ? encodeCursor({ scope, date: last.date, id: last._id }) : null,
      consistency: 'live-keyset',
    },
  }
}

export {
  DEFAULT_PAGE_LIMIT,
  MAX_DATE_RANGE_DAYS,
  MAX_CURSOR_LENGTH,
  MAX_LEGACY_RESULT_LIMIT,
  MAX_PAGE_LIMIT,
  PAGINATION_VERSION,
  PaginationError,
  READ_AGGREGATION_MAX_TIME_MS,
  assertDateRangeLimit,
  decodeCursor,
  encodeCursor,
  fetchBoundedAggregationList,
  fetchBoundedLegacyList,
  fetchTimeentryPage,
  parsePageOptions,
  scopeDigest,
  selectorAfter,
}
