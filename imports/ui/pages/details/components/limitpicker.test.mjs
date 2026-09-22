import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import { LIMIT_OPTIONS, normalizeLimitParameter, limitParameterCorrection } from '../../../../utils/limitParameter.js'

class ReactiveVar {
  constructor(value) { this.value = value }
  get() { return this.value }
  set(value) { this.value = value }
}
const stripImports = (source) => source.replace(/^import .*\r?\n/gm, '')

test('real picker tracks custom sizes and Back/default routes, and resets page on selection', () => {
  let pageLimit = '37'
  let created; let helpers; let events
  const autoruns = []; const writes = []
  const instance = { autorun(callback) { autoruns.push(callback); callback() } }
  vm.runInNewContext(stripImports(readFileSync(new URL('./limitpicker.js', import.meta.url), 'utf8')), {
    ReactiveVar, LIMIT_OPTIONS, normalizeLimitParameter,
    FlowRouter: { getQueryParam: () => pageLimit, setQueryParams: (params) => writes.push(params) },
    Template: { instance: () => instance, limitpicker: {
      onCreated(callback) { created = callback }, helpers(value) { helpers = value }, events(value) { events = value },
    } },
    $: (target) => ({ val: () => target.value }),
  })
  created.call(instance)
  assert.equal(instance.limit.get(), 37)
  assert.equal(helpers.selected(37), true)
  assert.deepEqual(Array.from(helpers.limits()), [10, 25, 37, 50, 100, 200, 500])
  pageLimit = undefined
  autoruns.forEach((callback) => callback())
  assert.equal(instance.limit.get(), 25)
  assert.equal(helpers.selected(37), false)
  events['change #limitpicker']({ currentTarget: { value: '500' } }, instance)
  assert.equal(writes[0].limit, 500)
  assert.equal(writes[0].page, null)
})

test('Details route normalizes limits before table children receive them', () => {
  const source = stripImports(readFileSync(new URL('../details.js', import.meta.url), 'utf8'))
  for (const raw of [undefined, '-1', 'garbage', '501', '37']) {
    let created; let rendered
    const writes = []; const runs = []
    const instance = { autorun(callback) { runs.push(callback) } }
    vm.runInNewContext(source, {
      ReactiveVar, normalizeLimitParameter, limitParameterCorrection,
      window: {},
      FlowRouter: { getParam: () => 'all', getQueryParam: (name) => (name === 'limit' ? raw : undefined), setQueryParams: (params) => writes.push(params) },
      Template: { instance: () => instance, timecardlist: {
        onCreated(callback) { created = callback }, onRendered(callback) { rendered = callback }, helpers() {}, events() {},
      } },
    })
    created.call(instance)
    rendered()
    runs.forEach((callback) => callback())
    assert.equal(instance.limit.get(), normalizeLimitParameter(raw))
    assert.deepEqual(JSON.parse(JSON.stringify(writes)), limitParameterCorrection(raw) ? [limitParameterCorrection(raw)] : [])
  }
})
