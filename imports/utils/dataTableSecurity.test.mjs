import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  escapeDataTableText,
  secureDataTableColumns,
} from './dataTableSecurity.js'

const hostile = `<img src=x onerror="alert('xss')"> & 'quoted'`
const encoded = '&lt;img src=x onerror=&quot;alert(&#39;xss&#39;)&quot;&gt; &amp; &#39;quoted&#39;'

test('DataTable plain text is HTML encoded', () => {
  assert.equal(escapeDataTableText(hostile), encoded)
  assert.equal(escapeDataTableText(null), '')
  assert.equal(escapeDataTableText(12.5), '12.5')
})

test('DataTable columns encode headings and default to a text formatter', () => {
  const columns = secureDataTableColumns([
    hostile,
    { name: hostile, editable: false },
  ])

  assert.equal(columns[0].name, encoded)
  assert.equal(columns[0].format(hostile), encoded)
  assert.equal(columns[1].name, encoded)
  assert.equal(columns[1].format(hostile), encoded)
  assert.equal(columns[1].editable, false)
})

test('DataTable columns preserve deliberate markup formatters', () => {
  const formatter = (value) => `<strong>${escapeDataTableText(value)}</strong>`
  const [column] = secureDataTableColumns([{ name: 'Result', formatter, format: formatter }])

  assert.equal(column.format, formatter)
  assert.equal(column.format(hostile), `<strong>${encoded}</strong>`)
})

test('every Frappe DataTable entry point installs the shared encoding policy', () => {
  for (const relativePath of [
    'ui/shared components/datatable.js',
    'ui/pages/details/components/dailytimetable.js',
    'ui/pages/details/components/detailtimetable.js',
    'ui/pages/details/components/periodtimetable.js',
    'ui/pages/details/components/workingtimetable.js',
    'ui/pages/overview/editproject/components/importcsv.js',
    'ui/pages/overview/editproject/components/projectAccessRights.js',
    'ui/pages/overview/editproject/components/wekanInterfaceSettings.js',
    'ui/pages/track/components/projectTasks.js',
  ]) {
    const contents = readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8')
    assert.match(contents, /secureDataTableColumns/u, relativePath)
  }
})

test('custom DataTable markup formatters encode legacy identifier attributes', () => {
  for (const relativePath of [
    'ui/pages/details/components/detailtimetable.js',
    'ui/pages/overview/editproject/components/projectAccessRights.js',
    'ui/pages/track/components/projectTasks.js',
  ]) {
    const contents = readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8')
    assert.match(contents, /escapeDataTableText/u, relativePath)
  }
})
