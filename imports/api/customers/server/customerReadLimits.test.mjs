import assert from 'node:assert/strict'
import test from 'node:test'

import {
  MAX_CUSTOMER_RESULTS,
  aggregateBoundedCustomers,
  customerAccessSelector,
  isBoundedCustomerName,
} from './customerReadLimits.js'
import { RESOURCE_QUERY_MAX_TIME_MS } from '../../../utils/resourceLimits.js'

test('customer access is restricted to exact project membership roles', () => {
  assert.deepEqual(customerAccessSelector('u1'), {
    $or: [{ userId: 'u1' }, { admins: 'u1' }, { team: 'u1' }],
  })
  for (const userId of ['', null, 'x'.repeat(129)]) {
    assert.throws(() => customerAccessSelector(userId), /valid customer caller/)
  }
})

test('customer names have a fixed Unicode-safe output ceiling', () => {
  assert.equal(isBoundedCustomerName('Customer'), true)
  assert.equal(isBoundedCustomerName('😀'.repeat(500)), true)
  for (const value of ['', null, 'x'.repeat(501), '\uD800']) {
    assert.equal(isBoundedCustomerName(value), false)
  }
})

test('customer aggregation is grouped, sorted and bounded with a sentinel', async () => {
  let observed
  const rows = [{ _id: 'Alpha' }, { _id: 'Beta' }]
  const result = await aggregateBoundedCustomers({
    userId: 'u1',
    maxResults: 2,
    aggregate: async (pipeline, options) => {
      observed = { pipeline, options }
      return rows
    },
  })
  assert.equal(result, rows)
  assert.deepEqual(observed.options, {
    allowDiskUse: false,
    maxTimeMS: RESOURCE_QUERY_MAX_TIME_MS,
  })
  assert.deepEqual(observed.pipeline, [
    {
      $match: {
        $or: [{ userId: 'u1' }, { admins: 'u1' }, { team: 'u1' }],
        customer: { $type: 'string', $ne: '' },
      },
    },
    { $match: { $expr: { $lte: [{ $strLenCP: '$customer' }, 500] } } },
    { $group: { _id: '$customer' } },
    { $sort: { _id: 1 } },
    { $limit: 3 },
  ])
})

test('customer aggregation rejects overflow instead of returning a partial list', async () => {
  await assert.rejects(
    aggregateBoundedCustomers({
      userId: 'u1',
      maxResults: 2,
      aggregate: async () => [{ _id: 'A' }, { _id: 'B' }, { _id: 'C' }],
    }),
    /Customer result exceeds the 2-item safety limit/,
  )
})

test('customer aggregation validates contracts before database work', async () => {
  await assert.rejects(
    aggregateBoundedCustomers({ userId: 'u1' }),
    /aggregation callback/,
  )
  await assert.rejects(
    aggregateBoundedCustomers({
      userId: 'u1', maxResults: MAX_CUSTOMER_RESULTS + 0.5, aggregate: async () => [],
    }),
    /positive customer result limit/,
  )
})
