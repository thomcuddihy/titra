import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createProjectFenceRecoveryHandler,
  validateProjectFenceRecoveryBody,
} from './projectFenceRecoveryRoutes.js'

function fixture(method = 'GET') {
  const calls = { authorize: 0, preview: [], read: 0, recover: [] }
  const responses = []
  const req = {
    method,
    headers: {},
    _parsedUrl: { pathname: '/project/recovery/project-1/' },
  }
  const res = {
    headers: {},
    setHeader(name, value) { this.headers[name] = value },
  }
  const dependencies = {
    authorize: async () => { calls.authorize += 1; return { _id: 'user-1' } },
    previewRecovery: async (args) => {
      calls.preview.push(structuredClone(args))
      return { payload: { projectId: args.projectId }, etag: '"recovery-preview"' }
    },
    readJson: async () => {
      calls.read += 1
      return {
        type: 'writer',
        recoveryId: 'writer:stale-resource',
        acknowledgeStaleFence: true,
      }
    },
    recover: async (args) => {
      calls.recover.push(structuredClone(args))
      return {
        payload: { cleared: { type: args.type, recoveryId: args.recoveryId } },
        etag: '"recovery-current"',
      }
    },
    sendResponse: (_res, status, message, payload) => {
      responses.push({ status, message, payload })
    },
  }
  return { calls, responses, req, res, dependencies }
}

test('GET returns an authenticated project preview and strong ETag', async () => {
  const f = fixture()
  await createProjectFenceRecoveryHandler(f.dependencies)(f.req, f.res)
  assert.deepEqual(f.calls.preview, [{ projectId: 'project-1', userId: 'user-1' }])
  assert.deepEqual(f.responses, [{
    status: 200,
    message: 'Returning project recovery state.',
    payload: { projectId: 'project-1' },
  }])
  assert.equal(f.res.headers.ETag, '"recovery-preview"')
})

test('POST forwards only the exact acknowledged target and preview ETag', async () => {
  const f = fixture('POST')
  f.req.headers = {
    'content-type': 'application/json; charset=utf-8',
    'if-match': '"recovery-preview"',
  }
  await createProjectFenceRecoveryHandler(f.dependencies)(f.req, f.res)
  assert.deepEqual(f.calls.recover, [{
    projectId: 'project-1',
    userId: 'user-1',
    expectedETag: '"recovery-preview"',
    type: 'writer',
    recoveryId: 'writer:stale-resource',
  }])
  assert.equal(f.responses[0].status, 200)
  assert.equal(f.res.headers.ETag, '"recovery-current"')
})

test('OPTIONS and wrong routes or methods terminate before authorization', async () => {
  const preflight = fixture('OPTIONS')
  await createProjectFenceRecoveryHandler(preflight.dependencies)(
    preflight.req, preflight.res,
  )
  assert.equal(preflight.responses[0].status, 204)
  assert.equal(preflight.res.headers.Allow, 'GET, POST, OPTIONS')
  assert.equal(preflight.calls.authorize, 0)

  const wrongRoute = fixture()
  wrongRoute.req._parsedUrl.pathname = '/project/recovery/project-1/extra/'
  await createProjectFenceRecoveryHandler(wrongRoute.dependencies)(
    wrongRoute.req, wrongRoute.res,
  )
  assert.equal(wrongRoute.responses[0].status, 404)
  assert.equal(wrongRoute.calls.authorize, 0)

  const wrongMethod = fixture('DELETE')
  await createProjectFenceRecoveryHandler(wrongMethod.dependencies)(
    wrongMethod.req, wrongMethod.res,
  )
  assert.equal(wrongMethod.responses[0].status, 405)
  assert.equal(wrongMethod.res.headers.Allow, 'GET, POST, OPTIONS')
  assert.equal(wrongMethod.calls.authorize, 0)
})

