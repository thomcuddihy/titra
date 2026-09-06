import dayjs from 'dayjs'
import utc from 'dayjs/plugin/utc'
import './taskSelectPopup.html'
import '../../../shared components/datatable.js'
import Tasks from '../../../../api/tasks/tasks.js'
import { i18nReady, t } from '../../../../utils/i18n.js'
import {
  getGlobalSetting, addToolTipToTableCell, showToast,
} from '../../../../utils/frontend_helpers'
import { taskSelectionCell } from '../../../../utils/taskSelectionMarkup.js'

function popupProjectId(templateInstance) {
  const projectId = templateInstance.data?.projectId
  if (projectId && typeof projectId.get === 'function') return projectId.get()
  return typeof projectId === 'string' ? projectId : null
}

function loadPopupIntegration(templateInstance, provider, destination, notification) {
  const projectId = popupProjectId(templateInstance)
  if (!projectId) return
  const requestKey = `${provider}:${projectId}`
  if (templateInstance.integrationSuggestionRequests.has(requestKey)) return
  templateInstance.integrationSuggestionRequests.add(requestKey)
  Meteor.call(
    'taskIntegrations.listSuggestions',
    { provider, projectId },
    (error, suggestions) => {
      destination.set(error ? false : suggestions)
      if (error && notification) showToast(t(notification))
    },
  )
}

