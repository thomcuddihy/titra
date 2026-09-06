import './webhookverificationcomponent.html'
import WebhookVerification from '../../../../api/webhookverification/webhookverification.js'
import { showToast } from '../../../../utils/frontend_helpers.js'
import { t } from '../../../../utils/i18n.js'

const DEFAULT_MAPPING_RULES = [{
  eventPointer: '/type',
  eventEquals: 'checkout.session.completed',
  userIdPointer: '/data/object/client_reference_id',
  action: 'complete',
}, {
  eventPointer: '/type',
  eventEquals: 'customer.subscription.deleted',
  userIdPointer: '/data/object/metadata/client_reference_id',
  action: 'revoke',
}]

function refreshStatus(templateInstance) {
  Meteor.call('webhookverification.status', (error, result) => {
    if (error) {
      showToast(error.reason)
      return
    }
    templateInstance.securityStatuses.set(Object.fromEntries(
      result.map((status) => [status._id, status]),
    ))
  })
}

function readConfiguration(templateInstance) {
  let mappingRules
  try {
    mappingRules = JSON.parse(templateInstance.$('#mappingRules').val())
  } catch (error) {
    showToast(t('administration.webhook_mapping_rules_invalid'))
    return undefined
  }
  if (!Array.isArray(mappingRules)) {
    showToast(t('administration.webhook_mapping_rules_invalid'))
    return undefined
  }
  const configuration = {
    name: templateInstance.$('#name').val(),
    description: templateInstance.$('#description').val(),
    verificationPeriod: Number(templateInstance.$('#verificationPeriod').val()),
    serviceUrl: templateInstance.$('#serviceUrl').val(),
    urlParam: templateInstance.$('#urlParam').val() || 'client_reference_id',
    verificationType: templateInstance.$('#verificationType').val(),
    mappingRules,
    active: templateInstance.$('#isActive').is(':checked'),
  }
  if (!configuration.name || !configuration.description) {
    showToast(t('notifications.fields_required'))
    return undefined
  }
  return configuration
}

function resetForm(templateInstance) {
  templateInstance.$('form').trigger('reset')
  templateInstance.$('#configurationRevision').val('0')
  templateInstance.$('#mappingRules').val(JSON.stringify(DEFAULT_MAPPING_RULES, null, 2))
  templateInstance.$('#provisioningStatus').text('')
  templateInstance.$('.js-add-webhook-verification').removeClass('d-none')
  templateInstance.$('.js-update-webhook-verification').addClass('d-none')
}

function showProvisioning(templateInstance, result) {
  const path = result.endpointId
    ? `/user/action-verification/webhook/${result.endpointId}` : ''
  templateInstance.$('#provisioningStatus').text([
    path,
    result.secretEnvironmentVariable || '',
  ].filter(Boolean).join('\n'))
}

Template.webhookverificationcomponent.onCreated(function webhookverificationcomponentCreated() {
  this.securityStatuses = new ReactiveVar({})
  this.subscribe('webhookverification', () => refreshStatus(this))
})

Template.webhookverificationcomponent.onRendered(function webhookverificationcomponentRendered() {
  this.$('#mappingRules').val(JSON.stringify(DEFAULT_MAPPING_RULES, null, 2))
})

Template.webhookverificationcomponent.helpers({
  webhookVerificationInterfaces: () => WebhookVerification.find(),
  securityStatus(interfaceId) {
    return Template.instance().securityStatuses.get()[interfaceId] || {
      operational: false, legacy: true, secretEnvironmentVariable: '',
    }
  },
})

Template.webhookverificationcomponent.events({
  'click .js-add-webhook-verification': (event, templateInstance) => {
    event.preventDefault()
    const configuration = readConfiguration(templateInstance)
    if (!configuration) return
    Meteor.call('webhookverification.insert', configuration, (error, result) => {
      if (error) {
        showToast(error.reason)
        return
      }
      showToast(t('notifications.success'))
      resetForm(templateInstance)
      showProvisioning(templateInstance, result)
      refreshStatus(templateInstance)
    })
  },
  'click .js-update-webhook-verification': (event, templateInstance) => {
    event.preventDefault()
    const configuration = readConfiguration(templateInstance)
    if (!configuration) return
    Meteor.call('webhookverification.update', {
      _id: templateInstance.$('#_id').val(),
      expectedRevision: Number(templateInstance.$('#configurationRevision').val()),
      ...configuration,
    }, (error, result) => {
      if (error) {
        showToast(error.reason)
        return
      }
      showToast(t('notifications.success'))
      resetForm(templateInstance)
      showProvisioning(templateInstance, result)
      refreshStatus(templateInstance)
    })
  },
  'click .js-edit-webhook-verification': (event, templateInstance) => {
    const webhookInterface = WebhookVerification.findOne({
      _id: event.currentTarget.dataset.interfaceId,
    })
    if (!webhookInterface) return
    templateInstance.$('#_id').val(webhookInterface._id)
    templateInstance.$('#configurationRevision').val(
      webhookInterface.configurationRevision ?? 0,
    )
    templateInstance.$('#name').val(webhookInterface.name)
    templateInstance.$('#description').val(webhookInterface.description)
    templateInstance.$('#verificationPeriod').val(webhookInterface.verificationPeriod || 30)
    templateInstance.$('#serviceUrl').val(webhookInterface.serviceUrl || '')
    templateInstance.$('#urlParam').val(webhookInterface.urlParam || 'client_reference_id')
    templateInstance.$('#verificationType').val(webhookInterface.verificationType || '')
    templateInstance.$('#mappingRules').val(JSON.stringify(
      webhookInterface.mappingRules || DEFAULT_MAPPING_RULES, null, 2,
    ))
    templateInstance.$('#isActive').prop(
      'checked', webhookInterface.securityVersion === 2 && webhookInterface.active === true,
    )
    templateInstance.$('#provisioningStatus').text(webhookInterface.endpointId || '')
    templateInstance.$('.js-add-webhook-verification').addClass('d-none')
    templateInstance.$('.js-update-webhook-verification').removeClass('d-none')
  },
  'click .js-remove-webhook-verification': (event, templateInstance) => {
    // eslint-disable-next-line no-alert
    if (!window.confirm(t('notifications.are_you_sure'))) return
    Meteor.call('webhookverification.remove', {
      _id: event.currentTarget.dataset.interfaceId,
      acknowledgeReferencedUsers: true,
    }, (error) => {
      if (error) showToast(error.reason)
      else {
        showToast(t('notifications.success'))
        refreshStatus(templateInstance)
      }
    })
  },
  'click .js-reset': (event, templateInstance) => {
    event.preventDefault()
    resetForm(templateInstance)
  },
})
