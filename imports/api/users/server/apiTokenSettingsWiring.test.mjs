import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

test('settings replace API tokens with a digest and remove the legacy plaintext field', () => {
  const source = readFileSync(new URL('./methods.js', import.meta.url), 'utf8')
  assert.match(source, /tokenHashDocument\(APItoken\)/u)
  assert.match(source, /modifier\.\$set\['services\.titraApiToken'\]/u)
  assert.match(source, /modifier\.\$unset = \{ 'profile\.APItoken': '' \}/u)
  assert.match(source, /error\?\.code === 11000/u)
  assert.match(source, /'api-token-in-use'/u)
  assert.doesNotMatch(source, /'profile\.APItoken': APItoken/u)
})

test('the browser treats the token as write-only and generates a strong replacement', () => {
  const source = readFileSync(
    new URL('../../../ui/pages/settings.js', import.meta.url),
    'utf8',
  )
  assert.match(source, /titraAPItoken: \(\) => ''/u)
  assert.match(source, /Random\.secret\(32\)/u)
  assert.doesNotMatch(source, /getUserSetting\('APItoken'\)/u)
})
