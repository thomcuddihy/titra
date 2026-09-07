import { Meteor } from 'meteor/meteor'
import { FlowRouter } from 'meteor/ostrio:flow-router-extra'
import { t } from '../../../../../utils/i18n'
import {
  dateOnlyToUTCDate,
  isDateOnly,
} from '../../../../../utils/timecardDate.js'
import { secureDataTableColumns } from '../../../../../utils/dataTableSecurity.js'
import './importcsv.html'

function parseCSV(text) {
  const lines = text.trim().split('\n')
  const headers = lines[0].split(',').map((header) => header.trim().toLowerCase())

  if (headers.length !== 3 || headers[0] !== 'task' || headers[1] !== 'date' || headers[2] !== 'hours') {
    throw new Meteor.Error(t('project.importCSV.invalidHeader'))
  }

  const data = []
  for (let lineIndex = 1; lineIndex < lines.length; lineIndex += 1) {
    const values = lines[lineIndex].split(',').map((value) => value.trim())
    if (values.length !== 3) {
      throw new Meteor.Error(
        `${t('project.importCSV.invalidDataFormat')} ${lineIndex + 1}.`,
      )
    }

    const task = values[0]
    const date = values[1]
    const hours = Number(values[2])

    const utcDateRegex = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
    const simpleDateRegex = /^\d{4}-\d{2}-\d{2}$/
    const parsedUTCDate = utcDateRegex.test(date) ? new Date(date) : undefined
    const validCalendarDate = simpleDateRegex.test(date) && isDateOnly(date)
    const validUTCDate = parsedUTCDate != null
      && !Number.isNaN(parsedUTCDate.getTime())
      && parsedUTCDate.toISOString() === date
    if (!validCalendarDate && !validUTCDate) {
      throw new Meteor.Error(
        `${t('project.importCSV.invalidDateFormat')} ${lineIndex + 1}. `
        + 'Expected UTC format (YYYY-MM-DDTHH:mm:ss.sssZ) or YYYY-MM-DD.',
      )
    }

    if (Number.isNaN(hours) || hours < 0) {
      throw new Meteor.Error(`${t('project.importCSV.invalidHours')} ${lineIndex + 1}.`)
    }

    data.push({ Task: task, Date: date, Hours: hours })
  }
  return data
}

function renderDataTable(templateInstance, data) {
  const container = document.getElementById('data-table-container')
  if (!container) {
    console.error('Data table container not found')
    return
  }

  container.innerHTML = ''

  if (!data || data.length === 0) {
    container.innerHTML = `<div class="text-gray-400 text-center py-4">${t('project.importCSV.noData')}</div>`
    return
  }

  const columns = secureDataTableColumns([
    { id: 'Task', name: t('globals.task') },
    { id: 'Date', name: t('globals.date') },
    { id: 'Hours', name: t('globals.hour_plural') },
  ])
  const transformedData = data.map((row) => [row.Task, row.Date, row.Hours])

  import('frappe-datatable/dist/frappe-datatable.css')
    .then(() => import('frappe-datatable'))
    .then((datatable) => {
      const DataTable = datatable.default
      return new DataTable(container, {
        columns,
        data: transformedData,
        layout: 'fluid',
        pagination: true,
        inlineFilters: true,
        resizable: true,
      })
    })
    .catch((error) => {
      console.error('Error loading Frappe DataTable:', error)
      templateInstance.error.set(t('project.importCSV.tableLoadFailed'))
    })
}

Template.importProjectCSV.onCreated(function importProjectCSVOnCreated() {
  this.file = new ReactiveVar(null)
  this.csvData = new ReactiveVar(null)
  this.error = new ReactiveVar(null)
  this.isUploaded = new ReactiveVar(false)
  this.loading = new ReactiveVar(false)
})

Template.importProjectCSV.events({
  'change #file-input': (event, templateInstance) => {
    const selectedFile = event.target.files?.[0]
    if (!selectedFile) {
      templateInstance.error.set(t('project.importCSV.noFileSelected'))
      return
    }

    templateInstance.file.set(selectedFile)
    templateInstance.error.set(null)
    templateInstance.loading.set(true)

    const reader = new FileReader()
    reader.onload = (readerEvent) => {
      try {
        const text = readerEvent.target?.result
        const parsedData = parseCSV(text)
        templateInstance.csvData.set(parsedData)
        templateInstance.loading.set(false)

        Meteor.setTimeout(() => {
          renderDataTable(templateInstance, parsedData)
        }, 500)
      } catch (error) {
        templateInstance.error.set(
          error.message || t('project.importCSV.fileReadFailed'),
        )
        templateInstance.loading.set(false)
        templateInstance.csvData.set(null)
      }
    }

    reader.onerror = () => {
      templateInstance.error.set(t('project.importCSV.fileReadFailed'))
      templateInstance.loading.set(false)
      templateInstance.csvData.set(null)
    }

    reader.readAsText(selectedFile)
  },

  'click #remove-file-button': (event, templateInstance) => {
    event.preventDefault()
    templateInstance.file.set(null)
    templateInstance.csvData.set(null)
    templateInstance.error.set(null)
    const container = document.getElementById('data-table-container')
    if (container) {
      container.innerHTML = ''
    }
  },

  'click #import-data-button': (event, templateInstance) => {
    event.preventDefault()
    const projectId = FlowRouter.getParam('id')
    const csvData = templateInstance.csvData.get()
    if (!csvData) {
      templateInstance.error.set(t('project.importCSV.noFileSelected'))
      return
    }

    let mappedData
    try {
      mappedData = csvData.map((entry) => {
        const lowercasedEntry = Object.keys(entry).reduce((accumulator, key) => {
          accumulator[key.toLowerCase()] = entry[key]
          return accumulator
        }, {})
        const dateString = lowercasedEntry.date
        const date = new Date(dateString)
        if (Number.isNaN(date.getTime())) {
          throw new Meteor.Error(
            `${t('project.importCSV.invalidDateFormat')}: ${dateString}`,
          )
        }
        const calendarDate = isDateOnly(dateString)
        return {
          ...lowercasedEntry,
          date: calendarDate ? dateOnlyToUTCDate(dateString) : date,
          ...(calendarDate
            ? { dateOnly: dateString }
            : { preserveLegacyTimestamp: true }),
          projectId,
        }
      })
    } catch (error) {
      templateInstance.error.set(error.message || t('errors.importFailed'))
      templateInstance.loading.set(false)
      return
    }
    templateInstance.loading.set(true)
    templateInstance.error.set(null)

    Meteor.call('bulkInsertTimecards', { timecards: mappedData }, (error) => {
      if (error) {
        templateInstance.error.set(error.message || t('errors.importFailed'))
        templateInstance.loading.set(false)
      } else {
        templateInstance.isUploaded.set(true)
        templateInstance.csvData.set(null)
        templateInstance.file.set(null)
        templateInstance.loading.set(false)
      }
    })
  },
})

Template.importProjectCSV.helpers({
  file() {
    return Template.instance().file.get()
  },
  csvData() {
    return Template.instance().csvData.get()
  },
  error() {
    return Template.instance().error.get()
  },
  isUploaded() {
    return Template.instance().isUploaded.get()
  },
  loading() {
    return Template.instance().loading.get()
  },
})
