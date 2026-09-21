import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import { normalizePageParameter } from '../../../../utils/pageParameter.js'
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

function createHarness(view, totalName, page) {
  const source = readFileSync(new URL(`./${view}.js`, import.meta.url), 'utf8')
  assert.match(source, /import \{ normalizePageParameter \} from '\.\.\/\.\.\/\.\.\/\.\.\/utils\/pageParameter.js'/)
  const executable = source
    .replace(/^import\s+[\s\S]*?\s+from\s+['"][^'"]+['"]\s*;?\r?\n/gm, '')
    .replace(/^import\s+['"][^'"]+['"]\s*;?\r?\n/gm, '')
  let created
  const requests = []
  const replies = []
  const autoruns = []
  const instance = {
    data: Object.fromEntries(Object.entries({
      project: 'all', resource: 'all', customer: 'all', period: 'currentMonth', limit: 25,
    }).map(([key, value]) => [key, new ReactiveVar(value)])),
    autorun(callback) { autoruns.push(callback) },
    subscribe(name, parameters) {
      if (name.startsWith('getDetailedTimeEntries')) capture(name, parameters)
      return { ready: () => true }
    },
  }
  function capture(name, parameters) {
    assert.equal(instance[totalName].get(), undefined,
      'Old query totals must be cleared before the new request is dispatched')
    const pagination = view === 'detailtimetable'
      ? normalizeDetailedPagination(parameters.limit, parameters.page)
      : normalizeBoundedPagination(parameters.limit, parameters.page)
    requests.push({ name, page: parameters.page, skip: pagination.skip })
  }
  const day = { startOf() { return this }, toDate: () => new Date('2026-09-01T00:00:00Z') }
  const context = {
    Date,
    ReactiveVar,
    normalizePageParameter,
    FlowRouter: { getQueryParam: () => page },
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
      return [{}, normalizeDetailedPagination(parameters.limit, parameters.page)]
    },
    Template: { [view]: {
      onCreated(callback) { created = callback },
      onRendered() {}, helpers() {}, events() {}, onDestroyed() {},
    } },
  }
  vm.runInNewContext(executable, context, { filename: `${view}.js` })
  created.call(instance)
  return { instance, requests, replies, async run() {
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
  }
}
