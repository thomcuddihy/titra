import { t } from '../../../../../utils/i18n.js'
import './wekanInterfaceSettings.html'
import Projects from '../../../../../api/projects/projects.js'
import { showToast } from '../../../../../utils/frontend_helpers.js'
import { escapeTaskSelectionText } from '../../../../../utils/taskSelectionMarkup.js'
import { secureDataTableColumns } from '../../../../../utils/dataTableSecurity.js'

function setWekanStatus(templateInstance, state) {
  templateInstance.$('#wekanurl').prop('disabled', state === 'loading')
  templateInstance.$('#wekanurl').toggleClass('is-invalid', state === 'invalid')
  const icons = {
    loading: '<i class="fa fa-spinner fa-spin"></i>',
    invalid: '<i class="fa fa-times"></i>',
    valid: '<i class="fa fa-check"></i>',
  }
  templateInstance.$('#wekan-status').html(icons[state] || t('project.check'))
}

function selectedProjectValues(templateInstance, field) {
  const value = templateInstance.project.get()?.[field]
  if (typeof value === 'string') return [value]
  return Array.isArray(value) ? value : []
}

function tableData(templateInstance, entries, { field, inputClass }) {
  const selected = selectedProjectValues(templateInstance, field)
  return entries.map((entry) => ([{
    content: entry.title,
    editable: false,
    focusable: false,
    resizeable: false,
    format: (value) => {
      const safeId = escapeTaskSelectionText(entry._id)
      const safeTitle = escapeTaskSelectionText(value)
      const checked = selected.includes(entry._id) ? ' checked' : ''
      return `<div class="form-check form-check-inline">
        <input class="form-check-input ${inputClass}" type="checkbox" value="${safeId}"${checked}/>
        <label class="form-check-label">${safeTitle}</label>
      </div>`
    },
  }]))
}

async function renderWekanTable(templateInstance, {
  container, entries, field, inputClass, label, tableProperty,
}) {
  const columns = secureDataTableColumns([t(label)])
  const data = tableData(templateInstance, entries, { field, inputClass })
  if (templateInstance[tableProperty]) {
    templateInstance[tableProperty].refresh(data, columns)
    return
  }
  await import('frappe-datatable/dist/frappe-datatable.css')
  const datatable = await import('frappe-datatable')
  const DataTable = datatable.default
  window.requestAnimationFrame(() => {
    Reflect.set(templateInstance, tableProperty, new DataTable(container, {
      columns,
      data,
      serialNoColumn: false,
      clusterize: false,
      layout: 'fluid',
      noDataMessage: t('tabular.sZeroRecords'),
      events: {
        onRemoveColumn() {
          templateInstance[tableProperty].refresh(data, columns)
        },
      },
    }))
    templateInstance.$('.dt-scrollable').height('+=4')
  })
}

function renderWekanOptions(templateInstance, result) {
  const lists = Array.isArray(result?.lists) ? result.lists : []
  const swimlanes = Array.isArray(result?.swimlanes) && result.swimlanes.length > 1
    ? result.swimlanes : []
  templateInstance.wekanLists.set(lists)
  templateInstance.wekanSwimlanes.set(swimlanes)
  Promise.all([
    renderWekanTable(templateInstance, {
      container: '#wekan-list-container',
      entries: lists,
      field: 'selectedWekanList',
      inputClass: 'js-wekan-list-entry',
      label: 'project.wekan_list',
      tableProperty: 'wekanListDatatable',
    }),
    renderWekanTable(templateInstance, {
      container: '#wekan-swimlane-container',
      entries: swimlanes,
      field: 'selectedWekanSwimlanes',
      inputClass: 'js-wekan-swimlane-entry',
      label: 'project.wekan_swimlane',
      tableProperty: 'swimlaneDatatable',
    }),
  ]).catch(() => {
    setWekanStatus(templateInstance, 'invalid')
    showToast(t('notifications.wekan_error'))
  })
}

function validateWekanUrl() {
  const templateInstance = Template.instance()
  if (Meteor.settings?.public?.sandstorm) {
    setWekanStatus(templateInstance, 'invalid')
    showToast(t('notifications.wekan_sandstorm_unsupported'))
    return
  }
  const projectId = templateInstance.data?.projectId
  if (!projectId) {
    setWekanStatus(templateInstance, 'invalid')
    showToast(t('notifications.wekan_save_first'))
    return
  }
  const replacementUrl = templateInstance.$('#wekanurl').val()
  const args = { projectId }
  if (typeof replacementUrl === 'string' && replacementUrl.length > 0) {
    args.replacementUrl = replacementUrl
  }
  setWekanStatus(templateInstance, 'loading')
  Meteor.call('taskIntegrations.inspectWekan', args, (error, result) => {
    if (error || !result) {
      setWekanStatus(templateInstance, 'invalid')
      showToast(t('notifications.wekan_error'))
      return
    }
    setWekanStatus(templateInstance, 'valid')
    renderWekanOptions(templateInstance, result)
  })
}

Template.wekanInterfaceSettings.onCreated(function wekanInterfaceSettingsCreated() {
  this.wekanLists = new ReactiveVar()
  this.wekanSwimlanes = new ReactiveVar()
  this.project = new ReactiveVar()
  this.autorun(() => {
    if (this.data?.projectId) {
      this.project.set(Projects.findOne({ _id: this.data.projectId }))
      this.handle = this.subscribe('singleProject', this.data.projectId)
    }
  })
})

Template.wekanInterfaceSettings.helpers({
  // The stored URL contains a bearer credential and is intentionally never published.
  wekanurl: () => '',
  wekanLists: () => Template.instance().wekanLists.get(),
  wekanSwimlanes: () => Template.instance().wekanSwimlanes.get(),
  displayHelp: () => Template.instance().wekanLists.get()
    || Template.instance().wekanSwimlanes.get(),
})

Template.wekanInterfaceSettings.events({
  'change #wekanurl': (event) => {
    event.preventDefault()
    validateWekanUrl()
  },
  'click #wekan-status': (event) => {
    event.preventDefault()
    validateWekanUrl()
  },
  'change .js-wekan-list-entry': (event, templateInstance) => {
    event.preventDefault()
    templateInstance.$('.js-wekan-swimlane-entry').prop('checked', false)
    $('.js-save').trigger('click')
  },
  'change .js-wekan-swimlane-entry': (event, templateInstance) => {
    event.preventDefault()
    templateInstance.$('.js-wekan-list-entry').prop('checked', false)
    $('.js-save').trigger('click')
  },
})
