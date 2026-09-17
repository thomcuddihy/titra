import writeExcelFile from 'write-excel-file/browser'
import { saveAs } from 'file-saver'

export async function exportSheetToXlsx(data, sheetName, fileName) {
  const blob = await writeExcelFile(data, {
    sheet: sheetName,
    stickyRowsCount: 1,
  }).toBlob()

  saveAs(blob, fileName)
}
