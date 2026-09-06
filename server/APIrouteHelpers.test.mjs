import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const tokenSecurityModuleUrl = new URL('./apiTokenSecurity.js', import.meta.url).href
const publicationAuthenticationModuleUrl = new URL(
  '../imports/utils/publicationAuthentication.js', import.meta.url,
).href
const helperSource = readFileSync(new URL('./APIrouteHelpers.js', import.meta.url), 'utf8')
  .replaceAll("'./apiTokenSecurity.js'", JSON.stringify(tokenSecurityModuleUrl))
  .replaceAll(
    "'../imports/utils/publicationAuthentication.js'",
    JSON.stringify(publicationAuthenticationModuleUrl),
  )
const helperModuleUrl = `data:text/javascript;base64,${Buffer.from(helperSource).toString('base64')}`

const {
  authorizeAPIRequest,
  expectedAPIUserPrecondition,
  parseCanonicalUTCMillisecondTimestamp,
  publicUserIdentity,
  routeParameters,
  singleRouteParameter,
} = await import(helperModuleUrl)

test('expected API user precondition binds every authenticated request except preflight', () => {
  const matching = { 'x-titra-expected-user-id': 'user_123-ABC' }
  assert.equal(expectedAPIUserPrecondition('POST', {}, 'user_123-ABC'), true)
  assert.equal(expectedAPIUserPrecondition('PATCH', matching, 'user_123-ABC'), true)
  assert.equal(expectedAPIUserPrecondition('DELETE', matching, 'another-user'), false)
  assert.equal(expectedAPIUserPrecondition('GET', matching, 'another-user'), false)
  assert.equal(expectedAPIUserPrecondition('HEAD', matching, 'another-user'), false)
  assert.equal(expectedAPIUserPrecondition('OPTIONS', matching, 'another-user'), true)

  for (const invalid of ['', ' has-spaces', 'has spaces', 'comma,value', 'x'.repeat(129), 42]) {
    assert.equal(
      expectedAPIUserPrecondition(
        'POST', { 'x-titra-expected-user-id': invalid }, String(invalid),
      ),
      false,
      String(invalid),
    )
  }
})

test('request authorization withholds the user when the atomic identity pin fails', async () => {
  const user = { _id: 'user-1', profile: { APItoken: 'secret' } }
  const findUser = async (selector) => (Object.hasOwn(selector, 'profile.APItoken') ? user : null)
  const authorized = await authorizeAPIRequest({
    method: 'POST',
    headers: {
      authorization: 'Bearer secret',
      'x-titra-expected-user-id': 'user-1',
    },
  }, findUser)
  assert.equal(authorized.status, 'authorized')
  assert.equal(authorized.user, user)

  const blocked = await authorizeAPIRequest({
    method: 'POST',
    headers: {
      authorization: 'Bearer secret',
      'x-titra-expected-user-id': 'user-2',
    },
  }, findUser)
  assert.deepEqual(blocked, { status: 'precondition_failed' })
  assert.equal(Object.hasOwn(blocked, 'user'), false)

  assert.deepEqual(await authorizeAPIRequest({
    method: 'GET',
    headers: {
      authorization: 'Bearer secret',
      'x-titra-expected-user-id': 'user-2',
    },
  }, findUser), { status: 'precondition_failed' })

  assert.deepEqual(await authorizeAPIRequest({
    method: 'POST', headers: { authorization: 'Bearer invalid' },
  }, async () => null), { status: 'unauthenticated' })
})

