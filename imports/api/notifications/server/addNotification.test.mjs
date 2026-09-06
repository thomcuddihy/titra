import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const sharedCollection = readFileSync(new URL('../notifications.js', import.meta.url), 'utf8')
const serverDelivery = readFileSync(new URL('./addNotification.js', import.meta.url), 'utf8')
const projectMethods = readFileSync(
  new URL('../../projects/server/methods.js', import.meta.url), 'utf8',
)

test('client notification collection has no server mail or crypto dependency', () => {
  assert.match(sharedCollection, /new Mongo\.Collection\('notifications'\)/)
  assert.doesNotMatch(sharedCollection, /meteor\/email|dailyMail|node:crypto/)
  assert.match(sharedCollection, /export default Notifications/)
})

test('project invitations use the atomic server-only delivery path', () => {
  assert.match(
    projectMethods,
    /from '\.\.\/\.\.\/notifications\/server\/addNotification\.js'/,
  )
  assert.match(serverDelivery, /sendOncePerUtcDay\(/)
  assert.match(serverDelivery, /reservationId: Random\.id\(\)/)
  assert.match(serverDelivery, /send: \(\) => Email\.sendAsync\(/)
  assert.doesNotMatch(serverDelivery, /DailyMailLimit\.(?:insert|findOne)/)
})
