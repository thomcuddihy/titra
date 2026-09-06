import dayjs from 'dayjs'
import { t } from '../../utils/i18n.js'
import { emojify, getGlobalSetting } from '../../utils/frontend_helpers'
import './about.html'

const CHANGELOG_URL = 'https://github.com/kromitgmbh/titra/tags'
const CHANGELOG_API_URL = 'https://api.github.com/repos/kromitgmbh/titra'

function showChangelogError(templateInstance) {
  templateInstance.$('#titra-changelog').text(t('settings.titra_changelog_error'))
}

function renderChangelog(templateInstance, { tagName, date, message }) {
  const target = templateInstance.$('#titra-changelog').get(0)
  if (!target) return
  const link = document.createElement('a')
  link.href = CHANGELOG_URL
  link.target = '_blank'
  link.rel = 'noopener noreferrer'
  link.textContent = tagName
  target.replaceChildren(
    document.createTextNode('Version '),
    link,
    document.createTextNode(` (${date}) :`),
    document.createElement('br'),
    document.createTextNode(message),
  )
}

Template.about.onCreated(function aboutCreated() {
  this.statistics = new ReactiveVar()
  Meteor.call('getStatistics', (error, result) => {
    if (!error) {
      this.statistics.set(result)
    } else {
      console.error(error)
    }
  })
})
Template.about.events({
  'click #retrieveChangeLog': (event, templateInstance) => {
    event.preventDefault()
    if (!templateInstance.$('#changelog').hasClass('show')) {
      $.getJSON(`${CHANGELOG_API_URL}/tags`).done((data) => {
        const tag = Array.isArray(data) ? data[2] : undefined
        const sha = typeof tag?.commit?.sha === 'string' ? tag.commit.sha : ''
        if (!/^[\da-f]{40,64}$/iu.test(sha)) {
          showChangelogError(templateInstance)
          return
        }
        $.getJSON(`${CHANGELOG_API_URL}/commits/${encodeURIComponent(sha)}`).done(async (commitData) => {
          try {
            const tagName = typeof tag.name === 'string' ? [...tag.name].slice(0, 200).join('') : ''
            const rawMessage = typeof commitData?.commit?.message === 'string'
              ? [...commitData.commit.message].slice(0, 20000).join('') : ''
            renderChangelog(templateInstance, {
              tagName,
              date: dayjs(commitData?.commit?.committer?.date)
                .format(getGlobalSetting('dateformat')),
              message: await emojify(rawMessage),
            })
          } catch {
            showChangelogError(templateInstance)
          }
        }).fail(() => showChangelogError(templateInstance))
      }).fail(() => showChangelogError(templateInstance))
    }
  },
})
Template.about.helpers({
  statistics() {
    return Template.instance().statistics.get()
  },
  bytesToSize(bytes) {
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB']
    if (bytes === 0) {
      return '0 Byte'
    }
    const i = parseInt(Math.floor(Math.log(bytes) / Math.log(1024)), 10)
    return `${Math.round(bytes / Math.pow(1024, i), 2)}  ${sizes[i]}`
  },
  humanReadableTime(time) {
    const days = Math.floor(time / 86400)
    const hours = Math.floor((time % 86400) / 3600)
    const minutes = Math.floor(((time % 86400) % 3600) / 60)
    // const seconds = Math.floor(((time % 86400) % 3600) % 60)
    let out = ''
    if (days > 0) {
      out += `${days} ${t('globals.day_plural')}, `
    }
    if (hours > 0) {
      out += `${hours} ${t('globals.hour_plural')}, `
    }
    if (minutes > 0) {
      out += `${minutes} ${t('globals.minute_plural')} `
    }
    return out
  },
})
