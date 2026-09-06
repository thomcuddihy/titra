import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const helperModuleUrl = `data:text/javascript;base64,${Buffer.from(
  readFileSync(new URL('./timecardDate.js', import.meta.url), 'utf8'),
).toString('base64')}`

const {
  buildTimecardDateFields,
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
} = await import(helperModuleUrl)

test('validates date-only and start-time values strictly', () => {
  assert.equal(isDateOnly('2024-02-29'), true)
  assert.equal(isDateOnly('2023-02-29'), false)
  assert.equal(isDateOnly('20-06-2026'), false)
  assert.equal(isDateOnly('2026-6-20'), false)
  assert.equal(isStartTime('00:00'), true)
  assert.equal(isStartTime('23:59'), true)
  assert.equal(isStartTime('24:00'), false)
  assert.equal(isStartTime('9:30'), false)
})

test('API dates accept only date-only or explicitly zoned RFC 3339 values', () => {
  assert.equal(parseAPITimecardDate('2026-09-01').toISOString(), '2026-09-01T00:00:00.000Z')
  assert.equal(
    parseAPITimecardDate('2026-09-01T10:15:30.125+10:00').toISOString(),
    '2026-09-01T00:15:30.125Z',
  )
  for (const value of [
    '09/01/2026', 'September 1 2026', '2026-09-01T10:15:30',
    '2026-02-30T10:15:30Z', '2026-09-01T25:00:00Z',
    '2026-09-01T10:15:30+14:01',
  ]) assert.throws(() => parseAPITimecardDate(value), TypeError)
})

test('round-trips a date-only value through the BSON Date shadow', () => {
  const date = dateOnlyToUTCDate('2026-06-20')
  assert.equal(date.toISOString(), '2026-06-20T00:00:00.000Z')
  assert.equal(dateOnlyFromUTCDate(date), '2026-06-20')
})

test('normalizes modern writes without partially migrating legacy payloads', () => {
  const legacyDate = new Date('2026-06-20T09:15:00.000Z')
  assert.deepEqual(buildTimecardDateFields(legacyDate), { date: legacyDate })
  assert.deepEqual(buildTimecardDateFields(legacyDate, null, null), { date: legacyDate })

  const modern = buildTimecardDateFields(legacyDate, '2026-06-20', '09:15')
  assert.equal(modern.date.toISOString(), '2026-06-20T00:00:00.000Z')
  assert.equal(modern.dateOnly, '2026-06-20')
  assert.equal(modern.startTime, '09:15')
  assert.throws(() => buildTimecardDateFields(legacyDate, '2026-02-29'), /dateOnly/)
  assert.throws(
    () => buildTimecardDateFields(legacyDate, '2026-06-20', '24:00'),
    /startTime/,
  )
  assert.throws(
    () => buildTimecardDateFields(legacyDate, undefined, '09:15'),
    /requires dateOnly/,
  )
})

test('builds timezone-independent inclusive date ranges', () => {
  const { startDate, endDate } = dateOnlyRange('2026-06-20', '2026-06-22')
  assert.equal(startDate.toISOString(), '2026-06-20T00:00:00.000Z')
  assert.equal(endDate.toISOString(), '2026-06-22T23:59:59.999Z')
  assert.throws(() => dateOnlyRange('2026-09-02', '2026-09-01'), TypeError)
})

test('builds a legacy-compatible calendar-day aggregation expression', () => {
  const expression = timecardDateAggregationExpression()
  assert.equal(expression.$dateFromString.dateString, '$dateOnly')
  assert.equal(
    expression.$dateFromString.onNull.$dateFromString.dateString.$dateToString.timezone,
    'UTC',
  )
  assert.deepEqual(expression.$dateFromString.onError, expression.$dateFromString.onNull)
})

test('prefers canonical fields and supports legacy BSON Date records', () => {
  assert.equal(getTimecardDateOnly({
    dateOnly: '2026-06-20',
    date: new Date('2026-06-19T22:00:00.000Z'),
  }), '2026-06-20')
  assert.equal(getTimecardDateOnly({
    date: new Date('2026-06-20T00:00:00.000Z'),
  }), '2026-06-20')
  assert.throws(() => getTimecardDateOnly({}), /valid date/)
})

test('keeps start time separate and calculates an end time', () => {
  const timecard = {
    dateOnly: '2026-06-20',
    date: dateOnlyToUTCDate('2026-06-20'),
    startTime: '23:30',
    hours: 2.25,
  }
  assert.equal(getTimecardStartTime(timecard), '23:30')
  assert.equal(getTimecardEndTime(timecard), '01:45')
  assert.equal(getTimecardStartTime({
    dateOnly: '2026-06-20',
    date: dateOnlyToUTCDate('2026-06-20'),
  }), undefined)

  const legacyTimecard = {
    date: new Date(2026, 5, 20, 9, 15),
    hours: 1.5,
  }
  assert.equal(getTimecardStartTime(legacyTimecard), '09:15')
  assert.equal(getTimecardEndTime(legacyTimecard), '10:45')
})

test('picker-local dates retain their selected day in every timezone', () => {
  const timezones = [
    'UTC',
    'Europe/Berlin',
    'Australia/Brisbane',
    'America/New_York',
    'Pacific/Honolulu',
    'Pacific/Kiritimati',
  ]
  const calendarDates = [
    [2026, 5, 20, '2026-06-20'],
    [2026, 2, 29, '2026-03-29'],
    [2026, 10, 1, '2026-11-01'],
    [2024, 1, 29, '2024-02-29'],
  ]

  for (const timezone of timezones) {
    const script = `
      import { dateOnlyFromLocalDate } from ${JSON.stringify(helperModuleUrl)}
      const dates = ${JSON.stringify(calendarDates)}
      process.stdout.write(JSON.stringify(dates.map(
        ([year, month, day]) => dateOnlyFromLocalDate(new Date(year, month, day)),
      )))
    `
    const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
      encoding: 'utf8',
      env: { ...process.env, TZ: timezone },
    })
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(
      JSON.parse(result.stdout),
      calendarDates.map(([, , , expected]) => expected),
      timezone,
    )
  }
})
