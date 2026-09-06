import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runInNewContext } from 'node:vm'

const require = createRequire(import.meta.url)
const preflight = require('../root-scripts/personal-task-suggestion-preflight.cjs')
const mongoshSource = readFileSync(
  new URL('../root-scripts/personal-task-suggestion-preflight.cjs', import.meta.url),
  'utf8',
)
const shell = readFileSync(
  new URL('../root-scripts/preflight-personal-task-suggestions.sh', import.meta.url),
  'utf8',
)

test('duplicate pipeline exactly matches the v7 unique partial-index population', () => {
  const pipeline = preflight.duplicatePipeline()
  assert.deepEqual(pipeline[0], {
    $match: {
      projectId: null,
      userId: { $type: 'string' },
      name: { $type: 'string' },
    },
  })
  assert.deepEqual(pipeline[1].$group._id, { userId: '$userId', name: '$name' })
  assert.deepEqual(pipeline[2], { $match: { documents: { $gt: 1 } } })
})

test('empty aggregate passes with a fixed sanitized marker', () => {
  const summary = { ...preflight.summarize([]), indexStatus: 'ABSENT' }
  assert.deepEqual(summary, {
    status: 'PASS',
    indexStatus: 'ABSENT',
    duplicateGroups: 0,
    duplicateDocuments: 0,
    excessDocuments: 0,
  })
  assert.equal(
    preflight.marker(summary),
    'TITRA_V7_PERSONAL_SUGGESTION_PREFLIGHT status=PASS index_status=ABSENT duplicate_groups=0 duplicate_documents=0 excess_documents=0',
  )
})

test('duplicates report counts without reflecting owner or task values', () => {
  const source = {
    duplicateGroups: 2,
    duplicateDocuments: 5,
    excessDocuments: 3,
    userId: 'private-owner',
    name: 'private task name',
  }
  const output = preflight.marker({
    ...preflight.summarize([source]), indexStatus: 'EXACT',
  })
  assert.equal(
    output,
    'TITRA_V7_PERSONAL_SUGGESTION_PREFLIGHT status=DUPLICATES index_status=EXACT duplicate_groups=2 duplicate_documents=5 excess_documents=3',
  )
  assert.doesNotMatch(output, /private-owner|private task name/)
})

test('malformed aggregate results fail closed', () => {
  for (const rows of [
    null,
    [{ duplicateGroups: 0, duplicateDocuments: 0, excessDocuments: 0 }],
    [{ duplicateGroups: 1, duplicateDocuments: 1, excessDocuments: 0 }],
    [{ duplicateGroups: 1, duplicateDocuments: 2, excessDocuments: 0 }],
    [{ duplicateGroups: 1.5, duplicateDocuments: 3, excessDocuments: 1.5 }],
    [{ duplicateGroups: 1, duplicateDocuments: 2, excessDocuments: 1 }, {}],
  ]) {
    assert.throws(() => preflight.summarize(rows))
  }
})

test('index inspection accepts only absence or the exact v7 definition', () => {
  assert.equal(preflight.inspectIndexes([{ name: '_id_', key: { _id: 1 } }]), 'ABSENT')
  assert.equal(preflight.inspectIndexes([{
    name: preflight.INDEX_NAME,
    key: preflight.INDEX_KEY,
    unique: true,
    partialFilterExpression: preflight.INDEX_PARTIAL_FILTER,
    v: 2,
  }]), 'EXACT')
  for (const indexes of [
    null,
    [{ name: preflight.INDEX_NAME, key: preflight.INDEX_KEY, unique: false }],
    [{ name: 'another_name', key: preflight.INDEX_KEY, unique: true,
      partialFilterExpression: preflight.INDEX_PARTIAL_FILTER }],
    [{ name: preflight.INDEX_NAME, key: { name: 1, userId: 1 }, unique: true,
      partialFilterExpression: preflight.INDEX_PARTIAL_FILTER }],
  ]) {
    assert.throws(() => preflight.inspectIndexes(indexes))
  }
})

test('database errors produce only the fixed error marker', () => {
  const output = []
  let status
  preflight.runMongosh({
    getCollection: () => ({
      getIndexes: () => [],
      aggregate: () => { throw new Error('private-owner private task name mongodb://secret') },
    }),
  }, (line) => output.push(line), (value) => { status = value })
  assert.deepEqual(output, ['TITRA_V7_PERSONAL_SUGGESTION_PREFLIGHT status=ERROR'])
  assert.equal(status, 43)
})

test('mongosh globals execute the check even when a module global exists', () => {
  const sandbox = {}
  runInNewContext(`
    globalThis.lines = []
    globalThis.exitStatus = null
    globalThis.db = {
      getCollection() {
        return {
          getIndexes() { return [] },
          aggregate() { return { toArray() { return [] } } },
        }
      },
    }
    globalThis.print = (line) => globalThis.lines.push(line)
    globalThis.quit = (status) => { globalThis.exitStatus = status }
    globalThis.module = { exports: { sentinel: true } }
    ${mongoshSource}
  `, sandbox)
  assert.equal(sandbox.exitStatus, 0)
  assert.deepEqual(Array.from(sandbox.lines), [
    'TITRA_V7_PERSONAL_SUGGESTION_PREFLIGHT status=PASS index_status=ABSENT duplicate_groups=0 duplicate_documents=0 excess_documents=0',
  ])
  assert.equal(sandbox.module.exports.sentinel, true)
  assert.deepEqual(Object.keys(sandbox.module.exports), ['sentinel'])
})

test('shell gate is read-only, identity-bound and authoritative only while stopped', () => {
  assert.match(shell, /--require-app-stopped/)
  assert.match(shell, /\$LOCK_INHERITED == true/)
  assert.match(shell, /com\.docker\.compose\.project/)
  assert.match(shell, /com\.docker\.compose\.service/)
  assert.match(shell, /'\{\{\.State\.Running\}\}'\) == 'false'/)
  assert.match(shell, /assert_mongo_identity/)
  assert.match(shell, /docker exec --interactive/)
  assert.match(shell, /--norc --file \/dev\/stdin/)
  assert.doesNotMatch(shell, /mongosh[^\n]*--eval/)
  assert.doesNotMatch(shell, /delete|remove|update|insert/i)
})
