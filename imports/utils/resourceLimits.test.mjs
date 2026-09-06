import assert from 'node:assert/strict'
import test from 'node:test'

import {
  MAX_TIMECARD_PUBLICATION_DAYS,
  assertBoundedDateRange,
  assertResultWithinLimit,
  normalizeBoundedPagination,
  normalizeResourceScope,
  resourceScopeSelectsAll,
} from './resourceLimits.js'

test('bounded date ranges accept the existing two-year task window', () => {
  const startDate = new Date('2024-09-03T00:00:00.000Z')
  const endDate = new Date('2026-09-03T23:59:59.999Z')
  const normalized = assertBoundedDateRange(startDate, endDate)
  assert.notEqual(normalized.startDate, startDate)
  assert.equal(normalized.startDate.toISOString(), startDate.toISOString())
  assert.equal(normalized.endDate.toISOString(), endDate.toISOString())
})

test('result sentinels reject overflow rather than silently truncating', () => {
  assert.deepEqual(assertResultWithinLimit(['one', 'two'], 2, 'Projects'), ['one', 'two'])
  assert.throws(() => assertResultWithinLimit(['one', 'two', 'overflow'], 2, 'Projects'),
    /Projects exceeds the 2-item safety limit/)
})

test('bounded date ranges reject invalid, reversed, and oversized input', () => {
  assert.throws(() => assertBoundedDateRange(new Date('invalid'), new Date()), /valid dates/)
  assert.throws(() => assertBoundedDateRange(
    new Date('2026-09-04T00:00:00.000Z'),
    new Date('2026-09-03T00:00:00.000Z'),
  ), /must not be after/)
  assert.throws(() => assertBoundedDateRange(
    new Date('2020-01-01T00:00:00.000Z'),
    new Date('2026-09-03T00:00:00.000Z'),
  ), new RegExp(`must not exceed ${MAX_TIMECARD_PUBLICATION_DAYS} days`))
})

test('bounded pagination requires positive finite integers and normalizes page zero', () => {
  assert.deepEqual(normalizeBoundedPagination(50, 0), { limit: 50, page: 1, skip: 0 })
  assert.deepEqual(normalizeBoundedPagination(50, 3), { limit: 50, page: 3, skip: 100 })
  for (const limit of [0, -1, 501, 1.5, Number.NaN]) {
    assert.throws(() => normalizeBoundedPagination(limit, 1), /limit must be between/)
  }
  for (const page of [-1, 10001, 1.5, Number.NaN]) {
    assert.throws(() => normalizeBoundedPagination(50, page), /page must be between/)
  }
})

test('resource scopes are bounded and treat all as an exact standalone sentinel', () => {
  assert.deepEqual(normalizeResourceScope('small-project', 'Project'), {
    all: false,
    value: 'small-project',
    values: ['small-project'],
  })
  assert.equal(normalizeResourceScope(['all'], 'Project').all, true)
  assert.equal(resourceScopeSelectsAll('all'), true)
  assert.equal(resourceScopeSelectsAll('installation'), false)
  assert.equal(resourceScopeSelectsAll(['small-project']), false)
  assert.throws(() => normalizeResourceScope(['all', 'project-1'], 'Project'), /by itself/)
  assert.throws(() => normalizeResourceScope(['duplicate', 'duplicate'], 'Project'), /invalid/)
  assert.throws(() => normalizeResourceScope('x'.repeat(10000), 'Project'), /invalid/)
  assert.throws(() => normalizeResourceScope('\uD800', 'Project'), /invalid/)
  assert.throws(() => normalizeResourceScope(new Array(1001).fill(0).map((_, i) => `p${i}`)),
    /invalid/)
  assert.throws(() => normalizeResourceScope(['all'], 'Project', { allowAll: false }), /by itself/)
})
