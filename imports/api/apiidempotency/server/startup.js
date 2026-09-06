import { Meteor } from 'meteor/meteor'

import { ensureApiV6Indexes } from './indexes.js'

Meteor.startup(async () => {
  await ensureApiV6Indexes()
})
