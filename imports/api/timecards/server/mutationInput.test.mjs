import assert from 'node:assert/strict'
import test from 'node:test'

import {
  MAX_BULK_TIMECARD_ENTRIES,
  MAX_WEEK_MUTATION_ENTRIES,
  assertTimecardMutationBatch,
  assertTimecardMutationInput,
} from './mutationInput.js'

const valid = {
  projectId: 'project', task: 'Work', date: new Date('2026-09-03T00:00:00.000Z'),
  hours: 1.125, taskRate: 100,
}

test('time entry mutations reject non-finite, invalid and oversized scalar values', () => {
  assert.doesNotThrow(() => assertTimecardMutationInput(valid))
  assert.doesNotThrow(() => assertTimecardMutationInput({ ...valid, projectId: undefined }))
  for (const input of [
    { ...valid, task: '' },
    { ...valid, task: 'x'.repeat(1001) },
    { ...valid, task: '\ud800' },
    { ...valid, date: new Date('invalid') },
    { ...valid, hours: Number.NaN },
    { ...valid, hours: Number.POSITIVE_INFINITY },
    { ...valid, taskRate: Number.NEGATIVE_INFINITY },
    { ...valid, projectId: 'x'.repeat(129) },
  ]) assert.throws(() => assertTimecardMutationInput(input), TypeError)
})

test('week and bulk mutation batches have hard request-work limits', () => {
  assert.doesNotThrow(() => assertTimecardMutationBatch([], MAX_WEEK_MUTATION_ENTRIES))
  assert.doesNotThrow(() => assertTimecardMutationBatch(
    Array(MAX_BULK_TIMECARD_ENTRIES), MAX_BULK_TIMECARD_ENTRIES,
  ))
  assert.throws(() => assertTimecardMutationBatch(
    Array(MAX_WEEK_MUTATION_ENTRIES + 1), MAX_WEEK_MUTATION_ENTRIES,
  ), TypeError)
  assert.throws(() => assertTimecardMutationBatch(
    Array(MAX_BULK_TIMECARD_ENTRIES + 1), MAX_BULK_TIMECARD_ENTRIES,
  ), TypeError)
})
