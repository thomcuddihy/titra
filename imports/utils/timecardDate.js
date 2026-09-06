const dateOnlyPattern = /^\d{4}-\d{2}-\d{2}$/
const startTimePattern = /^(?:[01]\d|2[0-3]):[0-5]\d$/
const rfc3339Pattern = /^(\d{4}-\d{2}-\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?(Z|[+-](?:0\d|1[0-4]):[0-5]\d)$/

function validDate(value) {
  if (value == null || value === '') {
    return undefined
  }
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value)
  return Number.isNaN(date.getTime()) ? undefined : date
}

function formatDateParts(year, month, day) {
  const yearPart = String(year).padStart(4, '0')
  const monthPart = String(month).padStart(2, '0')
  const dayPart = String(day).padStart(2, '0')
  return `${yearPart}-${monthPart}-${dayPart}`
}

/** Tests whether a value is a real calendar date in canonical YYYY-MM-DD form. */
function isDateOnly(value) {
  if (typeof value !== 'string' || !dateOnlyPattern.test(value)) {
    return false
  }
  const date = new Date(`${value}T00:00:00.000Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
}

/** Convert a browser date picker's local-midnight Date to a calendar date. */
function dateOnlyFromLocalDate(value) {
  const date = validDate(value)
  if (!date) {
    throw new TypeError('Expected a valid date')
  }
  return formatDateParts(date.getFullYear(), date.getMonth() + 1, date.getDate())
}

/** Convert a legacy BSON Date to the UTC calendar date used historically. */
function dateOnlyFromUTCDate(value) {
  if (isDateOnly(value)) {
    return value
  }
  const date = validDate(value)
  if (!date) {
    throw new TypeError('Expected a valid date')
  }
  return formatDateParts(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate())
}

/** Create the BSON Date shadow used by existing selectors and indexes. */
function dateOnlyToUTCDate(value) {
  if (!isDateOnly(value)) {
    throw new TypeError('Expected a date in YYYY-MM-DD format')
  }
  return new Date(`${value}T00:00:00.000Z`)
}

function isStartTime(value) {
  return typeof value === 'string' && startTimePattern.test(value)
}

/** Parse only a real date-only value or an RFC 3339 timestamp with an explicit offset. */
function parseAPITimecardDate(value) {
  if (isDateOnly(value)) return dateOnlyToUTCDate(value)
  if (typeof value !== 'string') throw new TypeError('Expected a date or RFC 3339 timestamp')
  const match = value.match(rfc3339Pattern)
  if (!match || !isDateOnly(match[1]) || (/^[+-]14:/.test(match[2]) && match[2] !== '+14:00'
    && match[2] !== '-14:00')) {
    throw new TypeError('Expected a date or RFC 3339 timestamp')
  }
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) throw new TypeError('Expected a date or RFC 3339 timestamp')
  return date
}

/**
 * Normalize modern writes while leaving timestamp-bearing legacy payloads
 * intact when their calendar date and start time were not sent separately.
 */
function buildTimecardDateFields(date, dateOnly, startTime) {
  if (dateOnly != null && !isDateOnly(dateOnly)) {
    throw new TypeError('dateOnly must use YYYY-MM-DD format')
  }
  if (startTime != null && !isStartTime(startTime)) {
    throw new TypeError('startTime must use HH:mm format')
  }
  if (startTime != null && dateOnly == null) {
    throw new TypeError('startTime requires dateOnly')
  }
  const fields = { date }
  if (dateOnly != null) {
    fields.date = dateOnlyToUTCDate(dateOnly)
    fields.dateOnly = dateOnly
  }
  if (startTime != null) {
    fields.startTime = startTime
  }
  return fields
}

function dateOnlyRange(fromDate, toDate = fromDate) {
  if (!isDateOnly(fromDate) || !isDateOnly(toDate)) {
    throw new TypeError('Dates must use YYYY-MM-DD format')
  }
  const startDate = dateOnlyToUTCDate(fromDate)
  const endDate = dateOnlyToUTCDate(toDate)
  if (startDate > endDate) {
    throw new TypeError('The start date must not be after the end date')
  }
  endDate.setUTCDate(endDate.getUTCDate() + 1)
  endDate.setUTCMilliseconds(-1)
  return { startDate, endDate }
}

/** Prefer the canonical day and fall back to the UTC day of a legacy BSON Date. */
function timecardDateAggregationExpression() {
  const legacyDate = {
    $dateFromString: {
      dateString: {
        $dateToString: {
          date: '$date',
          format: '%Y-%m-%d',
          timezone: 'UTC',
        },
      },
      format: '%Y-%m-%d',
      timezone: 'UTC',
    },
  }
  return {
    $dateFromString: {
      dateString: '$dateOnly',
      format: '%Y-%m-%d',
      timezone: 'UTC',
      onError: legacyDate,
      onNull: legacyDate,
    },
  }
}

function getTimecardDateOnly(timecard) {
  if (isDateOnly(timecard?.dateOnly)) {
    return timecard.dateOnly
  }
  return dateOnlyFromUTCDate(timecard?.date ?? timecard)
}

function getTimecardStartTime(timecard) {
  if (isStartTime(timecard?.startTime)) {
    return timecard.startTime
  }
  if (isDateOnly(timecard?.dateOnly)) {
    return undefined
  }
  const date = validDate(timecard?.date)
  if (!date) {
    return undefined
  }
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

function getTimecardEndTime(timecard) {
  const startTime = getTimecardStartTime(timecard)
  const hours = Number(timecard?.hours)
  if (!startTime || !Number.isFinite(hours)) {
    return undefined
  }
  const [startHour, startMinute] = startTime.split(':').map(Number)
  const minutesInDay = 24 * 60
  const rawEndMinutes = startHour * 60 + startMinute + Math.round(hours * 60)
  const endMinutes = ((rawEndMinutes % minutesInDay) + minutesInDay) % minutesInDay
  const endHour = String(Math.floor(endMinutes / 60)).padStart(2, '0')
  const endMinute = String(endMinutes % 60).padStart(2, '0')
  return `${endHour}:${endMinute}`
}

export {
  buildTimecardDateFields,
  dateOnlyFromLocalDate,
  dateOnlyFromUTCDate,
  dateOnlyRange,
  dateOnlyToUTCDate,
  getTimecardDateOnly,
  getTimecardEndTime,
  getTimecardStartTime,
  isDateOnly,
  isStartTime,
  parseAPITimecardDate,
  timecardDateAggregationExpression,
}
