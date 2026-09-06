import { FlowRouter } from 'meteor/ostrio:flow-router-extra'
import dayjs from 'dayjs'
import isoWeek from 'dayjs/plugin/isoWeek'
import utc from 'dayjs/plugin/utc'
import { Popover } from 'bootstrap'
import './magicPopup.html'
import './projectsearch.js'
import { t } from '../../../../utils/i18n.js'
import { googleAPI } from '../../../../utils/google/google_client.js'
import { getUserSetting, showToast } from '../../../../utils/frontend_helpers'
import Projects from '../../../../api/projects/projects'
import {
  dateOnlyFromLocalDate,
  dateOnlyToUTCDate,
  isDateOnly,
} from '../../../../utils/timecardDate.js'

Template.magicPopup.onCreated(function magicPopupCreated() {
  this.magicData = new ReactiveVar([])
  this.showPopup = new ReactiveVar(false)
  this.saveInFlight = new ReactiveVar(false)
  this.popupGeneration = 0
  dayjs.extend(isoWeek)
  dayjs.extend(utc)
  this.subscribe('myProjects')
})
const getMagicData = (templateInstance) => {
  const queryDate = FlowRouter.getQueryParam('date')
  const referenceDate = dayjs.utc(
    isDateOnly(queryDate) ? queryDate : dateOnlyFromLocalDate(new Date()),
    'YYYY-MM-DD',
  )
  let startDate = referenceDate.toDate()
  let endDate = referenceDate.add(1, 'day').toDate()
  if (FlowRouter.getQueryParam('view') === 'w') {
    const weekStart = referenceDate.startOf('day').isoWeekday(getUserSetting('startOfWeek'))
    startDate = weekStart.toDate()
    endDate = weekStart.endOf('day').add(6, 'day').toDate()
  }
  if (FlowRouter.getQueryParam('view') === 'm') {
    startDate = referenceDate.startOf('month').toDate()
    endDate = referenceDate.endOf('month').toDate()
  }
  templateInstance.magicData.set([])
  googleAPI().then(() => {
    Meteor.call('getGoogleWorkspaceData', { startDate, endDate }, (error, result) => {
      if (!error) {
        result.returnEvents = result.returnEvents.map((returnEvent) => ({ ...returnEvent, icon: 'fa-calendar' }))
        result.returnMessages = result.returnMessages.map((returnMessage) => ({ ...returnMessage, icon: 'fa-envelope' }))
        templateInstance.magicData.set(result.returnEvents.concat(result.returnMessages)
          .sort((a, b) => (a.date > b.date ? 1 : -1)))
      } else {
        console.error(error)
      }
    })
  })
}
Template.magicPopup.onRendered(() => {
  const templateInstance = Template.instance()
  templateInstance.$('#magicModal').on('hidden.bs.modal', () => {
    templateInstance.showPopup.set(false)
  })
  templateInstance.$('#magicModal').on('shown.bs.modal', () => {
    templateInstance.popupGeneration += 1
    templateInstance.showPopup.set(true)
  })
  templateInstance.autorun(() => {
    if (templateInstance.showPopup.get() && Meteor.user()?.profile?.googleAPIexpiresAt) {
      getMagicData(templateInstance)
    } else if (Meteor.user()?.profile?.googleAPIexpiresAt) {
      templateInstance.$('.robot').removeClass('d-none')
      templateInstance.$('.js-datatable-container').addClass('d-none')
    }
  })
})
Template.magicPopup.helpers({
  magicData: () => (Template.instance().magicData.get()?.length > 0
    ? Template.instance().magicData.get() : false),
  renderProjectSelect: (projectId) => `<select class="form-control js-magic-project" required>
    <option value="">${t('project.project_placeholder')}</option>
    ${Projects.find({ $or: [{ archived: { $exists: false } }, { archived: false }] }).fetch().map((project) => (project._id === projectId ? `<option value="${project._id}" selected>${project.name}</option>` : `<option value="${project._id}">${project.name}</option>`)).join('')}
  </select>`,
})

