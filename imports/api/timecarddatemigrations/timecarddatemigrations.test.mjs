import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const leaseSource = readFileSync(
  new URL('./timecarddatemigrations.js', import.meta.url),
  'utf8',
)
const timecardMethodsSource = readFileSync(
  new URL('../timecards/server/methods.js', import.meta.url),
  'utf8',
)

function sourceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker)
  const end = source.indexOf(endMarker, start + startMarker.length)
  assert.notEqual(start, -1, `missing source marker: ${startMarker}`)
  assert.notEqual(end, -1, `missing source marker: ${endMarker}`)
  return source.slice(start, end)
}

test('writer leases are server-timed, fenced, renewed, and released', () => {
  assert.match(leaseSource, /\$expr: migrationLeaseIsAvailableExpression\(\)/)
  assert.match(leaseSource, /fence: \{ \$add: \[\{ \$ifNull: \['\$fence', 0\] \}, 1\] \}/)
  assert.match(leaseSource, /leaseUntil: serverLeaseUntilExpression\(WRITER_LEASE_DURATION_MS\)/)
  assert.match(leaseSource, /await renewTimecardDateWriteLease\(token\)/)
  assert.match(leaseSource, /finally \{[^]*await releaseTimecardDateWriteLease\(token\)/)
})

test('all date-bearing timecard mutation paths participate in the migration lock', () => {
  assert.match(timecardMethodsSource, /assertTimecardDateMigrationUnlocked,[^]*withTimecardDateWriteLease,/)

  const insert = sourceBetween(
    timecardMethodsSource,
    'async function insertTimeCard(',
    'async function upsertTimecard(',
  )
  assert.match(insert, /await assertTimecardDateMigrationUnlocked\(\)/)
  assert.match(insert, /withTimecardDateWriteLease\(\(\) => Timecards\.insertAsync/)

  const weekUpsert = sourceBetween(
    timecardMethodsSource,
    'async function upsertTimecard(',
    'async function checkProjectAdministratorAndUser(',
  )
  assert.match(weekUpsert, /await assertTimecardDateMigrationUnlocked\(\)/)
  assert.match(weekUpsert, /withTimecardDateWriteLease\(async \(assertWriterLease\)/)
  assert.match(weekUpsert, /await assertWriterLease\(\)/)

  const update = sourceBetween(
    timecardMethodsSource,
    'const updateTimeCard = new ValidatedMethod({',
    'const deleteTimeCard = new ValidatedMethod({',
  )
  assert.match(update, /await assertTimecardDateMigrationUnlocked\(\)/)
  assert.match(update, /withTimecardDateWriteLease\(/)

  const singleDelete = sourceBetween(
    timecardMethodsSource,
    'const deleteTimeCard = new ValidatedMethod({',
    'const sendToSiwapp = new ValidatedMethod({',
  )
  assert.match(singleDelete, /await assertTimecardDateMigrationUnlocked\(\)/)
  assert.match(singleDelete, /withTimecardDateWriteLease\(/)

  const weekDelete = sourceBetween(
    timecardMethodsSource,
    'const deleteTimeCardsForWeek = new ValidatedMethod({',
    'const getGoogleWorkspaceData = new ValidatedMethod({',
  )
  assert.match(weekDelete, /await assertTimecardDateMigrationUnlocked\(\)/)
  assert.match(weekDelete, /withTimecardDateWriteLease\(async \(assertWriterLease\)/)
})
