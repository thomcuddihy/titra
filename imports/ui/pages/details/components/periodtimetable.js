import dayjs from 'dayjs'
import utc from 'dayjs/plugin/utc'
import { FlowRouter } from 'meteor/ostrio:flow-router-extra'
import { normalizePageParameter } from '../../../../utils/pageParameter.js'
import { tableRendererForTemplate } from './detailsTableRenderer.js'
import { normalizeLimitParameter } from '../../../../utils/limitParameter.js'
import { createDetailsRequestState } from '../../../../utils/detailsRequestState.js'
import './periodtimetable.html'
import './pagination.js'
import './limitpicker.js'
import './tableRequestFeedback.js'
import { createExportForTemplate } from './exportControls.js'
import { i18nReady, t } from '../../../../utils/i18n.js'
import {
  numberWithUserPrecision,
  getUserSetting,
  getUserTimeUnitVerbose,
  addToolTipToTableCell,
  totalHoursForPeriodMapper,
  getGlobalSetting,
  showToast,
} from '../../../../utils/frontend_helpers.js'
import { secureDataTableColumns } from '../../../../utils/dataTableSecurity.js'

Template.periodtimetable.onCreated(function periodtimetableCreated() {
  dayjs.extend(utc)
  this.periodTimecards = new ReactiveVar()
  this.totalPeriodTimeCards = new ReactiveVar()
  this.request = createDetailsRequestState({
    ReactiveVar, rows: this.periodTimecards, total: this.totalPeriodTimeCards,
    dependenciesReady: () => this.projectUsersHandle?.ready(),
  })
  this.exportController = createExportForTemplate(this, 'total', () => this.periodTimecards.get() || [])
  this.outboundInterfaces = new ReactiveVar([])
  this.autorun(() => {
    this.request.retry.get()
    if (this.data?.project.get()
      && this.data?.resource.get()
      && this.data?.period.get()
      && this.data?.limit.get()
      && this.data?.customer.get()) {
      const requestSequence = this.request.begin()
      this.projectUsersHandle = this.subscribe('projectResources', { projectId: this.data?.project.get() }, {
        onStop: (error) => {
          if (error && this.request.fail(requestSequence)) console.error(error)
        },
      })
      const methodParameters = {
        projectId: this.data?.project.get(),
        userId: this.data?.resource.get(),
        period: this.data?.period.get(),
        customer: this.data?.customer.get(),
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
      Meteor.call('getTotalHoursForPeriod', methodParameters, (error, result) => {
        if (!this.request.current(requestSequence)) return
        if (error) {
          this.request.fail(requestSequence)
          console.error(error)
        } else {
          this.request.complete(requestSequence, () => {
            this.periodTimecards.set(result.totalHours)
            this.totalPeriodTimeCards.set(result.totalEntries)
          })
        }
      })
    }
  })
  Meteor.call('outboundinterfaces.get', (error, result) => {
    if (error) {
      showToast(error)
      console.error(error)
    } else {
      this.outboundInterfaces.set(result)
    }
  })
})
Template.periodtimetable.onRendered(() => {
  const templateInstance = Template.instance()
  templateInstance.tableRenderer = tableRendererForTemplate(templateInstance)
  templateInstance.autorun(() => {
    if (i18nReady.get() && templateInstance.request.ready()) {
      let data = []
      if (templateInstance.periodTimecards.get() && templateInstance.projectUsersHandle.ready()) {
        data = templateInstance.periodTimecards.get().map(totalHoursForPeriodMapper)
          .map((entry) => Object.entries(entry)
            .map((key) => key[1]))
      }
      const columns = [
        { name: t('globals.project'), editable: false, format: addToolTipToTableCell },
      ]
      if (getGlobalSetting('showResourceInDetails')) {
        columns.push({
          name: t('globals.resource'), editable: false, format: addToolTipToTableCell,
        })
      }
      columns.push({
        name: getUserTimeUnitVerbose(),
        editable: false,
        format: numberWithUserPrecision,
      })
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
Template.periodtimetable.helpers({
  exportController: () => Template.instance().exportController,
  exportBusy: () => Template.instance().exportController.busy.get(),
  periodTimecards() {
    return Template.instance().request.hasRows()
  },
  request: () => Template.instance().request,
  tableHidden: () => !Template.instance().request.ready() || !Template.instance().request.rendered.get(),
  tableInert: () => (!Template.instance().request.ready() || !Template.instance().request.rendered.get() ? '' : null),
  totalPeriodTimeCards() {
    return Template.instance().totalPeriodTimeCards
  },
  outboundInterfaces: () => Template.instance().outboundInterfaces?.get(),
})
Template.periodtimetable.events({
  'click .js-export-csv': (event, templateInstance) => {
    event.preventDefault()
    return templateInstance.exportController.run('csv')
  },
  'click .js-export-xlsx': (event, templateInstance) => {
    event.preventDefault()
    return templateInstance.exportController.run('xlsx')
  },
  'click .js-outbound-interface': (event, templateInstance) => {
    event.preventDefault()
    if (!templateInstance.request.hasRows()) return
    Meteor.call('outboundinterfaces.run', { data: templateInstance.periodTimecards.get().map(totalHoursForPeriodMapper), _id: templateInstance.$(event.currentTarget).data('interface-id') }, (error, result) => {
      if (error) {
        showToast(error)
        console.error(error)
      } else {
        showToast(result)
      }
    })
  },
})
Template.periodtimetable.onDestroyed(() => {
  Template.instance().exportController.dispose()
  Template.instance().request.dispose()
  FlowRouter.setQueryParams({ page: null })
  Template.instance().tableRenderer?.destroy()
})
