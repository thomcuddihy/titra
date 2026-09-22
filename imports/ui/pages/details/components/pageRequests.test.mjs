import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import { normalizePageParameter } from '../../../../utils/pageParameter.js'
import { normalizeLimitParameter } from '../../../../utils/limitParameter.js'
import { createDetailsRequestState } from '../../../../utils/detailsRequestState.js'
import { normalizeDetailedPagination } from '../../../../utils/detailedTimeQuery.js'
import { normalizeBoundedPagination } from '../../../../utils/resourceLimits.js'

class ReactiveVar {
  constructor(value) { this.value = value }
  get() { return this.value }
  set(value) { this.value = value }
}

const views = [
  ['detailtimetable', 'totalDetailTimeEntries', 3],
  ['dailytimetable', 'totalEntries', 1],
  ['periodtimetable', 'totalPeriodTimeCards', 1],
  ['workingtimetable', 'totalWorkingTimeEntries', 1],
]

function createHarness(view, totalName, page, { limit = 25, deferSelectors = false } = {}) {
  const source = readFileSync(new URL(`./${view}.js`, import.meta.url), 'utf8')
  assert.match(source, /import \{ normalizePageParameter \} from '\.\.\/\.\.\/\.\.\/\.\.\/utils\/pageParameter.js'/)
  const executable = source
    .replace(/^import\s+[\s\S]*?\s+from\s+['"][^'"]+['"]\s*;?\r?\n/gm, '')
    .replace(/^import\s+['"][^'"]+['"]\s*;?\r?\n/gm, '')
  let created
  let destroyed
  let events
  const requests = []
  const replies = []
  const selectorReplies = []
  const subscriptions = []
  const autoruns = []
  const instance = {
    data: Object.fromEntries(Object.entries({
      project: 'all', resource: 'all', customer: 'all', period: 'currentMonth', limit,
    }).map(([key, value]) => [key, new ReactiveVar(value)])),
    autorun(callback) { autoruns.push(callback) },
    subscribe(name, parameters, callbacks) {
      if (name.startsWith('getDetailedTimeEntries')) capture(name, parameters)
      subscriptions.push({ name, callbacks })
      return { ready: () => true }
    },
  }
  function capture(name, parameters) {
    assert.equal(instance[totalName].get(), undefined,
      'Old query totals must be cleared before the new request is dispatched')
    const pagination = view === 'detailtimetable'
      ? normalizeDetailedPagination(parameters.limit, parameters.page)
      : normalizeBoundedPagination(parameters.limit, parameters.page)
    requests.push({ name, page: parameters.page, limit: parameters.limit, skip: pagination.skip })
  }
  const day = { startOf() { return this }, toDate: () => new Date('2026-09-01T00:00:00Z') }
  const context = {
    Date,
    ReactiveVar,
    normalizePageParameter,
    normalizeLimitParameter,
    createDetailsRequestState,
    createExportForTemplate: () => ({ run: () => false, dispose() {} }),
    console: { error() {} },
    FlowRouter: { getQueryParam: () => page, setQueryParams() {} },
    Mongo: { Collection: class {} },
    dayjs: { extend() {}, utc: () => day },
    utc: {},
    customParseFormat: {},
    getUserSetting: () => undefined,
    Meteor: { call(name, parameters, callback) {
      if (typeof parameters === 'object') {
        capture(name, parameters)
        replies.push(callback)
      }
    } },
    buildDetailedTimeEntriesForPeriodSelectorAsync: async (parameters) => {
      capture('local-selector', parameters)
      if (deferSelectors) return new Promise((resolve, reject) => selectorReplies.push({ resolve, reject }))
      return [{}, normalizeDetailedPagination(parameters.limit, parameters.page)]
    },
    Template: { instance: () => instance, [view]: {
      onCreated(callback) { created = callback },
      onRendered() {}, helpers() {}, events(value) { events = value }, onDestroyed(callback) { destroyed = callback },
    } },
  }
  vm.runInNewContext(executable, context, { filename: `${view}.js` })
  created.call(instance)
  return { instance, requests, replies, selectorReplies, subscriptions,
    destroy() { destroyed() },
    async click(selector) {
      let prevented = false
      await events[`click ${selector}`]({ preventDefault() { prevented = true } }, instance)
      assert.equal(prevented, true)
    },
    async run() {
    for (const callback of autoruns) await callback()
  } }
}

