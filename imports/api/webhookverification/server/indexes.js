import { Meteor } from 'meteor/meteor'
import WebhookVerification from '../webhookverification.js'

async function ensureWebhookVerificationIndexes(collection = WebhookVerification) {
  await collection.rawCollection().createIndex(
    { endpointId: 1 },
    {
      unique: true,
      name: 'webhook_secure_endpoint_unique',
      partialFilterExpression: {
        endpointId: { $type: 'string' },
        securityVersion: 2,
        mappingVersion: 1,
      },
    },
  )
}

Meteor.startup(() => ensureWebhookVerificationIndexes())

export { ensureWebhookVerificationIndexes }
