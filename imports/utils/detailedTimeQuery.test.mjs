import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('./detailedTimeQuery.js', import.meta.url), 'utf8')
const query = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)

test('detailed pagination is integer, bounded and preserves the legacy first page forms', () => {
  assert.deepEqual(query.normalizeDetailedPagination(undefined, undefined), {
    limit: undefined, skip: 0,
  })
  assert.deepEqual(query.normalizeDetailedPagination(25, undefined), { limit: 25, skip: 0 })
  assert.deepEqual(query.normalizeDetailedPagination(25, 0), { limit: 25, skip: 0 })
  assert.deepEqual(query.normalizeDetailedPagination(25, 1), { limit: 25, skip: 0 })
  assert.deepEqual(query.normalizeDetailedPagination(25, 3), { limit: 25, skip: 50 })
  for (const value of [0, -1, 501, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => query.normalizeDetailedPagination(value, 1), TypeError)
  }
  for (const value of [-1, 10001, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => query.normalizeDetailedPagination(25, value), TypeError)
  }
})

test('detailed filters clone only bounded scalar safe fields', () => {
  const input = { task: 'Review', hours: 1.125, state: 'new', billable: false, note: null }
  const result = query.normalizeDetailedFilters(input)
  assert.deepEqual(result, input)
  assert.notEqual(result, input)
  for (const invalid of [
    [], { $where: 'sleep(1000)' }, { 'custom.value': 'x' },
    { task: { $ne: null } }, { task: ['x'] }, { hours: Number.NaN }, { customer: null },
    { task: 'x'.repeat(1001) },
  ]) assert.throws(() => query.normalizeDetailedFilters(invalid), TypeError)
  assert.throws(() => query.normalizeDetailedFilters(
    Object.fromEntries(Array.from({ length: 65 }, (_value, index) => [`f${index}`, 'x'])),
  ), TypeError)
})

test('detailed scopes, search, sort, and periods are bounded exact values', () => {
  assert.deepEqual(query.normalizeDetailedScope(['p1', 'p2'], 'project'), ['p1', 'p2'])
  assert.equal(query.normalizeDetailedScope('all', 'project'), 'all')
  assert.equal(query.normalizeDetailedSearch('review'), 'review')
  assert.deepEqual(query.normalizeDetailedSort({ column: 1, order: 'desc' }), {
    column: 1, order: 'desc',
  })
  const dates = {
    startDate: new Date('2026-08-01T00:00:00Z'),
    endDate: new Date('2026-08-31T23:59:59Z'),
  }
  const period = query.normalizeDetailedPeriod('custom', dates)
  assert.deepEqual(period, { period: 'custom', dates })
  assert.notEqual(period.dates, dates)
  for (const value of [
    [], ['p1', 'p1'], ['all', 'p1'], ['x'.repeat(129)], Array(501).fill('p'),
  ]) {
    assert.throws(() => query.normalizeDetailedScope(value, 'project'), TypeError)
  }
  assert.throws(() => query.normalizeDetailedSearch('x'.repeat(1001)), TypeError)
  assert.throws(() => query.normalizeDetailedSort({ column: 99, order: 'sideways' }), TypeError)
  assert.throws(() => query.normalizeDetailedPeriod('forever'), TypeError)
  assert.throws(() => query.normalizeDetailedPeriod('custom', {
    startDate: dates.endDate, endDate: dates.startDate,
  }), TypeError)
})
