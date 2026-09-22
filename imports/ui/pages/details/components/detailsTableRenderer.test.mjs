import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { createDetailsRequestState } from '../../../../utils/detailsRequestState.js'
import { createDetailsTableRenderer } from './detailsTableRenderer.js'

class ReactiveVar {
  constructor(value) { this.value = value }
  get() { return this.value }
  set(value) { this.value = value }
}
function harness() {
  const rows = new ReactiveVar(); const total = new ReactiveVar()
  const request = createDetailsRequestState({ ReactiveVar, rows, total })
  let table; let resolve; let reject; let loads = 0; let dimensions = 0; let destroys = 0
  const renders = []; const frames = []; const errors = []
  const scrollable = { style: {} }
  const container = { querySelector: (selector) => (selector === '.dt-scrollable' ? scrollable : { style: { top: '100' } }) }
  class Table {
    constructor(element, config) { assert.equal(element, container); renders.push(config.data) }
    refresh(data) { renders.push(data) }
    setDimensions() { dimensions += 1 }
    destroy() { destroys += 1 }
  }
  const renderer = createDetailsTableRenderer({
    request, container: () => container, getTable: () => table, setTable: (value) => { table = value },
    load: () => { loads += 1; return new Promise((yes, no) => { resolve = yes; reject = no }) },
    schedule: (callback) => frames.push(callback), onError: (error) => errors.push(error),
  })
  const ready = (data = ['row']) => {
    const id = request.begin()
    request.complete(id, () => { rows.set(data); total.set(data.length) })
    return id
  }
  ready()
  return {
    request, renderer, ready, renders, frames, errors, scrollable,
    resolve: () => resolve(Table), reject: () => reject(new Error('load failed')),
    render: (data) => renderer.render({ data, columns: [{ width: 1 }, { width: 2 }] }),
    counts: () => ({ loads, dimensions, destroys }),
  }
}

test('one pending library load renders only the latest configuration', async () => {
  const h = harness()
  const first = h.render(['old']); const second = h.render(['new'])
  h.resolve()
  await Promise.all([first, second])
  assert.deepEqual(h.renders, [['new']])
  assert.equal(h.counts().loads, 1)
  assert.equal(h.request.rendered.get(), true)
  h.frames.forEach((callback) => callback())
  assert.equal(h.counts().dimensions, 1)
})

test('superseded request and destroyed view cannot construct or resize a replacement table', async () => {
  for (const destroy of [false, true]) {
    const h = harness()
    const pending = h.render(['old'])
    if (destroy) { h.request.dispose(); h.renderer.destroy() } else h.ready(['new'])
    h.resolve()
    await pending
    assert.deepEqual(h.renders, [])
    assert.equal(h.frames.length, 0)
  }
})

test('empty refresh clears old rows and old animation frames cannot resize newer results', async () => {
  const h = harness()
  const first = h.render(['old'])
  h.resolve(); await first
  h.ready([])
  await h.render([])
  h.frames.forEach((callback) => callback())
  assert.deepEqual(h.renders, [['old'], []])
  assert.equal(h.counts().dimensions, 1)
  assert.equal(h.scrollable.style.height, 'auto')
  h.request.dispose(); h.renderer.destroy()
  h.frames.forEach((callback) => callback())
  assert.equal(h.counts().dimensions, 1)
  assert.equal(h.counts().destroys, 1)
})

test('load errors affect only their current request and allow an explicit retry', async () => {
  const h = harness()
  const obsolete = h.render(['obsolete'])
  h.ready(['new'])
  h.reject(); await obsolete
  assert.equal(h.request.phase.get(), 'ready')
  assert.equal(h.errors.length, 0)
  const current = h.render(['current'])
  h.reject(); await current
  assert.equal(h.request.phase.get(), 'error')
  assert.equal(h.request.hasRows(), false)
  assert.equal(h.errors.length, 1)
  h.ready(['retry'])
  const retry = h.render(['retry'])
  h.resolve(); await retry
  assert.deepEqual(h.renders, [['retry']])
  assert.equal(h.request.rendered.get(), true)
})

test('all Details templates preserve layout while excluding stale content from interaction/accessibility', () => {
  for (const name of ['detailtimetable', 'dailytimetable', 'periodtimetable', 'workingtimetable']) {
    const html = readFileSync(new URL(`./${name}.html`, import.meta.url), 'utf8')
    const container = html.match(/<div id="datatable-container"[^>]+>/)[0]
    assert.match(container, /invisible/)
    assert.match(container, /aria-hidden="\{\{tableHidden\}\}"/)
    assert.match(container, /inert="\{\{tableInert\}\}"/)
    assert.doesNotMatch(container, /\shidden=/)
    assert.match(html, /tableRequestFeedback request=request/)
  }
})
