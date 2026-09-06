const CSV_BOM = '\uFEFF'
const SPREADSHEET_FORMULA_PREFIX = /^[=+\-@]/u
const SPREADSHEET_CONTROL_PREFIX = /^[\u0009\u000A\u000D]/u

function csvValueText(value) {
  if (value === undefined || value === null) return ''
  if (value instanceof Date) return value.toISOString()
  return String(value)
}

function neutralizeSpreadsheetFormula(value) {
  const text = csvValueText(value)
  const comparisonText = text.replace(/^\uFEFF/u, '').trimStart()
  if (typeof value === 'string'
    && (SPREADSHEET_CONTROL_PREFIX.test(text)
      || SPREADSHEET_FORMULA_PREFIX.test(comparisonText))) return `'${text}`
  return text
}

function encodeCsvCell(value) {
  return `"${neutralizeSpreadsheetFormula(value).replaceAll('"', '""')}"`
}

function encodeCsvRow(values) {
  if (!Array.isArray(values)) throw new TypeError('CSV rows must be arrays.')
  return values.map(encodeCsvCell).join(',')
}

function encodeCsv(rows, { includeBom = true } = {}) {
  if (!Array.isArray(rows)) throw new TypeError('CSV input must be an array of rows.')
  const body = rows.map(encodeCsvRow).join('\r\n')
  return `${includeBom ? CSV_BOM : ''}${body}${rows.length ? '\r\n' : ''}`
}

export {
  CSV_BOM,
  encodeCsv,
  encodeCsvCell,
  encodeCsvRow,
  neutralizeSpreadsheetFormula,
}
