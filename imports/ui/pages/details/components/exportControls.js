import dayjs from 'dayjs'
import utc from 'dayjs/plugin/utc'
import { saveAs } from 'file-saver'
import Projects from '../../../../api/projects/projects.js'
import CustomFields from '../../../../api/customfields/customfields.js'
import { projectResources } from '../../../../api/users/users.js'
import { getGlobalSetting, getUserSetting, getUserTimeUnitVerbose } from '../../../../utils/frontend_helpers.js'
import { t } from '../../../../utils/i18n.js'
import { getTimecardDateOnly, getTimecardStartTime, getTimecardEndTime } from '../../../../utils/timecardDate.js'
import { exportSheetToXlsx } from '../../../../utils/excelExport.js'
import { encodeCsv } from '../../../../utils/csvExport.js'
import { createDetailsExportController } from '../../../../utils/detailsExportController.js'
import { buildDetailsExportRows } from '../../../../utils/detailsExportRows.js'
import { MAX_EXPORT_BYTES } from '../../../../utils/exportCollection.js'
import { periodToDates } from '../../../../utils/periodHelpers.js'
import './exportControls.html'

dayjs.extend(utc)

function callMethod(name, parameters) {
  return new Promise((resolve, reject) => {
    Meteor.call(name, parameters, (error, result) => { if (error) reject(error); else resolve(result) })
  })
}

function snapshotExportContext() {
  const dateFormat = getGlobalSetting('dateformat')
  const unit = getUserSetting('timeunit')
  const precision = getUserSetting('precision')
  const hoursToDays = getUserSetting('hoursToDays') || getGlobalSetting('hoursToDays')
  const options = {
    showResource: getGlobalSetting('showResourceInDetails'),
    showCustomer: getGlobalSetting('showCustomerInDetails'),
    showRate: getGlobalSetting('showRateInDetails'),
    useState: getGlobalSetting('useState'),
    useStartTime: getGlobalSetting('useStartTime'),
  }
  const labels = Object.fromEntries([
    ['project', 'globals.project'], ['date', 'globals.date'], ['task', 'globals.task'],
    ['resource', 'globals.resource'], ['customer', 'globals.customer'], ['state', 'details.state'],
    ['rate', 'project.rate'], ['startTime', 'details.startTime'], ['endTime', 'details.endTime'],
    ['breakStartTime', 'details.breakStartTime'], ['breakEndTime', 'details.breakEndTime'],
    ['totalTime', 'details.totalTime'], ['regularWorkingTime', 'details.regularWorkingTime'],
    ['regularWorkingTimeDifference', 'details.regularWorkingTimeDifference'],
  ].map(([name, key]) => [name, t(key)]))
  labels.unit = getUserTimeUnitVerbose() || t('globals.hour_plural')
  const custom = (classname) => (getGlobalSetting('showCustomFieldsInDetails')
    ? CustomFields.find({ classname }).fetch().map((field) => field.name) : [])
  return {
    labels, options,
    projects: new Map(Projects.find({}).fetch().map((project) => [project._id, structuredClone(project)])),
    resources: new Map(projectResources.find({}).fetch().map((resource) => [resource._id, structuredClone(resource)])),
    timeFields: custom('time_entry'), projectFields: custom('project'),
    states: Object.fromEntries(['new', 'exported', 'billed', 'notBillable'].map((state) => [state, t(`details.${state}`)])),
    formatDate: (date) => dayjs.utc(date).format(dateFormat),
    formatTimecardDate: (entry) => dayjs.utc(getTimecardDateOnly(entry), 'YYYY-MM-DD').format(dateFormat),
    startTime: getTimecardStartTime,
    endTime: getTimecardEndTime,
    convertHours(hours, rounded) {
      const converted = unit === 'd' ? hours / hoursToDays : unit === 'm' ? hours * 60 : hours
      return rounded ? Number(Number(converted).toFixed(precision)) : Number(converted)
    },
  }
}

function createExportForTemplate(templateInstance, view, currentRows) {
  return createDetailsExportController({
    ReactiveVar,
    request: templateInstance.request,
    canExport: () => templateInstance.request.ready() && currentRows().length > 0,
    snapshot() {
      const { limit, page, ...query } = templateInstance.exportQuery
      const resourceLabel = $('#resourceselect option:selected').text().replace(' ', '_').toLowerCase()
      const sheetNames = { detailed: 'titra export', daily: 'daily', total: 'total time', working: 'working time' }
      return {
        view,
        query: structuredClone(query),
        rows: structuredClone(currentRows()),
        context: snapshotExportContext(),
        sheetName: sheetNames[view],
        fileName: view === 'detailed'
          ? `titra_export_${dayjs().format('YYYYMMDD-HHmm')}_${resourceLabel}`
          : `titra_${view}_time_${query.period}`,
      }
    },
    fetchPage: (parameters) => callMethod('timecards.exportPage', parameters),
    async prepareQuery(snapshot) {
      if (!['all', 'custom'].includes(snapshot.query.period)) {
        snapshot.query.dates = await periodToDates(snapshot.query.period)
        snapshot.query.period = 'custom'
      }
      if (snapshot.view === 'working') delete snapshot.query.customer
    },
    buildRows: (snapshot, rows) => buildDetailsExportRows(snapshot.view, rows, snapshot.context),
    saveCsv(data, fileName) {
      const blob = new Blob([encodeCsv(data)], { type: 'text/csv;charset=utf-8;header=present' })
      if (blob.size > MAX_EXPORT_BYTES) throw Object.assign(new Error('export-too-large'), { code: 'export-too-large' })
      saveAs(blob, fileName)
    },
    saveXlsx: exportSheetToXlsx,
    markExported: (timecardIds) => callMethod('timecards.markExported', { timecardIds }),
  })
}

Template.exportControls.helpers({
  busy: () => Template.currentData().controller.busy.get(),
  canCancel: () => Template.currentData().controller.stage.get() !== 'marking',
  selected(scope) { return Template.instance().data.controller.scope.get() === scope },
  progress() {
    if (Template.currentData().controller.stage.get() === 'marking') return t('details.exportMarking')
    const value = Template.currentData().controller.progress.get()
    return value ? t('details.exportProgress', value) : t('details.exportPreparing')
  },
  error() {
    const code = Template.currentData().controller.error.get()
    if (!code) return false
    const keys = {
      'export-cancelled': 'exportCancelled', 'export-too-large': 'exportTooLarge',
      'export-page-too-large': 'exportPageTooLarge',
      'export-filter-not-visible': 'exportFilterNotVisible',
      'export-incomplete': 'exportChanged', 'export-changed': 'exportChanged',
      'export-timeout': 'exportTimeout', 'export-mark-failed': 'exportMarkFailed',
    }
    return t(`details.${keys[code] || 'exportFailed'}`)
  },
  completed() {
    const count = Template.currentData().controller.completed.get()
    return count !== undefined ? t('details.exportCompleted', { count }) : false
  },
})
Template.exportControls.events({
  'click .js-export-scope': (event, templateInstance) => {
    event.preventDefault()
    const { controller } = templateInstance.data
    const scope = event.currentTarget.dataset.scope
    if (!controller.busy.get() && ['current', 'all'].includes(scope)) {
      controller.scope.set(scope)
    }
  },
  'click .js-cancel-export': (event, templateInstance) => {
    event.preventDefault()
    templateInstance.data.controller.cancel()
  },
})

export { createExportForTemplate }
