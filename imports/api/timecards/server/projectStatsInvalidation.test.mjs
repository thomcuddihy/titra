import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const methodsSource = readFileSync(new URL('./methods.js', import.meta.url), 'utf8')
const migrationSource = readFileSync(
  new URL('../../timecarddatemigrations/server/methods.js', import.meta.url), 'utf8',
)
const projectMethodsSource = readFileSync(
  new URL('../../projects/server/methods.js', import.meta.url), 'utf8',
)
const projectPublicationsSource = readFileSync(
  new URL('../../projects/server/publications.js', import.meta.url), 'utf8',
)

function section(source, start, end) {
  const startIndex = source.indexOf(start)
  const endIndex = source.indexOf(end, startIndex + start.length)
  assert.notEqual(startIndex, -1, `missing section start: ${start}`)
  assert.notEqual(endIndex, -1, `missing section end: ${end}`)
  return source.slice(startIndex, endIndex)
}

test('all aggregate-affecting timecard writes invalidate project statistics', () => {
  const cases = [
    [
      'async function insertTimeCard(',
      'async function buildAPITimeCardDocument',
      /runWithProjectStatsInvalidation\(\[projectId\]/,
    ],
    [
      'async function recoverAPITimeCard(',
      'async function insertAPITimeCard(',
      /runWithProjectStatsInvalidation\(\[projectId\]/,
    ],
    [
      'async function upsertTimecard(',
      'function isProjectAdministrator',
      /runWithProjectStatsInvalidation\(\[projectId\]/,
    ],
    ['const upsertWeek =', 'const updateTimeCard =', /runWithProjectStatsInvalidation/],
    ['const updateTimeCard =', 'const deleteTimeCard =', /\[timecard\.projectId, projectId\]/],
    [
      'async function deleteOwnedTimeCard(',
      'async function updateOwnedTimeCardTask(',
      /runWithProjectStatsInvalidation/,
    ],
    [
      'const deleteTimeCardsForWeek =',
      'const getGoogleWorkspaceData =',
      /runWithProjectStatsInvalidation\(/,
    ],
    ['const bulkInsertTimecards =', 'export {', /runWithProjectStatsInvalidation/],
  ]
  cases.forEach(([start, end, pattern]) => {
    assert.match(section(methodsSource, start, end), pattern)
  })
})

test('batch write paths suppress per-row bumps and issue one deduplicated invalidation', () => {
  for (const [start, end] of [
    ['const upsertWeek =', 'const updateTimeCard ='],
    ['const bulkInsertTimecards =', 'export {'],
  ]) {
    const source = section(methodsSource, start, end)
    assert.equal((source.match(/runWithProjectStatsInvalidation/g) || []).length, 1)
    assert.match(source, /invalidateStats: false/)
  }
})

test('migration batches refresh every claimed backup project in an outer finally', () => {
  for (const [start, end] of [
    ['const applyBatch =', 'const pause ='],
    ['const restoreBatch =', 'export {'],
  ]) {
    const source = section(migrationSource, start, end)
    assert.match(source, /const affectedProjectIds = new Set\(\)/)
    assert.match(source, /affectedProjectIds\.add\(claimedBackup\.original\?\.projectId\)/)
    assert.match(source, /finally \{\s+await runWithProjectStatsInvalidation/)
  }
})

test('statistics revision is private, reserved, and observed without a history cursor', () => {
  assert.match(projectMethodsSource, /'_statsRevision'/)
  const publication = section(
    projectPublicationsSource,
    "Meteor.publish('projectStats'",
    "Meteor.publish('publicProjectName'",
  )
  assert.match(publication, /_statsRevision: 1/)
  assert.match(publication, /createCoalescedAsyncRefresh\(refresh\)/)
  assert.doesNotMatch(publication, /Timecards\.find\([^)]*\)\.observe/)
})
