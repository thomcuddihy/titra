import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import { createDetailsExportController } from '../../../../utils/detailsExportController.js'
import { buildDetailsExportRows } from '../../../../utils/detailsExportRows.js'
import { encodeCsv } from '../../../../utils/csvExport.js'
import { MAX_EXPORT_BYTES } from '../../../../utils/exportCollection.js'

class ReactiveVar {
  constructor(value) { this.value = value }
  get() { return this.value }
  set(value) { this.value = value }
}

function harness(view = 'detailed') {
  const source = readFileSync(new URL('./exportControls.js', import.meta.url), 'utf8')
    .replace(/^import\s+[\s\S]*?\s+from\s+['"][^'"]+['"]\s*;?\r?\n/gm, '')
    .replace(/^import\s+['"][^'"]+['"]\s*;?\r?\n/gm, '')
    .replace(/^export .+$/gm, '')
  const project = { _id: 'p', name: 'Original project', customer: 'Customer', rate: 20, extra: false }
  const resource = { _id: 'u', name: 'Original resource' }
  const settings = { dateformat: 'FORMAT', showResourceInDetails: true, showCustomFieldsInDetails: true,
    showCustomerInDetails: true, useState: true, useStartTime: true, showRateInDetails: true }
  const user = { timeunit: 'h', precision: 3, hoursToDays: 8 }
  const entry = { _id: 'current', projectId: 'p', userId: 'u', task: 'Original task', hours: 1.234,
    dateOnly: '2026-09-22', startTime: '09:00', custom: 0 }
  const rows = [entry]
  const requests = []; const writes = []; const marked = []; const periods = []
  let helpers; let events; let controller; let pageReply
  const dayjs = () => ({ format: () => '20260922-1010' })
  dayjs.extend = () => {}
  dayjs.utc = (value) => ({ format: (format) => `${format}:${value}` })
  const context = {
    ReactiveVar, createDetailsExportController, buildDetailsExportRows, encodeCsv, MAX_EXPORT_BYTES,
    structuredClone, Map, Blob, Date, dayjs, utc: {},
    getGlobalSetting: (key) => settings[key], getUserSetting: (key) => user[key],
    getUserTimeUnitVerbose: () => `unit:${user.timeunit}`,
    Projects: { find: () => ({ fetch: () => [project] }) },
    projectResources: { find: () => ({ fetch: () => [resource] }) },
    CustomFields: { find: ({ classname }) => ({ fetch: () => [{ name: classname === 'time_entry' ? 'custom' : 'extra' }] }) },
    getTimecardDateOnly: (row) => row.dateOnly,
    getTimecardStartTime: (row) => row.startTime,
    getTimecardEndTime: () => '10:14',
    t: (key, variables = {}) => `${key}${Object.keys(variables).length ? JSON.stringify(variables) : ''}`,
    $: () => ({ text: () => 'All resources' }),
    periodToDates: async (period) => { periods.push(period); return { startDate: new Date('2026-09-01'), endDate: new Date('2026-09-22') } },
    Meteor: { call(name, parameters, callback) {
      if (name === 'timecards.exportPage') { requests.push(parameters); pageReply = callback }
      else { assert.equal(name, 'timecards.markExported'); marked.push(parameters.timecardIds); callback(null, { updated: parameters.timecardIds.length, skipped: 0 }) }
    } },
    saveAs: (blob, fileName) => writes.push({ blob, fileName }),
    exportSheetToXlsx: async (data, sheetName, fileName, { beforeSave }) => { beforeSave(); writes.push({ data, sheetName, fileName }) },
    Template: { currentData: () => ({ controller }), instance: () => ({ data: { controller } }), exportControls: {
      helpers(value) { helpers = value }, events(value) { events = value },
    } },
  }
  vm.createContext(context)
  vm.runInContext(source, context)
  const template = {
    request: { generation: () => 1, ready: () => true, current: () => true },
    exportQuery: { projectId: 'p', userId: 'u', customer: 'all', period: 'currentMonth', limit: 25, page: 7 },
  }
  controller = context.createExportForTemplate(template, view, () => rows)
  return {
    controller, template, project, resource, user, settings, entry, writes, requests, marked, periods,
    helpers,
    reply: () => pageReply(null, { rows: [structuredClone(entry)], keys: [entry._id], totalEntries: 1, page: 1 }),
    choose(scope) { events['click .js-export-scope']({ preventDefault() {}, currentTarget: { dataset: { scope } } }, { data: { controller } }) },
  }
}

test('export scope controls are accessible buttons, default current, and cannot switch while busy', () => {
  const f = harness()
  assert.equal(f.helpers.selected('current'), true)
  f.choose('all')
  assert.equal(f.helpers.selected('all'), true)
  f.controller.busy.set(true)
  f.choose('current')
  assert.equal(f.controller.scope.get(), 'all')
  f.controller.busy.set(false)
  f.choose('invalid')
  assert.equal(f.controller.scope.get(), 'all')
  const html = readFileSync(new URL('./exportControls.html', import.meta.url), 'utf8')
  assert.match(html, /role="group"/)
  assert.match(html, /data-scope="current" aria-pressed=/)
  assert.match(html, /data-scope="all" aria-pressed=/)
  assert.doesNotMatch(html, /btn-outline-secondary|text-body-secondary/)
  assert.equal((html.match(/\{\{else\}\}btn-secondary/g) || []).length, 2)
  assert.match(html, /class="btn btn-secondary btn-sm ms-2 js-cancel-export"/)
  assert.match(html, /class="small">\{\{t "details.exportLimits"\}\}/)
})

test('browser adapter freezes labels/metadata/settings/period before paged fetch without changing displayed query', async () => {
  const f = harness()
  f.choose('all')
  const pending = f.controller.run('xlsx')
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(f.periods, ['currentMonth'])
  assert.equal(f.requests[0].query.period, 'custom')
  assert.equal(f.requests[0].query.limit, undefined)
  assert.equal(f.requests[0].query.page, undefined)
  f.project.name = 'CHANGED project'; f.resource.name = 'CHANGED resource'
  f.settings.dateformat = 'CHANGED'; f.user.timeunit = 'm'
  f.reply()
  assert.equal(await pending, true)
  const [header, row] = f.writes[0].data
  assert.equal(row[0], 'Original project')
  assert.equal(row[1], 'FORMAT:2026-09-22')
  assert.equal(row[3], 'Original resource')
  assert.equal(row[header.indexOf('unit:h')], 1.234)
  assert.equal(f.writes[0].fileName, 'titra_export_20260922-1010_all_resources_all.xlsx')
  assert.equal(f.writes[0].sheetName, 'titra export')
  assert.equal(f.template.exportQuery.page, 7)
  assert.equal(f.template.exportQuery.limit, 25)
  assert.equal(f.template.exportQuery.period, 'currentMonth')
  assert.deepEqual(f.marked, [['current']])
})

test('current Detailed CSV preserves existing filename and marks only the exact downloaded rows', async () => {
  const f = harness()
  assert.equal(await f.controller.run('csv'), true)
  assert.equal(f.requests.length, 0)
  assert.equal(f.writes[0].fileName, 'titra_export_20260922-1010_all_resources.csv')
  assert.match(await f.writes[0].blob.text(), /Original project/)
  assert.deepEqual(f.marked, [['current']])
})
