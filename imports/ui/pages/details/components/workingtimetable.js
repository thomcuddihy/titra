import dayjs from 'dayjs'
import utc from 'dayjs/plugin/utc'
import { FlowRouter } from 'meteor/ostrio:flow-router-extra'
import { normalizePageParameter } from '../../../../utils/pageParameter.js'
import { tableRendererForTemplate } from './detailsTableRenderer.js'
import { normalizeLimitParameter } from '../../../../utils/limitParameter.js'
import { createDetailsRequestState } from '../../../../utils/detailsRequestState.js'
import { i18nReady, t } from '../../../../utils/i18n.js'
import {
  addToolTipToTableCell,
  getGlobalSetting,
  numberWithUserPrecision,
  getUserSetting,
} from '../../../../utils/frontend_helpers'
import './workingtimetable.html'
import './pagination.js'
import './limitpicker.js'
import './tableRequestFeedback.js'
import { createExportForTemplate } from './exportControls.js'
import { secureDataTableColumns } from '../../../../utils/dataTableSecurity.js'

Template.workingtimetable.onCreated(function workingtimetableCreated() {
  dayjs.extend(utc)
  this.workingTimeEntries = new ReactiveVar()
  this.totalWorkingTimeEntries = new ReactiveVar()
  this.request = createDetailsRequestState({
    ReactiveVar, rows: this.workingTimeEntries, total: this.totalWorkingTimeEntries,
    dependenciesReady: () => this.projectUsersHandle?.ready(),
  })
  this.exportController = createExportForTemplate(this, 'working', () => this.workingTimeEntries.get() || [])
  this.autorun(() => {
    this.request.retry.get()
    if (this.data?.project.get()
      && this.data?.resource.get()
      && this.data?.period.get()
      && this.data?.limit.get()) {
      const requestSequence = this.request.begin()
      this.subscribe('userRoles')
      this.projectUsersHandle = this.subscribe('projectResources', { projectId: this.data?.project.get() }, {
        onStop: (error) => {
          if (error && this.request.fail(requestSequence)) console.error(error)
        },
      })
      const methodParameters = {
        projectId: this.data?.project.get(),
        userId: this.data?.resource.get(),
        period: this.data?.period.get(),
        limit: normalizeLimitParameter(this.data?.limit.get()),
        page: normalizePageParameter(FlowRouter.getQueryParam('page')),
      }
      if (this.data?.period.get() === 'custom') {
        methodParameters.dates = {
          startDate: getUserSetting('customStartDate') ? getUserSetting('customStartDate') : dayjs.utc().startOf('month').toDate(),
          endDate: getUserSetting('customEndDate') ? getUserSetting('customEndDate') : dayjs.utc().toDate(),
        }
      }
      this.exportQuery = methodParameters
      Meteor.call('getWorkingHoursForPeriod', methodParameters, (error, result) => {
        if (!this.request.current(requestSequence)) return
        if (error) {
          this.request.fail(requestSequence)
          console.error(error)
        } else {
          this.request.complete(requestSequence, () => {
            this.workingTimeEntries.set(result.workingHours.sort((a, b) => a.date - b.date))
            this.totalWorkingTimeEntries.set(result.totalEntries)
          })
        }
      })
    }
  })
})
Template.workingtimetable.onRendered(() => {
  const templateInstance = Template.instance()
  templateInstance.tableRenderer = tableRendererForTemplate(templateInstance)
  templateInstance.autorun(() => {
    if (i18nReady.get() && templateInstance.request.ready()) {
      let data = []
      if (templateInstance.workingTimeEntries.get()) {
        data = templateInstance.workingTimeEntries.get()
          .map((entry) => Object.entries(entry)
            .map((key) => { if (key[1] instanceof Date) { return dayjs.utc(key[1]).format(getGlobalSetting('dateformat')) } return key[1] }))
      }
      const columns = [
        {
          name: t('globals.date'),
          editable: false,
          compareValue: (cell, keyword) => [dayjs(cell, getGlobalSetting('dateformat')).toDate(), dayjs(keyword, getGlobalSetting('dateformat')).toDate()],
          format: addToolTipToTableCell,
        },
        { name: t('globals.resource'), editable: false, format: addToolTipToTableCell },
        { name: t('details.startTime'), editable: false },
        { name: t('details.breakStartTime'), editable: false },
        { name: t('details.breakEndTime'), editable: false },
        { name: t('details.endTime'), editable: false },
        { name: t('details.totalTime'), editable: false, format: numberWithUserPrecision },
        { name: t('details.regularWorkingTime'), editable: false, format: numberWithUserPrecision },
        { name: t('details.regularWorkingTimeDifference'), editable: false, format: numberWithUserPrecision }]
      templateInstance.tableRenderer.render({
        columns: secureDataTableColumns(columns),
        serialNoColumn: false,
        clusterize: false,
        layout: 'ratio',
        showTotalRow: true,
        data,
        noDataMessage: t('tabular.sZeroRecords'),
      })
    }
  })
})
Template.workingtimetable.helpers({
  exportController: () => Template.instance().exportController,
  exportBusy: () => Template.instance().exportController.busy.get(),
  workingTimeEntries() {
    return Template.instance().request.hasRows()
  },
  request: () => Template.instance().request,
  tableHidden: () => !Template.instance().request.ready() || !Template.instance().request.rendered.get(),
  tableInert: () => (!Template.instance().request.ready() || !Template.instance().request.rendered.get() ? '' : null),
  workingTimeSum() {
    return (Template.instance().workingTimeEntries.get() || [])
      .reduce(((total, element) => total + element.totalTime), 0)
  },
  regularWorkingTimeSum() {
    return (Template.instance().workingTimeEntries.get() || [])
      .reduce(((total, element) => total + element.regularWorkingTime), 0)
  },
  regularWorkingTimeDifferenceSum() {
    return (Template.instance().workingTimeEntries.get() || [])
      .reduce(((total, element) => total + element.regularWorkingTimeDifference), 0)
  },
  totalWorkingTimeEntries() {
    return Template.instance().totalWorkingTimeEntries
  },
})
Template.workingtimetable.events({
  'click .js-export-csv': (event, templateInstance) => {
    event.preventDefault()
    return templateInstance.exportController.run('csv')
  },
  'click .js-export-xlsx': (event, templateInstance) => {
    event.preventDefault()
    return templateInstance.exportController.run('xlsx')
  },
})
Template.workingtimetable.onDestroyed(() => {
  Template.instance().exportController.dispose()
  Template.instance().request.dispose()
  FlowRouter.setQueryParams({ page: null })
  Template.instance().tableRenderer?.destroy()
})
