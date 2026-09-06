import assert from 'node:assert/strict'
import test from 'node:test'

import {
  BASE_HTTP_SECURITY_HEADERS,
  applyHttpSecurityHeaders,
  httpSecurityHeaders,
} from './httpSecurityHeaders.js'

test('browser-facing defaults prevent sniffing and unnecessary powerful features', () => {
  assert.deepEqual(httpSecurityHeaders(), BASE_HTTP_SECURITY_HEADERS)
  assert.equal(BASE_HTTP_SECURITY_HEADERS['X-Content-Type-Options'], 'nosniff')
  assert.equal(BASE_HTTP_SECURITY_HEADERS['Referrer-Policy'], 'no-referrer')
  assert.match(BASE_HTTP_SECURITY_HEADERS['Permissions-Policy'], /camera=\(\)/)
  assert.equal(BASE_HTTP_SECURITY_HEADERS['Cross-Origin-Opener-Policy'], 'same-origin-allow-popups')
})

test('HSTS is exact opt-in because TLS termination is deployment-specific', () => {
  assert.equal(httpSecurityHeaders({ TITRA_ENABLE_HSTS: 'TRUE' })['Strict-Transport-Security'], undefined)
  assert.equal(
    httpSecurityHeaders({ TITRA_ENABLE_HSTS: 'true' })['Strict-Transport-Security'],
    'max-age=31536000',
  )
})

test('header application does not mutate a response after headers were sent', () => {
  const calls = []
  applyHttpSecurityHeaders({
    headersSent: false,
    setHeader: (...args) => calls.push(args),
  })
  assert.equal(calls.length, Object.keys(BASE_HTTP_SECURITY_HEADERS).length)
  calls.length = 0
  applyHttpSecurityHeaders({ headersSent: true, setHeader: (...args) => calls.push(args) })
  assert.deepEqual(calls, [])
})
