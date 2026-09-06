import assert from 'node:assert/strict'
import test from 'node:test'

import {
  GOOGLE_RESPONSE_MAX_BYTES,
  GoogleWorkspaceSecurityError,
  MAX_CALENDAR_EVENTS,
  MAX_GMAIL_MESSAGES,
  MAX_OPENAI_ENRICHMENTS,
  assertGoogleWorkspaceDateRange,
  googleCalendarEventsUrl,
  googleGmailListUrl,
  googleGmailMessageUrl,
  mapInBoundedBatches,
  normalizeCalendarEventsResponse,
  normalizeGmailListResponse,
  normalizeGmailMessageResponse,
  partitionOpenAIEnrichmentBudget,
} from './googleWorkspaceSecurity.js'

const rejects = (callback) => assert.throws(callback, GoogleWorkspaceSecurityError)

test('Workspace date windows are valid, forward and bounded to 31 days', () => {
  const start = new Date('2026-09-01T00:00:00.000Z')
  const end = new Date('2026-09-30T23:59:59.999Z')
  assert.deepEqual(assertGoogleWorkspaceDateRange(start, end), { startDate: start, endDate: end })
  for (const dates of [
    [new Date('invalid'), end], [start, start], [end, start],
    [start, new Date('2026-10-03T00:00:00.000Z')], ['2026-09-01', end],
  ]) rejects(() => assertGoogleWorkspaceDateRange(...dates))
})

test('fixed Google URLs encode range, cap results and validate message IDs', () => {
  const start = new Date('2026-09-01T00:00:00.000Z')
  const end = new Date('2026-09-02T00:00:00.000Z')
  const calendar = new URL(googleCalendarEventsUrl(start, end))
  assert.equal(calendar.origin, 'https://www.googleapis.com')
  assert.equal(calendar.searchParams.get('maxResults'), String(MAX_CALENDAR_EVENTS))
  const gmail = new URL(googleGmailListUrl(start, end))
  assert.equal(gmail.searchParams.get('maxResults'), String(MAX_GMAIL_MESSAGES))
  assert.match(gmail.searchParams.get('q'), /^in:sent after:\d+ before:\d+$/u)
  assert.equal(
    googleGmailMessageUrl('safe_ID-1'),
    'https://www.googleapis.com/gmail/v1/users/me/messages/safe_ID-1?format=metadata',
  )
  for (const id of ['', '../token', 'id?format=raw', 'a'.repeat(513)]) {
    rejects(() => googleGmailMessageUrl(id))
  }
  assert.equal(GOOGLE_RESPONSE_MAX_BYTES, 2 * 1024 * 1024)
})

test('calendar and mail responses are reduced to bounded, expected fields', () => {
  const events = normalizeCalendarEventsResponse({ items: [{
    summary: 'Meeting', description: 'description',
    start: { dateTime: '2026-09-01T09:00:00+10:00' },
    end: { dateTime: '2026-09-01T09:30:00+10:00' },
    attendees: [{ email: 'person@example.test', responseStatus: 'accepted' }],
    conferenceData: { secret: true },
  }] })
  assert.deepEqual(events, [{
    summary: 'Meeting', description: 'description',
    startTime: '2026-09-01T09:00:00+10:00', endTime: '2026-09-01T09:30:00+10:00',
    attendees: [{ email: 'person@example.test' }],
  }])
  assert.deepEqual(normalizeGmailListResponse({
    messages: [{ id: 'message_1', threadId: 'private' }],
  }), ['message_1'])
  assert.deepEqual(normalizeGmailMessageResponse({
    internalDate: '1788220800000', sizeEstimate: 123,
    snippet: 'A short message', payload: { headers: [
      { name: 'Subject', value: 'Work' }, { name: 'To', value: 'one@example.test' },
      { name: 'Cc', value: 'two@example.test' },
    ] },
    raw: 'not returned',
  }), {
    internalDate: 1788220800000, sizeEstimate: 123,
    recipients: 'one@example.test, two@example.test', subject: 'Work',
    snippet: 'A short message',
  })
})

test('malformed or oversized provider structures fail closed', () => {
  for (const response of [null, { items: {} }, { items: [{ start: {}, end: {} }] }]) {
    rejects(() => normalizeCalendarEventsResponse(response))
  }
  for (const response of [null, { messages: {} }, { messages: [{ id: '../bad' }] }]) {
    rejects(() => normalizeGmailListResponse(response))
  }
  for (const response of [
    null, { internalDate: 'bad', payload: { headers: [] } },
    { internalDate: '1', sizeEstimate: -1, payload: { headers: [] } },
    { internalDate: '1', payload: { headers: [{ name: 'To', value: 'x\u0000y' }] } },
  ]) rejects(() => normalizeGmailMessageResponse(response))
})

test('outbound fan-out never exceeds the requested bounded concurrency', async () => {
  let active = 0
  let maximum = 0
  const output = await mapInBoundedBatches([1, 2, 3, 4, 5, 6, 7], async (value) => {
    active += 1
    maximum = Math.max(maximum, active)
    await new Promise((resolve) => { setTimeout(resolve, 1) })
    active -= 1
    return value * 2
  }, 3)
  assert.deepEqual(output, [2, 4, 6, 8, 10, 12, 14])
  assert.equal(maximum <= 3, true)
  await assert.rejects(() => mapInBoundedBatches([], async () => {}, 11))
})

test('OpenAI enrichment budget is shared across calendar and email results', () => {
  assert.deepEqual(partitionOpenAIEnrichmentBudget(12, 50), {
    calendarEvents: 12,
    gmailMessages: MAX_OPENAI_ENRICHMENTS - 12,
  })
  assert.deepEqual(partitionOpenAIEnrichmentBudget(250, 100), {
    calendarEvents: MAX_OPENAI_ENRICHMENTS,
    gmailMessages: 0,
  })
  assert.throws(() => partitionOpenAIEnrichmentBudget(-1, 1), GoogleWorkspaceSecurityError)
})
