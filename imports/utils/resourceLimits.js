const DAY_MS = 24 * 60 * 60 * 1000

// These are server-enforced ceilings, not UI pagination defaults. Keep the
// two-year project-task view working while preventing one DDP subscription
// from retaining an arbitrary portion of the timecards collection.
const MAX_TIMECARD_PUBLICATION_DAYS = 735
const MAX_TIMECARD_PUBLICATION_RECORDS = 10000
const MAX_WEEK_TIMECARD_RECORDS = 1000
const MAX_WORKING_TIME_ROWS = 500
const MAX_PROJECT_SCOPE_IDS = 1000
const MAX_RESOURCE_PAGE = 10000
const RESOURCE_QUERY_MAX_TIME_MS = 5000
const MAX_RESOURCE_SCOPE_TEXT = 128

function invalid(message) {
  throw new TypeError(message)
}

function assertBoundedDateRange(startDate, endDate, {
  label = 'Date range',
  maxDays = MAX_TIMECARD_PUBLICATION_DAYS,
} = {}) {
  if (!(startDate instanceof Date) || Number.isNaN(startDate.getTime())
    || !(endDate instanceof Date) || Number.isNaN(endDate.getTime())) {
    invalid(`${label} must contain valid dates.`)
  }
  if (startDate > endDate) invalid(`${label} start must not be after its end.`)
  if (!Number.isSafeInteger(maxDays) || maxDays < 1) invalid('Date-range limit is invalid.')
  if ((endDate.getTime() - startDate.getTime()) > maxDays * DAY_MS) {
    invalid(`${label} must not exceed ${maxDays} days.`)
  }
  return { startDate: new Date(startDate), endDate: new Date(endDate) }
}

function normalizeBoundedPagination(limit, page, {
  label = 'Result',
  maxLimit = MAX_WORKING_TIME_ROWS,
  maxPage = MAX_RESOURCE_PAGE,
} = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > maxLimit) {
    invalid(`${label} limit must be between 1 and ${maxLimit}.`)
  }
  if (page == null || page === 0) page = 1
  if (!Number.isSafeInteger(page) || page < 1 || page > maxPage) {
    invalid(`${label} page must be between 1 and ${maxPage}.`)
  }
  return { limit, page, skip: (page - 1) * limit }
}

function assertResultWithinLimit(results, max, label = 'Result') {
  if (!Array.isArray(results) || !Number.isSafeInteger(max) || max < 1) {
    invalid('Result-limit check is invalid.')
  }
  if (results.length > max) invalid(`${label} exceeds the ${max}-item safety limit.`)
  return results
}

function normalizeResourceScope(value, label = 'Resource', {
  allowAll = true,
  maxItems = MAX_PROJECT_SCOPE_IDS,
} = {}) {
  const scalar = typeof value === 'string'
  const values = scalar ? [value] : value
  if (!Array.isArray(values) || !values.length || values.length > maxItems
    || values.some((item) => typeof item !== 'string' || !item
      || item.length > MAX_RESOURCE_SCOPE_TEXT * 2 || !item.isWellFormed()
      || [...item].length > MAX_RESOURCE_SCOPE_TEXT)
    || new Set(values).size !== values.length) {
    invalid(`${label} scope is invalid.`)
  }
  const all = values.includes('all')
  if ((all && !allowAll) || (all && values.length !== 1)) {
    invalid(`${label} all-selector must be used by itself.`)
  }
  return { all, value: scalar ? values[0] : [...values], values: [...values] }
}

function resourceScopeSelectsAll(value) {
  return value === 'all' || (Array.isArray(value) && value.includes('all'))
}

export {
  MAX_RESOURCE_PAGE,
  MAX_RESOURCE_SCOPE_TEXT,
  MAX_PROJECT_SCOPE_IDS,
  MAX_TIMECARD_PUBLICATION_DAYS,
  MAX_TIMECARD_PUBLICATION_RECORDS,
  MAX_WEEK_TIMECARD_RECORDS,
  MAX_WORKING_TIME_ROWS,
  RESOURCE_QUERY_MAX_TIME_MS,
  assertBoundedDateRange,
  assertResultWithinLimit,
  normalizeBoundedPagination,
  normalizeResourceScope,
  resourceScopeSelectsAll,
}
