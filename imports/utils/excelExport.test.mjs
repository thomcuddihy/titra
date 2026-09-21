import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import AdmZip from 'adm-zip'

const moduleUrl = (source) => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
// Exercise the real browser exporter and its ZIP/XML output; only the browser
// download is replaced, so the test does not open a file dialog or write files.
const saverUrl = moduleUrl('export const downloads = []; export function saveAs(blob, fileName) { downloads.push({ blob, fileName }) }')
const { downloads } = await import(saverUrl)
const source = readFileSync(new URL('./excelExport.js', import.meta.url), 'utf8')
  .replace("'file-saver'", JSON.stringify(saverUrl))
  .replace("'write-excel-file/browser'", JSON.stringify(import.meta.resolve('write-excel-file/browser')))
  .replace("'write-excel-file/utility'", JSON.stringify(import.meta.resolve('write-excel-file/utility')))
const { exportSheetToXlsx } = await import(moduleUrl(source))

async function exportArchive(data, sheetName = 'titra export', fileName = 'titra.xlsx') {
  const count = downloads.length
  await exportSheetToXlsx(data, sheetName, fileName)
  assert.equal(downloads.length, count + 1)
  const download = downloads.at(-1)
  assert.equal(download.fileName, fileName)
  assert.equal(download.blob.type, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  return new AdmZip(Buffer.from(await download.blob.arrayBuffer()))
}

test('XLSX preserves primitive values, precise hours, date labels, and a frozen filter header', async () => {
  const data = [
    ['Project', 'Date', 'Task', 'Hours', 'Billable', 'Empty'],
    ['Project Alpha', '2026-09-22', 'Review & research <notes>', 1.237, false, null],
    ['Project Beta', '2026-09-21', 'Client meetings', 0, true, undefined],
  ]
  const before = structuredClone(data)
  const archive = await exportArchive(data, 'daily & total', 'daily.xlsx')
  assert.deepEqual(data, before)
  const worksheet = archive.readAsText('xl/worksheets/sheet1.xml')
  const strings = archive.readAsText('xl/sharedStrings.xml')
  const workbook = archive.readAsText('xl/workbook.xml')
  assert.match(worksheet, /<c r="D2"><v>1\.237<\/v><\/c>/)
  assert.match(worksheet, /<c r="D3"><v>0<\/v><\/c>/)
  assert.match(worksheet, /<c r="E2" t="b"><v>0<\/v><\/c>/)
  assert.match(worksheet, /<c r="E3" t="b"><v>1<\/v><\/c>/)
  assert.match(worksheet, /<pane[^>]*ySplit="1"[^>]*topLeftCell="A2"[^>]*state="frozen"/)
  assert.match(worksheet, /<autoFilter ref="A1:F3"\/>/)
  assert.ok(worksheet.indexOf('</sheetData>') < worksheet.indexOf('<autoFilter'))
  assert.match(strings, /<t>2026-09-22<\/t>/)
  assert.match(strings, /Review &amp; research &lt;notes&gt;/)
  assert.match(workbook, /name="daily &amp; total"/)
})

test('XLSX treats formula-looking task/project values as literal text', async () => {
  const tasks = ['=1+1', '+SUM(A1:A2)', '-1+1', '@SUM(A1:A2)', '\t=1+1', '\r=1+1', '=HYPERLINK("https://example.invalid","click")']
  const archive = await exportArchive([['Task'], ...tasks.map((task) => [task])])
  const worksheet = archive.readAsText('xl/worksheets/sheet1.xml')
  const strings = archive.readAsText('xl/sharedStrings.xml')
  assert.doesNotMatch(worksheet, /<f(?:\s|>)/)
  assert.equal((worksheet.match(/t="s"/g) || []).length, tasks.length + 1)
  for (const task of tasks) assert.ok(strings.includes(task))
  assert.doesNotMatch(archive.readAsText('xl/worksheets/_rels/sheet1.xml.rels'), /example\.invalid/)
})

test('XLSX dates remain numeric Excel dates rather than host-timezone formatted strings', async () => {
  const instant = new Date('2026-09-22T00:00:00Z')
  const archive = await exportArchive([['Date'], [instant]])
  const worksheet = archive.readAsText('xl/worksheets/sheet1.xml')
  assert.match(worksheet, /<c r="A2" s="\d+"><v>46287<\/v><\/c>/)
  assert.match(archive.readAsText('xl/styles.xml'), /yyyy-mm-dd hh:mm:ss/)
  assert.equal(instant.toISOString(), '2026-09-22T00:00:00.000Z')
})

test('XLSX filters include columns beyond Z and empty/header-only exports remain valid', async () => {
  const wide = await exportArchive([Array(28).fill('Header'), Array(28).fill(1)])
  assert.match(wide.readAsText('xl/worksheets/sheet1.xml'), /<autoFilter ref="A1:AB2"\/>/)
  const header = await exportArchive([['Task']])
  assert.match(header.readAsText('xl/worksheets/sheet1.xml'), /<autoFilter ref="A1:A1"\/>/)
  const empty = await exportArchive([])
  const emptyRow = await exportArchive([[]])
  assert.doesNotMatch(empty.readAsText('xl/worksheets/sheet1.xml'), /<autoFilter/)
  assert.doesNotMatch(emptyRow.readAsText('xl/worksheets/sheet1.xml'), /<autoFilter/)
})

test('XLSX rejects executable cell instructions, malformed input and nonfinite numbers before download', async () => {
  const count = downloads.length
  await Promise.all([{ type: 'Formula', value: '=1+1' }, {}, [], NaN, Infinity, -Infinity, new Date(NaN), 1n].map(
    (value) => assert.rejects(exportSheetToXlsx([['Task'], [value]], 'data', 'invalid.xlsx'), TypeError),
  ))
  await Promise.all([null, {}, ['not a row']].map(
    (data) => assert.rejects(exportSheetToXlsx(data, 'data', 'invalid.xlsx'), TypeError),
  ))
  assert.equal(downloads.length, count)
})

test('XLSX produces valid compressed output above fflate asynchronous-worker threshold', async () => {
  const data = [['Task', 'Hours'], ...Array.from({ length: 2000 }, (_, index) => [
    `Task ${index}: ${'Detailed research and reporting '.repeat(8)}`, index / 1000,
  ])]
  const archive = await exportArchive(data)
  const worksheet = archive.readAsText('xl/worksheets/sheet1.xml')
  const strings = archive.readAsText('xl/sharedStrings.xml')
  assert.ok(Buffer.byteLength(strings) > 160000)
  assert.equal((worksheet.match(/<row /g) || []).length, 2001)
  assert.match(worksheet, /<autoFilter ref="A1:B2001"\/>/)
  assert.ok(strings.includes('Task 1999:'))
})
