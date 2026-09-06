import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const helperModuleUrl = `data:text/javascript;base64,${Buffer.from(
  readFileSync(new URL('./timecardDateMigration.js', import.meta.url), 'utf8'),
).toString('base64')}`

const {
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
} = await import(helperModuleUrl)

test('validates migration options and explicit IANA time zones', () => {
  assert.equal(isValidIanaTimeZone('Australia/Brisbane'), true)
  assert.equal(isValidIanaTimeZone('UTC'), true)
  assert.equal(isValidIanaTimeZone('+10:00'), false)
  assert.equal(isValidIanaTimeZone('Mars/Olympus_Mons'), false)
  assert.equal(isValidIanaTimeZone(' Australia/Brisbane '), false)
  assert.equal(normalizeIanaTimeZone('Australia/Brisbane'), 'Australia/Brisbane')

  assert.deepEqual(validateMigrationOptions({
    mode: MIGRATION_MODES.UTC_WALL_CLOCK,
  }), {
    mode: MIGRATION_MODES.UTC_WALL_CLOCK,
    startTimePolicy: START_TIME_POLICIES.EXTRACT,
    timeZone: undefined,
  })
  assert.deepEqual(validateMigrationOptions({
    mode: MIGRATION_MODES.DATE_ONLY,
  }), {
    mode: MIGRATION_MODES.DATE_ONLY,
    startTimePolicy: START_TIME_POLICIES.OMIT,
    timeZone: undefined,
  })
  assert.throws(
    () => validateMigrationOptions({ mode: MIGRATION_MODES.INSTANT_IN_ZONE }),
    /timeZone/,
  )
  assert.throws(
    () => validateMigrationOptions({ mode: MIGRATION_MODES.LEGACY_DISPLAY_IN_ZONE }),
    /timeZone/,
  )
  assert.throws(
    () => validateMigrationOptions({
      mode: MIGRATION_MODES.DATE_ONLY,
      startTimePolicy: START_TIME_POLICIES.EXTRACT,
    }),
    /requires the omit/,
  )
  assert.throws(() => validateMigrationOptions({ mode: 'browser-local' }), /mode/)
})

test('classifies canonical, legacy, ambiguous and quarantined records', () => {
  assert.deepEqual(classifyTimecardDate({
    date: new Date('2026-06-20T00:00:00.000Z'),
    dateOnly: '2026-06-20',
    startTime: '09:15',
  }), {
    classification: CLASSIFICATIONS.CANONICAL,
    migratable: false,
    reasons: ['canonical-date-fields'],
    warnings: [],
  })

  assert.equal(classifyTimecardDate({
    date: new Date('2026-06-20T09:15:00.000Z'),
  }).classification, CLASSIFICATIONS.LEGACY)
  assert.deepEqual(classifyTimecardDate({
    date: new Date('2026-06-20T00:00:00.000Z'),
  }), {
    classification: CLASSIFICATIONS.AMBIGUOUS,
    migratable: true,
    reasons: ['utc-midnight-has-no-time-intent'],
    warnings: ['ambiguous-utc-midnight'],
  })

  const quarantined = [
    [{}, 'missing-or-invalid-date'],
    [{ date: 'not a date' }, 'missing-or-invalid-date'],
    [{ date: new Date('2026-06-20T00:00:00Z'), dateOnly: '2026-02-29' }, 'invalid-date-only'],
    [{ date: new Date('2026-06-20T00:00:00Z'), startTime: '24:00' }, 'invalid-start-time'],
    [{ date: new Date('2026-06-20T00:00:00Z'), startTime: '09:00' }, 'start-time-without-date-only'],
    [{
      date: new Date('2026-06-20T09:00:00Z'),
      dateOnly: '2026-06-20',
      startTime: '09:00',
    }, 'date-shadow-mismatch'],
  ]
  quarantined.forEach(([timecard, reason]) => {
    const classification = classifyTimecardDate(timecard)
    assert.equal(classification.classification, CLASSIFICATIONS.QUARANTINED)
    assert.equal(classification.migratable, false)
    assert.ok(classification.reasons.includes(reason))
  })
})

