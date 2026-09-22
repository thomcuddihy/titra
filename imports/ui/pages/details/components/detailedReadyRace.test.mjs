import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import { createDetailsRequestState } from '../../../../utils/detailsRequestState.js'
import { normalizePageParameter } from '../../../../utils/pageParameter.js'
import { normalizeLimitParameter } from '../../../../utils/limitParameter.js'

// Model Tracker's dependency invalidation (including short-circuit reads), not
// unconditional manual reruns: the bug only appears when a plain subscription
// handle is replaced while phase and selector are already loading/undefined.
function reactiveHarness() {
  let active
  const pending = new Set()
  class ReactiveVar {
    constructor(value) { this.value = value; this.dependents = new Set() }
    get() {
      if (active) { this.dependents.add(active); active.dependencies.add(this) }
      return this.value
    }
    set(value) {
      if (Object.is(this.value, value)) return
      this.value = value
      this.dependents.forEach((computation) => pending.add(computation))
    }
  }
  function run(computation) {
    computation.dependencies.forEach((dependency) => dependency.dependents.delete(computation))
    computation.dependencies.clear()
    active = computation
    try { computation.callback() } finally { active = undefined }
  }
  return {
    ReactiveVar,
    autorun(callback) { run({ callback, dependencies: new Set() }) },
    flush() {
      let iterations = 0
      while (pending.size) {
        assert.ok(iterations++ < 100, 'Reactive computations must settle')
        const batch = [...pending]; pending.clear()
        batch.forEach(run)
      }
    },
  }
}

test('Detailed view follows the newest unready subscription after rapid filter and limit changes', async () => {
  const { ReactiveVar, autorun, flush } = reactiveHarness()
  let created; let rendered
  const selectors = []; const subscriptions = []; const tables = []
  const instance = {
    data: Object.fromEntries(Object.entries({ project: 'all', resource: 'all', customer: 'all', period: 'all', limit: 500 })
      .map(([key, value]) => [key, new ReactiveVar(value)])),
    autorun,
    subscribe(name) {
      const ready = new ReactiveVar(!name.startsWith('getDetailed'))
      const handle = { ready: () => ready.get() }
      subscriptions.push({ name, ready, handle })
      return handle
    },
    $: () => ({ remove() {} }),
  }
  const source = readFileSync(new URL('./detailtimetable.js', import.meta.url), 'utf8')
    .replace(/^import\s+[\s\S]*?\s+from\s+['"][^'"]+['"]\s*;?\r?\n/gm, '')
    .replace(/^import\s+['"][^'"]+['"]\s*;?\r?\n/gm, '')
  vm.runInNewContext(source, {
    ReactiveVar, createDetailsRequestState, normalizePageParameter, normalizeLimitParameter,
    createExportForTemplate: () => ({ run: () => false, dispose() {} }),
    FlowRouter: { getQueryParam: () => undefined },
    Template: { instance: () => instance, detailtimetable: {
      onCreated(callback) { created = callback }, onRendered(callback) { rendered = callback }, helpers() {}, events() {}, onDestroyed() {},
    } },
    Mongo: { Collection: class { findOne() { return { count: 0 } } } },
    Timecards: { find: () => ({ fetch: () => [] }) },
    Meteor: { call() {} },
    dayjs: { extend() {} }, utc: {}, customParseFormat: {},
    i18nReady: new ReactiveVar(true),
    getGlobalSetting: () => false,
    t: (key) => key,
    getUserTimeUnitVerbose: () => 'Hours',
    addToolTipToTableCell() {}, numberWithUserPrecision() {},
    secureDataTableColumns: (columns) => columns,
    tableRendererForTemplate: () => ({ render(config) { tables.push(config.data); instance.request.rendered.set(true) } }),
    buildDetailedTimeEntriesForPeriodSelectorAsync: () => new Promise((resolve) => selectors.push(resolve)),
  })
  created.call(instance)
  rendered()
  assert.equal(instance.request.phase.get(), 'loading')
  instance.data.period.set('currentMonth')
  flush()
  instance.data.limit.set(25)
  flush()
  assert.equal(selectors.length, 3)
  // Only the latest request becomes ready; superseded handles stay unready.
  selectors[2]([{}, { limit: 25 }])
  await new Promise((resolve) => setImmediate(resolve))
  subscriptions.slice(-2).forEach(({ ready }) => ready.set(true))
  flush()
  assert.equal(instance.request.phase.get(), 'ready')
  assert.equal(instance.request.rendered.get(), true)
  assert.equal(instance.totalDetailTimeEntries.get(), 0)
  assert.ok(tables.length > 0)
  assert.ok(tables.every((data) => data.length === 0))
  selectors[0]([{ obsolete: true }, {}])
  selectors[1]([{ obsolete: true }, {}])
  await new Promise((resolve) => setImmediate(resolve))
  flush()
  assert.equal(instance.selector.get()[0].obsolete, undefined)
})
