import assert from 'node:assert/strict'
import test from 'node:test'
import { MAX_PAGE_PARAMETER, normalizePageParameter } from './pageParameter.js'
import { normalizeDetailedPagination } from './detailedTimeQuery.js'
import { normalizeBoundedPagination } from './resourceLimits.js'

test('missing and malformed route page values fall back to numeric page one', () => {
  for (const value of [
    undefined, null, '', ' ', '\t', 'NaN', NaN, 'Infinity', Infinity,
    '0', 0, '-1', -1, '1.5', 1.5, '1e2', '0x10', '01', '+2', ' 2 ',
    '10001', 10001, '9'.repeat(1000), true, false, [], ['2'], {},
  ]) assert.equal(normalizePageParameter(value), 1, String(value))
})

test('valid route pages are numeric and accepted by both strict query validators', () => {
  for (const page of [1, 2, 9, 10, 100, MAX_PAGE_PARAMETER]) {
    for (const value of [page, String(page)]) {
      const actual = normalizePageParameter(value)
      assert.equal(actual, page)
      assert.equal(normalizeDetailedPagination(25, actual).skip, (page - 1) * 25)
      assert.equal(normalizeBoundedPagination(25, actual).skip, (page - 1) * 25)
    }
  }
})

test('normalizing the route does not make invalid direct DDP inputs acceptable', () => {
  for (const value of [NaN, Infinity, -1, 1.5, 10001, '2', []]) {
    assert.throws(() => normalizeDetailedPagination(25, value), TypeError)
    assert.throws(() => normalizeBoundedPagination(25, value), TypeError)
  }
})
