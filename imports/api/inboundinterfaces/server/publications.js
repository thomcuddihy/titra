import InboundInterfaces from '../inboundinterfaces.js'
import { checkAdminAuthentication } from '../../../utils/server_method_helpers.js'
import {
  INBOUND_ADMIN_INTERFACE_FIELDS,
  publishAdminCollection,
} from '../../../utils/adminCollectionPublication.js'

/**
 * Publishes the inbound interfaces to the client.
 * Requires admin authentication.
 * @function getInboundInterfaces
 * @memberof Meteor.publish
 * @name 'inboundinterfaces'
 * @returns {Mongo.Cursor} The cursor containing the inbound interfaces.
 */
Meteor.publish('inboundinterfaces', async function getInboundInterfaces() {
  await checkAdminAuthentication(this)
  return publishAdminCollection(this, {
    users: Meteor.users,
    collection: InboundInterfaces,
    collectionName: 'inboundinterfaces',
    fields: INBOUND_ADMIN_INTERFACE_FIELDS,
  })
})