test('authorization denial, missing precondition, and wrong media type never mutate', async () => {
  const denied = fixture('POST')
  denied.dependencies.authorize = async () => null
  await createProjectFenceRecoveryHandler(denied.dependencies)(denied.req, denied.res)
  assert.deepEqual(denied.responses, [])
  assert.deepEqual(denied.calls.recover, [])

  const missing = fixture('POST')
  missing.req.headers['content-type'] = 'application/json'
  await createProjectFenceRecoveryHandler(missing.dependencies)(missing.req, missing.res)
  assert.equal(missing.responses[0].status, 428)
  assert.equal(missing.calls.read, 0)

  for (const contentType of [
    undefined, 'text/json', 'application/json; charset=latin1', 'application/json, text/plain',
  ]) {
    const media = fixture('POST')
    media.req.headers['if-match'] = '"recovery-preview"'
    if (contentType !== undefined) media.req.headers['content-type'] = contentType
    await createProjectFenceRecoveryHandler(media.dependencies)(media.req, media.res)
    assert.equal(media.responses[0].status, 415)
    assert.equal(media.calls.read, 0)
    assert.deepEqual(media.calls.recover, [])
  }
})

test('body validation requires exactly one explicit stale-fence acknowledgment', async () => {
  const valid = {
    type: 'writer', recoveryId: 'writer:stale-resource', acknowledgeStaleFence: true,
  }
  assert.equal(validateProjectFenceRecoveryBody(valid), valid)
  for (const body of [
    null,
    [],
    {},
    { ...valid, acknowledgeStaleFence: false },
    { ...valid, extra: true },
    { type: 'writer', recoveryId: 'writer:stale-resource' },
  ]) {
    assert.throws(() => validateProjectFenceRecoveryBody(body))
    const f = fixture('POST')
    f.req.headers = {
      'content-type': 'application/json', 'if-match': '"recovery-preview"',
    }
    f.dependencies.readJson = async () => body
    await createProjectFenceRecoveryHandler(f.dependencies)(f.req, f.res)
    assert.equal(f.responses[0].status, 400)
    assert.deepEqual(f.calls.recover, [])
  }
})

test('request parsing errors are narrow while internal TypeErrors remain HTTP 500', async () => {
  const cases = [
    [Object.assign(new Error('private-oversize-detail'), { type: 'entity.too.large' }), 413],
    [Object.assign(new Error('private-parse-detail'), { type: 'entity.parse.failed' }), 400],
    [new SyntaxError('private-syntax-detail'), 400],
    [new TypeError('private-reader-type-detail'), 500],
    [new Error('private-database-detail'), 500],
  ]
  for (const [error, expectedStatus] of cases) {
    const f = fixture('POST')
    f.req.headers = {
      'content-type': 'application/json', 'if-match': '"recovery-preview"',
    }
    f.dependencies.readJson = async () => { throw error }
    await createProjectFenceRecoveryHandler(f.dependencies)(f.req, f.res)
    assert.equal(f.responses[0].status, expectedStatus)
    assert.equal(f.responses[0].message.includes(error.message), false)
  }

  const internalRecover = fixture('POST')
  internalRecover.req.headers = {
    'content-type': 'application/json', 'if-match': '"recovery-preview"',
  }
  internalRecover.dependencies.recover = async () => {
    throw new TypeError('internal recovery bug')
  }
  await createProjectFenceRecoveryHandler(internalRecover.dependencies)(
    internalRecover.req, internalRecover.res,
  )
  assert.equal(internalRecover.responses[0].status, 500)
  assert.equal(internalRecover.responses[0].message.includes('internal recovery bug'), false)
})

test('only explicit service error codes receive public HTTP classifications', async () => {
  for (const [code, expectedStatus] of [
    ['not-authorized', 404],
    ['project-recovery-invalid', 400],
    ['project-recovery-conflict', 409],
    ['project-recovery-disabled', 503],
    ['project-recovery-state-invalid', 500],
    ['unexpected', 500],
  ]) {
    const get = fixture()
    get.dependencies.previewRecovery = async () => {
      throw Object.assign(new Error(`private ${code}`), { error: code })
    }
    await createProjectFenceRecoveryHandler(get.dependencies)(get.req, get.res)
    assert.equal(get.responses[0].status, expectedStatus)
    assert.equal(get.responses[0].message.includes(`private ${code}`), false)
  }
})
