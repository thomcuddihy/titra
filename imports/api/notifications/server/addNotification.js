import { Email } from 'meteor/email'
import { Random } from 'meteor/random'

import { getGlobalSettingAsync } from '../../../utils/server_method_helpers.js'
import DailyMailLimit from '../dailymaillimit.js'
import Notifications from '../notifications.js'
import {
  createMongoDailyMailStore,
  sendOncePerUtcDay,
} from './dailyMailDelivery.js'

const dailyMailStore = createMongoDailyMailStore(DailyMailLimit)

async function addNotification(message, userId) {
  const id = Random.id()
  const meteorUser = await Meteor.users.findOneAsync({
    _id: userId,
    inactive: { $ne: true },
  })
  const mailFrom = await getGlobalSettingAsync('fromAddress')
  const mailName = await getGlobalSettingAsync('fromName')
  let recipient = ''
  if (meteorUser) {
    recipient = meteorUser.emails[0].address
    await Notifications.removeAsync({ userId })
    await Notifications.insertAsync({ _id: id, userId, message })
    Meteor.setTimeout(async () => {
      await Notifications.removeAsync({ _id: id })
    }, 60000)
  } else {
    recipient = userId
  }
  const recipientName = meteorUser?.profile?.name || 'there'
  await sendOncePerUtcDay({
    recipient,
    reservationId: Random.id(),
    store: dailyMailStore,
    send: () => Email.sendAsync({
      to: recipient,
      from: `${mailName} <${mailFrom}>`,
      subject: `New notification from ${mailName}`,
      text: `Hey there ${recipientName},

I just wanted to let you know that something happened on ${mailName}:

${message}

Go to ${process.env.ROOT_URL} and login to learn more!

Have a nice day,
${mailName} Bot`,
    }),
  })
}

export { addNotification }
