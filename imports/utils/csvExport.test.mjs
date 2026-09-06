import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const helperModuleUrl = `data:text/javascript;base64,${Buffer.from(
  readFileSync(new URL('./csvExport.js', import.meta.url), 'utf8'),
).toString('base64')}`

const {
  CSV_BOM, encodeCsv, encodeCsvCell, neutralizeSpreadsheetFormula,
} = await import(helperModuleUrl)

test('encodes RFC 4180 fields, quotes, commas and line breaks', () => {
  assert.equal(encodeCsvCell('one, "two"\nthree'), '"one, ""two""\nthree"')
  assert.equal(
    encodeCsv([['Name', 'Value'], ['Alice', 'one, "two"']], { includeBom: false }),
    '"Name","Value"\r\n"Alice","one, ""two"""\r\n',
  )
})

test('neutralizes spreadsheet formulas including whitespace-prefixed payloads', () => {
  for (const value of [
    '=1+1', '+cmd|\'/C calc\'!A0', '-2+3', '@SUM(A1:A2)',
    ' =HYPERLINK("https://bad.invalid")', '\t=1+1', '\tplain text',
    '\uFEFF=1+1', '\u00A0@SUM(A1:A2)',
  ]) assert.equal(neutralizeSpreadsheetFormula(value), `'${value}`)
  assert.equal(neutralizeSpreadsheetFormula('ordinary text'), 'ordinary text')
  assert.equal(neutralizeSpreadsheetFormula(-5), '-5')
})

test('emits one BOM, CRLF records and safe hostile cells', () => {
  const csv = encodeCsv([['task'], ['=WEBSERVICE("https://bad.invalid")']])
  assert.equal(csv.startsWith(CSV_BOM), true)
  assert.equal(csv, `${CSV_BOM}"task"\r\n"'=WEBSERVICE(""https://bad.invalid"")"\r\n`)
})
