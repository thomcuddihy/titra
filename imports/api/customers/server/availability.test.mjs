import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const publications = await readFile(
  new URL('./publications.js', import.meta.url), 'utf8',
)
const methods = await readFile(new URL('./methods.js', import.meta.url), 'utf8')

test('customer publication has independent start-rate and active-retention bounds', () => {
  assert.match(publications, /createActivePublicationGate\(\{\s*perUser: 20,/)
  assert.match(publications, /customerPublicationGate\.acquire\(\{/)
  assert.match(publications, /userId: context\.userId,/)
  assert.match(publications, /peerAddress: context\.connection\?\.clientAddress,/)
  assert.equal((publications.match(/DDPRateLimiter\.addRule\(\{/g) || []).length, 2)
  assert.match(publications, /userId\(userId\)/)
  assert.match(publications, /clientAddress\(clientAddress\)/)
})

test('customer publication observes one bounded projected project window', () => {
  assert.match(publications, /fields: customerProjectFields,/)
  assert.match(publications, /sort: \{ _id: 1 \},/)
  assert.match(publications, /limit: MAX_CUSTOMER_PROJECTS \+ 1,/)
  assert.match(publications, /projects\.size > MAX_CUSTOMER_PROJECTS/)
  assert.match(publications, /reconciler\.removeAll\(\)/)
  assert.match(publications, /this\.error\(new Meteor\.Error\(/)
})

test('explicit customer project scopes publish only when the exact scope is visible', () => {
  assert.match(
    publications,
    /requestedIds === null \|\| projects\.size === requestedIds\.length/,
  )
  assert.match(publications, /exactScopeVisible \? customerPublicationDocuments/)
})

test('getAllCustomers delegates to the bounded aggregation and has caller rate rules', () => {
  assert.match(methods, /aggregateBoundedCustomers\(\{/)
  assert.match(methods, /aggregate\(pipeline, options\)\.toArray\(\)/)
  assert.equal((methods.match(/DDPRateLimiter\.addRule\(\{/g) || []).length, 2)
  assert.match(methods, /type: 'method',\s*name: 'getAllCustomers'/)
  assert.doesNotMatch(methods, /aggregate\(\[\{\s*\$match:/)
})