test('UTC wall-clock mode retains historical UTC calendar and clock values', () => {
  const preview = previewTimecardDateMigration({
    date: new Date('2024-02-29T23:59:00.000Z'),
  }, {
    mode: MIGRATION_MODES.UTC_WALL_CLOCK,
    startTimePolicy: START_TIME_POLICIES.EXTRACT,
  })

  assert.equal(preview.classification, CLASSIFICATIONS.LEGACY)
  assert.equal(preview.source.iso, '2024-02-29T23:59:00.000Z')
  assert.equal(preview.source.utcDateOnly, '2024-02-29')
  assert.equal(preview.source.utcStartTime, '23:59')
  assert.equal(preview.source.utcTimeWithPrecision, '23:59:00.000')
  assert.equal(preview.proposed.date.toISOString(), '2024-02-29T00:00:00.000Z')
  assert.equal(preview.proposed.dateOnly, '2024-02-29')
  assert.equal(preview.proposed.startTime, '23:59')
  assert.equal(preview.dayShift, 0)
  assert.equal(preview.zonedDayShift, null)
  assert.equal(preview.omittedTimeOfDay, false)
  assert.deepEqual(preview.precisionLoss, {
    seconds: 0,
    milliseconds: 0,
    lostMilliseconds: 0,
    hasLoss: false,
  })
  assert.deepEqual(preview.warnings, [])
})

test('instant-in-zone mode handles positive, negative and date-line day shifts', () => {
  const cases = [
    ['Australia/Brisbane', '2026-06-20T16:15:00.000Z', '2026-06-21', '02:15', 1, 'calendar-day-shift-forward'],
    ['Pacific/Honolulu', '2026-06-20T05:15:00.000Z', '2026-06-19', '19:15', -1, 'calendar-day-shift-backward'],
    ['Pacific/Kiritimati', '2026-12-31T12:30:00.000Z', '2027-01-01', '02:30', 1, 'calendar-day-shift-forward'],
  ]

  cases.forEach(([timeZone, iso, dateOnly, startTime, dayShift, warning]) => {
    const preview = previewTimecardDateMigration({ date: new Date(iso) }, {
      mode: MIGRATION_MODES.INSTANT_IN_ZONE,
      timeZone,
      startTimePolicy: START_TIME_POLICIES.EXTRACT,
    })
    assert.equal(preview.proposed.dateOnly, dateOnly, timeZone)
    assert.equal(preview.proposed.startTime, startTime, timeZone)
    assert.equal(preview.proposed.date.toISOString(), `${dateOnly}T00:00:00.000Z`, timeZone)
    assert.equal(preview.dayShift, dayShift, timeZone)
    assert.equal(preview.zonedDayShift, dayShift, timeZone)
    assert.ok(preview.warnings.includes(warning), timeZone)
  })
})

test('legacy-display-in-zone keeps the UTC date and derives only the zoned clock', () => {
  const cases = [
    [
      'Australia/Brisbane',
      '2026-06-20T16:15:00.000Z',
      '2026-06-20',
      '02:15',
      1,
      'zoned-clock-from-next-day',
    ],
    [
      'America/New_York',
      '2026-06-20T02:15:00.000Z',
      '2026-06-20',
      '22:15',
      -1,
      'zoned-clock-from-previous-day',
    ],
    [
      'Pacific/Kiritimati',
      '2026-12-31T12:30:00.000Z',
      '2026-12-31',
      '02:30',
      1,
      'zoned-clock-from-next-day',
    ],
  ]

  cases.forEach(([timeZone, iso, dateOnly, startTime, zonedDayShift, warning]) => {
    const preview = previewTimecardDateMigration({ date: new Date(iso) }, {
      mode: MIGRATION_MODES.LEGACY_DISPLAY_IN_ZONE,
      timeZone,
      startTimePolicy: START_TIME_POLICIES.EXTRACT,
    })
    assert.equal(preview.proposed.dateOnly, dateOnly, timeZone)
    assert.equal(preview.proposed.startTime, startTime, timeZone)
    assert.equal(preview.proposed.date.toISOString(), `${dateOnly}T00:00:00.000Z`, timeZone)
    assert.equal(preview.dayShift, 0, timeZone)
    assert.equal(preview.zonedDayShift, zonedDayShift, timeZone)
    assert.ok(preview.warnings.includes(warning), timeZone)
    assert.equal(preview.warnings.includes('calendar-day-shift-forward'), false, timeZone)
    assert.equal(preview.warnings.includes('calendar-day-shift-backward'), false, timeZone)
  })
})

