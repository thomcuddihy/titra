import { Meteor } from 'meteor/meteor'

import DailyMailLimit from '../dailymaillimit.js'

async function ensureDailyMailLimitIndexes(collection = DailyMailLimit) {
  const raw = collection.rawCollection()
  await raw.createIndex(
    { expiresAt: 1 },
    { expireAfterSeconds: 0, name: 'daily_mail_limit_expiry' },
  )
  await raw.createIndex(
    { email: 1, timestamp: 1 },
    {
      name: 'daily_mail_legacy_lookup',
      partialFilterExpression: {
        email: { $type: 'string' },
        timestamp: { $type: 'date' },
      },
    },
  )
}

Meteor.startup(() => ensureDailyMailLimitIndexes())

export { ensureDailyMailLimitIndexes }
