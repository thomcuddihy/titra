import assert from 'node:assert/strict'
import test from 'node:test'

import {
  integrationRequest,
  isNonPublicAddress,
  MAX_RESPONSE_BYTES,
  MAX_RESULTS,
  MAX_SIWAPP_REQUEST_BYTES,
  MAX_SIWAPP_RESPONSE_BYTES,
  MAX_WEKAN_RESPONSE_BYTES,
  MAX_WEKAN_SELECTORS,
  inspectWekanConfiguration,
  normalizeGitlabQuery,
  normalizeIntegrationBaseUrl,
  normalizeWekanSelectors,
  normalizeWekanStoredUrl,
  parseWekanConfiguration,
  privateHostnameAllowed,
  REQUEST_TIMEOUT_MS,
  requestTaskIntegrationSuggestions,
  requestWekanTaskSuggestions,
  resolvePinnedTarget,
  sanitizeSuggestions,
  sendSiwappInvoice,
  TaskIntegrationError,
} from './taskIntegrationProxy.js'

const production = { NODE_ENV: 'production' }

test('integration base URLs require credential-free HTTPS URLs', () => {
  assert.equal(
    normalizeIntegrationBaseUrl('https://tickets.example.test/root', production).href,
    'https://tickets.example.test/root/',
  )
  for (const input of [
    'http://tickets.example.test/',
    'ftp://tickets.example.test/',
    'https://user:secret@tickets.example.test/',
    'https://tickets.example.test/#secret',
    'https://tickets.example.test/?secret=true',
    ' https://tickets.example.test/',
  ]) assert.throws(() => normalizeIntegrationBaseUrl(input, production), TaskIntegrationError)
})

test('HTTP is restricted to an explicit loopback-only development opt-in', () => {
  const allowed = {
    NODE_ENV: 'development',
    TITRA_ALLOW_LOOPBACK_HTTP_INTEGRATIONS: 'true',
  }
  assert.equal(normalizeIntegrationBaseUrl('http://localhost:3000/', allowed).protocol, 'http:')
  assert.equal(normalizeIntegrationBaseUrl('http://[::1]:3000/', allowed).protocol, 'http:')
  assert.throws(
    () => normalizeIntegrationBaseUrl('http://10.0.0.2/', allowed),
    TaskIntegrationError,
  )
  assert.throws(
    () => normalizeIntegrationBaseUrl('http://localhost/', { ...allowed, NODE_ENV: 'production' }),
    TaskIntegrationError,
  )
})

test('non-public IP detection covers local, private, metadata and mapped addresses', () => {
  for (const address of [
    '0.0.0.0', '10.1.2.3', '100.64.0.1', '127.0.0.1', '169.254.169.254',
    '172.31.1.1', '192.168.1.1', '198.18.0.1', '::', '::1', 'fd00::1',
    'fe80::1', '::ffff:127.0.0.1', '2001:db8::1', '2001::1',
    '2002:7f00:1::', '64:ff9b::a9fe:a9fe',
  ]) assert.equal(isNonPublicAddress(address), true, address)
  assert.equal(isNonPublicAddress('8.8.8.8'), false)
  assert.equal(isNonPublicAddress('2606:4700:4700::1111'), false)
})

test('DNS targets are pinned and any private answer fails closed without an opt-in', async () => {
  const url = new URL('https://tickets.example.test/')
  const lookup = async () => [
    { address: '203.0.113.5', family: 4 },
    { address: '127.0.0.1', family: 4 },
  ]
  await assert.rejects(resolvePinnedTarget(url, { environment: production, lookup }), {
    code: 'integration-endpoint-private',
  })
  assert.deepEqual(await resolvePinnedTarget(url, {
    environment: {
      ...production,
      TITRA_PRIVATE_INTEGRATION_HOSTS: 'other.example.test, tickets.example.test',
    },
    lookup,
  }), { address: '203.0.113.5', family: 4 })
  assert.equal(privateHostnameAllowed('tickets.example.test', {
    TITRA_PRIVATE_INTEGRATION_HOSTS: '*.example.test',
  }), false)
  assert.equal(privateHostnameAllowed('tickets.example.test', {
    TITRA_PRIVATE_INTEGRATION_HOSTS: 'evil.example.test,tickets.example.test.evil',
  }), false)
})

test('development loopback request resolution needs no broader private-host exception', async () => {
  assert.deepEqual(await resolvePinnedTarget(new URL('http://localhost:3000/'), {
    environment: {
      NODE_ENV: 'development',
      TITRA_ALLOW_LOOPBACK_HTTP_INTEGRATIONS: 'true',
    },
    lookup: async () => [{ address: '127.0.0.1', family: 4 }],
  }), { address: '127.0.0.1', family: 4 })
})

