import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  MAX_MIGRATION_STREAM_BATCH_SIZE,
  forEachKeysetBatch,
  keysetSelector,
} from './migrationStreaming.js'

test('keyset selector preserves scope and advances strictly after the cursor', () => {
  assert.deepEqual(keysetSelector({ runId: 'run' }, 'timecardId'), { runId: 'run' })
  assert.deepEqual(keysetSelector({ runId: 'run' }, 'timecardId', 'card-2'), {
    $and: [{ runId: 'run' }, { timecardId: { $gt: 'card-2' } }],
  })
  assert.throws(() => keysetSelector([], '_id'), TypeError)
  assert.throws(() => keysetSelector({}, ''), TypeError)
})

test('streaming traversal retains only bounded keyset pages and renews its lease', async () => {
  const source = Array.from({ length: 1203 }, (_, index) => ({
    _id: String(index).padStart(5, '0'),
  }))
  const pageSizes = []
  const visited = []
  let renewals = 0
  const result = await forEachKeysetBatch({
    batchSize: 500,
    renew: async () => { renewals += 1 },
    fetchBatch: async ({ afterValue, limit }) => source
      .filter(({ _id }) => afterValue === undefined || _id > afterValue)
      .slice(0, limit),
    onBatch: async (batch) => {
      pageSizes.push(batch.length)
      visited.push(...batch.map(({ _id }) => _id))
    },
  })
  assert.deepEqual(pageSizes, [500, 500, 203])
  assert.deepEqual(visited, source.map(({ _id }) => _id))
  assert.deepEqual(result, { batches: 3, documents: 1203, lastValue: '01202' })
  assert.equal(renewals, 6)
})

test('streaming traversal rejects oversized, cursorless, and stalled sources', async () => {
  const base = { onBatch: async () => {} }
  await assert.rejects(forEachKeysetBatch({
    ...base,
    batchSize: 2,
    fetchBatch: async () => [{ _id: '1' }, { _id: '2' }, { _id: '3' }],
  }), /exceeded/u)
  await assert.rejects(forEachKeysetBatch({
    ...base,
    fetchBatch: async () => [{ name: 'missing' }],
  }), /without a cursor/u)
  let calls = 0
  await assert.rejects(forEachKeysetBatch({
    ...base,
    batchSize: 1,
    fetchBatch: async () => {
      calls += 1
      return [{ _id: 'same' }]
    },
  }), /did not advance/u)
  assert.equal(calls, 2)
  await assert.rejects(forEachKeysetBatch({
    ...base,
    batchSize: MAX_MIGRATION_STREAM_BATCH_SIZE + 1,
    fetchBatch: async () => [],
  }), /configuration/u)
})

test('migration methods use keyset streams instead of whole-collection materialization', () => {
  const source = readFileSync(new URL('./methods.js', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /Timecards\.find\(\)\.fetchAsync\(\)/u)
  assert.match(source, /forEachKeysetBatch\(\{/u)
  assert.match(source, /sort:\s*\{ timecardId: 1 \},\s*limit,/u)
  assert.match(source, /createBackupDigestAccumulator\(/u)
  assert.match(source, /renewLease\(runId, lock\.fence, 'verify'\)/u)
})
