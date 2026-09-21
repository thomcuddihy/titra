import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { applyXlsxWorkerPolicy, withXlsxWorkerPolicy } from './xlsxWorkerPolicy.js'

test('XLSX worker permission is separate from and preserves all existing CSP directives', () => {
  const original = "default-src 'self'; script-src 'self' 'nonce-AbC123' 'sha256-MixedCase'; object-src 'none'; frame-ancestors https://example.invalid; connect-src 'self' wss://example.invalid;"
  const result = withXlsxWorkerPolicy(original)
  assert.equal(result, `${original} worker-src 'self' blob:;`)
  assert.equal(withXlsxWorkerPolicy(result), result)
  assert.doesNotMatch(result.split(';').find((directive) => directive.trim().startsWith('script-src')), /blob:|unsafe-eval/)
  assert.equal(withXlsxWorkerPolicy("default-src 'self'"), "default-src 'self'; worker-src 'self' blob:;")
})

test('explicit operator worker restrictions are not overridden', () => {
  for (const original of [
    "default-src 'self'; worker-src 'none';",
    "default-src 'self'; worker-src 'self';",
    "default-src 'self'; WoRkEr-SrC https://workers.example.invalid;",
    "default-src 'self'; worker-src;",
  ]) assert.equal(withXlsxWorkerPolicy(original), original)
})

test('policy application preserves multiple headers and does not invent a replacement CSP', () => {
  const original = ["default-src 'self'; script-src 'self';", "object-src 'none'; worker-src 'none';"]
  const changes = []
  const response = {
    headersSent: false,
    getHeader(name) {
      assert.equal(name, 'Content-Security-Policy')
      return original
    },
    setHeader: (...args) => changes.push(args),
  }
  applyXlsxWorkerPolicy(response)
  assert.deepEqual(changes, [['Content-Security-Policy', [
    `${original[0]} worker-src 'self' blob:;`, original[1],
  ]]])
  assert.equal(original[0], "default-src 'self'; script-src 'self';")
  changes.length = 0
  for (const value of [undefined, null, '', 5]) {
    response.getHeader = () => value
    applyXlsxWorkerPolicy(response)
  }
  assert.deepEqual(changes, [])
  response.headersSent = true
  response.getHeader = () => { throw new Error('Must not read sent headers') }
  applyXlsxWorkerPolicy(response)
})

test('worker middleware runs on the normal handler chain after BrowserPolicy, not the earlier raw chain', () => {
  const source = readFileSync(new URL('../imports/startup/server/startup.js', import.meta.url), 'utf8')
  assert.match(source, /import \{ BrowserPolicy \} from 'meteor\/browser-policy-content'/)
  assert.match(source, /WebApp\.handlers\.use\(\(_request, response, next\) => \{\s*applyXlsxWorkerPolicy\(response\)\s*next\(\)/)
  assert.doesNotMatch(source, /BrowserPolicy\.content\.(?:setPolicy|allowScriptOrigin|allowScriptBlobUrl|_constructCsp)/)
})
