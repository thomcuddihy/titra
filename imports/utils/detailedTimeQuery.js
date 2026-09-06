const MAX_DETAILED_FILTERS = 64
const MAX_DETAILED_FILTER_TEXT = 1000
const MAX_DETAILED_LIMIT = 500
const MAX_DETAILED_PAGE = 10000
const MAX_DETAILED_SCOPE_IDS = 500
const DETAILED_PERIODS = new Set([
  'currentMonth', 'currentWeek', 'currentYear', 'lastMonth', 'last3months',
  'lastWeek', 'lastYear', 'custom', 'all',
])

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value))
}

function invalid(message) {
  throw new TypeError(message)
}

function normalizeDetailedFilters(filters) {
  if (filters == null) return undefined
  if (!plainObject(filters)) invalid('Detailed filters must be a plain object.')
  const entries = Object.entries(filters)
  if (entries.length > MAX_DETAILED_FILTERS) invalid('Too many detailed filters.')
  const normalized = {}
  for (const [key, value] of entries) {
    if (!key || key.length > 128 || key.startsWith('$') || key.includes('.')
      || !key.isWellFormed()) invalid('Detailed filter field is invalid.')
    if (['customer', 'date', 'state'].includes(key) && typeof value !== 'string') {
      invalid(`Detailed ${key} filter must be text.`)
    }
    if (key === 'hours' && typeof value !== 'string' && typeof value !== 'number') {
      invalid('Detailed hours filter must be numeric.')
    }
    if (typeof value === 'string') {
      if ([...value].length > MAX_DETAILED_FILTER_TEXT || !value.isWellFormed()) {
        invalid('Detailed filter text is invalid.')
      }
      normalized[key] = value
    } else if (typeof value === 'number') {
      if (!Number.isFinite(value)) invalid('Detailed filter number is invalid.')
      normalized[key] = value
    } else if (typeof value === 'boolean' || value === null) {
      normalized[key] = value
    } else invalid('Detailed filter values must be scalar.')
  }
  return normalized
}

function normalizeDetailedPagination(limit, page) {
  if (limit == null && page == null) return { limit: undefined, skip: 0 }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_DETAILED_LIMIT) {
    invalid(`Detailed limit must be between 1 and ${MAX_DETAILED_LIMIT}.`)
  }
  if (page != null && (!Number.isSafeInteger(page) || page < 0 || page > MAX_DETAILED_PAGE)) {
    invalid(`Detailed page must be between 0 and ${MAX_DETAILED_PAGE}.`)
  }
  return {
    limit,
    skip: page && page > 1 ? (page - 1) * limit : 0,
  }
}

function normalizeDetailedScope(value, label) {
  const values = Array.isArray(value) ? value : [value]
  if (!values.length || values.length > MAX_DETAILED_SCOPE_IDS
    || values.some((item) => typeof item !== 'string' || !item || item.length > 128
      || !item.isWellFormed())
    || new Set(values).size !== values.length
    || (values.includes('all') && values.length !== 1)) {
    invalid(`Detailed ${label} scope is invalid.`)
  }
  return Array.isArray(value) ? [...values] : values[0]
}

function normalizeDetailedSearch(value) {
  if (value == null || value === '') return undefined
  if (typeof value !== 'string' || [...value].length > MAX_DETAILED_FILTER_TEXT
    || !value.isWellFormed()) invalid('Detailed search is invalid.')
  return value
}

function normalizeDetailedSort(value) {
  if (value == null) return undefined
  if (!plainObject(value) || Object.keys(value).sort().join(',') !== 'column,order'
    || !Number.isSafeInteger(value.column) || value.column < 0 || value.column > 4
    || !['asc', 'desc'].includes(value.order)) invalid('Detailed sort is invalid.')
  return { column: value.column, order: value.order }
}

function normalizeDetailedPeriod(value, dates) {
  if (typeof value !== 'string' || !DETAILED_PERIODS.has(value)) {
    invalid('Detailed period is invalid.')
  }
  if (value === 'custom') {
    if (!plainObject(dates) || Object.keys(dates).sort().join(',') !== 'endDate,startDate'
      || !(dates.startDate instanceof Date) || Number.isNaN(dates.startDate.getTime())
      || !(dates.endDate instanceof Date) || Number.isNaN(dates.endDate.getTime())
      || dates.startDate > dates.endDate) invalid('Detailed custom dates are invalid.')
    return {
      period: value,
      dates: { startDate: new Date(dates.startDate), endDate: new Date(dates.endDate) },
    }
  }
  return { period: value, dates: undefined }
}

export {
  MAX_DETAILED_FILTERS,
  MAX_DETAILED_FILTER_TEXT,
  MAX_DETAILED_LIMIT,
  MAX_DETAILED_PAGE,
  MAX_DETAILED_SCOPE_IDS,
  normalizeDetailedFilters,
  normalizeDetailedPagination,
  normalizeDetailedPeriod,
  normalizeDetailedScope,
  normalizeDetailedSearch,
  normalizeDetailedSort,
}
