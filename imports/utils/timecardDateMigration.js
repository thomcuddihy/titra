const MIGRATION_MODES = Object.freeze({
  UTC_WALL_CLOCK: 'utc-wall-clock',
  INSTANT_IN_ZONE: 'instant-in-zone',
  LEGACY_DISPLAY_IN_ZONE: 'legacy-display-in-zone',
  DATE_ONLY: 'date-only',
})

const START_TIME_POLICIES = Object.freeze({
  EXTRACT: 'extract',
  OMIT: 'omit',
})

const CLASSIFICATIONS = Object.freeze({
  CANONICAL: 'canonical',
  LEGACY: 'legacy',
  AMBIGUOUS: 'ambiguous',
  QUARANTINED: 'quarantined',
})

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const START_TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000

function hasOwn(object, property) {
  return Object.prototype.hasOwnProperty.call(object, property)
}

function validDate(value) {
  if (value == null || value === '') {
    return undefined
  }
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value)
  return Number.isNaN(date.getTime()) ? undefined : date
}

function isDateOnly(value) {
  if (typeof value !== 'string' || !DATE_ONLY_PATTERN.test(value)) {
    return false
  }
  const date = new Date(`${value}T00:00:00.000Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
}

function isStartTime(value) {
  return typeof value === 'string' && START_TIME_PATTERN.test(value)
}

function formatDateOnly(year, month, day) {
  const yearPart = String(year).padStart(4, '0')
  const monthPart = String(month).padStart(2, '0')
  const dayPart = String(day).padStart(2, '0')
  const value = `${yearPart}-${monthPart}-${dayPart}`
  if (!isDateOnly(value)) {
    throw new RangeError('The interpreted calendar date cannot be represented as YYYY-MM-DD')
  }
  return value
}

function utcParts(date) {
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    hour: date.getUTCHours(),
    minute: date.getUTCMinutes(),
    second: date.getUTCSeconds(),
  }
}

/**
 * Resolves and validates an explicit IANA time-zone identifier.
 * Offset strings and the host process time zone are intentionally unsupported.
 */
function normalizeIanaTimeZone(value) {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value
    || value.startsWith('+') || value.startsWith('-')) {
    throw new TypeError('timeZone must be an explicit valid IANA time-zone identifier')
  }
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: value })
      .resolvedOptions().timeZone
  } catch {
    throw new TypeError('timeZone must be an explicit valid IANA time-zone identifier')
  }
}

function isValidIanaTimeZone(value) {
  try {
    normalizeIanaTimeZone(value)
    return true
  } catch {
    return false
  }
}

function zonedParts(date, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-US-u-ca-gregory-nu-latn', {
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
    minute: '2-digit',
    month: '2-digit',
    second: '2-digit',
    timeZone,
    year: 'numeric',
  })
  const parts = {}
  formatter.formatToParts(date).forEach(({ type, value }) => {
    if (type !== 'literal') {
      parts[type] = value
    }
  })
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  }
}

function utcDateOnly(date) {
  const parts = utcParts(date)
  return formatDateOnly(parts.year, parts.month, parts.day)
}

function formatStartTime(parts) {
  return `${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`
}

function formatTimeWithPrecision(parts, milliseconds) {
  const seconds = String(parts.second).padStart(2, '0')
  const millisecondsPart = String(milliseconds).padStart(3, '0')
  return `${formatStartTime(parts)}:${seconds}.${millisecondsPart}`
}

function calendarDayDifference(fromDateOnly, toDateOnly) {
  const from = Date.parse(`${fromDateOnly}T00:00:00.000Z`)
  const to = Date.parse(`${toDateOnly}T00:00:00.000Z`)
  return Math.round((to - from) / MILLISECONDS_PER_DAY)
}

/**
 * Classifies only the date representation. Other timecard fields do not affect
 * whether a record is safe to preview or migrate.
 */
function classifyTimecardDate(timecard) {
  if (!timecard || typeof timecard !== 'object' || Array.isArray(timecard)) {
    return {
      classification: CLASSIFICATIONS.QUARANTINED,
      migratable: false,
      reasons: ['record-not-object'],
      warnings: [],
    }
  }

  const date = validDate(timecard.date)
  const hasDateOnly = hasOwn(timecard, 'dateOnly')
    && timecard.dateOnly !== undefined && timecard.dateOnly !== null
  const hasStartTime = hasOwn(timecard, 'startTime')
    && timecard.startTime !== undefined && timecard.startTime !== null
  const quarantineReasons = []

  if (!date) {
    quarantineReasons.push('missing-or-invalid-date')
  }
  if (hasDateOnly && !isDateOnly(timecard.dateOnly)) {
    quarantineReasons.push('invalid-date-only')
  }
  if (hasStartTime && !isStartTime(timecard.startTime)) {
    quarantineReasons.push('invalid-start-time')
  }
  if (!hasDateOnly && hasStartTime && isStartTime(timecard.startTime)) {
    quarantineReasons.push('start-time-without-date-only')
  }

  if (date && hasDateOnly && isDateOnly(timecard.dateOnly)) {
    const expectedShadow = Date.parse(`${timecard.dateOnly}T00:00:00.000Z`)
    if (date.getTime() !== expectedShadow) {
      quarantineReasons.push('date-shadow-mismatch')
    }
  }

  if (quarantineReasons.length > 0) {
    return {
      classification: CLASSIFICATIONS.QUARANTINED,
      migratable: false,
      reasons: quarantineReasons,
      warnings: [],
    }
  }

  if (hasDateOnly) {
    return {
      classification: CLASSIFICATIONS.CANONICAL,
      migratable: false,
      reasons: ['canonical-date-fields'],
      warnings: [],
    }
  }

  const isUtcMidnight = date.getUTCHours() === 0
    && date.getUTCMinutes() === 0
    && date.getUTCSeconds() === 0
    && date.getUTCMilliseconds() === 0

  if (isUtcMidnight) {
    return {
      classification: CLASSIFICATIONS.AMBIGUOUS,
      migratable: true,
      reasons: ['utc-midnight-has-no-time-intent'],
      warnings: ['ambiguous-utc-midnight'],
    }
  }

  return {
    classification: CLASSIFICATIONS.LEGACY,
    migratable: true,
    reasons: ['combined-date-and-time'],
    warnings: [],
  }
}

function validateMigrationOptions(options = {}) {
  const { mode } = options
  if (!Object.values(MIGRATION_MODES).includes(mode)) {
    throw new TypeError(`mode must be one of: ${Object.values(MIGRATION_MODES).join(', ')}`)
  }

  const startTimePolicy = options.startTimePolicy
    ?? (mode === MIGRATION_MODES.DATE_ONLY
      ? START_TIME_POLICIES.OMIT
      : START_TIME_POLICIES.EXTRACT)
  if (!Object.values(START_TIME_POLICIES).includes(startTimePolicy)) {
    const policies = Object.values(START_TIME_POLICIES).join(', ')
    throw new TypeError(`startTimePolicy must be one of: ${policies}`)
  }
  if (mode === MIGRATION_MODES.DATE_ONLY && startTimePolicy !== START_TIME_POLICIES.OMIT) {
    throw new TypeError('date-only mode requires the omit start-time policy')
  }

  let timeZone
  if ([MIGRATION_MODES.INSTANT_IN_ZONE, MIGRATION_MODES.LEGACY_DISPLAY_IN_ZONE]
    .includes(mode)) {
    timeZone = normalizeIanaTimeZone(options.timeZone)
  } else if (options.timeZone != null) {
    timeZone = normalizeIanaTimeZone(options.timeZone)
  }

  return { mode, startTimePolicy, timeZone }
}

function sourceDescription(date) {
  const parts = utcParts(date)
  return {
    date: new Date(date.getTime()),
    iso: date.toISOString(),
    utcDateOnly: formatDateOnly(parts.year, parts.month, parts.day),
    utcStartTime: formatStartTime(parts),
    utcTimeWithPrecision: formatTimeWithPrecision(parts, date.getUTCMilliseconds()),
  }
}

/**
 * Produces an inert preview. It never mutates the supplied record and does not
 * read the process/browser time zone. The caller is responsible for applying
 * the proposed fields after creating and verifying a backup.
 */
function previewTimecardDateMigration(timecard, options) {
  const normalizedOptions = validateMigrationOptions(options)
  const classification = classifyTimecardDate(timecard)
  const result = {
    ...classification,
    ...normalizedOptions,
    source: validDate(timecard?.date)
      ? sourceDescription(validDate(timecard.date))
      // The declaration is kept beside the other snapshot helpers below.
      // eslint-disable-next-line no-use-before-define
      : snapshotTimecardDateFields(timecard),
    proposed: null,
    dayShift: null,
    zonedDayShift: null,
    precisionLoss: null,
    omittedTimeOfDay: null,
  }

  if (!classification.migratable) {
    return result
  }

  const sourceDate = validDate(timecard.date)
  const sourceDateOnly = utcDateOnly(sourceDate)
  const sourceParts = utcParts(sourceDate)
  let interpretedDateParts = sourceParts
  let interpretedTimeParts = sourceParts
  let zonedDayShift = null

  if ([MIGRATION_MODES.INSTANT_IN_ZONE, MIGRATION_MODES.LEGACY_DISPLAY_IN_ZONE]
    .includes(normalizedOptions.mode)) {
    const partsInZone = zonedParts(sourceDate, normalizedOptions.timeZone)
    const dateInZone = formatDateOnly(partsInZone.year, partsInZone.month, partsInZone.day)
    zonedDayShift = calendarDayDifference(sourceDateOnly, dateInZone)
    interpretedTimeParts = partsInZone
    if (normalizedOptions.mode === MIGRATION_MODES.INSTANT_IN_ZONE) {
      interpretedDateParts = partsInZone
    }
  }

  const dateOnly = formatDateOnly(
    interpretedDateParts.year,
    interpretedDateParts.month,
    interpretedDateParts.day,
  )
  const dayShift = calendarDayDifference(sourceDateOnly, dateOnly)
  const precisionLoss = {
    seconds: interpretedTimeParts.second,
    milliseconds: sourceDate.getUTCMilliseconds(),
    lostMilliseconds: interpretedTimeParts.second * 1000 + sourceDate.getUTCMilliseconds(),
    hasLoss: interpretedTimeParts.second !== 0 || sourceDate.getUTCMilliseconds() !== 0,
  }
  const proposed = {
    date: new Date(`${dateOnly}T00:00:00.000Z`),
    dateOnly,
  }
  const warnings = [...classification.warnings]

  if (normalizedOptions.startTimePolicy === START_TIME_POLICIES.EXTRACT) {
    proposed.startTime = formatStartTime(interpretedTimeParts)
  } else {
    warnings.push('start-time-omitted')
  }
  if (precisionLoss.hasLoss) {
    warnings.push('sub-minute-precision-loss')
  }
  if (dayShift < 0) {
    warnings.push('calendar-day-shift-backward')
  } else if (dayShift > 0) {
    warnings.push('calendar-day-shift-forward')
  }
  if (normalizedOptions.mode === MIGRATION_MODES.LEGACY_DISPLAY_IN_ZONE) {
    if (zonedDayShift < 0) {
      warnings.push('zoned-clock-from-previous-day')
    } else if (zonedDayShift > 0) {
      warnings.push('zoned-clock-from-next-day')
    }
  }

  return {
    ...result,
    warnings,
    proposed,
    dayShift,
    zonedDayShift,
    precisionLoss,
    omittedTimeOfDay: normalizedOptions.startTimePolicy === START_TIME_POLICIES.OMIT,
  }
}

function snapshotTimecardDateFields(timecard) {
  const source = timecard && typeof timecard === 'object' ? timecard : {}
  return {
    date: source.date instanceof Date ? new Date(source.date.getTime()) : source.date,
    dateOnly: source.dateOnly,
    startTime: source.startTime,
  }
}

function normalizeFingerprintValue(value) {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime())
      ? { type: 'date', value: 'invalid' }
      : { type: 'date', value: value.toISOString() }
  }
  if (value === undefined) {
    return { type: 'undefined' }
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    return { type: 'number', value: String(value) }
  }
  return { type: typeof value, value }
}

/**
 * Returns a stable payload suitable for equality checks or a server-side hash.
 * It intentionally covers only fields owned by this migration.
 */
function timecardDateFingerprintPayload(timecard) {
  const snapshot = snapshotTimecardDateFields(timecard)
  return JSON.stringify({
    date: normalizeFingerprintValue(snapshot.date),
    dateOnly: normalizeFingerprintValue(snapshot.dateOnly),
    startTime: normalizeFingerprintValue(snapshot.startTime),
  })
}

function equalTimecardDateFields(left, right) {
  return timecardDateFingerprintPayload(left) === timecardDateFingerprintPayload(right)
}

export {
  CLASSIFICATIONS,
  MIGRATION_MODES,
  START_TIME_POLICIES,
  classifyTimecardDate,
  equalTimecardDateFields,
  isValidIanaTimeZone,
  normalizeIanaTimeZone,
  previewTimecardDateMigration,
  snapshotTimecardDateFields,
  timecardDateFingerprintPayload,
  validateMigrationOptions,
}
