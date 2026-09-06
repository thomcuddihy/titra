import { Meteor } from 'meteor/meteor'
import WebhookVerification from '../webhookverification.js'
import { checkAdminAuthentication } from '../../../utils/server_method_helpers.js'
import { publishAdminCollection } from '../../../utils/adminCollectionPublication.js'

const WEBHOOK_VERIFICATION_ADMIN_FIELDS = Object.freeze({
  name: 1,
  description: 1,
  verificationPeriod: 1,
  serviceUrl: 1,
  urlParam: 1,
  verificationType: 1,
  mappingRules: 1,
  active: 1,
  endpointId: 1,
  securityVersion: 1,
  mappingVersion: 1,
  configurationRevision: 1,
  createdAt: 1,
  updatedAt: 1,
})

Meteor.publish('webhookverification', async function webhookverificationpublication() {
  try {
    await checkAdminAuthentication(this)
  } catch (error) {
    return this.ready()
  }
  // Explicit allowlist: environment-provisioned secrets are never stored, and
  // future sensitive fields must not become publishable by accident.
  return publishAdminCollection(this, {
    users: Meteor.users,
    collection: WebhookVerification,
    collectionName: 'webhookverification',
    fields: WEBHOOK_VERIFICATION_ADMIN_FIELDS,
    selector: { removedAt: { $exists: false } },
  })
})

export { WEBHOOK_VERIFICATION_ADMIN_FIELDS }
