import assert from 'node:assert/strict'
import test from 'node:test'

import {
  MAX_HOLIDAY_RESULTS,
  boundedHolidayList,
  boundedHolidayMap,
  normalizeHolidayCode,
  normalizeHolidayYear,
} from './holidayReadLimits.js'

test('holiday years default to UTC current year and stay in a finite range', () => {
  assert.equal(normalizeHolidayYear(undefined, new Date('2026-12-31T23:00:00Z')), 2026)
  assert.equal(normalizeHolidayYear(1970), 1970)
  assert.equal(normalizeHolidayYear(2100), 2100)
  for (const year of [1969, 2101, 2026.5, Infinity, '2026']) {
    assert.throws(() => normalizeHolidayYear(year), /Holiday year must be between/)
  }
})

test('holiday location codes are text- and control-bounded', () => {
  assert.equal(normalizeHolidayCode('AU', 'Country'), 'AU')
  assert.equal(normalizeHolidayCode('', 'Country', { optional: true }), undefined)
  assert.equal(normalizeHolidayCode(false, 'Country', { optional: true }), undefined)
  for (const code of ['', 'x'.repeat(65), 'AU\nQLD', '\uD800']) {
    assert.throws(() => normalizeHolidayCode(code, 'Location'), /Location is invalid/)
  }
})

test('holiday array and option-map results reject sentinel overflow', () => {
  const list = [{ name: 'Holiday' }]
  const map = { AU: 'Australia' }
  assert.equal(boundedHolidayList(list), list)
  assert.equal(boundedHolidayMap(map), map)
  assert.equal(boundedHolidayMap(false), false)
  assert.throws(
    () => boundedHolidayList(Array.from({ length: MAX_HOLIDAY_RESULTS + 1 })),
    /safety limit/,
  )
  assert.throws(
    () => boundedHolidayMap(Object.fromEntries(Array.from(
      { length: MAX_HOLIDAY_RESULTS + 1 }, (_, index) => [`k${index}`, index],
    ))),
    /safety limit/,
  )
  assert.throws(() => boundedHolidayList({}), /invalid/)
  assert.throws(() => boundedHolidayMap([]), /invalid/)
})