Template.magicPopup.events({
  'click .js-authorize-google': (event, templateInstance) => {
    event.preventDefault()
    getMagicData(templateInstance)
  },
  'click .js-change-project': (event) => {
    event.preventDefault()
    const doubleClickEvent = new MouseEvent('dblclick', {
      view: window,
      bubbles: true,
      cancelable: true,
    })
    const singleClickEvent = new MouseEvent('click')
    event.currentTarget.parentElement.dispatchEvent(doubleClickEvent)
    event.currentTarget.parentElement.parentElement.querySelector('.js-magic-project-select').dispatchEvent(singleClickEvent)
  },
  'click .js-select-all': (event, templateInstance) => {
    templateInstance.$('.js-magic-select').prop('checked', event.currentTarget.checked)
  },
  'mouseover .js-origin-icon': (event) => {
    const element = event.currentTarget
    Popover.getOrCreateInstance(element)
  },
  'click .js-save': (event, templateInstance) => {
    event.preventDefault()
    if (templateInstance.saveInFlight.get()) {
      return
    }
    let selectedEntries = []
    templateInstance.$('tbody tr').each((index, element) => {
      const selected = $(element).find('.js-magic-select').prop('checked')
      const date = $(element).find('.js-magic-date').val()
      const projectId = $(element).find('.js-magic-project').val()
      const task = $(element).find('.js-magic-task').val()
      let hours = Number.parseFloat(templateInstance.$(element).find('.js-magic-hours').val())
      if (selected) {
        $(element).find('.js-magic-date').removeClass('is-invalid')
        $(element).find('.js-magic-project').removeClass('is-invalid')
        $(element).find('.js-magic-task').removeClass('is-invalid')
        $(element).find('.js-magic-hours').removeClass('is-invalid')
        if (!isDateOnly(date)) {
          $(element).find('.js-magic-date').addClass('is-invalid')
          selectedEntries = []
          return false
        }
        if (!projectId) {
          $(element).find('.js-magic-project').addClass('is-invalid')
          selectedEntries = []
          return false
        }
        if (!task) {
          $(element).find('.js-magic-task').addClass('is-invalid')
          selectedEntries = []
          return false
        }
        if (!hours) {
          $(element).find('.js-magic-hours').addClass('is-invalid')
          selectedEntries = []
          return false
        }
        if (getUserSetting('timeunit') === 'd') {
          hours *= (getUserSetting('hoursToDays'))
        }
        if (getUserSetting('timeunit') === 'm') {
          hours /= 60
        }
        const existingEntry = selectedEntries.find((entry) => entry.projectId === projectId
          && entry.task === task && entry.dateOnly === date)
        if (existingEntry) {
          existingEntry.hours += hours
        } else {
          selectedEntries.push({
            date: dateOnlyToUTCDate(date),
            dateOnly: date,
            projectId,
            task,
            hours,
          })
        }
      }
      return true
    })
    if (selectedEntries.length > 0) {
      const { popupGeneration } = templateInstance
      templateInstance.saveInFlight.set(true)
      templateInstance.$('.js-save').prop('disabled', true)
      Meteor.call('upsertWeek', selectedEntries, (error) => {
        templateInstance.saveInFlight.set(false)
        if (templateInstance.view?.isDestroyed) {
          return
        }
        templateInstance.$('.js-save').prop('disabled', false)
        if (error) {
          console.error(error)
          const message = typeof error.error === 'string'
            && error.error.startsWith('notifications.')
            ? t(error.error)
            : error.reason || error.message || t('notifications.unknown_error')
          showToast(message)
        } else {
          if (templateInstance.popupGeneration === popupGeneration
            && templateInstance.showPopup.get()) {
            templateInstance.$('#magicModal').modal('hide')
          }
          showToast(t('notifications.time_entry_saved'))
        }
      })
    } else {
      showToast(t('notifications.no_entry_selected'))
    }
  },
})
