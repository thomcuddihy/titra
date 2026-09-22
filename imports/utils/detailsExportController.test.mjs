import assert from 'node:assert/strict'
import test from 'node:test'
import { createDetailsExportController } from './detailsExportController.js'
import { buildDetailsExportRows } from './detailsExportRows.js'

class ReactiveVar {
  constructor(value) { this.value = value }
  get() { return this.value }
  set(value) { this.value = value }
}
function fixture(view = 'detailed', overrides = {}) {
  const requested = []; const saved = []; const marked = []
  let epoch = 1; let allowed = true
  const rows = [{ _id: 'current', task: 'Current page task' }]
  const base = {
    ReactiveVar,
    request: { generation: () => epoch, current: (value) => epoch === value, ready: () => allowed },
    canExport: () => allowed,
    snapshot: () => ({ view, rows: structuredClone(rows), query: { period: 'all', projectId: 'all' }, fileName: 'export', sheetName: 'Sheet' }),
    fetchPage: async (parameters) => {
      requested.push(parameters)
      const count = parameters.page === 1 ? 500 : 1
      const records = Array.from({ length: count }, (_, index) => ({ _id: `${parameters.page}-${index}` }))
      return { rows: records, keys: records.map((entry) => entry._id), totalEntries: 501, page: parameters.page }
    },
    buildRows: (_snapshot, entries) => [['header'], ...entries.map((entry) => [entry._id])],
    saveCsv: async (data, fileName) => saved.push({ data, fileName }),
    saveXlsx: async (data, _sheetName, fileName, { beforeSave }) => { beforeSave(); saved.push({ data, fileName }) },
    markExported: async (ids) => marked.push(ids),
  }
  const controller = createDetailsExportController({ ...base, ...overrides })
  return { controller, requested, saved, marked, rows,
    changeFilters() { epoch += 1 }, disable() { allowed = false } }
}

for (const view of ['detailed', 'daily', 'total', 'working']) {
  for (const format of ['csv', 'xlsx']) {
    test(`${view} ${format} defaults to captured current page without fetching`, async () => {
      const f = fixture(view)
      assert.equal(f.controller.scope.get(), 'current')
      assert.equal(await f.controller.run(format), true)
      assert.equal(f.requested.length, 0)
      assert.deepEqual(f.saved[0].data, [['header'], ['current']])
      assert.equal(f.saved[0].fileName, `export.${format}`)
      assert.deepEqual(f.marked, view === 'detailed' ? [['current']] : [])
    })
    test(`${view} ${format} all matching pages do not reuse displayed page size or mutate displayed rows`, async () => {
      const f = fixture(view)
      f.controller.scope.set('all')
      assert.equal(await f.controller.run(format), true)
      assert.deepEqual(f.requested.map(({ page, limit }) => [page, limit]), [[1, 500], [2, 500]])
      assert.ok(f.requested.every((query) => query.view === view))
      assert.equal(f.saved[0].data.length, 502)
      assert.equal(f.saved[0].fileName, `export_all.${format}`)
      assert.equal(f.rows.length, 1)
      assert.equal(f.controller.progress.get().loaded, 501)
    })
  }
}

test('busy guard prevents duplicate exports and filter changes cancel an in-flight read without saving/marking', async () => {
  let resolve
  const f = fixture('detailed', { fetchPage: () => new Promise((yes) => { resolve = yes }) })
  f.controller.scope.set('all')
  const pending = f.controller.run('csv')
  await new Promise((yes) => setImmediate(yes))
  assert.equal(await f.controller.run('xlsx'), false)
  f.changeFilters()
  assert.equal(await pending, false)
  resolve({ rows: [], keys: [], totalEntries: 0, page: 1 })
  assert.equal(f.controller.error.get(), 'export-cancelled')
  assert.deepEqual(f.saved, [])
  assert.deepEqual(f.marked, [])
})

test('cancel during XLSX compression checks again before native download', async () => {
  let finish
  const f = fixture('detailed', { saveXlsx: (_data, _sheet, _file, { beforeSave }) => new Promise((resolve, reject) => {
    finish = () => { try { beforeSave(); resolve() } catch (error) { reject(error) } }
  }) })
  const pending = f.controller.run('xlsx')
  f.controller.cancel()
  finish()
  assert.equal(await pending, false)
  assert.equal(f.controller.error.get(), 'export-cancelled')
  assert.deepEqual(f.marked, [])
})

