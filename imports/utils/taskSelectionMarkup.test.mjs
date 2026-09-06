import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  escapeTaskSelectionText,
  taskSelectionCell,
} from './taskSelectionMarkup.js'

test('task names are encoded for both visible text and the data attribute', () => {
  const hostile = `Ticket & \"quoted\" 'single' ><img src=x onerror=alert(1)>`
  const encoded = 'Ticket &amp; &quot;quoted&quot; &#39;single&#39; &gt;&lt;img src=x onerror=alert(1)&gt;'
  assert.equal(escapeTaskSelectionText(hostile), encoded)
  assert.equal(taskSelectionCell(hostile),
    `<button type="button" class="btn text-primary py-0 js-select-task" data-task="${encoded}"><i class="fa fa-plus"></i></button><span>${encoded}</span>`)
  assert.doesNotMatch(taskSelectionCell(hostile), /<img/i)
})

test('ordinary Unicode task names are preserved', () => {
  assert.equal(escapeTaskSelectionText('Résumé – 東京'), 'Résumé – 東京')
  assert.match(taskSelectionCell('Résumé – 東京'), /<span>Résumé – 東京<\/span>$/)
})

test('every task-selection DataTable provider uses the safe markup helper', () => {
  const source = readFileSync(new URL(
    '../ui/pages/track/components/taskSelectPopup.js', import.meta.url,
  ), 'utf8')
  assert.equal(source.match(/format: taskSelectionCell/g)?.length, 5)
  assert.doesNotMatch(source, /data-task="\$\{value\}"/)
  assert.doesNotMatch(source, /text\(element\.name\)\.html\(\)/)
})
