import { t } from '../../utils/i18n.js'
import '../shared components/backbutton.js'
import './profile.html'
import { getUserSetting, showToast } from '../../utils/frontend_helpers.js'
import { avatarPresentation } from '../../utils/userContentSecurity.js'

Template.profile.helpers({
  name: () => getUserSetting('name'),
  profileAvatar: () => avatarPresentation(Meteor.user()),
  hasCustomAvatar: () => Boolean(avatarPresentation(Meteor.user()).url),
  avatarColor: () => (Meteor.user() && getUserSetting('avatarColor')
    ? getUserSetting('avatarColor') : Template.instance().selectedAvatarColor.get()),
})

Template.profile.events({
  'click .js-save': (event, templateInstance) => {
    event.preventDefault()
    const updateJSON = {
      name: templateInstance.$('#name').val(),
      avatarColor: templateInstance.$('#avatarColor').val(),
    }
    if (!templateInstance.$('#avatarData').val() || templateInstance.$('#avatarData').val() !== 'false') {
      updateJSON.avatar = templateInstance.$('#avatarData').val()
    }
    Meteor.call('updateProfile', updateJSON, (error) => {
      if (error) {
        showToast(t(error.error))
      } else {
        showToast(t('notifications.settings_saved_success'))
        templateInstance.$('#imagePreview').hide()
      }
    })
  },
  // 'click .js-logout': (event) => {
  //   event.preventDefault()
  //   Meteor.logout()
  // },

  'click .js-avatar-picker': (event, templateInstance) => {
    event.preventDefault()
    templateInstance.$('#avatarImage').click()
  },
  'change #avatarImage': (event, templateInstance) => {
    if (event.currentTarget.files && event.currentTarget.files[0]) {
      const reader = new FileReader()
      reader.onloadend = (callbackresult) => {
        const image = new Image()
        image.onload = () => {
          const maxHeight = 125
          const maxWidth = 125
          const resizeCanvas = document.createElement('canvas')
          let ratio = 1
          if (image.height > maxHeight) {
            ratio = maxHeight / image.height
          } else if (image.width > maxWidth) {
            ratio = maxWidth / image.width
          }
          if (resizeCanvas) {
            resizeCanvas.width = image.width * ratio
            resizeCanvas.height = image.height * ratio
            resizeCanvas
              .getContext('2d')
              .drawImage(image, 0, 0, resizeCanvas.width, resizeCanvas.height)
            const dataURL = resizeCanvas.toDataURL('image/png')
            templateInstance.$('#imagePreview img').attr('src', dataURL)
            templateInstance.$('#avatarData').val(dataURL)
            templateInstance.$('#imagePreview').show()
          } else {
            console.error('unable to create Canvas')
          }
        }
        image.src = callbackresult.target.result
      }
      reader.readAsDataURL(event.currentTarget.files[0])
    }
  },
  'click #removeAvatar': (event, templateInstance) => {
    event.preventDefault()
    templateInstance.$('#avatarData').val('')
    templateInstance.$('.js-save').click()
  },
})
Template.profile.onCreated(function settingsCreated() {
  this.selectedAvatarColor = new ReactiveVar('#455A64')
})
Template.profile.onRendered(function settingsRendered() {
  const templateInstance = Template.instance()
  templateInstance.autorun(() => {
    if (!Meteor.loggingIn() && Meteor.user()
        && Meteor.user().profile && this.subscriptionsReady()) {
      templateInstance.$('#avatarData').val(avatarPresentation(Meteor.user()).url)
    }
  })
})
