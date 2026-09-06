import { Meteor } from 'meteor/meteor'
import WebhookReceipts from '../webhookreceipts.js'

Meteor.startup(async () => {
  await WebhookReceipts.rawCollection().createIndex(
    { interfaceId: 1, eventId: 1 },
    { unique: true, name: 'webhook_interface_event_unique' },
  )
  await WebhookReceipts.rawCollection().createIndex(
    { expiresAt: 1 },
    { expireAfterSeconds: 0, name: 'webhook_receipt_expiry' },
  )
})
