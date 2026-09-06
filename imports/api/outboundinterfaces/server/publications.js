/**
 * Publishes the outbound interfaces to the client.
 * Requires admin authentication.
 * @function getOutboundInterfaces
 * @memberof Meteor.publish
 * @name 'outboundinterfaces'
 * @returns {Mongo.Cursor} The cursor containing the outbound interfaces.
 */
import OutboundInterfaces from '../outboundinterfaces.js'
import { checkAdminAuthentication } from '../../../utils/server_method_helpers.js'
import {
  OUTBOUND_ADMIN_INTERFACE_FIELDS,
  publishAdminCollection,
} from '../../../utils/adminCollectionPublication.js'

Meteor.publish('outboundinterfaces', async function getOutboundInterfaces() {
  await checkAdminAuthentication(this)
  return publishAdminCollection(this, {
    users: Meteor.users,
    collection: OutboundInterfaces,
    collectionName: 'outboundinterfaces',
    fields: OUTBOUND_ADMIN_INTERFACE_FIELDS,
  })
})
