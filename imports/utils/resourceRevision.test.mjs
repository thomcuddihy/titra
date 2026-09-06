import assert from 'node:assert/strict'
import test from 'node:test'

import {
  matchesResourceRevision,
  parseResourceRevisionETag,
  resourceRevisionETag,
  revisionFieldFor,
} from './resourceRevision.js'

test('resource revisions are strong, kind-scoped, and legacy aware', () => {
  assert.equal(revisionFieldFor('project-task'), 'projectTaskRevision')
  assert.equal(resourceRevisionETag('project', {}), '"titra-project-revision-legacy"')
  assert.equal(resourceRevisionETag('project', { projectRevision: 7 }), '"titra-project-revision-7"')
  assert.equal(parseResourceRevisionETag('project', ' "titra-project-revision-7" '), 7)
  assert.equal(parseResourceRevisionETag('project', '"titra-project-revision-legacy"'), null)
  assert.equal(matchesResourceRevision('project', {}, null), true)
  assert.equal(matchesResourceRevision('project', { projectRevision: 7 }, 7), true)
  assert.equal(matchesResourceRevision('project', { projectRevision: 8 }, 7), false)
})

test('resource revisions reject cross-kind, weak, malformed, negative, and unsafe values', () => {
  for (const value of [
    'W/"titra-project-revision-1"',
    '"titra-project-task-revision-1"',
    '"titra-project-revision-01"',
    '"titra-project-revision--1"',
    `"titra-project-revision-${Number.MAX_SAFE_INTEGER + 1}"`,
    '*',
    '',
  ]) assert.throws(() => parseResourceRevisionETag('project', value), TypeError)
  assert.throws(() => resourceRevisionETag('project', { projectRevision: -1 }), TypeError)
  assert.throws(() => resourceRevisionETag('project', { projectRevision: 1.5 }), TypeError)
  assert.throws(() => revisionFieldFor('unknown'), TypeError)
})
