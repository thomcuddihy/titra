const MAX_TASK_SEARCH_FILTER_CODE_POINTS = 256
const MAX_TASK_SEARCH_RESULTS = 200
const MAX_PROJECT_TASKS = 2000

function assertTaskSearchFilter(filter) {
  if (filter === undefined || filter === null || filter === '') return
  if (typeof filter !== 'string' || !filter.isWellFormed()
    || [...filter].length > MAX_TASK_SEARCH_FILTER_CODE_POINTS) {
    throw new TypeError('Invalid task search filter.')
  }
}

function assertTaskSearchLimit(limit) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_TASK_SEARCH_RESULTS) {
    throw new TypeError('Invalid task search limit.')
  }
}

function assertProjectId(projectId) {
  if (typeof projectId !== 'string' || !projectId || projectId.length > 128
    || !projectId.isWellFormed()) throw new TypeError('Invalid project ID.')
}

function boundedTaskSearchLimit(value) {
  const numeric = Number(value)
  return Number.isSafeInteger(numeric) && numeric >= 1
    ? Math.min(numeric, MAX_TASK_SEARCH_RESULTS)
    : MAX_TASK_SEARCH_RESULTS
}

export {
  MAX_PROJECT_TASKS,
  MAX_TASK_SEARCH_FILTER_CODE_POINTS,
  MAX_TASK_SEARCH_RESULTS,
  assertProjectId,
  assertTaskSearchFilter,
  assertTaskSearchLimit,
  boundedTaskSearchLimit,
}
