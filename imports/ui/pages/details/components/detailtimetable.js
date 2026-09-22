import dayjs from 'dayjs'
import utc from 'dayjs/plugin/utc'
import customParseFormat from 'dayjs/plugin/customParseFormat'
import { FlowRouter } from 'meteor/ostrio:flow-router-extra'
import { normalizePageParameter } from '../../../../utils/pageParameter.js'
import { normalizeLimitParameter } from '../../../../utils/limitParameter.js'
import { createDetailsRequestState } from '../../../../utils/detailsRequestState.js'
import { tableRendererForTemplate } from './detailsTableRenderer.js'
import { Modal } from 'bootstrap'
import { i18nReady, t } from '../../../../utils/i18n.js'
import Timecards from '../../../../api/timecards/timecards'
import CustomFields from '../../../../api/customfields/customfields'
import {
  addToolTipToTableCell,
  timeInUserUnit,
  getGlobalSetting,
  numberWithUserPrecision,
  getUserSetting,
  getUserTimeUnitVerbose,
  showToast,
} from '../../../../utils/frontend_helpers'
import { projectResources } from '../../../../api/users/users.js'
import Projects from '../../../../api/projects/projects'
import { buildDetailedTimeEntriesForPeriodSelectorAsync } from '../../../../utils/server_method_helpers'
import {
  getTimecardDateOnly,
  getTimecardEndTime,
  getTimecardStartTime,
} from '../../../../utils/timecardDate.js'
import {
  escapeDataTableText,
  secureDataTableColumns,
} from '../../../../utils/dataTableSecurity.js'
import './detailtimetable.html'
import './pagination.js'
import './limitpicker.js'
import './tableRequestFeedback.js'
import { createExportForTemplate } from './exportControls.js'

const Counts = new Mongo.Collection('counts')

dayjs.extend(utc)
dayjs.extend(customParseFormat)

const customFieldType = 'name'

