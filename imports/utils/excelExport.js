import writeExcelFile from 'write-excel-file/browser'
import {
  getCellAddress,
  getOrderOfSiblings,
  getSelfClosingTagMarkup,
  insertElementMarkupAccordingToOrderOfSiblings,
} from 'write-excel-file/utility'
import { saveAs } from 'file-saver'

function normalizeCell(value) {
  if (value === null || value === undefined) return null
  if (typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (value instanceof Date && Number.isFinite(value.getTime())) return new Date(value.getTime())
  // Records supply values, never the export library's cell instructions.
  // In particular, an object must not be interpreted as a Formula cell.
  throw new TypeError('Excel export cells must contain finite numbers, text, booleans, dates, or null.')
}

function headerFilter(data) {
  const columns = data.reduce((count, row) => Math.max(count, row.length), 0)
  if (data.length === 0 || columns === 0) return []
  const range = `A1:${getCellAddress(data.length - 1, columns - 1)}`
  return [{
    files: {
      transform: {
        'xl/worksheets/sheet{id}.xml': {
          transform: (xml) => insertElementMarkupAccordingToOrderOfSiblings(
            xml,
            getSelfClosingTagMarkup('autoFilter', { ref: range }),
            getOrderOfSiblings('xl/worksheets/sheet{id}.xml', 'worksheet'),
            'worksheet',
          ),
        },
      },
    },
  }]
}

// eslint-disable-next-line import/prefer-default-export
export async function exportSheetToXlsx(data, sheetName, fileName) {
  if (!Array.isArray(data) || data.some((row) => !Array.isArray(row))) {
    throw new TypeError('Excel export data must be an array of rows.')
  }
  const rows = data.map((row) => row.map(normalizeCell))
  const blob = await writeExcelFile(rows, {
    sheet: sheetName,
    stickyRowsCount: 1,
    dateFormat: 'yyyy-mm-dd hh:mm:ss',
  }, {
    features: headerFilter(rows),
  }).toBlob()

  saveAs(blob, fileName)
}
