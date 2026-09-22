import assert from 'node:assert/strict'
import test from 'node:test'
import { limitParameterCorrection, normalizeLimitParameter, MAX_LIMIT_PARAMETER, LIMIT_OPTIONS } from './limitParameter.js'
import { normalizeDetailedPagination } from './detailedTimeQuery.js'
import { normalizeBoundedPagination } from './resourceLimits.js'

test('missing and malformed row limits use 25, not an unbounded or NaN DDP query', () => {
  for (const value of [undefined, null, '', ' ', '0', 0, '-2', -2, '501', 501, '1e2', '0x10',
    '01', '+2', ' 2 ', 'NaN', NaN, Infinity, 'Infinity', 1.5, '1.5', '9'.repeat(1000), [], ['25'], {}, true]) {
    assert.equal(normalizeLimitParameter(value), 25, String(value))
  }
})

test('all supported finite limits and the legacy All bookmark stay within both server ceilings', () => {
  assert.equal(MAX_LIMIT_PARAMETER, 500)
  assert.ok(!LIMIT_OPTIONS.includes(-1))
  for (let limit = 1; limit <= MAX_LIMIT_PARAMETER; limit += 1) {
    for (const value of [limit, String(limit)]) {
      assert.equal(normalizeLimitParameter(value), limit)
      assert.equal(normalizeDetailedPagination(limit, 2).skip, limit)
      assert.equal(normalizeBoundedPagination(limit, 2).skip, limit)
    }
  }
  for (const value of [-1, '-1']) {
    assert.equal(normalizeLimitParameter(value), 500)
    assert.deepEqual(limitParameterCorrection(value), { limit: 500, page: null })
    assert.throws(() => normalizeDetailedPagination(value, 1), TypeError)
    assert.throws(() => normalizeBoundedPagination(value, 1), TypeError)
  }
})

test('canonical URL limits do not rewrite history, corrected ones reset the old page', () => {
  for (const value of [undefined, null, '25', '37', '500', 25]) assert.equal(limitParameterCorrection(value), undefined)
  for (const value of ['', 'bad', '025', '501', 0]) {
    assert.deepEqual(limitParameterCorrection(value), { limit: 25, page: null })
  }
})
