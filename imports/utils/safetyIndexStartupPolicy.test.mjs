import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

function source(relativeUrl) {
  return readFileSync(new URL(relativeUrl, import.meta.url), 'utf8')
}

test('dashboard safety indexes are awaited by Meteor startup', () => {
  const contents = source('../api/dashboards/server/methods.js')
  assert.match(contents, /Meteor\.startup\(async \(\) => \{/u)
  assert.match(contents, /await Promise\.all\(\[/u)
  assert.match(contents, /unique: true/u)
})

test('Google OAuth indexes exist before its method and service are registered', () => {
  const contents = source('./google/google_server.js')
  const awaitIndex = contents.indexOf('await ensureStateIndexes()')
  const method = contents.indexOf('registerAuthorizationMethod()', awaitIndex)
  const service = contents.indexOf("OAuth.registerService('googleapi'", awaitIndex)
  assert.ok(awaitIndex >= 0)
  assert.ok(method > awaitIndex)
  assert.ok(service > method)
  assert.doesNotMatch(contents, /ensureStateIndexes\(\)\.catch/u)
})

test('startup awaits Google registration', () => {
  const startup = source('../startup/server/startup.js')
  assert.match(startup, /await registerGoogleAPI\(\)/u)
})
