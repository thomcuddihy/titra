import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const lockSource = readFileSync(new URL('./timecarddatemigrations.js', import.meta.url), 'utf8')
const timecardMethods = readFileSync(
  new URL('../timecards/server/methods.js', import.meta.url),
  'utf8',
)

test('the API branch contains only the date-migration lock and writer-lease foundation', () => {
  assert.match(lockSource, /new Mongo\.Collection\('timecardDateMigrationLocks'\)/u)
  assert.match(lockSource, /async function acquireTimecardDateWriteLease\(\)/u)
  assert.match(lockSource, /async function renewTimecardDateWriteLease\(token\)/u)
  assert.match(lockSource, /async function assertTimecardDateMigrationUnlocked\(\)/u)
  assert.doesNotMatch(lockSource, /timecardDateMigration(?:Runs|Backups)/u)
  assert.doesNotMatch(lockSource, /TimecardDateMigration(?:Runs|Backups)/u)
  assert.doesNotMatch(lockSource, /getMigrationPreview|restoreTimecards|createBackup/iu)
})

test('time-entry mutations participate in the shared migration fence', () => {
  assert.match(timecardMethods, /assertTimecardDateMigrationUnlocked/u)
  assert.match(timecardMethods, /withTimecardDateWriteLease/u)
  assert.match(timecardMethods, /await assertTimecardDateMigrationUnlocked\(\)/u)
})