test('provider requests use fixed API paths and server-only authentication headers', () => {
  const zammad = integrationRequest({
    provider: 'zammad',
    profile: { zammadurl: 'https://tickets.example.test/helpdesk/', zammadtoken: ' secret ' },
    project: {},
  }, production)
  assert.equal(zammad.url.href, 'https://tickets.example.test/helpdesk/api/v1/tickets')
  assert.deepEqual(zammad.headers, { Authorization: 'Token token=secret' })

  const gitlab = integrationRequest({
    provider: 'gitlab',
    profile: { gitlaburl: 'https://git.example.test/', gitlabtoken: 'token' },
    project: { gitlabquery: 'projects/42/issues?state=opened' },
  }, production)
  assert.equal(gitlab.url.href, 'https://git.example.test/api/v4/projects/42/issues?state=opened')
  assert.deepEqual(gitlab.headers, { 'PRIVATE-TOKEN': 'token' })
})

test('GitLab relative queries reject traversal and URL-control syntax', () => {
  assert.equal(normalizeGitlabQuery(undefined), 'issues')
  assert.equal(normalizeGitlabQuery('projects/1/issues?state=opened'), 'projects/1/issues?state=opened')
  for (const value of [
    '/issues', '../admin', 'projects/%2e%2e/admin', 'issues#fragment', 'issues\\admin',
    ' issues', 'issues\nX-Test: value',
  ]) assert.throws(() => normalizeGitlabQuery(value), TaskIntegrationError)
})

test('Wekan export URLs are parsed without putting the bearer token in request URLs', () => {
  const configuration = parseWekanConfiguration(
    'https://wekan.example.test/root/api/boards/board_1/export?authToken=secret%20token',
    production,
  )
  assert.equal(
    configuration.baseUrl.href,
    'https://wekan.example.test/root/api/boards/board_1/',
  )
  assert.equal(configuration.boardId, 'board_1')
  assert.equal(configuration.credential, 'secret token')
  assert.equal(configuration.baseUrl.href.includes('secret'), false)
  assert.equal(normalizeWekanStoredUrl(
    'https://wekan.example.test/api/boards/board/export?authToken=secret%20token',
    production,
  ), 'https://wekan.example.test/api/boards/board/export?authToken=secret+token')
})

test('Wekan rejects Sandstorm, URL control, extra parameters, and unsafe transport', () => {
  for (const input of [
    'https://wekan.example.test/#capability',
    'https://user:secret@wekan.example.test/api/boards/board/export?authToken=token',
    'https://wekan.example.test/api/boards/board/export?authToken=token&next=/admin',
    'https://wekan.example.test/api/boards/board/export?authToken=one&authToken=two',
    'https://wekan.example.test/api/boards/../admin/export?authToken=token',
    'https://wekan.example.test/api/boards/%62oard/export?authToken=token',
    'https://wekan.example.test/api/boards/board/cards?authToken=token',
    'http://wekan.example.test/api/boards/board/export?authToken=token',
  ]) assert.throws(() => parseWekanConfiguration(input, production), TaskIntegrationError)
})

test('Wekan selector IDs are deduplicated and strictly bounded', () => {
  assert.deepEqual(normalizeWekanSelectors('list-one'), ['list-one'])
  assert.deepEqual(normalizeWekanSelectors(['list-one', 'list-one']), ['list-one'])
  assert.throws(() => normalizeWekanSelectors(['../admin']), TaskIntegrationError)
  const tooMany = Array.from(
    { length: MAX_WEKAN_SELECTORS + 1 },
    (_, index) => `list-${index}`,
  )
  assert.throws(() => normalizeWekanSelectors(tooMany), TaskIntegrationError)
})

test('Wekan list and swimlane inspection is pinned, bounded, and whitelisted', async () => {
  const calls = []
  const result = await inspectWekanConfiguration(
    'https://wekan.example.test/api/boards/board/export?authToken=secret',
    {
      environment: production,
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      request: async (url, options) => {
        calls.push({ url: url.href, options })
        return url.pathname.endsWith('/lists')
          ? [{ _id: 'list_1', title: '<b>Inbox</b>', token: 'never-returned' }]
          : [{ _id: 'swimlane_1', title: 'Default', private: true }]
      },
    },
  )
  assert.deepEqual(result, {
    lists: [{ _id: 'list_1', title: '<b>Inbox</b>' }],
    swimlanes: [{ _id: 'swimlane_1', title: 'Default' }],
  })
  assert.deepEqual(calls.map(({ url }) => url), [
    'https://wekan.example.test/api/boards/board/lists',
    'https://wekan.example.test/api/boards/board/swimlanes',
  ])
  for (const call of calls) {
    assert.equal(call.url.includes('secret'), false)
    assert.deepEqual(call.options.headers, { Authorization: 'Bearer secret' })
    assert.equal(call.options.target.address, '93.184.216.34')
    assert.equal(call.options.maxBytes, MAX_WEKAN_RESPONSE_BYTES)
    assert.equal(call.options.timeoutMs, REQUEST_TIMEOUT_MS)
  }
  assert.equal(JSON.stringify(result).includes('never-returned'), false)
})

