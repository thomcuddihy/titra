import { Meteor } from 'meteor/meteor'

async function ensureUserSecurityIndexes(collection = Meteor.users) {
  try {
    await collection.rawCollection().createIndex(
      { 'services.titraApiToken.sha256': 1 },
      {
        unique: true,
        name: 'user_titra_api_token_sha256_unique',
        partialFilterExpression: {
          'services.titraApiToken.version': 1,
          'services.titraApiToken.sha256': { $type: 'string' },
        },
      },
    )
  } catch (error) {
    if (error?.code === 11000 || error?.code === 11001) {
      throw new Error('The API token digest index requires duplicate cleanup.')
    }
    throw error
  }
}

Meteor.startup(() => ensureUserSecurityIndexes())

export { ensureUserSecurityIndexes }
