import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const helperModuleUrl = `data:text/javascript;base64,${Buffer.from(
  readFileSync(new URL('./timecardDateMigrationPaging.js', import.meta.url), 'utf8'),
).toString('base64')}`

const {
  buildPreviewSort,
  hasNextPage,
  hasPreviousPage,
  pageCount,
} = await import(helperModuleUrl)

test('defaults preview ordering to latest source date with a stable tie-breaker', () => {
  assert.deepEqual(buildPreviewSort(), {
    field: 'date',
    direction: 'desc',
    mongo: { 'original.date': -1, timecardId: 1 },
  })
})

test('allows only named preview sort fields and directions', () => {
  assert.deepEqual(buildPreviewSort('context', 'asc'), {
    field: 'context',
    direction: 'asc',
    mongo: {
      'original.userId': 1,
      'original.projectId': 1,
      'original.task': 1,
      timecardId: 1,
    },
  })
  assert.deepEqual(buildPreviewSort('day-shift', 'desc').mongo, {
    'preview.dayShift': -1,
    'original.date': -1,
    timecardId: 1,
  })
  assert.throws(() => buildPreviewSort('$where', 'asc'), /supported preview sort column/)
  assert.throws(() => buildPreviewSort('current', 'asc'), /supported preview sort column/)
  assert.throws(() => buildPreviewSort('__proto__', 'asc'), /supported preview sort column/)
  assert.throws(() => buildPreviewSort('constructor', 'asc'), /supported preview sort column/)
  assert.throws(() => buildPreviewSort('toString', 'asc'), /supported preview sort column/)
  assert.throws(() => buildPreviewSort('date', '-1'), /ascending or descending/)
})

test('calculates navigation state at empty, exact, and partial page boundaries', () => {
  const cases = [
    {
      total: 0, page: 1, pageSize: 25, previous: false, next: false, pages: 1,
    },
    {
      total: 25, page: 1, pageSize: 25, previous: false, next: false, pages: 1,
    },
    {
      total: 26, page: 1, pageSize: 25, previous: false, next: true, pages: 2,
    },
    {
      total: 50, page: 2, pageSize: 25, previous: true, next: false, pages: 2,
    },
    {
      total: 51, page: 2, pageSize: 25, previous: true, next: true, pages: 3,
    },
    {
      total: 205, page: 3, pageSize: 100, previous: true, next: false, pages: 3,
    },
  ]
  cases.forEach((item) => {
    assert.equal(hasPreviousPage(item.page), item.previous)
    assert.equal(hasNextPage(item), item.next)
    assert.equal(pageCount(item.total, item.pageSize), item.pages)
  })
})

test('disables both page controls while a request is loading', () => {
  assert.equal(hasPreviousPage(2, true), false)
  assert.equal(hasNextPage({
    page: 1, pageSize: 25, total: 100, loading: true,
  }), false)
})
