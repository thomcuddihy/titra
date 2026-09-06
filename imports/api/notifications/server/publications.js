import { Meteor } from 'meteor/meteor'
import Notifications from '../notifications.js'
import { checkAuthentication } from '../../../utils/server_method_helpers.js'
import { publishAuthorizedCollection } from '../../../utils/authorizedCollectionPublication.js'
import { NOTIFICATION_CLIENT_FIELDS } from './publicationSecurity.js'

/** Publish exact self-notification fields while the signed-in user remains active. */
Meteor.publish('mynotifications', async function myNotifications() {
  if (!this.userId) return this.ready()
  await checkAuthentication(this)
  return publishAuthorizedCollection(this, {
    users: Meteor.users,
    collection: Notifications,
    collectionName: 'notifications',
    selector: { userId: this.userId },
    fields: NOTIFICATION_CLIENT_FIELDS,
  })
})
