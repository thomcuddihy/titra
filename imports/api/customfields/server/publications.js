import { Meteor } from 'meteor/meteor'
import { check } from 'meteor/check'
import CustomFields from '../customfields.js'
import {
  checkAdminAuthentication,
  checkAuthentication,
} from '../../../utils/server_method_helpers.js'
import { publishAuthorizedCollection } from '../../../utils/authorizedCollectionPublication.js'
import {
  CUSTOM_FIELD_CLIENT_FIELDS,
  userCustomFieldClass,
} from './publicationSecurity.js'

/** Publish all custom-field definitions only to a current active administrator. */
Meteor.publish('customfields', async function customfieldsPublication() {
  await checkAdminAuthentication(this)
  return publishAuthorizedCollection(this, {
    users: Meteor.users,
    collection: CustomFields,
    collectionName: 'customfields',
    fields: CUSTOM_FIELD_CLIENT_FIELDS,
    requireAdmin: true,
  })
})

/** Publish ordinary field definitions to active authenticated users. */
Meteor.publish('customfieldsForClass', async function customfieldsForClass({ classname }) {
  check(classname, String)
  await checkAuthentication(this)
  if (!userCustomFieldClass(classname)) return this.ready()
  return publishAuthorizedCollection(this, {
    users: Meteor.users,
    collection: CustomFields,
    collectionName: 'customfields',
    selector: { classname },
    fields: CUSTOM_FIELD_CLIENT_FIELDS,
  })
})