function detailedDataTableMapper(entry, forExport) {
  const project = Projects.findOne({ _id: entry.projectId })
  const dateOnly = getTimecardDateOnly(entry)
  let mapping = [entry.projectId,
    dayjs.utc(dateOnly, 'YYYY-MM-DD').format(getGlobalSetting('dateformat')),
    entry.task.replace(/^=/, '\\=')]
  if (getGlobalSetting('showResourceInDetails')) {
    mapping.push(entry.userId)
  }
  if (forExport) {
    mapping = [project?.name ? project.name : '',
      dayjs.utc(dateOnly, 'YYYY-MM-DD').format(getGlobalSetting('dateformat')),
      entry.task.replace(/^=/, '\\=')]
    if (getGlobalSetting('showResourceInDetails')) {
      mapping.push(projectResources.findOne() ? projectResources.findOne({ _id: entry.userId })?.name : '')
    }
  }
  if (getGlobalSetting('showCustomFieldsInDetails')) {
    if (CustomFields.find({ classname: 'time_entry' }).count() > 0) {
      for (const customfield of CustomFields.find({ classname: 'time_entry' }).fetch()) {
        mapping.push(entry[customfield[customFieldType]])
      }
    }
    if (CustomFields.find({ classname: 'project' }).count() > 0) {
      for (const customfield of CustomFields.find({ classname: 'project' }).fetch()) {
        mapping.push(project[customfield[customFieldType]])
      }
    }
  }
  if (getGlobalSetting('showCustomerInDetails')) {
    mapping.push(project ? project.customer : '')
  }
  if (getGlobalSetting('useState')) {
    mapping.push(entry.state)
  }
  if (getGlobalSetting('useStartTime')) {
    mapping.push(getTimecardStartTime(entry))
    mapping.push(getTimecardEndTime(entry))
  }
  mapping.push(Number(timeInUserUnit(entry.hours)))
  if (getGlobalSetting('showRateInDetails')) {
    let resourceRate
    if (project.rates) {
      resourceRate = project.rates[entry.userId]
    }
    const rate = entry.taskRate || resourceRate || project.rate || 0
    mapping.push(rate)
  }
  mapping.push(entry._id)
  return mapping
}
Template.detailtimetable.onCreated(function workingtimetableCreated() {
  this.totalDetailTimeEntries = new ReactiveVar()
  this.search = new ReactiveVar()
  this.sort = new ReactiveVar()
  this.tcid = new ReactiveVar()
  this.selector = new ReactiveVar()
  this.filters = new ReactiveVar({})
  this.outboundInterfaces = new ReactiveVar([])
  this.request = createDetailsRequestState({ ReactiveVar, rows: this.selector, total: this.totalDetailTimeEntries })
  this.exportController = createExportForTemplate(this, 'detailed', () => {
    const selector = this.selector.get()
    return selector ? Timecards.find(selector[0], selector[1]).fetch() : []
  })
  this.autorun(() => {
    this.request.retry.get()
    if (this.data?.project.get()
      && this.data?.resource.get()
      && this.data?.customer.get()
      && this.data?.period.get()
      && this.data?.limit.get()) {
      const requestSequence = this.request.begin()
      const onStop = (error) => {
        if (error && this.request.fail(requestSequence)) console.error(error)
      }
      this.myProjectsHandle = this.subscribe('myprojects', {}, { onStop })
      this.projectResourcesHandle = this.subscribe('projectResources', { projectId: this.data?.project.get() }, { onStop })
      this.timeCustomFieldsHandle = this.subscribe('customfieldsForClass', { classname: 'time_entry' }, { onStop })
      this.projectCustomFieldsHandle = this.subscribe('customfieldsForClass', { classname: 'project' }, { onStop })
      const subscriptionParameters = {
        projectId: this.data?.project.get(),
        userId: this.data?.resource.get(),
        customer: this.data?.customer.get(),
        period: this.data?.period.get(),
        limit: normalizeLimitParameter(this.data?.limit.get()),
        search: this.search.get(),
        sort: this.sort.get(),
        page: normalizePageParameter(FlowRouter.getQueryParam('page')),
        filters: this.filters.get(),
      }
      if (this.data?.period.get() === 'custom') {
        subscriptionParameters.dates = {
          startDate: getUserSetting('customStartDate') || dayjs.utc().startOf('month').toDate(),
          endDate: getUserSetting('customEndDate') || dayjs.utc().toDate(),
        }
      }
      this.exportQuery = subscriptionParameters
      this.detailedEntriesPeriodCountHandle = this.subscribe('getDetailedTimeEntriesForPeriodCount', subscriptionParameters, { onStop })
      this.detailedTimeEntriesForPeriodHandle = this.subscribe('getDetailedTimeEntriesForPeriod', subscriptionParameters, { onStop })
      buildDetailedTimeEntriesForPeriodSelectorAsync(subscriptionParameters).then((selector) => {
        if (!this.request.current(requestSequence)) return
        // Minimongo contains the published page already; don't skip it twice.
        delete selector[1].skip
        this.selector.set(selector)
      }).catch((error) => {
        if (this.request.fail(requestSequence)) console.error(error)
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
Template.detailtimetable.onRendered(() => {
  const templateInstance = Template.instance()
  templateInstance.tableRenderer = tableRendererForTemplate(templateInstance)
  dayjs.extend(utc)
  templateInstance.autorun(() => {
    // Subscribe to the request epoch before ready() short-circuits. Rapid
    // filter changes can replace an unready handle without changing phase.
    const requestSequence = templateInstance.request.generation()
    if (templateInstance.request.phase.get() !== 'error'
      && templateInstance.detailedTimeEntriesForPeriodHandle?.ready()
      && templateInstance.detailedEntriesPeriodCountHandle?.ready()
      && templateInstance.projectResourcesHandle?.ready() && i18nReady.get()
      && templateInstance.myProjectsHandle?.ready()
      && templateInstance.timeCustomFieldsHandle?.ready()
      && templateInstance.projectCustomFieldsHandle?.ready()
      && templateInstance.selector.get()) {
      templateInstance.request.complete(requestSequence)
      const data = Timecards.find(
        templateInstance.selector.get()[0],
        templateInstance.selector.get()[1],
      )
        .fetch().map((entry) => detailedDataTableMapper(entry, false))
      if (data.length === 0) {
        templateInstance.$('.dt-row-totalRow').remove()
      }
      const columns = [
        {
          name: t('globals.project'),
          id: 'projectId',
          editable: false,
          format: (value) => addToolTipToTableCell(Projects.findOne({ _id: value })?.name),
        },
        {
          name: t('globals.date'),
          id: 'date',
          editable: false,
          format: addToolTipToTableCell,
        },
        {
          name: t('globals.task'), id: 'task', editable: false, format: addToolTipToTableCell,
        }]
      if (getGlobalSetting('showResourceInDetails')) {
        columns.push({
          name: t('globals.resource'),
          id: 'userId',
          editable: false,
          format: (value) => addToolTipToTableCell(projectResources.findOne() ? projectResources.findOne({ _id: value })?.name : ''),
        })
      }
      if (getGlobalSetting('showCustomFieldsInDetails')) {
        let customFieldColumnType = 'desc'
        if (getGlobalSetting('showNameOfCustomFieldInDetails')) {
          customFieldColumnType = 'name'
        }
        if (CustomFields.find({ classname: 'time_entry' }).count() > 0) {
          for (const customfield of CustomFields.find({ classname: 'time_entry' }).fetch()) {
            columns.push({
              name: customfield[customFieldColumnType],
              id: customfield.name,
              editable: false,
              format: addToolTipToTableCell,
            })
          }
        }
        if (CustomFields.find({ classname: 'project' }).count() > 0) {
          for (const customfield of CustomFields.find({ classname: 'project' }).fetch()) {
            columns.push({
              name: customfield[customFieldColumnType],
              id: customfield.name,
              editable: false,
              format: addToolTipToTableCell,
            })
          }
        }
      }
      if (getGlobalSetting('showCustomerInDetails')) {
        columns.push(
          {
            name: t('globals.customer'), id: 'customer', editable: false, format: addToolTipToTableCell,
          },
        )
      }
      if (getGlobalSetting('useState')) {
        columns.push(
          {
            name: t('details.state'),
            id: 'state',
            editable: true,
            format: (value) => {
              if (value === null) {
                return ''
              }
              const cellContent = value ? addToolTipToTableCell(t(`details.${value}`)) : addToolTipToTableCell(t('details.new'))
              return `${cellContent} <i class="fa fa-chevron-down float-end js-edit-state btn-reveal" aria-hidden="true"></i>`
            },
          },
        )
      }
      if (getGlobalSetting('useStartTime')) {
        columns.push(
          {
            name: t('details.startTime'),
            id: 'startTime',
            editable: false,
            format: addToolTipToTableCell,
          },
        )
        columns.push(
          {
            name: t('details.endTime'),
            id: 'endTime',
            editable: false,
            format: addToolTipToTableCell,
          },
        )
      }
      columns.push({
        name: getUserTimeUnitVerbose(),
        id: 'hours',
        editable: false,
        format: numberWithUserPrecision,
      })
      if (getGlobalSetting('showRateInDetails')) {
        columns.push({
          name: t('project.rate'),
          id: 'rate',
          editable: false,
          format: numberWithUserPrecision,
        })
      }
      columns.push(
        {
          name: t('navigation.edit'),
          id: 'actions',
          editable: false,
          dropdown: false,
          focusable: false,
          format: (value) => {
            if (!value) {
              return ''
            }
            const timeCard = Timecards.findOne({ _id: value })
            let showEdit = timeCard.userId === Meteor.userId()
            if ((getGlobalSetting('enableLogForOtherUsers'))) {
              const targetProject = Projects.findOne({ _id: timeCard.projectId })
              if (targetProject.userId === Meteor.userId()
                || targetProject.admins?.indexOf(Meteor.userId()) >= 0) {
                showEdit = true
              }
            }
            if (showEdit) {
              const safeId = escapeDataTableText(value)
              return `<div class="text-center">
                <a href="#" class="js-edit" data-id="${safeId}"><i class="fa fa-edit"></i></a>
                <a href="#" class="js-delete" data-id="${safeId}"><i class="fa fa-trash"></i></a>
              </div>`
            }
            return ''
          },
        },
      )
      const securedColumns = secureDataTableColumns(columns)
      const datatableConfig = {
        columns: securedColumns,
        data,
        serialNoColumn: false,
        clusterize: false,
        layout: 'ratio',
        showTotalRow: true,
        noDataMessage: t('tabular.sZeroRecords'),
        inlineFilters: true,
        events: {
          onSortColumn(column) {
            if (column) {
              templateInstance.sort.set({ column: column.colIndex, order: column.sortOrder })
            }
          },
        },
        headerDropdown: [
          {
            label: 'Filter',
            action(column) {
              const filterModal = new Modal('#filterModal')
              filterModal.show()
              templateInstance.$('#genericFilter').html('')
              const uniqueRowValues = new Map()
              for (const row of templateInstance.datatable.datamanager.rows) {
                if (column.id === 'state') {
                  if (row[column.colIndex].content === undefined) {
                    uniqueRowValues.set('new', t('details.new'))
                  } else {
                    uniqueRowValues.set(
                      row[column.colIndex].content,
                      $(row[column.colIndex].html).text(),
                    )
                  }
                } else {
                  uniqueRowValues.set(
                    row[column.colIndex].content,
                    $(row[column.colIndex].html).text()
                      ? $(row[column.colIndex].html).text() : row[column.colIndex].content,
                  )
                }
              }
              for (const [key, value] of uniqueRowValues) {
                templateInstance.$('#genericFilter').append(new Option(value, key))
              }
              templateInstance.$('#genericFilter').data('filtertarget', column.id)
            },
          },
        ],
      }
      if (getGlobalSetting('useState')) {
        datatableConfig
          .getEditor = (colIndex, rowIndex, value, parent, column, row, editorData) => {
            if (column.id === 'state' && Timecards.findOne({ _id: editorData[editorData.length - 1] }).userId === Meteor.userId() && rowIndex !== 'totalRow') {
              const $select = document.createElement('select')
              $select.classList = 'form-control js-state-select'
              parent.style.padding = 0
              $select.style.position = 'absolute'
              $select.style.zIndex = 1000
              $select.size = 4
              $select.options.add(new Option(t('details.new'), 'new'))
              $select.options.add(new Option(t('details.exported'), 'exported'))
              $select.options.add(new Option(t('details.billed'), 'billed'))
              $select.options.add(new Option(t('details.notBillable'), 'notBillable'))

              parent.appendChild($select)
              return {
                initValue(initValue) {
                  $select.focus()
                  if (initValue) {
                    $($select).val(initValue)
                  } else {
                    $select.selectedIndex = 0
                  }
                },
                setValue(setValue) {
                  Meteor.call('setTimeEntriesState', { timeEntries: [editorData[editorData.length - 1]], state: setValue }, (error) => {
                    if (error) {
                      console.error(error)
                    } else {
                      showToast(t('notifications.time_entry_updated'))
                    }
                  })
                },
                getValue() {
                  return $($select).val()
                },
              }
            }
            return null
          }
      }
      templateInstance.tableRenderer.render(datatableConfig)
      const countsId = templateInstance.data.project.get() instanceof Array ? templateInstance.data.project.get().join('') : templateInstance.data.project.get()
      templateInstance.totalDetailTimeEntries
        .set(Counts.findOne({ _id: countsId })
          ? Counts.findOne({ _id: countsId }).count : 0)
    }
  })
})
Template.detailtimetable.helpers({
  exportController: () => Template.instance().exportController,
  exportBusy: () => Template.instance().exportController.busy.get(),
  detailTimeEntries() {
    if (Template.instance().request.ready() && Template.instance().selector.get()) {
      return Timecards
        .find(
          Template.instance().selector.get()[0],
          Template.instance().selector.get()[1],
        ).count() > 0
        ? Timecards.find(
          Template.instance().selector.get()[0],
          Template.instance().selector.get()[1],
        ) : false
    }
    return false
  },
  detailTimeSum() {
    if (Template.instance().request.ready() && Template.instance().selector.get()) {
      return timeInUserUnit(Timecards
        .find(Template.instance().selector.get()[0], Template.instance().selector.get()[1])
        .fetch().reduce(((total, element) => total + element.hours), 0))
      }
    return 0
  },
  totalDetailTimeEntries() {
    return Template.instance().totalDetailTimeEntries
  },
  request: () => Template.instance().request,
  tableHidden: () => !Template.instance().request.ready() || !Template.instance().request.rendered.get(),
  tableInert: () => (!Template.instance().request.ready() || !Template.instance().request.rendered.get() ? '' : null),
  tcid() { return Template.instance().tcid },
  showInvoiceButton: () => (getGlobalSetting('enableSiwapp') && getUserSetting('siwappurl')),
  showMarkAsBilledButton: () => (getGlobalSetting('useState') && (!getGlobalSetting('enableSiwapp') || !getUserSetting('siwappurl'))),
  filters() {
    return !!(Template.instance().filters.get()
    && Object.keys(Template.instance().filters.get()).length > 0)
  },
  outboundInterfaces: () => Template.instance().outboundInterfaces?.get(),
})
Template.detailtimetable.events({
  'click .js-export-csv': (event, templateInstance) => {
    event.preventDefault()
    return templateInstance.exportController.run('csv')
  },
  'click .js-export-xlsx': (event, templateInstance) => {
    event.preventDefault()
    return templateInstance.exportController.run('xlsx')
  },
  'click .js-track-time': (event, templateInstance) => {
    event.preventDefault()
    templateInstance.tcid.set(undefined)
    new Modal($('#edit-tc-entry-modal')[0], { focus: false }).show()
  },
  'click .js-share': (event, templateInstance) => {
    event.preventDefault()
    const projectId = FlowRouter.getParam('projectId')
    if ($('#period').val() === 'all' || projectId === 'all' || projectId.split(',').length > 1) {
      showToast(t('notifications.sanity'))
      return
    }
    Meteor.call('addDashboard', {
      projectId, resourceId: $('#resourceselect').val()[0], customer: $('#customerselect').val()[0], timePeriod: $('#period').val(),
    }, (error, _id) => {
      if (error) {
        showToast(t('notifications.dashboard_creation_failed'))
        // console.error(error)
      } else {
        $('#dashboardURL').val(FlowRouter.url('dashboard', { _id }))
        new Modal($('.js-dashboard-modal')[0], { focus: false }).toggle()
      }
    })
  },
  'click .js-invoice': (event, templateInstance) => {
    event.preventDefault()
    if (!templateInstance.request.ready()) return
    if (getUserSetting('siwappurl')) {
      Meteor.call('sendToSiwapp', {
        projectId: $('.js-projectselect').val(),
        timePeriod: $('#period').val(),
        userId: $('#resourceselect').val(),
        customer: $('#customerselect').val(),
        dates: {
          startDate: getUserSetting('customStartDate') ? getUserSetting('customStartDate') : dayjs.utc().startOf('month').toDate(),
          endDate: getUserSetting('customEndDate') ? getUserSetting('customEndDate') : dayjs.utc().toDate(),
        },
      }, (error, result) => {
        if (error) {
          showToast(t('notifications.export_failed', { error }))
        } else {
          showToast(t(result))
        }
      })
    }
  },
  'click .js-mark-billed': (event, templateInstance) => {
    event.preventDefault()
    if (!templateInstance.request.ready()) return
    const selector = structuredClone(templateInstance.selector.get()[0])
    selector.state = { $ne: 'notBillable' }
    Meteor.call('setTimeEntriesState', { timeEntries: Timecards.find(selector, templateInstance.selector.get()[1]).fetch().map((entry) => entry._id), state: 'billed' }, (error) => {
      if (error) {
        console.error(error)
      } else {
        showToast(t('notifications.time_entry_updated'))
      }
    })
  },
  'click .js-delete': (event, templateInstance) => {
    event.preventDefault()
    if (!templateInstance.request.ready()) return
    if (confirm(t('notifications.delete_confirm'))) {
      Meteor.call('deleteTimeCard', { timecardId: templateInstance.$(event.currentTarget).data('id') }, (error, result) => {
        if (!error) {
          showToast(t('notifications.time_entry_deleted'))
        } else {
          console.error(error)
          if (typeof error.error === 'string') {
            showToast(t(error.error.replace('[', '').replace(']', '')))
          }
        }
      })
    }
  },
  'click .js-edit': (event, templateInstance) => {
    event.preventDefault()
    if (!templateInstance.request.ready()) return
    templateInstance.tcid.set(templateInstance.$(event.currentTarget).data('id'))
    new Modal($('#edit-tc-entry-modal')[0], { focus: false }).show()
  },
  'change .js-search': (event, templateInstance) => {
    templateInstance.search.set($(event.currentTarget).val())
  },
  'click .js-edit-state': (event, templateInstance) => {
    event.preventDefault()
    const doubleClickEvent = new MouseEvent('dblclick', {
      view: window,
      bubbles: true,
      cancelable: true,
    })
    const singleClickEvent = new MouseEvent('click')
    event.currentTarget.parentElement.dispatchEvent(doubleClickEvent)
    templateInstance.$(event.currentTarget.parentElement.parentElement.querySelector('.js-state-select')).trigger('click')
  },
  'click .js-state-select option': (event, templateInstance) => {
    event.preventDefault()
    templateInstance.datatable.setDimensions()
    event.currentTarget.parentElement.parentElement.parentElement.previousElementSibling.dispatchEvent(new MouseEvent('mousedown', {
      view: window,
      bubbles: true,
      cancelable: true,
    }))
    event.currentTarget.parentElement.dispatchEvent(new MouseEvent('mousedown', {
      view: window,
      bubbles: true,
      cancelable: true,
    }))
    event.currentTarget.parentElement.dispatchEvent(new MouseEvent('mouseup', {
      view: window,
      bubbles: true,
      cancelable: true,
    }))
  },
  'click #saveFilter': (event, templateInstance) => {
    event.preventDefault()
    const filter = templateInstance.filters.get()
    const filterTarget = templateInstance.$('#genericFilter').data('filtertarget')
    filter[filterTarget] = templateInstance.$('#genericFilter').val()
    templateInstance.filters.set(filter)
  },
  'click .js-remove-filters': (event, templateInstance) => {
    event.preventDefault()
    templateInstance.filters.set({})
  },
  'mouseup .dt-cell--header > .dt-cell__content': (event, templateInstance) => {
    event.preventDefault()
    const requestSequence = templateInstance.request.generation()
    window.setTimeout(() => {
      if (!templateInstance.request.current(requestSequence)
        || !templateInstance.request.ready() || !templateInstance.datatable) return
      templateInstance.datatable.setDimensions()
      const top = Number.parseInt(templateInstance.find('.dt-row.vrow:last-of-type')?.style.top, 10)
      templateInstance.$('.dt-scrollable').height(Number.isFinite(top) ? `${top + 40}px` : 'auto')
    }, 100)
  },
  'click .js-outbound-interface': (event, templateInstance) => {
    event.preventDefault()
    if (!templateInstance.request.ready()) return
    Meteor.call('outboundinterfaces.run', { data: Timecards.find(structuredClone(templateInstance.selector.get()[0]), templateInstance.selector.get()[1]).fetch().map((entry) => detailedDataTableMapper(entry, true)), _id: templateInstance.$(event.currentTarget).data('interface-id') }, (error, result) => {
      if (error) {
        showToast(error)
        console.error(error)
      } else {
        showToast(result)
      }
    })
  },
})
Template.detailtimetable.onDestroyed(() => {
  Template.instance().exportController.dispose()
  Template.instance().request.dispose()
  FlowRouter.setQueryParams({ page: null })
  Template.instance().tableRenderer?.destroy()
})
