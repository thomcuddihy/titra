import {
  MAX_LEGACY_RESULT_LIMIT,
  fetchBoundedAggregationList,
  fetchBoundedLegacyList,
} from './apiPagination.js'

function finiteHours(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/**
 * Reads a bounded task set and calculates all actual-hour totals with one
 * grouped Mongo aggregation. The deadline and output ceiling are enforced by
 * apiPagination's shared availability policy.
 */
async function fetchBoundedProjectTaskStats({
  projectId,
  findTasks,
  aggregateTimecards,
  maxTasks = MAX_LEGACY_RESULT_LIMIT,
}) {
  if (typeof projectId !== 'string' || !projectId) {
    throw new TypeError('A project ID is required for task statistics.')
  }
  const tasks = await fetchBoundedLegacyList({
    find: findTasks,
    baseSelector: { projectId },
    sort: { _id: 1 },
    maxLimit: maxTasks,
  })
  const taskNames = [...new Set(tasks
    .map((task) => task?.name)
    .filter((name) => typeof name === 'string'))]
  const groupedHours = taskNames.length === 0 ? [] : await fetchBoundedAggregationList({
    aggregate: aggregateTimecards,
    pipeline: [
      { $match: { projectId, task: { $in: taskNames } } },
      { $group: { _id: '$task', totalHours: { $sum: '$hours' } } },
      { $sort: { _id: 1 } },
    ],
    maxLimit: maxTasks,
  })
  const hoursByTask = new Map(groupedHours
    .filter((entry) => typeof entry?._id === 'string')
    .map((entry) => [entry._id, finiteHours(entry.totalHours)]))
  const taskStats = tasks.map((task) => {
    const estimatedHours = finiteHours(task.estimatedHours)
    const actualHours = hoursByTask.get(task.name) || 0
    return {
      taskId: task._id,
      taskName: task.name,
      estimatedHours,
      actualHours,
      variance: actualHours - estimatedHours,
      start: task.start,
      end: task.end,
    }
  })
  return {
    projectId,
    totalEstimatedHours: taskStats.reduce((sum, task) => sum + task.estimatedHours, 0),
    totalActualHours: taskStats.reduce((sum, task) => sum + task.actualHours, 0),
    tasks: taskStats,
  }
}

export { fetchBoundedProjectTaskStats }
