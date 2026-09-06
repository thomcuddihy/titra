import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const source = await readFile(new URL('./methods.js', import.meta.url), 'utf8')

test('statistics remain authenticated and accept no unbounded input', () => {
  assert.match(source, /mixins: \[authenticationMixin\]/)
  assert.match(source, /check\(args, Match\.Maybe\(\{\}\)\)/)
  assert.doesNotMatch(source, /validate: null/)
})

test('statistics have independent caller rate and concurrent work limits', () => {
  assert.equal((source.match(/DDPRateLimiter\.addRule\(\{/g) || []).length, 2)
  assert.match(source, /userId\(userId\)/)
  assert.match(source, /clientAddress\(clientAddress\)/)
  assert.match(source, /createActivePublicationGate\(\{\s*perUser: 2,\s*perPeer: 5,\s*total: 20,/)
  assert.match(source, /statisticsExecutionGate\.acquire\(\{/)
  assert.match(source, /finally \{\s*release\(\)/)
})

test('admin database probes have a deadline and host arrays are bounded', () => {
  assert.equal((source.match(/maxTimeMS: RESOURCE_QUERY_MAX_TIME_MS/g) || []).length, 2)
  assert.match(source, /boundedCpuDetails\(os\.cpus\(\)\)/)
  assert.match(source, /storageEngine\?\.name \|\| 'unknown'/)
})
