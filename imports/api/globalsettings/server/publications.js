import { Globalsettings } from '../globalsettings.js'
import {
  GLOBAL_SETTING_SOURCE_FIELDS,
  globalSettingDocuments,
} from '../globalSettingSecurity.js'
import { publishReactiveCollection } from '../../../utils/adminCollectionPublication.js'

/**
 * Publishes the global settings.
 * @returns {Mongo.Cursor} The global settings.
 */
Meteor.publish('globalsettings', async function publishGlobalsettings() {
  return publishReactiveCollection(this, {
    users: Meteor.users,
    collection: Globalsettings,
    collectionName: 'globalsettings',
    fields: GLOBAL_SETTING_SOURCE_FIELDS,
    documentsForUser: globalSettingDocuments,
  })
})
