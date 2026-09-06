import { FlowRouter } from 'meteor/ostrio:flow-router-extra'
import './tasksearch.html'
import './taskSelectPopup.js'
import { t } from '../../../../utils/i18n.js'
import Tasks from '../../../../api/tasks/tasks.js'
import Timecards from '../../../../api/timecards/timecards.js'
import { getGlobalSetting, showToast } from '../../../../utils/frontend_helpers'
import Autocomplete from '../../../../utils/autocomplete'

function selectedProjectId(templateInstance) {
  const projectId = templateInstance.data?.projectId
  if (projectId && typeof projectId.get === 'function') return projectId.get()
  if (typeof projectId === 'string') return projectId
  return FlowRouter.getParam('projectId')
}

function loadIntegrationSuggestions(templateInstance, provider, destination, notification) {
  const projectId = selectedProjectId(templateInstance)
  if (!projectId) return
  const requestKey = `${provider}:${projectId}`
  if (templateInstance.integrationSuggestionRequests.has(requestKey)) return
  templateInstance.integrationSuggestionRequests.add(requestKey)
  Meteor.call(
    'taskIntegrations.listSuggestions',
    { provider, projectId },
    (error, suggestions) => {
      if (error) {
        destination.set(false)
        showToast(t(notification))
        return
      }
      destination.set(suggestions)
    },
  )
}

Template.tasksearch.events({
  'click .js-show-task-select-popup': (event) => {
    event.preventDefault()
    $('#taskSelectPopup').modal('show')
  },
  'keyup .js-tasksearch-input': (event, templateInstance) => {
    event.preventDefault()
    templateInstance.filter.set(templateInstance.$(event.currentTarget).val())
  },
  'click .js-remove-value': (event, templateInstance) => {
    event.preventDefault()
    event.stopPropagation()
    templateInstance.$('.js-tasksearch-input').val('')
    templateInstance.filter.set('')
    templateInstance.targetTask.renderIfNeeded()
  },
  'click .js-show-task-rate': (event, templateInstance) => {
    event.preventDefault()
    templateInstance.$('.js-task-rate-container').toggleClass('d-none')
  },
})