test('legacy-display-in-zone follows DST while retaining its UTC calendar day', () => {
  const preview = (iso, startTimePolicy = START_TIME_POLICIES.EXTRACT) => (
    previewTimecardDateMigration({ date: new Date(iso) }, {
      mode: MIGRATION_MODES.LEGACY_DISPLAY_IN_ZONE,
      timeZone: 'America/New_York',
      startTimePolicy,
    })
  )

  assert.deepEqual(
    [
      preview('2026-03-08T06:30:00.000Z').proposed.startTime,
      preview('2026-03-08T07:30:00.000Z').proposed.startTime,
    ],
    ['01:30', '03:30'],
  )
  assert.deepEqual(
    [
      preview('2026-11-01T05:30:00.000Z').proposed.startTime,
      preview('2026-11-01T06:30:00.000Z').proposed.startTime,
    ],
    ['01:30', '01:30'],
  )
  const omitted = preview('2026-03-08T07:30:00.000Z', START_TIME_POLICIES.OMIT)
  assert.equal(omitted.proposed.dateOnly, '2026-03-08')
  assert.equal(Object.hasOwn(omitted.proposed, 'startTime'), false)
  assert.equal(omitted.omittedTimeOfDay, true)
  assert.ok(omitted.warnings.includes('start-time-omitted'))
})

test('instant-in-zone mode follows DST gaps and repeated wall-clock times', () => {
  const preview = (iso) => previewTimecardDateMigration({ date: new Date(iso) }, {
    mode: MIGRATION_MODES.INSTANT_IN_ZONE,
    timeZone: 'America/New_York',
    startTimePolicy: START_TIME_POLICIES.EXTRACT,
  }).proposed

  assert.deepEqual(
    [
      preview('2026-03-08T06:30:00.000Z').startTime,
      preview('2026-03-08T07:30:00.000Z').startTime,
    ],
    ['01:30', '03:30'],
  )
  assert.deepEqual(
    [
      preview('2026-11-01T05:30:00.000Z').startTime,
      preview('2026-11-01T06:30:00.000Z').startTime,
    ],
    ['01:30', '01:30'],
  )
})

test('date-only mode omits time explicitly and flags ambiguous midnight records', () => {
  const preview = previewTimecardDateMigration({
    date: new Date('2026-01-01T00:00:00.000Z'),
  }, {
    mode: MIGRATION_MODES.DATE_ONLY,
  })

  assert.equal(preview.classification, CLASSIFICATIONS.AMBIGUOUS)
  assert.deepEqual(preview.proposed, {
    date: new Date('2026-01-01T00:00:00.000Z'),
    dateOnly: '2026-01-01',
  })
  assert.equal(preview.omittedTimeOfDay, true)
  assert.ok(preview.warnings.includes('ambiguous-utc-midnight'))
  assert.ok(preview.warnings.includes('start-time-omitted'))
})

test('reports seconds and millisecond precision that canonical fields cannot retain', () => {
  const preview = previewTimecardDateMigration({
    date: new Date('2026-06-20T09:15:42.137Z'),
  }, {
    mode: MIGRATION_MODES.UTC_WALL_CLOCK,
  })

  assert.equal(preview.source.utcTimeWithPrecision, '09:15:42.137')
  assert.equal(preview.proposed.startTime, '09:15')
  assert.deepEqual(preview.precisionLoss, {
    seconds: 42,
    milliseconds: 137,
    lostMilliseconds: 42137,
    hasLoss: true,
  })
  assert.ok(preview.warnings.includes('sub-minute-precision-loss'))
})

