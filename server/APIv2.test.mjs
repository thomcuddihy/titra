import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

function moduleUrl(path, replacements = {}) {
  let source = readFileSync(new URL(path, import.meta.url), 'utf8')
  Object.entries(replacements).forEach(([from, to]) => {
    source = source.replaceAll(`'${from}'`, JSON.stringify(to))
  })
  return `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
}

const contractsUrl = moduleUrl('./APIv2Contracts.js')
const contracts = await import(contractsUrl)
const route = await import(moduleUrl('./APIv2Route.js', {
  './APIv2Contracts.js': contractsUrl,
}))

function response() {
  return {
    headers: {}, writes: [],
    setHeader(name, value) { this.headers[name] = value },
    writeHead(status, headers) { this.status = status; Object.assign(this.headers, headers) },
    end(body) { this.writes.push(body == null ? undefined : JSON.parse(body)) },
  }
}

test('v2 capabilities describe the complete hardened API contract', () => {
  const value = contracts.apiV2Capabilities()
  assert.equal(value.apiVersion, 2)
  assert.equal(value.capabilitiesVersion, 2)
  assert.equal(value.features.timeEntries.taskEdit, 1)
  assert.equal(value.features.webhooks.actionVerificationReceiver, 3)
  assert.equal(value.features.pagination.stableCursor, 1)
  assert.equal(value.features.idempotency.create, 1)
  assert.equal(value.features.timers.atomicTransitions, 2)
  assert.equal(value.features.projects.emptyDelete, 1)
  assert.equal(value.features.projects.fenceRecovery, 1)
  assert.equal(value.contracts.projectFenceRecovery, 1)
  assert.deepEqual(value.contracts.webhookRetry, {
    version: 1,
    authenticationTimestamp: 'fresh',
    actionTimestamp: 'original',
    configurationBinding: 'revision',
    retentionSeconds: 604800,
    clientSafetyMarginSeconds: 600,
  })
  assert.deepEqual(value.contracts.timerStartReplay, {
    version: 1,
    scope: 'user',
    activeReplay: 'returnExisting',
    consumedReplay: 'conflict',
    consumedErrorCode: 'timer-operation-consumed',
    retentionSeconds: 604800,
    clientSafetyMarginSeconds: 600,
  })
  assert.deepEqual(value.contracts.expectedUserId, {
    version: 1,
    header: 'X-Titra-Expected-User-Id',
    appliesTo: 'authenticatedRequests',
    required: false,
    mismatchStatus: 412,
  })
  assert.equal(value.idempotency.retentionSeconds, 604800)
  assert.equal(value.timeEntryPagination.maxLimit, 500)
  assert.equal(value.timeEntryPagination.consistency, 'live-keyset')
  assert.equal(value.deployment.projectFenceRecoveryEnabled, false)
  assert.equal(value.deployment.webhookActionVerificationEnabled, false)
  assert.equal(value.contracts.errors.version, 1)
  assert.equal(value.contracts.errors.mediaType, 'application/problem+json')
  assert.equal(value.contracts.errors.otherAdvertisedRoutes, 'legacy-v1-envelope')
  assert.deepEqual(value.contracts.errors.routes, [
    { path: '/capabilities/v2', methods: ['GET'] },
    { path: '/user/action-verification/webhook/:endpointId', methods: ['POST'] },
  ])
  assert.equal(value.limits.webhookBodyBytes, 65536)
  assert.equal(value.limits.webhookProcessingLeaseSeconds, 60)
  assert.equal(value.limits.timerStartRetainedOperations, 4096)
  assert.equal(value.limits.projectFenceRecoveryMinimumAgeSeconds, 900)
  assert.equal(value.mutationPreconditions.version, 2)
  const mutations = new Map(value.mutationPreconditions.operations
    .map((operation) => [operation.id, operation]))
  assert.equal(mutations.size, value.mutationPreconditions.operations.length)
  assert.deepEqual(mutations.get('timeEntry.taskEdit').headers, [
    'Content-Type: application/json', 'If-Match',
  ])
  assert.ok(mutations.get('projectTask.delete').bodyPreconditions
    .includes('acknowledgeRecordedEntries when required'))
  assert.deepEqual(mutations.get('projectTask.create').bodyPreconditions, [
    'start/end canonical UTC RFC3339 milliseconds',
  ])
  assert.deepEqual(mutations.get('project.fenceRecovery').bodyPreconditions, [
    'type', 'recoveryId', 'acknowledgeStaleFence=true',
  ])
  assert.ok(mutations.get('project.fenceRecovery').guards.includes('exactCompareAndSwap'))
  assert.deepEqual(mutations.get('timer.stop').bodyPreconditions, ['timerId'])
  assert.ok(mutations.get('timer.start').guards.includes('unconsumedOperationId'))
  assert.ok(mutations.get('webhook.actionVerification').guards.includes('hmacSha256'))
  assert.equal(
    contracts.apiV2Capabilities({
      projectFenceRecoveryEnabled: true,
      webhookActionVerificationEnabled: true,
    }).deployment.webhookActionVerificationEnabled,
    true,
  )
  assert.equal(
    contracts.apiV2Capabilities({ projectFenceRecoveryEnabled: true })
      .deployment.projectFenceRecoveryEnabled,
    true,
  )
})

test('problem contract maps every public code without accepting arbitrary messages', () => {
  for (const [code, definition] of Object.entries(contracts.API_V2_PROBLEMS)) {
    const problem = contracts.apiV2Problem(code, { id: 'request_1234567890' })
    assert.equal(problem.status, definition[0])
    assert.equal(problem.body.error.code, code)
    assert.equal(problem.body.error.version, 1)
    assert.equal(problem.body.error.requestId, 'request_1234567890')
    assert.ok(['rejected', 'unknown'].includes(problem.body.error.outcome))
    assert.equal(problem.body.error.retry.allowed, false)
  }
  const unknown = contracts.apiV2Problem('PRIVATE_DATABASE_SECRET', {
    id: 'bad id containing a token',
  })
  assert.equal(unknown.body.error.code, 'INTERNAL_ERROR')
  assert.doesNotMatch(JSON.stringify(unknown), /PRIVATE|token|DATABASE/)
})

test('expected-user mismatch has the stable rejected 412 problem contract', () => {
  assert.deepEqual(contracts.API_V2_PROBLEMS.PRECONDITION_FAILED, [
    412,
    'precondition',
    'A write precondition failed.',
    'rejected',
  ])
  const problem = contracts.apiV2Problem('PRECONDITION_FAILED', {
    id: 'expected_user_mismatch_1',
  })
  assert.equal(problem.status, 412)
  assert.deepEqual(problem.body.error, {
    version: 1,
    code: 'PRECONDITION_FAILED',
    category: 'precondition',
    message: 'A write precondition failed.',
    requestId: 'expected_user_mismatch_1',
    outcome: 'rejected',
    retry: { allowed: false },
  })
})

test('overdue action verification has a stable non-reflective 403 problem contract', () => {
  assert.deepEqual(contracts.API_V2_PROBLEMS.ACTION_VERIFICATION_REQUIRED, [
    403,
    'authorization',
    'Required account verification is overdue.',
    'rejected',
  ])
  const problem = contracts.apiV2Problem('ACTION_VERIFICATION_REQUIRED', {
    id: 'verification_required_1',
  })
  assert.equal(problem.status, 403)
  assert.equal(problem.body.error.code, 'ACTION_VERIFICATION_REQUIRED')
  assert.equal(problem.body.error.category, 'authorization')
  assert.equal(problem.body.error.outcome, 'rejected')
  assert.equal(problem.body.error.retry.allowed, false)
})

test('problem responses expose request/retry metadata with no cache or secret reflection', () => {
  const res = response()
  contracts.sendAPIv2Problem(res, 'WEBHOOK_PROCESSING', {
    id: 'stable_request_1234', retryAfterSeconds: 5, ignored: 'secret',
  })
  assert.equal(res.status, 503)
  assert.equal(res.headers['Content-Type'], 'application/problem+json')
  assert.equal(res.headers['Cache-Control'], 'no-store')
  assert.equal(res.headers['X-Request-ID'], 'stable_request_1234')
  assert.equal(res.headers['Retry-After'], '5')
  assert.equal(res.writes[0].error.category, 'processing')
  assert.equal(res.writes[0].error.outcome, 'unknown')
  assert.match(res.writes[0].error.message, /retry after/i)
  assert.equal(res.writes[0].error.retry.allowed, true)
  assert.equal(res.writes[0].error.retry.afterSeconds, 5)
  assert.doesNotMatch(JSON.stringify(res.writes), /secret/)
})

test('success response has v2 envelope, CORS security headers and an empty 204 body', () => {
  const ok = response()
  contracts.sendAPIv2(ok, 200, { safe: true }, { id: 'request_success_1' })
  assert.deepEqual(ok.writes, [{ apiVersion: 2, payload: { safe: true } }])
  assert.match(ok.headers['Access-Control-Allow-Headers'], /X-Titra-Webhook-Signature/)
  const allowedHeaders = new Set(ok.headers['Access-Control-Allow-Headers'].split(', '))
  assert.ok(allowedHeaders.has('X-Titra-Expected-User-Id'))
  assert.match(ok.headers['Access-Control-Expose-Headers'], /X-Request-ID/)
  const empty = response()
  contracts.sendAPIv2(empty, 204, undefined, { id: 'request_success_2' })
  assert.deepEqual(empty.writes, [undefined])
})

test('capability handler is authenticated for GET, strict-path and preflights before auth', async () => {
  let authCalls = 0
  const handler = route.createAPIv2CapabilitiesHandler({
    authorize: async () => { authCalls += 1; return { _id: 'user-1' } },
    configuration: async () => ({
      projectFenceRecoveryEnabled: true,
      webhookActionVerificationEnabled: true,
    }),
  })
  const ok = response()
  await handler({
    method: 'GET', headers: {}, _parsedUrl: { pathname: '/capabilities/v2/' },
  }, ok)
  assert.equal(ok.status, 200)
  assert.equal(ok.writes[0].payload.apiVersion, 2)
  assert.equal(ok.writes[0].payload.deployment.webhookActionVerificationEnabled, true)
  assert.equal(ok.writes[0].payload.deployment.projectFenceRecoveryEnabled, true)
  assert.equal(authCalls, 1)
  for (const [pathname, method, status] of [
    ['/capabilities/v2', 'OPTIONS', 204],
    ['/capabilities/v2/', 'POST', 405],
    ['/capabilities/v2/extra', 'GET', 404],
  ]) {
    const res = response()
    const before = authCalls
    await handler({ method, headers: {}, _parsedUrl: { pathname } }, res)
    assert.equal(res.status, status)
    assert.equal(authCalls, before)
  }
})

test('capability authorization denial is terminal and writes no v2 success', async () => {
  const handler = route.createAPIv2CapabilitiesHandler({
    authorize: async (_req, res) => {
      contracts.sendAPIv2Problem(res, 'UNAUTHENTICATED')
      return false
    },
  })
  const res = response()
  await handler({ method: 'GET', headers: {}, _parsedUrl: { pathname: '/capabilities/v2' } }, res)
  assert.equal(res.status, 401)
  assert.equal(res.writes.length, 1)
})
