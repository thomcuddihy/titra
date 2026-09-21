import assert from 'node:assert/strict'
import test from 'node:test'

import { buildSafePayload, sanitizeObject, sanitizeSlug } from './sanitizer.js'
import {
  taskForbiddenCustomfieldKeys,
  timeEntryForbiddenCustomfieldKeys,
} from './securityFieldPolicies.js'

test('payload sanitization rejects arrays and non-object input', () => {
  for (const value of [null, undefined, false, 42, 'text', [], ['field']]) {
    assert.deepEqual(buildSafePayload(value), {})
    assert.deepEqual(sanitizeObject(value), {})
  }
})

test('payload sanitization removes prototype keys without mutating the input', () => {
  const input = JSON.parse('{"__proto__":{"polluted":true},"prototype":1,"constructor":2,"notes":"retained"}')
  const original = structuredClone(input)
  assert.deepEqual(sanitizeObject(input), { notes: 'retained' })
  assert.deepEqual(buildSafePayload(input, null, []), { notes: 'retained' })
  assert.deepEqual(input, original)
  assert.equal(Object.prototype.polluted, undefined)
})

test('safe payloads enforce allowlists and denylists and ignore inherited values', () => {
  const input = Object.assign(Object.create({ inherited: 'ignored' }), {
    name: 'Project', notes: 'custom notes', protected: 'do not copy',
  })
  assert.deepEqual(buildSafePayload(input, ['name']), { name: 'Project' })
  assert.deepEqual(buildSafePayload(input, new Set(['name'])), { name: 'Project' })
  assert.deepEqual(buildSafePayload(input, []), {})
  assert.deepEqual(buildSafePayload(input, null, ['protected']), {
    name: 'Project', notes: 'custom notes',
  })
})

test('time-entry custom fields cannot overwrite identity, civil dates or revisions', () => {
  const protectedFields = [
    '_id', 'userId', 'projectId', 'date', 'dateOnly', 'startTime', 'dateRevision',
    'hours', 'task', 'taskRate', 'state', 'lastUsed', 'name', 'createdAt', 'updatedAt',
  ]
  const input = Object.fromEntries(protectedFields.map((key) => [key, 'forbidden']))
  input.notes = 'retained'
  assert.deepEqual(sanitizeObject(input, timeEntryForbiddenCustomfieldKeys), {
    notes: 'retained',
  })
})

test('project-task custom fields cannot overwrite lifecycle or revision fields', () => {
  const protectedFields = [
    '_id', 'projectId', 'name', 'start', 'end', 'estimatedHours', 'dependencies',
    'isDefaultTask', 'userId', 'createdAt', 'updatedAt', 'projectTaskRevision',
  ]
  const input = Object.fromEntries(protectedFields.map((key) => [key, 'forbidden']))
  input.notes = 'retained'
  assert.deepEqual(sanitizeObject(input, taskForbiddenCustomfieldKeys), {
    notes: 'retained',
  })
})

test('legacy slug normalization remains unchanged', () => {
  assert.equal(sanitizeSlug('  A Sample Project!  '), 'a-sample-project')
  assert.equal(sanitizeSlug('---Hello---World'), 'hello-world')
  assert.equal(sanitizeSlug('x'.repeat(101)).length, 100)
  assert.equal(sanitizeSlug(null), '')
})
