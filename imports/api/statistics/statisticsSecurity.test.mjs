import assert from 'node:assert/strict'
import test from 'node:test'

import { MAX_STATISTICS_CPUS, boundedCpuDetails } from './statisticsSecurity.js'

test('CPU details have a fixed result and text ceiling', () => {
  const cpus = Array.from({ length: MAX_STATISTICS_CPUS + 2 }, (_, index) => ({
    model: `${'m'.repeat(300)}-${index}`,
    speed: index,
    times: { user: 1, nice: 2, sys: 3, idle: 4, irq: 5 },
    ignored: 'not returned',
  }))
  const result = boundedCpuDetails(cpus)
  assert.equal(result.length, MAX_STATISTICS_CPUS)
  assert.equal([...result[0].model].length, 256)
  assert.deepEqual(result[0].times, { user: 1, nice: 2, sys: 3, idle: 4, irq: 5 })
  assert.equal(Object.hasOwn(result[0], 'ignored'), false)
})

test('CPU details normalize malformed numeric host data', () => {
  assert.deepEqual(boundedCpuDetails(null), [])
  assert.deepEqual(boundedCpuDetails([{ model: null, speed: Infinity, times: {
    user: -1, nice: NaN, sys: undefined, idle: 4, irq: 0,
  } }]), [{
    model: '',
    speed: 0,
    times: { user: 0, nice: 0, sys: 0, idle: 4, irq: 0 },
  }])
})