test('partial page failure and native download errors never mark records', async () => {
  const failing = fixture('detailed', { fetchPage: async () => ({ rows: [], keys: [], totalEntries: 501, page: 1 }) })
  failing.controller.scope.set('all')
  assert.equal(await failing.controller.run('csv'), false)
  assert.equal(failing.controller.error.get(), 'export-incomplete')
  assert.deepEqual(failing.saved, []); assert.deepEqual(failing.marked, [])
  const native = fixture('detailed', { saveCsv() { throw new Error('download failed') } })
  assert.equal(await native.controller.run('csv'), false)
  assert.equal(native.controller.error.get(), 'export-failed')
  assert.deepEqual(native.marked, [])
})

test('allowlisted Meteor transport failures retain actionable feedback without exposing arbitrary server text', async () => {
  for (const [error, expected] of [
    ['export-too-large', 'export-too-large'], ['export-page-too-large', 'export-page-too-large'],
    ['export-access-changed', 'export-changed'], ['export-invalid-result', 'export-incomplete'],
    ['export-filter-not-visible', 'export-filter-not-visible'],
    ['private server diagnostic', 'export-failed'],
  ]) {
    const f = fixture('daily', { fetchPage: async () => { throw { error, reason: 'secret diagnostic' } } })
    f.controller.scope.set('all')
    assert.equal(await f.controller.run('csv'), false)
    assert.equal(f.controller.error.get(), expected)
    assert.deepEqual(f.saved, [])
    assert.deepEqual(f.marked, [])
  }
})

test('malformed required raw fields abort both formats before any file or state write', async () => {
  for (const view of ['detailed', 'daily', 'total', 'working']) {
    for (const format of ['csv', 'xlsx']) {
      const f = fixture(view, { buildRows: () => buildDetailsExportRows(view, [{}], {}) })
      assert.equal(await f.controller.run(format), false)
      assert.equal(f.controller.error.get(), 'export-incomplete')
      assert.deepEqual(f.saved, [])
      assert.deepEqual(f.marked, [])
    }
  }
})

test('both serializers reject instructions/objects/nonfinite cells before any download or marking', async () => {
  for (const format of ['csv', 'xlsx']) {
    for (const value of [{ formula: '=1+1' }, [], NaN, Infinity, new Date(NaN)]) {
      const f = fixture('detailed', { buildRows: () => [['header'], [value]] })
      assert.equal(await f.controller.run(format), false)
      assert.equal(f.controller.error.get(), 'export-failed')
      assert.deepEqual(f.saved, [])
      assert.deepEqual(f.marked, [])
    }
    const f = fixture('daily', { buildRows: () => [[null, undefined, false, 0, '=literal', new Date('2026-09-22')]] })
    assert.equal(await f.controller.run(format), true)
    assert.equal(f.saved.length, 1)
  }
})

test('marking failure is distinguished from download failure and does not automatically retry', async () => {
  const f = fixture('detailed', { markExported() { throw new Error('permission changed') } })
  assert.equal(await f.controller.run('csv'), false)
  assert.equal(f.saved.length, 1)
  assert.equal(f.controller.completed.get(), 1)
  assert.equal(f.controller.error.get(), 'export-mark-failed')
})

test('marking exact snapshot IDs uses chunks at most 1000 and ignores later filter changes after save', async () => {
  const marked = []
  const entries = Array.from({ length: 1001 }, (_, index) => ({ _id: String(index) }))
  entries.push({ _id: 'billed', state: 'billed' }, { _id: 'notBillable', state: 'notBillable' })
  const f = fixture('detailed', {
    snapshot: () => ({ view: 'detailed', rows: entries, query: {}, fileName: 'export', sheetName: 'Sheet' }),
    markExported: async (ids) => { marked.push(ids); f.changeFilters() },
  })
  assert.equal(await f.controller.run('csv'), true)
  assert.deepEqual(marked.map((ids) => ids.length), [1000, 1])
  assert.ok(!marked.flat().includes('billed'))
  assert.ok(!marked.flat().includes('notBillable'))
})

test('not-ready/disposed views cannot export; relative-period preparation completes before fetching and can cancel', async () => {
  const disabled = fixture('daily'); disabled.disable()
  assert.equal(await disabled.controller.run('csv'), false)
  const disposed = fixture('daily'); disposed.controller.dispose()
  assert.equal(await disposed.controller.run('csv'), false)
  const order = []
  const f = fixture('daily', {
    prepareQuery: async (captured) => { order.push('prepare'); captured.query.period = 'custom'; f.controller.cancel() },
    fetchPage: async () => { order.push('fetch'); return {} },
  })
  f.controller.scope.set('all')
  assert.equal(await f.controller.run('csv'), false)
  assert.deepEqual(order, ['prepare'])
  assert.equal(f.controller.error.get(), 'export-cancelled')
})
