import assert from 'node:assert/strict'
import test from 'node:test'
import { buildDetailsExportRows, exportedTimecardIds, validateDetailsExportEntries } from './detailsExportRows.js'

const context = () => ({
  labels: Object.fromEntries(['date', 'resource', 'project', 'task', 'customer', 'state', 'rate',
    'startTime', 'breakStartTime', 'breakEndTime', 'endTime', 'totalTime', 'regularWorkingTime',
    'regularWorkingTimeDifference', 'unit'].map((key) => [key, key])),
  options: { showResource: true, showCustomer: true, useState: true, useStartTime: true, showRate: true },
  projects: new Map([['p', { name: 'Project', customer: 'Customer', rate: 10, rates: { u: 20 }, projectField: 0 }]]),
  resources: new Map([['u', { name: 'User' }]]),
  timeFields: ['timeField'], projectFields: ['projectField'],
  states: { new: 'New', exported: 'Exported', billed: 'Billed', notBillable: 'Not billable' },
  formatDate: (date) => `date:${date}`,
  formatTimecardDate: (entry) => entry.dateOnly,
  startTime: (entry) => entry.startTime,
  endTime: () => '10:30',
  convertHours: (hours) => hours * 60,
})

test('Detailed rows preserve headers/custom fields/state/date/times/rates/units and literal zero/false values', () => {
  const entry = { _id: 'id', projectId: 'p', userId: 'u', task: '=literal task', hours: 1.5,
    dateOnly: '2026-09-22', startTime: '09:00', timeField: false, taskRate: 30 }
  const rows = buildDetailsExportRows('detailed', [entry], context())
  assert.deepEqual(rows[0], ['project', 'date', 'task', 'resource', 'timeField', 'projectField',
    'customer', 'state', 'startTime', 'endTime', 'unit', 'rate'])
  assert.deepEqual(rows[1], ['Project', '2026-09-22', '=literal task', 'User', false, 0,
    'Customer', 'New', '09:00', '10:30', 90, 30])
  assert.equal(entry.task, '=literal task')
})

test('Detailed columns remain aligned for every optional-column combination', () => {
  const keys = ['showResource', 'showCustomer', 'useState', 'useStartTime', 'showRate']
  for (let flags = 0; flags < 32; flags += 1) {
    const captured = context()
    captured.options = Object.fromEntries(keys.map((key, index) => [key, Boolean(flags & (1 << index))]))
    const [header, row] = buildDetailsExportRows('detailed', [{ _id: 'id', projectId: 'p', userId: 'u', task: 'Task', hours: 0, state: 'billed', dateOnly: '2026-09-22' }], captured)
    assert.equal(row.length, header.length)
    assert.equal(row[header.indexOf('unit')], 0)
    if (captured.options.useState) assert.equal(row[header.indexOf('state')], 'Billed')
    if (captured.options.showRate) assert.equal(row[header.indexOf('rate')], 20)
  }
})

test('Daily and Total raw aggregate rows use the same snapshotted metadata and units', () => {
  const entry = { _id: { date: '2026-09-22', projectId: 'p', userId: 'u' }, totalHours: 1.234 }
  assert.deepEqual(buildDetailsExportRows('daily', [entry], context()), [
    ['date', 'project', 'resource', 'unit'], ['date:2026-09-22', 'Project', 'User', 74.03999999999999],
  ])
  assert.deepEqual(buildDetailsExportRows('total', [entry], context()), [
    ['project', 'resource', 'unit'], ['Project', 'User', 74.03999999999999],
  ])
  const noResource = context(); noResource.options.showResource = false
  assert.deepEqual(buildDetailsExportRows('total', [entry], noResource)[0], ['project', 'unit'])
})

test('Working rows preserve zero and negative totals without converting server-calculated units twice', () => {
  const entry = { date: '2026-09-22', resource: 'User', startTime: '09:00', breakStartTime: '',
    breakEndTime: '', endTime: '10:00', totalTime: 0, regularWorkingTime: 8, regularWorkingTimeDifference: -8 }
  const [header, row] = buildDetailsExportRows('working', [entry], context())
  assert.equal(header.length, 9)
  assert.deepEqual(row, ['date:2026-09-22', 'User', '09:00', '', '', '10:00', 0, 8, -8])
})

test('Only exact exported missing/new IDs are eligible for marking, deduplicated', () => {
  assert.deepEqual(exportedTimecardIds([
    { _id: '1' }, { _id: '2', state: 'new' }, { _id: '3', state: 'billed' },
    { _id: '4', state: 'notBillable' }, { _id: '5', state: 'exported' }, { _id: '1' },
  ]), ['1', '2'])
})

test('all views reject missing required IDs/dates/totals before serialization, never defaulting an absent date to today', () => {
  const valid = {
    detailed: { _id: 'id', projectId: 'p', userId: 'u', task: '', hours: 0, dateOnly: '2026-09-22' },
    daily: { _id: { projectId: 'p', userId: 'u', date: new Date('2026-09-22') }, totalHours: 0 },
    total: { _id: { projectId: 'p', userId: 'u' }, totalHours: 0 },
    working: { date: new Date('2026-09-22'), totalTime: 0, regularWorkingTime: 0, regularWorkingTimeDifference: -1 },
  }
  const invalid = {
    detailed: [undefined, { ...valid.detailed, _id: undefined }, { ...valid.detailed, projectId: '' },
      { ...valid.detailed, userId: [] }, { ...valid.detailed, task: {} }, { ...valid.detailed, hours: '1' },
      { ...valid.detailed, dateOnly: undefined }, { ...valid.detailed, dateOnly: '2026-02-30' }],
    daily: [{ ...valid.daily, _id: {} }, { ...valid.daily, _id: { projectId: 'p', userId: 'u' } },
      { ...valid.daily, totalHours: Infinity }],
    total: [{ ...valid.total, _id: { userId: 'u' } }, { ...valid.total, totalHours: undefined }],
    working: [{ ...valid.working, date: undefined }, { ...valid.working, date: new Date(NaN) },
      { ...valid.working, totalTime: undefined }, { ...valid.working, regularWorkingTime: NaN },
      { ...valid.working, regularWorkingTimeDifference: '0' }],
  }
  for (const view of Object.keys(valid)) {
    assert.doesNotThrow(() => validateDetailsExportEntries(view, [valid[view]]))
    for (const entry of invalid[view]) {
      assert.throws(() => buildDetailsExportRows(view, [entry], context()), { code: 'export-incomplete' })
    }
  }
  assert.doesNotThrow(() => validateDetailsExportEntries('detailed', [{ ...valid.detailed, dateOnly: undefined, date: new Date('2026-09-22') }]))
})
