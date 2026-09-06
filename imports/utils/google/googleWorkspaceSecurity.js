const MAX_GOOGLE_WORKSPACE_RANGE_MS = 31 * 24 * 60 * 60 * 1000
const MAX_CALENDAR_EVENTS = 250
const MAX_GMAIL_MESSAGES = 100
const MAX_OPENAI_ENRICHMENTS = 20
const GOOGLE_RESPONSE_MAX_BYTES = 2 * 1024 * 1024

class GoogleWorkspaceSecurityError extends Error {
  constructor() {
    super('Google Workspace data could not be read.')
    this.name = 'GoogleWorkspaceSecurityError'
  }
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function boundedText(value, maximum, fallback = '') {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'string' || value.length > maximum || /\u0000/u.test(value)) {
    throw new GoogleWorkspaceSecurityError()
  }
  return value
}

function assertGoogleWorkspaceDateRange(startDate, endDate) {
  if (
    !(startDate instanceof Date)
    || !(endDate instanceof Date)
    || !Number.isFinite(startDate.getTime())
    || !Number.isFinite(endDate.getTime())
    || endDate.getTime() <= startDate.getTime()
    || endDate.getTime() - startDate.getTime() > MAX_GOOGLE_WORKSPACE_RANGE_MS
  ) throw new GoogleWorkspaceSecurityError()
  return { startDate, endDate }
}

function googleCalendarEventsUrl(startDate, endDate) {
  assertGoogleWorkspaceDateRange(startDate, endDate)
  const url = new URL('https://www.googleapis.com/calendar/v3/calendars/primary/events')
  url.searchParams.set('singleEvents', 'true')
  url.searchParams.set('maxResults', String(MAX_CALENDAR_EVENTS))
  url.searchParams.set('timeMax', endDate.toISOString())
  url.searchParams.set('timeMin', startDate.toISOString())
  return url.toString()
}

function googleGmailListUrl(startDate, endDate) {
  assertGoogleWorkspaceDateRange(startDate, endDate)
  const url = new URL('https://www.googleapis.com/gmail/v1/users/me/messages')
  url.searchParams.set('maxResults', String(MAX_GMAIL_MESSAGES))
  url.searchParams.set(
    'q',
    `in:sent after:${Math.floor(startDate.getTime() / 1000)} before:${Math.ceil(endDate.getTime() / 1000)}`,
  )
  return url.toString()
}

function normalizeGoogleMessageId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,512}$/u.test(value)) {
    throw new GoogleWorkspaceSecurityError()
  }
  return value
}

function googleGmailMessageUrl(messageId) {
  const id = normalizeGoogleMessageId(messageId)
  return `https://www.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}?format=metadata`
}

function normalizeCalendarEventsResponse(response) {
  if (!isPlainObject(response)) throw new GoogleWorkspaceSecurityError()
  const items = response.items === undefined ? [] : response.items
  if (!Array.isArray(items)) throw new GoogleWorkspaceSecurityError()
  return items.slice(0, MAX_CALENDAR_EVENTS).map((event) => {
    if (!isPlainObject(event) || !isPlainObject(event.start) || !isPlainObject(event.end)) {
      throw new GoogleWorkspaceSecurityError()
    }
    const attendees = event.attendees === undefined ? [] : event.attendees
    if (!Array.isArray(attendees)) throw new GoogleWorkspaceSecurityError()
    const startTime = boundedText(event.start.dateTime || event.start.date, 128)
    const endTime = boundedText(event.end.dateTime || event.end.date, 128)
    if (!startTime || !endTime) throw new GoogleWorkspaceSecurityError()
    return {
      summary: boundedText(event.summary, 1000),
      description: boundedText(event.description, 10000).slice(0, 255),
      startTime,
      endTime,
      attendees: attendees.slice(0, 100).map((attendee) => {
        if (!isPlainObject(attendee)) throw new GoogleWorkspaceSecurityError()
        return { email: boundedText(attendee.email, 254) }
      }),
    }
  })
}