for (const [view, totalName, expectedRequests] of views) {
  test(`${view} mounts the pager even when an out-of-range page returns no rows`, () => {
    const html = readFileSync(new URL(`./${view}.html`, import.meta.url), 'utf8')
    const pager = html.indexOf('{{>pagination ')
    assert.ok(pager >= 0)
    const blocks = []
    for (const token of html.slice(0, pager).matchAll(/\{\{([#/])([\w]+)[^}]*\}\}/g)) {
      if (token[1] === '#') blocks.push(token[2])
      else assert.equal(blocks.pop(), token[2])
    }
    assert.deepEqual(blocks, [], 'Pager lifecycle must not depend on the current rows being nonempty')
  })
  test(`${view} sends numeric, bounded pages from its real creation autoruns`, async () => {
    for (const raw of [undefined, null, '', 'bad', 'NaN', '-2', '2.5', '10001', '1', '2', '10', '10000']) {
      const harness = createHarness(view, totalName, raw)
      // Simulate a previous query's count to catch loading-state regressions.
      harness.instance[totalName].set(500)
      await harness.run()
      assert.equal(harness.requests.length, expectedRequests)
      for (const request of harness.requests) {
        assert.equal(request.page, normalizePageParameter(raw))
        assert.equal(request.skip, (normalizePageParameter(raw) - 1) * 25)
      }
    }
  })
  test(`${view} normalizes legacy and invalid limits without relaxing the server`, async () => {
    for (const limit of ['-1', -1, 'garbage', '501', '10', '37', '500', 500]) {
      const harness = createHarness(view, totalName, '2', { limit })
      await harness.run()
      for (const request of harness.requests) {
        assert.equal(request.limit, normalizeLimitParameter(limit))
        assert.equal(request.skip, normalizeLimitParameter(limit))
      }
    }
  })
  test(`${view} blocks export and outbound handlers while pending or failed`, async () => {
    const harness = createHarness(view, totalName, '2')
    await harness.run()
    for (const phase of ['loading', 'error']) {
      harness.instance.request.phase.set(phase)
      await harness.click('.js-export-csv')
      await harness.click('.js-export-xlsx')
      if (view !== 'workingtimetable') await harness.click('.js-outbound-interface')
    }
  })
  if (view !== 'detailtimetable') {
    test(`${view} ignores late replies from a superseded page/filter request`, async () => {
      const harness = createHarness(view, totalName, '2')
      await harness.run()
      await harness.run()
      const result = (totalEntries) => ({
        dailyHours: [], totalHours: [], workingHours: [], totalEntries,
      })
      harness.replies[0](undefined, result(500))
      assert.equal(harness.instance[totalName].get(), undefined)
      harness.replies[1](undefined, result(25))
      assert.equal(harness.instance[totalName].get(), 25)
      harness.replies[0](undefined, result(500))
      assert.equal(harness.instance[totalName].get(), 25)
    })
    test(`${view} clears rows on new request/error and prevents failed or destroyed replies reviving them`, async () => {
      const harness = createHarness(view, totalName, '2')
      const rowsName = ({ dailytimetable: 'dailyTimecards', periodtimetable: 'periodTimecards', workingtimetable: 'workingTimeEntries' })[view]
      const result = { dailyHours: [{ _id: { date: 1 } }], totalHours: [{}], workingHours: [{ date: 1 }], totalEntries: 1 }
      await harness.run()
      harness.replies[0](undefined, result)
      assert.equal(harness.instance.request.ready(), true)
      assert.equal(harness.instance[rowsName].get().length, 1)
      await harness.run()
      assert.equal(harness.instance[rowsName].get(), undefined)
      assert.equal(harness.instance.request.ready(), false)
      harness.replies[1](new Error('query failed'))
      assert.equal(harness.instance.request.phase.get(), 'error')
      assert.equal(harness.instance[rowsName].get(), undefined)
      assert.equal(harness.instance[totalName].get(), undefined)
      harness.replies[1](undefined, result)
      assert.equal(harness.instance.request.phase.get(), 'error')
      await harness.run()
      harness.destroy()
      harness.replies[2](undefined, result)
      assert.equal(harness.instance[rowsName].get(), undefined)
      assert.equal(harness.instance.request.ready(), false)
    })
  }
}

test('Detailed selector results cannot overwrite a newer filter, a failed subscription, or destroyed view', async () => {
  const harness = createHarness('detailtimetable', 'totalDetailTimeEntries', '2', { deferSelectors: true })
  await harness.run()
  await harness.run()
  harness.selectorReplies[1].resolve([{ task: 'current' }, { skip: 25 }])
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(harness.instance.selector.get()[0].task, 'current')
  assert.equal(harness.instance.selector.get()[1].skip, undefined)
  harness.selectorReplies[0].resolve([{ task: 'old' }, {}])
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(harness.instance.selector.get()[0].task, 'current')
  await harness.run()
  harness.subscriptions.at(-1).callbacks.onStop(new Error('subscription failed'))
  harness.selectorReplies[2].resolve([{ task: 'failed' }, {}])
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(harness.instance.request.phase.get(), 'error')
  assert.equal(harness.instance.selector.get(), undefined)
  await harness.run()
  harness.selectorReplies[3].reject(new Error('selector failed'))
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(harness.instance.request.phase.get(), 'error')
  await harness.run()
  harness.destroy()
  harness.selectorReplies[4].resolve([{ task: 'destroyed' }, {}])
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(harness.instance.selector.get(), undefined)
})
