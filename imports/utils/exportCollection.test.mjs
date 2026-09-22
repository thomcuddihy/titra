import assert from 'node:assert/strict'
import test from 'node:test'
import {
  collectExportPages, EXPORT_PAGE_SIZE, MAX_EXPORT_ROWS, MAX_EXPORT_BYTES,
} from './exportCollection.js'

const response = (page, rows, totalEntries = rows.length) => ({
  page, rows, keys: rows.map((row) => row._id), totalEntries,
})
const rejected = (code) => (error) => error.code === code

test('all export collects every bounded page in order without mutating replies', async () => {
  const data = Array.from({ length: 1203 }, (_, i) => ({ _id: `record-${i}`, hours: i / 1000 }))
  const before = structuredClone(data)
  const calls = []; const progress = []
  const result = await collectExportPages({
    fetchPage: async ({ page, limit }) => {
      calls.push({ page, limit })
      return response(page, data.slice((page - 1) * limit, page * limit), data.length)
    },
    onProgress: (value) => progress.push(value),
  })
  assert.deepEqual(result, data)
  assert.deepEqual(data, before)
  assert.deepEqual(calls, [1, 2, 3].map((page) => ({ page, limit: EXPORT_PAGE_SIZE })))
  assert.deepEqual(progress, [500, 1000, 1203].map((loaded) => ({ loaded, total: 1203 })))
})

test('empty export finishes after one page; exact page multiple has no extra request', async () => {
  let calls = 0
  assert.deepEqual(await collectExportPages({ fetchPage: async () => {
    calls += 1; return response(1, [])
  } }), [])
  assert.equal(calls, 1)
  calls = 0
  const rows = await collectExportPages({ pageSize: 1, fetchPage: async ({ page }) => {
    calls += 1; return response(page, [{ _id: `r${page}` }], 2)
  } })
  assert.equal(rows.length, 2)
  assert.equal(calls, 2)
})

test('collection refuses changed counts, duplicate keys and truncated pages', async () => {
  for (const [second, code] of [
    [response(2, [{ _id: 'b' }], 3), 'export-changed'],
    [response(2, [{ _id: 'a' }], 2), 'export-changed'],
    [response(2, [], 2), 'export-incomplete'],
    [response(3, [{ _id: 'b' }], 2), 'export-incomplete'],
  ]) {
    await assert.rejects(collectExportPages({ pageSize: 1, fetchPage: async ({ page }) => (
      page === 1 ? response(1, [{ _id: 'a' }], 2) : second
    ) }), rejected(code))
  }
})

test('invalid response envelopes fail closed instead of downloading a partial export', async () => {
  for (const result of [null, {}, response(1, [], -1), response(1, [], 1.5),
    { ...response(1, [{ _id: 'a' }]), keys: [] },
    { ...response(1, [{ _id: 'a' }]), keys: [null] },
    { ...response(1, [{ _id: 'a' }]), keys: [''] },
    { ...response(1, [{ _id: 'a' }]), keys: ['\ud800'] },
    { page: 1, rows: [null], keys: ['a'], totalEntries: 1 },
    { page: 1, rows: [42], keys: ['a'], totalEntries: 1 },
    { page: 1, rows: [[]], keys: ['a'], totalEntries: 1 },
    response(1, [{ _id: 'a' }, { _id: 'a' }]),
  ]) {
    await assert.rejects(collectExportPages({ fetchPage: async () => result }),
      (error) => ['export-incomplete', 'export-changed'].includes(error.code))
  }
})

test('row and UTF-8 byte ceilings are explicit errors, never silent truncation', async () => {
  await assert.rejects(collectExportPages({ fetchPage: async () => response(1, [], MAX_EXPORT_ROWS + 1) }),
    rejected('export-too-large'))
  const row = { _id: 'a', task: '漢'.repeat(20) }
  const bytes = new TextEncoder().encode(JSON.stringify({ rows: [row], keys: ['a'] })).byteLength
  await assert.rejects(collectExportPages({ maxBytes: bytes - 1, fetchPage: async () => response(1, [row]) }),
    rejected('export-too-large'))
  assert.deepEqual(await collectExportPages({ maxBytes: bytes, fetchPage: async () => response(1, [row]) }), [row])
  assert.equal(MAX_EXPORT_BYTES, 50 * 1024 * 1024)
})

test('network failures and cancellation between pages return no partial array', async () => {
  let cancelled = false; let calls = 0
  await assert.rejects(collectExportPages({ pageSize: 1, isCancelled: () => cancelled,
    onProgress: () => { cancelled = true }, fetchPage: async ({ page }) => {
      calls += 1; return response(page, [{ _id: 'a' }], 2)
    } }), rejected('export-cancelled'))
  assert.equal(calls, 1)
  const failure = new Error('Read failed')
  await assert.rejects(collectExportPages({ pageSize: 1, fetchPage: async ({ page }) => {
    if (page === 2) throw failure
    return response(page, [{ _id: 'a' }], 2)
  } }), (error) => error === failure)
})

test('pending reads time out or cancel without waiting for their late reply', async () => {
  let cancelled = false
  let reply
  const pending = collectExportPages({
    isCancelled: () => cancelled,
    fetchPage: () => new Promise((resolve) => { reply = resolve }),
  })
  await new Promise((resolve) => setImmediate(resolve))
  cancelled = true
  await assert.rejects(pending, rejected('export-cancelled'))
  reply(response(1, [{ _id: 'late' }]))
  await assert.rejects(collectExportPages({ timeoutMs: 5, fetchPage: () => new Promise(() => {}) }),
    rejected('export-timeout'))
})

test('already-cancelled and malformed options do not start network work', async () => {
  let calls = 0
  const fetchPage = async () => { calls += 1; return response(1, []) }
  await assert.rejects(collectExportPages({ fetchPage, isCancelled: () => true }), rejected('export-cancelled'))
  for (const options of [{ pageSize: 0 }, { pageSize: 501 }, { maxRows: MAX_EXPORT_ROWS + 1 },
    { maxBytes: MAX_EXPORT_BYTES + 1 }, { timeoutMs: 0 }]) {
    await assert.rejects(collectExportPages({ fetchPage, ...options }), TypeError)
  }
  assert.equal(calls, 0)
})
