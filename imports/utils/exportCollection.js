// Export pages are collected separately from the displayed table. A failed,
// cancelled or inconsistent collection must never be offered as a complete file.
const EXPORT_PAGE_SIZE = 500
const MAX_EXPORT_ROWS = 100000
const MAX_EXPORT_BYTES = 50 * 1024 * 1024
const EXPORT_TIMEOUT_MS = 120000

class ExportCollectionError extends Error {
  constructor(code) {
    super(code)
    this.name = 'ExportCollectionError'
    this.code = code
  }
}

function fail(code) { throw new ExportCollectionError(code) }

async function collectExportPages({
  fetchPage, isCancelled = () => false, onProgress = () => {},
  pageSize = EXPORT_PAGE_SIZE, maxRows = MAX_EXPORT_ROWS,
  maxBytes = MAX_EXPORT_BYTES, timeoutMs = EXPORT_TIMEOUT_MS,
}) {
  if (typeof fetchPage !== 'function' || typeof isCancelled !== 'function'
    || typeof onProgress !== 'function'
    || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > EXPORT_PAGE_SIZE
    || !Number.isSafeInteger(maxRows) || maxRows < 1 || maxRows > MAX_EXPORT_ROWS
    || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_EXPORT_BYTES
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > EXPORT_TIMEOUT_MS) {
    throw new TypeError('Invalid export collection options.')
  }
  const deadline = Date.now() + timeoutMs
  const check = () => {
    if (isCancelled()) fail('export-cancelled')
    if (Date.now() >= deadline) fail('export-timeout')
  }
  const rows = []
  const seen = new Set()
  const encoder = new TextEncoder()
  let total
  let bytes = 0
  for (let page = 1; ; page += 1) {
    check()
    let timer
    // DDP cannot abort an already running method. Stop waiting promptly on
    // cancellation, and ignore its eventual read-only reply without downloading.
    const interrupted = new Promise((resolve, reject) => {
      const poll = () => {
        try { check() } catch (error) { reject(error); return }
        timer = setTimeout(poll, Math.min(100, Math.max(1, deadline - Date.now())))
      }
      timer = setTimeout(poll, Math.min(100, Math.max(1, deadline - Date.now())))
    })
    let result
    try {
      result = await Promise.race([
        Promise.resolve().then(() => { check(); return fetchPage({ page, limit: pageSize }) }),
        interrupted,
      ])
    } finally { clearTimeout(timer) }
    check()
    if (!result || !Array.isArray(result.rows) || !Array.isArray(result.keys)
      || result.page !== page || !Number.isSafeInteger(result.totalEntries)
      || result.totalEntries < 0 || result.rows.length !== result.keys.length) {
      fail('export-incomplete')
    }
    if (result.totalEntries > maxRows) fail('export-too-large')
    if (total === undefined) total = result.totalEntries
    else if (total !== result.totalEntries) fail('export-changed')
    const expected = Math.min(pageSize, total - rows.length)
    if (result.rows.length !== expected) fail('export-incomplete')
    if (result.rows.some((row) => !row || typeof row !== 'object' || Array.isArray(row)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(row)))) {
      fail('export-incomplete')
    }
    for (const key of result.keys) {
      if (typeof key !== 'string' || !key || key.length > 2048 || !key.isWellFormed()) {
        fail('export-incomplete')
      }
      if (seen.has(key)) fail('export-changed')
      seen.add(key)
    }
    let encoded
    try { encoded = JSON.stringify({ rows: result.rows, keys: result.keys }) } catch {
      fail('export-incomplete')
    }
    bytes += encoder.encode(encoded).byteLength
    if (bytes > maxBytes) fail('export-too-large')
    rows.push(...result.rows)
    onProgress({ loaded: rows.length, total })
    check()
    if (rows.length === total) return rows
  }
}

export {
  EXPORT_PAGE_SIZE, EXPORT_TIMEOUT_MS, MAX_EXPORT_ROWS, MAX_EXPORT_BYTES,
  ExportCollectionError, collectExportPages,
}
