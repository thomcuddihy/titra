import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const helperModuleUrl = `data:text/javascript;base64,${Buffer.from(
  readFileSync(new URL('./timecardRevision.js', import.meta.url), 'utf8'),
).toString('base64')}`

const {
  LEGACY_DATE_REVISION_ETAG,
  matchesTimecardDateRevision,
  parseTimecardDateRevisionETag,
  timecardDateRevisionETag,
  timecardDateStateSelector,
} = await import(helperModuleUrl)

test('creates strong ETags for modern and legacy time entries', () => {
  assert.equal(timecardDateRevisionETag({}), LEGACY_DATE_REVISION_ETAG)
  assert.equal(LEGACY_DATE_REVISION_ETAG, '"titra-date-revision-legacy"')
  assert.equal(timecardDateRevisionETag({ dateRevision: 0 }), '"titra-date-revision-0"')
  assert.equal(timecardDateRevisionETag({ dateRevision: 42 }), '"titra-date-revision-42"')
  assert.throws(() => timecardDateRevisionETag({ dateRevision: -1 }), /invalid/)
  assert.throws(() => timecardDateRevisionETag({ dateRevision: 1.5 }), /invalid/)
  assert.throws(() => timecardDateRevisionETag({ dateRevision: '1' }), /invalid/)
})

test('parses only one strong Titra date revision ETag', () => {
  assert.equal(parseTimecardDateRevisionETag(LEGACY_DATE_REVISION_ETAG), null)
  assert.equal(parseTimecardDateRevisionETag(' "titra-date-revision-0" '), 0)
  assert.equal(parseTimecardDateRevisionETag('"titra-date-revision-42"'), 42)
  assert.throws(() => parseTimecardDateRevisionETag(undefined), /If-Match/)
  assert.throws(() => parseTimecardDateRevisionETag('*'), /If-Match/)
  assert.throws(() => parseTimecardDateRevisionETag('W/"titra-date-revision-1"'), /If-Match/)
  assert.throws(() => parseTimecardDateRevisionETag('"titra-date-revision-01"'), /If-Match/)
  assert.throws(
    () => parseTimecardDateRevisionETag(
      '"titra-date-revision-1", "titra-date-revision-2"',
    ),
    /If-Match/,
  )
  assert.throws(
    () => parseTimecardDateRevisionETag('"titra-date-revision-9007199254740992"'),
    /too large/,
  )
})

test('matches missing and numbered revisions without conflating them', () => {
  assert.equal(matchesTimecardDateRevision({}, null), true)
  assert.equal(matchesTimecardDateRevision({ dateRevision: null }, null), false)
  assert.equal(matchesTimecardDateRevision({ dateRevision: 0 }, 0), true)
  assert.equal(matchesTimecardDateRevision({ dateRevision: 1 }, 0), false)
  assert.equal(matchesTimecardDateRevision({}, 0), false)
})

test('builds an exact compare-and-swap selector for all date state', () => {
  assert.deepEqual(timecardDateStateSelector({
    _id: 'entry-id',
    date: new Date('2026-06-20T00:00:00.000Z'),
    dateOnly: '2026-06-20',
    dateRevision: 3,
  }), {
    _id: 'entry-id',
    date: new Date('2026-06-20T00:00:00.000Z'),
    dateOnly: '2026-06-20',
    startTime: { $exists: false },
    dateRevision: 3,
  })
})
