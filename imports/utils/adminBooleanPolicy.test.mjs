import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

test('server-side privilege branches require the literal boolean admin flag', () => {
  const helpers = readFileSync(new URL('./server_method_helpers.js', import.meta.url), 'utf8')
  const statistics = readFileSync(
    new URL('../api/statistics/methods.js', import.meta.url), 'utf8',
  )
  assert.match(helpers, /meteorUser\?\.isAdmin === true/u)
  assert.doesNotMatch(helpers, /meteorUser && meteorUser\.isAdmin/u)
  assert.equal((statistics.match(/if \(isAdmin === true\)/gu) || []).length, 2)
  assert.doesNotMatch(statistics, /if \(isAdmin\)/u)
})
