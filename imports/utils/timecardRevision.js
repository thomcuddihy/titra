const LEGACY_DATE_REVISION_ETAG = '"titra-date-revision-legacy"'
const DATE_REVISION_ETAG_PATTERN = /^"titra-date-revision-(0|[1-9]\d*)"$/
const TIMECARD_DATE_STATE_FIELDS = ['date', 'dateOnly', 'startTime', 'dateRevision']

function hasDateRevision(timecard) {
  return Boolean(timecard)
    && Object.prototype.hasOwnProperty.call(timecard, 'dateRevision')
}

/** Build a selector that fails if any date-related field changed after it was read. */
function timecardDateStateSelector(timecard) {
  const selector = { _id: timecard._id }
  TIMECARD_DATE_STATE_FIELDS.forEach((field) => {
    selector[field] = Object.prototype.hasOwnProperty.call(timecard, field)
      ? timecard[field]
      : { $exists: false }
  })
  return selector
}

function timecardDateRevisionETag(timecard) {
  if (!hasDateRevision(timecard)) {
    return LEGACY_DATE_REVISION_ETAG
  }
  if (!Number.isSafeInteger(timecard.dateRevision) || timecard.dateRevision < 0) {
    throw new TypeError('Time entry has an invalid date revision')
  }
  return `"titra-date-revision-${timecard.dateRevision}"`
}

function parseTimecardDateRevisionETag(value) {
  if (typeof value !== 'string') {
    throw new TypeError('If-Match must contain one Titra date revision ETag')
  }
  const normalizedValue = value.trim()
  if (normalizedValue === LEGACY_DATE_REVISION_ETAG) {
    return null
  }
  const match = normalizedValue.match(DATE_REVISION_ETAG_PATTERN)
  if (!match) {
    throw new TypeError('If-Match must contain one Titra date revision ETag')
  }
  const revision = Number(match[1])
  if (!Number.isSafeInteger(revision)) {
    throw new TypeError('If-Match date revision is too large')
  }
  return revision
}

function matchesTimecardDateRevision(timecard, expectedDateRevision) {
  if (expectedDateRevision === null) {
    return !hasDateRevision(timecard)
  }
  return hasDateRevision(timecard)
    && timecard.dateRevision === expectedDateRevision
}

export {
  LEGACY_DATE_REVISION_ETAG,
  matchesTimecardDateRevision,
  parseTimecardDateRevisionETag,
  timecardDateRevisionETag,
  timecardDateStateSelector,
}