test('Wekan card requests use selected swimlanes first and return safe bounded data', async () => {
  const calls = []
  const suggestions = await requestWekanTaskSuggestions({
    wekanurl: 'https://wekan.example.test/api/boards/board/export?authToken=secret',
    selectedWekanSwimlanes: ['lane_one', 'lane_two'],
    selectedWekanList: ['must_not_be_requested'],
  }, {
    environment: production,
    lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    request: async (url) => {
      calls.push(url.href)
      return [
        { title: 'Card', description: 'Description', credential: 'never-returned' },
        { title: 'Archived', description: 'Hidden', archived: true },
      ]
    },
  })
  assert.deepEqual(calls, [
    'https://wekan.example.test/api/boards/board/swimlanes/lane_one/cards',
    'https://wekan.example.test/api/boards/board/swimlanes/lane_two/cards',
  ])
  assert.deepEqual(suggestions, [{ title: 'Card', description: 'Description' }])
  assert.equal(JSON.stringify(suggestions).includes('never-returned'), false)
})

test('Wekan outbound requests reject private DNS before any HTTP request', async () => {
  let requested = false
  await assert.rejects(inspectWekanConfiguration(
    'https://wekan.example.test/api/boards/board/export?authToken=secret',
    {
      environment: production,
      lookup: async () => [{ address: '169.254.169.254', family: 4 }],
      request: async () => { requested = true; return [] },
    },
  ), { code: 'integration-endpoint-private' })
  assert.equal(requested, false)
})

test('responses are bounded, whitelisted and stripped of provider secrets', () => {
  const oversized = 'x'.repeat(5000)
  const input = Array.from({ length: MAX_RESULTS + 10 }, (_, index) => ({
    id: index,
    title: index === 1 ? '' : `Ticket ${index}`,
    description: oversized,
    note: `Note ${index}`,
    token: 'must-not-leak',
    nested: { private: true },
  }))
  const result = sanitizeSuggestions('gitlab', input)
  assert.equal(result.length, MAX_RESULTS - 1)
  assert.deepEqual(Object.keys(result[0]), ['title', 'description'])
  assert.equal(result[0].description.length, 4096)
  assert.equal(JSON.stringify(result).includes('must-not-leak'), false)
})

test('request orchestration pins DNS and enforces common size/time limits', async () => {
  const calls = []
  const result = await requestTaskIntegrationSuggestions({
    provider: 'zammad',
    profile: { zammadurl: 'https://tickets.example.test/', zammadtoken: 'token' },
    project: { _id: 'project' },
  }, {
    environment: production,
    lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    request: async (url, options) => {
      calls.push({ url: url.href, options })
      return [{ title: 'A', note: 'B', credential: 'never-returned' }]
    },
  })
  assert.deepEqual(result, [{ title: 'A', description: 'B' }])
  assert.equal(calls[0].url, 'https://tickets.example.test/api/v1/tickets')
  assert.equal(calls[0].options.target.address, '93.184.216.34')
  assert.equal(calls[0].options.maxBytes, MAX_RESPONSE_BYTES)
  assert.equal(calls[0].options.timeoutMs, REQUEST_TIMEOUT_MS)
})

test('non-array upstream documents are rejected', () => {
  assert.throws(() => sanitizeSuggestions('zammad', { tickets: [] }), {
    code: 'integration-response-invalid',
  })
})

test('Siwapp invoices use the pinned bounded transport and fixed endpoint', async () => {
  const calls = []
  const invoice = { data: { attributes: { draft: true } } }
  assert.equal(await sendSiwappInvoice({
    profile: { siwappurl: 'https://billing.example.test/root/', siwapptoken: 'token' },
    invoice,
  }, {
    environment: production,
    lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    request: async (url, options) => {
      calls.push({ url: url.href, options })
      return { status: 201 }
    },
  }), true)
  assert.equal(calls[0].url, 'https://billing.example.test/root/api/v1/invoices')
  assert.equal(calls[0].options.body, JSON.stringify(invoice))
  assert.deepEqual(calls[0].options.headers, { Authorization: 'Token token=token' })
  assert.equal(calls[0].options.target.address, '93.184.216.34')
  assert.equal(calls[0].options.maxResponseBytes, MAX_SIWAPP_RESPONSE_BYTES)
  assert.equal(calls[0].options.timeoutMs, REQUEST_TIMEOUT_MS)
})

test('Siwapp rejects redirects, oversized requests and private endpoints', async () => {
  const common = {
    profile: { siwappurl: 'https://billing.example.test/', siwapptoken: 'token' },
    invoice: { data: {} },
  }
  await assert.rejects(sendSiwappInvoice(common, {
    environment: production,
    lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    request: async () => ({ status: 302 }),
  }), { code: 'integration-unavailable' })
  await assert.rejects(sendSiwappInvoice({
    ...common,
    invoice: { data: 'x'.repeat(MAX_SIWAPP_REQUEST_BYTES) },
  }, {
    environment: production,
    lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    request: async () => ({ status: 201 }),
  }), { code: 'integration-request-too-large' })
  await assert.rejects(sendSiwappInvoice(common, {
    environment: production,
    lookup: async () => [{ address: '169.254.169.254', family: 4 }],
    request: async () => ({ status: 201 }),
  }), { code: 'integration-endpoint-private' })
})
