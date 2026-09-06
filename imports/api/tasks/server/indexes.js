import { Meteor } from 'meteor/meteor'
import Tasks from '../tasks.js'

async function ensureTaskIndexes(collection = Tasks) {
  try {
    await collection.rawCollection().createIndex(
      { userId: 1, name: 1 },
      {
        unique: true,
        name: 'task_personal_suggestion_user_name_unique',
        partialFilterExpression: {
          // MongoDB 7 partial indexes reject $exists:false. Equality to null
          // covers both missing and explicit-null legacy personal suggestions.
          projectId: null,
          userId: { $type: 'string' },
          name: { $type: 'string' },
        },
      },
    )
  } catch (error) {
    if (error?.code === 11000 || error?.code === 11001) {
      // Mongo's duplicate-index diagnostic includes the duplicated user/name
      // key. Keep startup fail-closed without copying that private value into
      // the application-level error or support logs.
      throw new Error(
        'The personal task suggestion uniqueness index requires duplicate cleanup.',
      )
    }
    throw error
  }
}

Meteor.startup(() => ensureTaskIndexes())

export { ensureTaskIndexes }
