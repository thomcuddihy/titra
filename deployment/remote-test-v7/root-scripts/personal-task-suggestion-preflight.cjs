'use strict'

const MARKER = 'TITRA_V7_PERSONAL_SUGGESTION_PREFLIGHT'
const QUERY_TIMEOUT_MS = 120000
const INDEX_NAME = 'task_personal_suggestion_user_name_unique'
const INDEX_KEY = { userId: 1, name: 1 }
const INDEX_PARTIAL_FILTER = {
  projectId: null,
  userId: { $type: 'string' },
  name: { $type: 'string' },
}

function duplicatePipeline() {
  return [
    {
      $match: {
        projectId: null,
        userId: { $type: 'string' },
        name: { $type: 'string' },
      },
    },
    {
      $group: {
        _id: { userId: '$userId', name: '$name' },
        documents: { $sum: 1 },
      },
    },
    { $match: { documents: { $gt: 1 } } },
    {
      $group: {
        _id: null,
        duplicateGroups: { $sum: 1 },
        duplicateDocuments: { $sum: '$documents' },
        excessDocuments: { $sum: { $subtract: ['$documents', 1] } },
      },
    },
    {
      $project: {
        _id: 0,
        duplicateGroups: 1,
        duplicateDocuments: 1,
        excessDocuments: 1,
      },
    },
  ]
}

function count(value) {
  return Number.isSafeInteger(value) && value >= 0
}

function plainObject(value) {
  return value !== null && typeof value === 'object'
    && Object.getPrototypeOf(value) === Object.prototype
}

function sameDocument(left, right) {
  if (left === right) return true
  if (!plainObject(left) || !plainObject(right)) return false
  const leftKeys = Object.keys(left).sort()
  const rightKeys = Object.keys(right).sort()
  if (leftKeys.length !== rightKeys.length
    || leftKeys.some((key, index) => key !== rightKeys[index])) return false
  return leftKeys.every((key) => sameDocument(left[key], right[key]))
}

function sameIndexKey(left, right) {
  if (!plainObject(left) || !plainObject(right)) return false
  const leftKeys = Object.keys(left)
  const rightKeys = Object.keys(right)
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index] && left[key] === right[key])
}

function inspectIndexes(indexes) {
  if (!Array.isArray(indexes)) {
    throw new TypeError('Unexpected task index result')
  }
  const relevant = indexes.filter((index) => plainObject(index)
    && (index.name === INDEX_NAME || sameIndexKey(index.key, INDEX_KEY)))
  if (relevant.length === 0) return 'ABSENT'
  if (relevant.length === 1) {
    const [index] = relevant
    if (index.name === INDEX_NAME
      && sameIndexKey(index.key, INDEX_KEY)
      && index.unique === true
      && sameDocument(index.partialFilterExpression, INDEX_PARTIAL_FILTER)) {
      return 'EXACT'
    }
  }
  throw new TypeError('Conflicting personal task suggestion index')
}

function summarize(rows) {
  if (!Array.isArray(rows) || rows.length > 1) {
    throw new TypeError('Unexpected personal task suggestion aggregate result')
  }
  if (rows.length === 0) {
    return {
      status: 'PASS',
      duplicateGroups: 0,
      duplicateDocuments: 0,
      excessDocuments: 0,
    }
  }
  const result = rows[0]
  if (!result || Object.getPrototypeOf(result) !== Object.prototype
    || !count(result.duplicateGroups)
    || !count(result.duplicateDocuments)
    || !count(result.excessDocuments)
    || result.duplicateGroups < 1
    || result.duplicateDocuments < result.duplicateGroups * 2
    || result.excessDocuments !== result.duplicateDocuments - result.duplicateGroups) {
    throw new TypeError('Invalid personal task suggestion aggregate counts')
  }
  return { status: 'DUPLICATES', ...result }
}

function marker(summary) {
  if (!summary || !['PASS', 'DUPLICATES'].includes(summary.status)
    || !['ABSENT', 'EXACT'].includes(summary.indexStatus)
    || !count(summary.duplicateGroups)
    || !count(summary.duplicateDocuments)
    || !count(summary.excessDocuments)) {
    throw new TypeError('Invalid personal task suggestion preflight summary')
  }
  return `${MARKER} status=${summary.status}`
    + ` index_status=${summary.indexStatus}`
    + ` duplicate_groups=${summary.duplicateGroups}`
    + ` duplicate_documents=${summary.duplicateDocuments}`
    + ` excess_documents=${summary.excessDocuments}`
}

function inspectDatabase(database) {
  if (!database || typeof database.getCollection !== 'function') {
    throw new TypeError('A Mongo database handle is required')
  }
  const collection = database.getCollection('tasks')
  const indexStatus = inspectIndexes(collection.getIndexes())
  const rows = collection.aggregate(
    duplicatePipeline(),
    { allowDiskUse: true, maxTimeMS: QUERY_TIMEOUT_MS },
  ).toArray()
  return { ...summarize(rows), indexStatus }
}

function runMongosh(database, printLine, quitProcess) {
  let exitStatus = 43
  let output = `${MARKER} status=ERROR`
  try {
    const summary = inspectDatabase(database)
    output = marker(summary)
    exitStatus = summary.status === 'PASS' ? 0 : 42
  } catch {
    // Never reflect Mongo diagnostics or task/user values into console or
    // shareable deployment output. The wrapper reports only the exit status.
  }
  printLine(output)
  quitProcess(exitStatus)
}

if (typeof db !== 'undefined' && typeof print === 'function' && typeof quit === 'function') {
  runMongosh(db, print, quit)
} else if (typeof module === 'object' && module?.exports) {
  module.exports = {
    MARKER,
    INDEX_KEY,
    INDEX_NAME,
    INDEX_PARTIAL_FILTER,
    QUERY_TIMEOUT_MS,
    duplicatePipeline,
    inspectDatabase,
    inspectIndexes,
    marker,
    runMongosh,
    sameDocument,
    sameIndexKey,
    summarize,
  }
}
