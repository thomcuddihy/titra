import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const source = await readFile(new URL('./methods.js', import.meta.url), 'utf8')

test('all holiday reads remain authenticated and validate their complete input', () => {
  assert.equal((source.match(/mixins: \[authenticationMixin\]/g) || []).length, 4)
  assert.match(source, /Match\.Maybe\(\{ year: Match\.Maybe\(Number\) \}\)/)
  assert.match(source, /check\(args, Match\.Maybe\(\{\}\)\)/)
  assert.match(source, /normalizeHolidayCode\(country, 'Country'\)/)
  assert.match(source, /normalizeHolidayCode\(state, 'State'\)/)
})

test('holiday generation is fixed to one bounded year and result envelope', () => {
  assert.match(source, /h\.getHolidays\(normalizeHolidayYear\(year\)\)/)
  assert.match(source, /boundedHolidayList\(/)
  assert.equal((source.match(/boundedHolidayMap\(/g) || []).length, 3)
})

test('holiday reads have independent caller-rate and concurrent-work limits', () => {
  assert.equal((source.match(/DDPRateLimiter\.addRule\(\{/g) || []).length, 2)
  assert.match(source, /userId\(userId\)/)
  assert.match(source, /clientAddress\(clientAddress\)/)
  assert.match(source, /createActivePublicationGate\(\{\s*perUser: 5,\s*perPeer: 20,\s*total: 100,/)
  assert.match(source, /holidayExecutionGate\.acquire\(\{/)
  assert.match(source, /finally \{\s*release\(\)/)
})