function normalizeGmailListResponse(response) {
  if (!isPlainObject(response)) throw new GoogleWorkspaceSecurityError()
  const messages = response.messages === undefined ? [] : response.messages
  if (!Array.isArray(messages)) throw new GoogleWorkspaceSecurityError()
  return messages.slice(0, MAX_GMAIL_MESSAGES).map((message) => {
    if (!isPlainObject(message)) throw new GoogleWorkspaceSecurityError()
    return normalizeGoogleMessageId(message.id)
  })
}

function normalizeGmailMessageResponse(response) {
  if (!isPlainObject(response) || !/^\d{1,16}$/u.test(String(response.internalDate))) {
    throw new GoogleWorkspaceSecurityError()
  }
  const internalDate = Number(response.internalDate)
  if (!Number.isSafeInteger(internalDate) || !Number.isFinite(new Date(internalDate).getTime())) {
    throw new GoogleWorkspaceSecurityError()
  }
  const sizeEstimate = response.sizeEstimate === undefined ? 0 : response.sizeEstimate
  if (!Number.isSafeInteger(sizeEstimate) || sizeEstimate < 0 || sizeEstimate > 1024 ** 3) {
    throw new GoogleWorkspaceSecurityError()
  }
  const headers = response.payload?.headers === undefined ? [] : response.payload.headers
  if (!Array.isArray(headers) || headers.length > 200) throw new GoogleWorkspaceSecurityError()
  let subject = ''
  let recipients = ''
  for (const header of headers) {
    if (!isPlainObject(header)) throw new GoogleWorkspaceSecurityError()
    const name = boundedText(header.name, 128).toLowerCase()
    const value = boundedText(header.value, 10000)
    if (name === 'subject') subject = value
    if (name === 'to' || name === 'cc') recipients += `${recipients ? ', ' : ''}${value}`
    if (recipients.length > 20000) throw new GoogleWorkspaceSecurityError()
  }
  return {
    internalDate,
    sizeEstimate,
    recipients,
    subject,
    snippet: boundedText(response.snippet, 10000).slice(0, 500),
  }
}

async function mapInBoundedBatches(values, mapper, concurrency = 10) {
  if (
    !Array.isArray(values)
    || typeof mapper !== 'function'
    || !Number.isSafeInteger(concurrency)
    || concurrency < 1
    || concurrency > 10
  ) throw new GoogleWorkspaceSecurityError()
  const result = []
  for (let offset = 0; offset < values.length; offset += concurrency) {
    // eslint-disable-next-line no-await-in-loop
    result.push(...await Promise.all(values.slice(offset, offset + concurrency).map(mapper)))
  }
  return result
}

function partitionOpenAIEnrichmentBudget(
  calendarEventCount,
  gmailMessageCount,
  maximum = MAX_OPENAI_ENRICHMENTS,
) {
  if (![calendarEventCount, gmailMessageCount, maximum]
    .every((value) => Number.isSafeInteger(value) && value >= 0)) {
    throw new GoogleWorkspaceSecurityError()
  }
  const calendarEvents = Math.min(calendarEventCount, maximum)
  return {
    calendarEvents,
    gmailMessages: Math.min(gmailMessageCount, maximum - calendarEvents),
  }
}

export {
  GOOGLE_RESPONSE_MAX_BYTES,
  GoogleWorkspaceSecurityError,
  MAX_CALENDAR_EVENTS,
  MAX_GMAIL_MESSAGES,
  MAX_GOOGLE_WORKSPACE_RANGE_MS,
  MAX_OPENAI_ENRICHMENTS,
  assertGoogleWorkspaceDateRange,
  googleCalendarEventsUrl,
  googleGmailListUrl,
  googleGmailMessageUrl,
  mapInBoundedBatches,
  normalizeCalendarEventsResponse,
  normalizeGmailListResponse,
  normalizeGmailMessageResponse,
  normalizeGoogleMessageId,
  partitionOpenAIEnrichmentBudget,
}
