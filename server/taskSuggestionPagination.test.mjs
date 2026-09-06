import assert from 'node:assert/strict'
import test from 'node:test'

import {
  TaskSuggestionPaginationError,
  decodeTaskSuggestionCursor,
  encodeTaskSuggestionCursor,
  fetchTaskSuggestionPage,
} from './taskSuggestionPagination.js'

function matcher(record, selector) {
  return Object.entries(selector).every(([key, condition]) => {
    if (condition && typeof condition === 'object') {
      if (Object.hasOwn(condition, '$exists')) {
        return Object.hasOwn(record, key) === condition.$exists
      }
      if (Object.hasOwn(condition, '$gt')) return record[key] > condition.$gt
    }
    if (condition === null) return record[key] == null
    return record[key] === condition
  })
}

function finder(records) {
  return async (selector, options) => records
    .filter((record) => matcher(record, selector))
    .sort((left, right) => left._id.localeCompare(right._id))
    .slice(0, options.limit)
}

test('cursor is opaque, owner-bound, canonical and rejects malformed values', () => {
  const cursor = encodeTaskSuggestionCursor({ userId: 'u1', id: 'suggestion-2' })
  assert.notEqual(cursor.includes('u1'), true)
  assert.equal(decodeTaskSuggestionCursor(cursor, 'u1'), 'suggestion-2')
  assert.throws(
    () => decodeTaskSuggestionCursor(cursor, 'u2'),
    (error) => error instanceof TaskSuggestionPaginationError
      && error.error === 'task-suggestion-invalid',
  )
  for (const invalid of ['', '***', 'e30=', 'x'.repeat(513)]) {
    assert.throws(() => decodeTaskSuggestionCursor(invalid, 'u1'), TaskSuggestionPaginationError)
  }
})

test('next page survives deletion of its boundary suggestion', async () => {
  const records = [1, 2, 3, 4].map((value) => ({
    _id: `s${value}`, userId: 'u1', name: `Task ${value}`,
  }))
  records[1].projectId = null
  const first = await fetchTaskSuggestionPage({
    userId: 'u1', limit: 2, find: finder(records),
    serialize: async (value) => ({ id: value._id }),
  })
  assert.deepEqual(first.items, [{ id: 's1' }, { id: 's2' }])
  assert.equal(first.page.complete, false)
  records.splice(records.findIndex((value) => value._id === 's2'), 1)
  const second = await fetchTaskSuggestionPage({
    userId: 'u1', limit: 2, cursor: first.page.nextCursor,
    find: finder(records), serialize: async (value) => ({ id: value._id }),
  })
  assert.deepEqual(second.items, [{ id: 's3' }, { id: 's4' }])
  assert.equal(second.page.complete, true)
  assert.equal(second.page.nextCursor, null)
})

test('page query and ordering fail closed', async () => {
  await assert.rejects(fetchTaskSuggestionPage({
    userId: 'u1', limit: 2, find: async () => [{ _id: 's2' }, { _id: 's1' }],
    serialize: async (value) => value,
  }), /stable ID order/)
  await assert.rejects(fetchTaskSuggestionPage({
    userId: 'u1', limit: 2, find: async () => undefined,
    serialize: async (value) => value,
  }), /must return an array/)
})