Template.tasksearch.onCreated(function tasksearchcreated() {
  this.filter = new ReactiveVar()
  this.wekanAPITasks = new ReactiveVar()
  this.zammadAPITasks = new ReactiveVar()
  this.gitlabAPITasks = new ReactiveVar()
  this.integrationSuggestionRequests = new Set()
  this.wekanUnsupportedShown = false
  this.inboundInterfaceTasks = new ReactiveVar([])
  Meteor.call('inboundinterfaces.get', (inboundinterfaceserror, inboundInterfaces) => {
    if (inboundinterfaceserror) {
      console.error(inboundinterfaceserror)
    } else {
      for (const inboundInterface of inboundInterfaces) {
        Meteor.call('inboundinterfaces.getTasks', { _id: inboundInterface._id, projectId: FlowRouter.getParam('projectId') }, (error, result) => {
          if (error) {
            console.error(error)
          } else {
            this.inboundInterfaceTasks.set(this.inboundInterfaceTasks.get().concat(result))
          }
        })
      }
    }
  })
  this.autorun(() => {
    let tcid
    if (this.data?.tcid && this.data?.tcid.get()) {
      tcid = this.data?.tcid.get()
    } else if (FlowRouter.getParam('tcid')) {
      tcid = FlowRouter.getParam('tcid')
    }
    if (tcid) {
      const handle = this.subscribe('singleTimecard', tcid)
      if (handle.ready()) {
        this.$('.js-tasksearch-input').val(Timecards.findOne({ _id: tcid }).task)
      }
    }
  })
  this.autorun(() => {
    if (!getGlobalSetting('enableWekan')) return
    if (Meteor.settings?.public?.sandstorm) {
      this.wekanAPITasks.set(false)
      if (!this.wekanUnsupportedShown) {
        this.wekanUnsupportedShown = true
        showToast(t('notifications.wekan_sandstorm_unsupported'))
      }
      return
    }
    loadIntegrationSuggestions(
      this,
      'wekan',
      this.wekanAPITasks,
      'notifications.wekan_error',
    )
  })
  this.autorun(() => {
    if (getGlobalSetting('enableZammad')) {
      loadIntegrationSuggestions(
        this,
        'zammad',
        this.zammadAPITasks,
        'notifications.zammad_error',
      )
    }
  })
  this.autorun(() => {
    if (getGlobalSetting('enableGitlab')) {
      loadIntegrationSuggestions(
        this,
        'gitlab',
        this.gitlabAPITasks,
        'notifications.gitlab_error',
      )
    }
  })
  this.autorun(() => {
    this.subscribe('mytasks', { filter: this.filter.get(), projectId: this.data?.projectId.get() ? this.data?.projectId.get() : FlowRouter.getParam('projectId') })
  })
  this.autorun(() => {
    if (this.data?.projectId.get()) {
      this.taskSelectPopup = Blaze.renderWithData(
        Template.taskSelectPopup,
        { projectId: this.data?.projectId },
        document.body,
      )
    }
  })
  this.autorun(() => {
    if (this.subscriptionsReady()) {
      let data = []
      if (!Template.instance().filter.get() || Template.instance().filter.get() === '') {
        data = Tasks.find({}, { sort: { projectId: -1, lastUsed: -1 }, limit: getGlobalSetting('taskSearchNumResults') })
          .fetch().map((task) => ({ label: task.name, value: task._id }))
      } else {
        const finalArray = []
        const wekanAPITasks = Template.instance().wekanAPITasks.get()
        const zammadAPITasks = Template.instance().zammadAPITasks.get()
        const gitlabAPITasks = Template.instance().gitlabAPITasks.get()
        const inboundInterfaceTasks = Template.instance().inboundInterfaceTasks.get()
        const regex = `.*${Template.instance().filter.get().replace(/[-[\]{}()*+?.,\\/^$|#\s]/g, '\\$&')}.*`
        if (wekanAPITasks?.length > 0) {
          finalArray.push(...wekanAPITasks
            .map((elem) => ({ label: elem.title, value: elem.title, wekan: true }))
            .filter((element) => new RegExp(regex, 'i').exec(element.label)))
        }
        if (zammadAPITasks && zammadAPITasks.length > 0) {
          finalArray.push(...zammadAPITasks.map((elem) => ({ label: elem.title, value: elem.title, zammad: true })).filter((element) => new RegExp(regex, 'i').exec(element.label)))
        }
        if (gitlabAPITasks && gitlabAPITasks.length > 0) {
          finalArray.push(...gitlabAPITasks.map((elem) => ({ label: elem.title, value: elem.title, gitlab: true })).filter((element) => new RegExp(regex, 'i').exec(element.label)))
        }
        if (inboundInterfaceTasks && inboundInterfaceTasks.length > 0) {
          finalArray.push(...inboundInterfaceTasks.map((elem) => ({ label: elem.name, value: elem.name, inboundInterface: true })).filter((element) => new RegExp(regex, 'i').exec(element.label)))
        }
        finalArray.push(...Tasks.find({ name: { $regex: regex, $options: 'i' } }, { sort: { projectId: -1, lastUsed: -1 }, limit: getGlobalSetting('taskSearchNumResults') }).fetch().map((task) => ({ label: task.name, value: task._id })))
        data = finalArray
      }
      if (this.targetTask) {
        this.targetTask.setData(data)
      } else {
        this.targetTask = new Autocomplete(this.$('.js-tasksearch-input').get(0), {
          data,
          maximumItems: getGlobalSetting('taskSearchNumResults'),
          threshold: 0,
          onSelectItem: () => {
            this.$('.js-tasksearch-input').removeClass('is-invalid')
            $('#hours').first().trigger('focus')
          },
        })
      }
    }
  })
})
Template.tasksearch.helpers({
  displayTaskSelectionIcon: () => (Template.instance()?.data?.projectId
    ? Template.instance()?.data?.projectId?.get() : false),
  taskRate: () => Timecards.findOne({ _id: Template.instance().data.tcid?.get() })?.taskRate,
})
Template.tasksearch.onRendered(() => {
  Template.instance().$('#edit-tc-entry-modal').on('hidden.bs.modal', () => {
    Blaze.remove(Template.instance().taskSelectPopup)
  })
})