test('request authorization enforces overdue and malformed action verification state', async () => {
  const request = {
    method: 'GET',
    headers: { authorization: 'Bearer legacy-token' },
  }
  const authorizeUser = (user) => authorizeAPIRequest(
    request,
    async (selector) => (Object.hasOwn(selector, 'profile.APItoken') ? user : null),
  )
  for (const actionVerification of [
    undefined,
    { required: false },
    { required: true, completed: false, deadline: new Date('2999-01-01T00:00:00.000Z') },
    { required: true, completed: true, deadline: new Date('2000-01-01T00:00:00.000Z') },
  ]) {
    const user = {
      _id: 'user-1', profile: { APItoken: 'legacy-token' }, actionVerification,
    }
    assert.equal((await authorizeUser(user)).status, 'authorized')
  }

  for (const actionVerification of [
    { required: true, completed: false, deadline: new Date('2000-01-01T00:00:00.000Z') },
    { required: true, completed: false, deadline: '2000-01-01T00:00:00.000Z' },
    { required: true, completed: false },
  ]) {
    const decision = await authorizeUser({
      _id: 'user-1', profile: { APItoken: 'legacy-token' }, actionVerification,
    })
    assert.deepEqual(decision, { status: 'action_verification_required' })
    assert.equal(Object.hasOwn(decision, 'user'), false)
  }

  const routes = readFileSync(new URL('./APIroutes.js', import.meta.url), 'utf8')
  assert.match(routes, /action_verification_required[\s\S]*sendResponse\(res, 403/)
  assert.match(routes, /action_verification_required[\s\S]*ACTION_VERIFICATION_REQUIRED/)
})

test('parses only canonical UTC RFC3339 timestamps with exact milliseconds', () => {
  const value = '2026-09-01T02:03:04.005Z'
  assert.equal(parseCanonicalUTCMillisecondTimestamp(value).toISOString(), value)
  for (const invalid of [
    null,
    0,
    true,
    [],
    {},
    '2026-09-01',
    '2026-09-01T02:03:04Z',
    '2026-09-01T02:03:04.0050Z',
    '2026-09-01T02:03:04.005z',
    '2026-09-01T02:03:04.005+00:00',
    '2026-09-01 02:03:04.005Z',
    '2026-02-29T02:03:04.005Z',
    '2026-09-01T24:00:00.000Z',
    '2026-09-01T02:03:60.000Z',
  ]) {
    assert.throws(
      () => parseCanonicalUTCMillisecondTimestamp(invalid),
      /canonical UTC timestamp/,
      String(invalid),
    )
  }
})

test('extracts exactly one decoded route parameter', () => {
  assert.equal(
    singleRouteParameter('/timeentry/get/abc%20123/', '/timeentry/get'),
    'abc 123',
  )
  assert.throws(
    () => singleRouteParameter('/timeentry/get/', '/timeentry/get'),
    /exactly 1 route parameter/,
  )
  assert.throws(
    () => singleRouteParameter('/timeentry/get/one/two', '/timeentry/get'),
    /exactly 1 route parameter/,
  )
  assert.throws(
    () => singleRouteParameter('/project/users/abc', '/timeentry/get'),
    /exactly 1 route parameter/,
  )
  assert.throws(
    () => singleRouteParameter('/timeentry/get/%E0%A4%A', '/timeentry/get'),
    /URI malformed/,
  )
})

test('extracts an exact, decoded and bounded route parameter tuple', () => {
  assert.deepEqual(
    routeParameters('/project/range/p1/2026-01-01/2026-01-31/', '/project/range', 3),
    ['p1', '2026-01-01', '2026-01-31'],
  )
  assert.throws(() => routeParameters('/project/range/p1/extra', '/project/range', 1))
  assert.throws(() => routeParameters('/project/range/p1', '/other', 1))
  assert.throws(() => routeParameters('/project/range/p1', '/project/range', -1))
})

test('limits API user identity output to ID and display name', () => {
  assert.deepEqual(publicUserIdentity({
    _id: 'user-1',
    username: 'private-login',
    emails: [{ address: 'private@example.test' }],
    profile: {
      name: 'Display Name',
      APItoken: 'secret-token',
      timer: new Date(),
    },
    isAdmin: true,
  }), {
    _id: 'user-1',
    name: 'Display Name',
  })
  assert.deepEqual(publicUserIdentity({
    _id: 'user-2',
    profile: {},
  }), {
    _id: 'user-2',
    name: null,
  })
})