Template.taskSelectPopup.onCreated(function taskSelectPopupCreated() {
  dayjs.extend(utc)
  const templateInstance = this
  templateInstance.activeTab = new ReactiveVar('local-tab')
  templateInstance.activeInboundInterfaceId = new ReactiveVar()
  templateInstance.taskSelectSearchValue = new ReactiveVar()
  templateInstance.wekanAPITasks = new ReactiveVar()
  templateInstance.modalDisplayed = new ReactiveVar(false)
  templateInstance.limit = new ReactiveVar(10)
  templateInstance.localTasksData = new ReactiveVar([])
  templateInstance.wekanTasksData = new ReactiveVar([])
  templateInstance.zammadTicketsData = new ReactiveVar()
  templateInstance.gitlabIssuesData = new ReactiveVar()
  templateInstance.integrationSuggestionRequests = new Set()
  templateInstance.wekanUnsupportedShown = false
  templateInstance.inboundInterfaces = new ReactiveVar()
  templateInstance.inboundInterfaceData = new ReactiveVar([])
  templateInstance.inboundInterfaceColumns = new ReactiveVar([
    {
      name: t('globals.task'),
      format: taskSelectionCell,
    },
    {
      name: t('globals.description'),
      format: addToolTipToTableCell,
    }])
  Meteor.call('inboundinterfaces.get', (error, result) => {
    if (error) {
      console.error(error)
    } else {
      templateInstance.inboundInterfaces.set(result)
    }
  })
  templateInstance.autorun(() => {
    if (templateInstance.activeInboundInterfaceId.get()) {
      Meteor.call('inboundinterfaces.getTasks', { _id: templateInstance.activeInboundInterfaceId.get(), projectId: templateInstance.data?.projectId?.get() }, (error, result) => {
        if (error) {
          console.error(error)
        } else {
          templateInstance.inboundInterfaceData.set(result)
        }
      })
    }
  })
  templateInstance.autorun(() => {
    if (templateInstance.modalDisplayed.get()) {
      templateInstance.subscribe('allmytasks', { limit: this.limit.get(), filter: templateInstance.taskSelectSearchValue.get() })
    }
  })
  templateInstance.autorun(() => {
    if (templateInstance.modalDisplayed.get()) {
      if (i18nReady.get()) {
        templateInstance.localTasksColumns = new ReactiveVar([{
          name: t('task.addTask'),
          editable: false,
          format: taskSelectionCell,
        }, {
          name: t('task.lastUsed'),
          editable: false,
          format: (value) => dayjs(value, 'YYYY/MM/DD').format(getGlobalSetting('dateformat')),
        }])
      }
      const taskFilter = {}
      if (templateInstance.taskSelectSearchValue?.get()) {
        taskFilter.name = { $regex: `.*${templateInstance.taskSelectSearchValue?.get()?.replace(/[-[\]{}()*+?.,\\/^$|#\s]/g, '\\$&')}.*`, $options: 'i' }
      }
      templateInstance.localTasksData
        .set(Tasks.find(taskFilter, { limit: templateInstance.limit.get(), sort: { lastUsed: -1 } })
          .fetch().map((element) => [element.name, dayjs(element.lastUsed).format('YYYY/MM/DD')]))
    }
  })
  templateInstance.autorun(() => {
    if (!templateInstance.modalDisplayed.get() || !popupProjectId(templateInstance)
      || !getGlobalSetting('enableWekan')) return
    if (Meteor.settings?.public?.sandstorm) {
      templateInstance.wekanAPITasks.set(false)
      if (!templateInstance.wekanUnsupportedShown) {
        templateInstance.wekanUnsupportedShown = true
        showToast(t('notifications.wekan_sandstorm_unsupported'))
      }
      return
    }
    loadPopupIntegration(
      templateInstance,
      'wekan',
      templateInstance.wekanAPITasks,
      'notifications.wekan_error',
    )
  })
  templateInstance.autorun(() => {
    if (templateInstance.modalDisplayed.get()) {
      if (i18nReady.get()) {
        templateInstance.wekanTasksColumns = new ReactiveVar([
          {
            name: t('globals.task'),
            format: taskSelectionCell,
          },
          {
            name: t('globals.description'),
            format: addToolTipToTableCell,
          }])
      }
      if (templateInstance.wekanAPITasks.get()) {
        templateInstance.wekanTasksData.set(templateInstance.wekanAPITasks.get()
          .slice(0, templateInstance.limit.get())
          .filter((item) => {
            if (templateInstance.taskSelectSearchValue.get()) {
              return item.title.indexOf(templateInstance.taskSelectSearchValue.get()) >= 0
            }
            return true
          }).sort((a, b) => (a.title > b.title ? 1 : -1))
          .map((element) => [element.title, element.description]))
      }
    }
  })
  templateInstance.autorun(() => {
    if (templateInstance.modalDisplayed.get()) {
      if (i18nReady.get()) {
        templateInstance.zammadTicketsColumns = new ReactiveVar([
          {
            name: t('globals.task'),
            format: taskSelectionCell,
          },
          {
            name: t('globals.description'),
            format: addToolTipToTableCell,
          }])
        if (getGlobalSetting('enableZammad')) {
          loadPopupIntegration(templateInstance, 'zammad', templateInstance.zammadTicketsData)
        }
        templateInstance.gitlabIssuesColumns = new ReactiveVar([
          {
            name: t('globals.task'),
            format: taskSelectionCell,
          },
          {
            name: t('globals.description'),
            format: addToolTipToTableCell,
          }])
        if (getGlobalSetting('enableGitlab')) {
          loadPopupIntegration(templateInstance, 'gitlab', templateInstance.gitlabIssuesData)
        }
      }
    }
  })
})

