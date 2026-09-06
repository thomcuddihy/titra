import assert from 'node:assert/strict'
import test from 'node:test'

import {
  MAX_TASK_SEARCH_FILTER_CODE_POINTS,
  MAX_TASK_SEARCH_RESULTS,
  assertProjectId,
  assertTaskSearchFilter,
  assertTaskSearchLimit,
  boundedTaskSearchLimit,
} from './publicationInput.js'

test('task-search inputs are bounded before regex/database work', () => {
  for (const value of [undefined, null, '', 'ordinary search', '🕐'.repeat(256)]) {
    assert.doesNotThrow(() => assertTaskSearchFilter(value))
  }
  for (const value of ['x'.repeat(MAX_TASK_SEARCH_FILTER_CODE_POINTS + 1), 4, '\ud800']) {
    assert.throws(() => assertTaskSearchFilter(value), TypeError)
  }
  assert.doesNotThrow(() => assertTaskSearchLimit(1))
  assert.doesNotThrow(() => assertTaskSearchLimit(MAX_TASK_SEARCH_RESULTS))
  for (const value of [0, -1, 1.5, MAX_TASK_SEARCH_RESULTS + 1, Number.NaN]) {
    assert.throws(() => assertTaskSearchLimit(value), TypeError)
  }
})

test('configured task-search limits are capped and fail to a safe default', () => {
  assert.equal(boundedTaskSearchLimit(10), 10)
  assert.equal(boundedTaskSearchLimit('25'), 25)
  assert.equal(boundedTaskSearchLimit(1000000), MAX_TASK_SEARCH_RESULTS)
  assert.equal(boundedTaskSearchLimit(0), MAX_TASK_SEARCH_RESULTS)
  assert.equal(boundedTaskSearchLimit('invalid'), MAX_TASK_SEARCH_RESULTS)
})

test('project identifiers are bounded and well formed', () => {
  assert.doesNotThrow(() => assertProjectId('project-id'))
  for (const value of ['', 'x'.repeat(129), '\ud800', null]) {
    assert.throws(() => assertProjectId(value), TypeError)
  }
})
