const MIN_HOLIDAY_YEAR = 1970
const MAX_HOLIDAY_YEAR = 2100
const MAX_HOLIDAY_CODE_LENGTH = 64
const MAX_HOLIDAY_RESULTS = 512

function normalizeHolidayYear(year, now = new Date()) {
  const selected = year == null ? now.getUTCFullYear() : year
  if (!Number.isSafeInteger(selected)
    || selected < MIN_HOLIDAY_YEAR || selected > MAX_HOLIDAY_YEAR) {
    throw new TypeError(
      `Holiday year must be between ${MIN_HOLIDAY_YEAR} and ${MAX_HOLIDAY_YEAR}.`,
    )
  }
  return selected
}

function normalizeHolidayCode(value, label, { optional = false } = {}) {
  if (optional && (value == null || value === '' || value === false)) return undefined
  if (typeof value !== 'string' || !value
    || value.length > MAX_HOLIDAY_CODE_LENGTH * 2
    || !value.isWellFormed()
    || [...value].length > MAX_HOLIDAY_CODE_LENGTH
    || /[\u0000-\u001F\u007F]/u.test(value)) {
    throw new TypeError(`${label} is invalid.`)
  }
  return value
}

function boundedHolidayList(value, label = 'Holiday list') {
  if (!Array.isArray(value)) throw new TypeError(`${label} is invalid.`)
  if (value.length > MAX_HOLIDAY_RESULTS) {
    throw new TypeError(`${label} exceeds the ${MAX_HOLIDAY_RESULTS}-item safety limit.`)
  }
  return value
}

function boundedHolidayMap(value, label = 'Holiday options') {
  if (value == null || value === false) return value
  if (typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new TypeError(`${label} is invalid.`)
  }
  if (Object.keys(value).length > MAX_HOLIDAY_RESULTS) {
    throw new TypeError(`${label} exceeds the ${MAX_HOLIDAY_RESULTS}-item safety limit.`)
  }
  return value
}

export {
  MAX_HOLIDAY_CODE_LENGTH,
  MAX_HOLIDAY_RESULTS,
  MAX_HOLIDAY_YEAR,
  MIN_HOLIDAY_YEAR,
  boundedHolidayList,
  boundedHolidayMap,
  normalizeHolidayCode,
  normalizeHolidayYear,
}