Template.taskSelectPopup.helpers({
  localTasks: () => (Template.instance().taskSelectSearchValue?.get()
    ? Tasks.find({ name: { $regex: `.*${Template.instance().taskSelectSearchValue?.get()?.replace(/[-[\]{}()*+?.,\\/^$|#\s]/g, '\\$&')}.*`, $options: 'i' } }, { sort: { name: -1 } })
    : Tasks.find({}, { sort: { lastUsed: -1 }, limit: Template.instance().limit.get() })),
  localTasksData: () => Template.instance().localTasksData,
  localTasksColumns: () => Template.instance().localTasksColumns,
  wekanTasksData: () => Template.instance().wekanTasksData,
  wekanTasksColumns: () => Template.instance().wekanTasksColumns,
  wekanTasksDataContent: () => Template.instance().wekanTasksData.get(),
  zammadTicketsColumns: () => Template.instance().zammadTicketsColumns,
  zammadTicketsData: () => new ReactiveVar(Template.instance().zammadTicketsData.get()
    ?.slice(0, Template.instance().limit.get())
    .filter((item) => {
      if (Template.instance().taskSelectSearchValue.get()) {
        return item.title.indexOf(Template.instance().taskSelectSearchValue.get()) >= 0
      }
      return true
    }).sort((a, b) => (a.title > b.title ? 1 : -1))
    .map((element) => [element.title, element.description])),
  gitlabIssuesColumns: () => Template.instance().gitlabIssuesColumns,
  gitlabIssuesData: () => new ReactiveVar(Template.instance().gitlabIssuesData.get()
    ?.slice(0, Template.instance().limit.get())
    .filter((item) => {
      if (Template.instance().taskSelectSearchValue.get()) {
        return item.title.indexOf(Template.instance().taskSelectSearchValue.get()) >= 0
      }
      return true
    }).sort((a, b) => (a.title > b.title ? 1 : -1))
    .map((element) => [element.title, element.description])),
  zammadEnabled: () => getGlobalSetting('enableZammad'),
  gitlabEnabled: () => getGlobalSetting('enableGitlab'),
  modalDisplayed: () => Template.instance().modalDisplayed.get(),
  isActive: (tab) => Template.instance().activeTab.get() === tab || Template.instance().activeTab.get() === `${tab}-tab`,
  inboundInterfaces: () => Template.instance().inboundInterfaces.get(),
  inboundInterfaceColumns: () => Template.instance().inboundInterfaceColumns,
  inboundInterfaceData: () => (Template.instance().inboundInterfaceData?.get().length > 0
    ? new ReactiveVar(Template.instance().inboundInterfaceData?.get()
      ?.slice(0, Template.instance().limit.get())
      .filter((item) => {
        if (Template.instance().taskSelectSearchValue.get()) {
          return item.name.indexOf(Template.instance().taskSelectSearchValue.get()) >= 0
        }
        return true
      }).sort((a, b) => (a.name > b.name ? 1 : -1))
      .map((element) => [element.name, element.description])) : false),
})

Template.taskSelectPopup.events({
  'keyup #taskSelectSearch': (event, templateInstance) => {
    event.preventDefault()
    templateInstance.taskSelectSearchValue.set(templateInstance.$(event.currentTarget).val())
  },
  'click .js-select-task': (event, templateInstance) => {
    event.preventDefault()
    $('.js-tasksearch-results').addClass('d-none')
    $('.js-tasksearch-input').val(templateInstance.$(event.currentTarget).data('task'))
    templateInstance.$('#taskSelectPopup').modal('hide')
  },
  'change #limitSelection': (event, templateInstance) => {
    event.preventDefault()
    templateInstance.limit.set(Number.parseInt(templateInstance.$(event.currentTarget).val(), 10))
  },
  'click .nav-link[data-bs-toggle]': (event, templateInstance) => {
    event.preventDefault()
    window.requestAnimationFrame(() => {
      templateInstance.activeTab.set(templateInstance.$(event.currentTarget).get(0).id)
      templateInstance.activeInboundInterfaceId.set(templateInstance.$(event.currentTarget).data('interface-id'))
    })
  },
})

Template.taskSelectPopup.onRendered(() => {
  const templateInstance = Template.instance()
  $('#taskSelectPopup').on('shown.bs.modal', () => {
    $('.js-tasksearch-results').addClass('d-none')
    templateInstance.modalDisplayed.set(true)
  })
  $('#taskSelectPopup').on('hidden.bs.modal', () => {
    templateInstance.modalDisplayed.set(false)
  })
})
