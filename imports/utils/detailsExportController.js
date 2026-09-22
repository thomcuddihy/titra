import { collectExportPages, MAX_EXPORT_BYTES, MAX_EXPORT_ROWS } from './exportCollection.js'
import { exportedTimecardIds } from './detailsExportRows.js'

function exportError(code) {
  return Object.assign(new Error(code), { code })
}

function publicExportFailure(failure) {
  // Meteor transport errors carry `error`; local collection errors use `code`.
  // Only known identifiers reach the UI, never arbitrary server messages.
  const code = typeof failure?.code === 'string' ? failure.code : failure?.error
  if (code === 'export-access-changed') return 'export-changed'
  if (code === 'export-invalid-result') return 'export-incomplete'
  return ['export-cancelled', 'export-too-large', 'export-page-too-large',
    'export-filter-not-visible', 'export-incomplete', 'export-changed', 'export-timeout'].includes(code) ? code : 'export-failed'
}

function validateExportData(data) {
  if (!Array.isArray(data)) throw exportError('export-failed')
  const encoder = new TextEncoder()
  let bytes = 2
  for (const row of data) {
    if (!Array.isArray(row)) throw exportError('export-failed')
    for (const value of row) {
      if (value == null || typeof value === 'string' || typeof value === 'boolean'
        || (typeof value === 'number' && Number.isFinite(value))
        || (value instanceof Date && Number.isFinite(value.getTime()))) continue
      throw exportError('export-failed')
    }
    // Bound each row before constructing a whole-file serialized string; a
    // repeated large project custom field must not expand into a giant buffer.
    bytes += encoder.encode(JSON.stringify(row)).byteLength + 1
    if (bytes > MAX_EXPORT_BYTES) throw exportError('export-too-large')
  }
}

function createDetailsExportController({
  ReactiveVar, request, canExport, snapshot, fetchPage, buildRows,
  saveCsv, saveXlsx, markExported, prepareQuery = async () => {},
}) {
  const scope = new ReactiveVar('current')
  const busy = new ReactiveVar(false)
  const progress = new ReactiveVar()
  const error = new ReactiveVar()
  const completed = new ReactiveVar()
  const stage = new ReactiveVar()
  let active
  let disposed = false
  return {
    scope, busy, progress, error, completed, stage,
    cancel() { if (active && !active.saved) active.cancelled = true },
    dispose() { disposed = true; if (active && !active.saved) active.cancelled = true },
    async run(format) {
      if (disposed || busy.get() || !canExport() || !['csv', 'xlsx'].includes(format)) return false
      const job = { epoch: request.generation(), cancelled: false, saved: false }
      active = job
      busy.set(true)
      stage.set('preparing')
      progress.set(undefined)
      error.set(undefined)
      completed.set(undefined)
      const isCancelled = () => job.cancelled || disposed || !request.current(job.epoch) || !request.ready()
      const beforeSave = () => { if (isCancelled()) throw exportError('export-cancelled') }
      try {
        // Snapshot current rows too: they must not change during compression.
        const captured = snapshot()
        const mode = scope.get()
        if (mode === 'all') await prepareQuery(captured)
        beforeSave()
        const entries = mode === 'all' ? await collectExportPages({
          fetchPage: ({ page, limit }) => fetchPage({ view: captured.view, query: captured.query, page, limit }),
          isCancelled,
          onProgress: (value) => { if (active === job) progress.set(value) },
        }) : captured.rows
        beforeSave()
        if (entries.length > MAX_EXPORT_ROWS) throw exportError('export-too-large')
        const data = buildRows(captured, entries)
        validateExportData(data)
        const fileName = `${captured.fileName}${mode === 'all' ? '_all' : ''}.${format}`
        stage.set('saving')
        if (format === 'xlsx') await saveXlsx(data, captured.sheetName, fileName, { beforeSave })
        else { beforeSave(); await saveCsv(data, fileName) }
        job.saved = true
        completed.set(entries.length)
        // Once the download has started, changes to the displayed filters must
        // not change or cancel marking this exact file's eligible timecards.
        if (captured.view === 'detailed') {
          stage.set('marking')
          const ids = exportedTimecardIds(entries)
          for (let offset = 0; offset < ids.length; offset += 1000) {
            await markExported(ids.slice(offset, offset + 1000))
          }
        }
        return true
      } catch (failure) {
        error.set(job.saved ? 'export-mark-failed' : publicExportFailure(failure))
        return false
      } finally {
        if (active === job) { active = undefined; busy.set(false) }
      }
    },
  }
}

export { createDetailsExportController }