test('does not propose updates for canonical or quarantined records', () => {
  const canonical = previewTimecardDateMigration({
    date: new Date('2026-06-20T00:00:00.000Z'),
    dateOnly: '2026-06-20',
    startTime: '09:15',
  }, { mode: MIGRATION_MODES.UTC_WALL_CLOCK })
  const invalid = previewTimecardDateMigration({ date: 'invalid' }, {
    mode: MIGRATION_MODES.UTC_WALL_CLOCK,
  })

  assert.equal(canonical.proposed, null)
  assert.equal(canonical.dayShift, null)
  assert.equal(invalid.proposed, null)
  assert.equal(invalid.classification, CLASSIFICATIONS.QUARANTINED)
})

test('snapshots, compares and fingerprints only migration-owned date fields', () => {
  const original = {
    _id: 'card-1',
    date: new Date('2026-06-20T09:15:42.137Z'),
    hours: 2,
  }
  const beforePreview = timecardDateFingerprintPayload(original)
  const preview = previewTimecardDateMigration(original, {
    mode: MIGRATION_MODES.UTC_WALL_CLOCK,
  })
  const snapshot = snapshotTimecardDateFields(original)

  assert.equal(timecardDateFingerprintPayload(original), beforePreview)
  assert.notEqual(preview.source.date, original.date)
  assert.equal(preview.source.date.getTime(), original.date.getTime())
  assert.notEqual(preview.proposed.date, original.date)
  assert.notEqual(snapshot.date, original.date)
  assert.equal(snapshot.date.getTime(), original.date.getTime())
  assert.equal(equalTimecardDateFields(original, { ...original, hours: 8 }), true)
  assert.equal(equalTimecardDateFields(original, {
    ...original,
    date: new Date('2026-06-20T09:16:00.000Z'),
  }), false)
  assert.equal(
    timecardDateFingerprintPayload(original),
    timecardDateFingerprintPayload(snapshot),
  )
})

test('legacy-display-in-zone is identical in every host process timezone', () => {
  const hostTimeZones = [
    'UTC',
    'Australia/Brisbane',
    'America/New_York',
    'Pacific/Honolulu',
    'Pacific/Kiritimati',
  ]
  const script = `
    import { previewTimecardDateMigration } from ${JSON.stringify(helperModuleUrl)}
    const result = previewTimecardDateMigration(
      { date: new Date('2026-12-31T23:59:42.137Z') },
      { mode: 'legacy-display-in-zone', timeZone: 'Europe/Berlin', startTimePolicy: 'extract' },
    )
    process.stdout.write(JSON.stringify({
      date: result.proposed.date.toISOString(),
      dateOnly: result.proposed.dateOnly,
      startTime: result.proposed.startTime,
      dayShift: result.dayShift,
      zonedDayShift: result.zonedDayShift,
      warnings: result.warnings,
      precisionLoss: result.precisionLoss,
    }))
  `
  const results = hostTimeZones.map((timeZone) => {
    const child = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
      encoding: 'utf8',
      env: { ...process.env, TZ: timeZone },
    })
    assert.equal(child.status, 0, child.stderr)
    return JSON.parse(child.stdout)
  })

  results.slice(1).forEach((result) => assert.deepEqual(result, results[0]))
  assert.deepEqual(results[0], {
    date: '2026-12-31T00:00:00.000Z',
    dateOnly: '2026-12-31',
    startTime: '00:59',
    dayShift: 0,
    zonedDayShift: 1,
    warnings: [
      'sub-minute-precision-loss',
      'zoned-clock-from-next-day',
    ],
    precisionLoss: {
      seconds: 42,
      milliseconds: 137,
      lostMilliseconds: 42137,
      hasLoss: true,
    },
  })
})
