import { createHash } from 'node:crypto'

const TASK_SUGGESTION_CURSOR_VERSION = 1
const MAX_TASK_SUGGESTION_CURSOR_LENGTH = 512
const CURSOR_PATTERN = /^[A-Za-z0-9_-]+$/

class TaskSuggestionPaginationError extends Error {
  constructor(message) {
    super(message)
    this.name = 'TaskSuggestionPaginationError'
    this.error = 'task-suggestion-invalid'
  }
}

function userScope(userId) {
  if (typeof userId !== 'string' || !userId) {
    throw new TypeError('A task suggestion owner is required.')
  }
  return createHash('sha256').update(`titra-task-suggestions-v1\0${userId}`, 'utf8').digest('hex')
}

function encodeTaskSuggestionCursor({ userId, id }) {
  if (typeof id !== 'string' || !id || id.length > 128) {
    throw new TypeError('A task suggestion cursor ID is invalid.')
  }
  return Buffer.from(JSON.stringify({
    v: TASK_SUGGESTION_CURSOR_VERSION,
    u: userScope(userId),
    i: id,
  }), 'utf8').toString('base64url')
}

function decodeTaskSuggestionCursor(cursor, userId) {
  if (typeof cursor !== 'string' || !cursor
    || cursor.length > MAX_TASK_SUGGESTION_CURSOR_LENGTH
    || !CURSOR_PATTERN.test(cursor)) {
    throw new TaskSuggestionPaginationError('Invalid task suggestion cursor.')
  }
  let value
  try {
    const decoded = Buffer.from(cursor, 'base64url')
    if (decoded.toString('base64url') !== cursor) throw new Error('Non-canonical cursor')
    value = JSON.parse(decoded.toString('utf8'))
  } catch (error) {
    throw new TaskSuggestionPaginationError('Invalid task suggestion cursor.')
  }
  if (!value || Object.getPrototypeOf(value) !== Object.prototype
    || Object.keys(value).sort().join(',') !== 'i,u,v'
    || value.v !== TASK_SUGGESTION_CURSOR_VERSION
    || value.u !== userScope(userId)
    || typeof value.i !== 'string' || !value.i || value.i.length > 128) {
    throw new TaskSuggestionPaginationError('Invalid task suggestion cursor.')
  }
  return value.i
}

async function fetchTaskSuggestionPage({ userId, limit, cursor, find, serialize }) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500
    || typeof find !== 'function' || typeof serialize !== 'function') {
    throw new TypeError('Invalid task suggestion page request.')
  }
  const afterId = cursor == null ? null : decodeTaskSuggestionCursor(cursor, userId)
  const selector = {
    userId,
    // Match both the normal missing field and explicit-null legacy rows. This
    // is the same scope enforced by the MongoDB 7-compatible partial index.
    projectId: null,
    ...(afterId == null ? {} : { _id: { $gt: afterId } }),
  }
  const documents = await find(selector, { sort: { _id: 1 }, limit: limit + 1 })
  if (!Array.isArray(documents)) throw new TypeError('Task suggestion query must return an array.')
  const complete = documents.length <= limit
  const page = documents.slice(0, limit)
  for (let index = 0; index < page.length; index += 1) {
    const id = page[index]?._id
    if (typeof id !== 'string' || !id || id.length > 128
      || (index > 0 && page[index - 1]._id >= id)) {
      throw new TypeError('Task suggestions were not returned in stable ID order.')
    }
  }
  const items = await Promise.all(page.map(serialize))
  return {
    items,
    page: {
      version: TASK_SUGGESTION_CURSOR_VERSION,
      limit,
      returned: items.length,
      complete,
      nextCursor: complete ? null : encodeTaskSuggestionCursor({
        userId, id: page.at(-1)._id,
      }),
    },
  }
}

export {
  MAX_TASK_SUGGESTION_CURSOR_LENGTH,
  TASK_SUGGESTION_CURSOR_VERSION,
  TaskSuggestionPaginationError,
  decodeTaskSuggestionCursor,
  encodeTaskSuggestionCursor,
  fetchTaskSuggestionPage,
}
