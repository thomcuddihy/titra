import {
  MAX_PROJECT_SCOPE_IDS,
  RESOURCE_QUERY_MAX_TIME_MS,
  assertResultWithinLimit,
} from '../../../utils/resourceLimits.js'

const TOP_TASK_RESULT_LIMIT = 3

async function fetchBoundedProjectMethodRows({
  find,
  selector,
  fields,
  label,
  maxResults = MAX_PROJECT_SCOPE_IDS,
  sort = { _id: 1 },
}) {
  if (typeof find !== 'function' || !fields || typeof fields !== 'object') {
    throw new TypeError('A bounded project-method query is required.')
  }
  if (!Number.isSafeInteger(maxResults) || maxResults < 1) {
    throw new TypeError('A positive project-method result limit is required.')
  }
  const rows = await find(selector, {
    fields,
    sort,
    limit: maxResults + 1,
  })
  return assertResultWithinLimit(rows, maxResults, label)
}

async function aggregateBoundedProjectMethodRows({
  aggregate,
  pipeline,
  label,
  maxResults,
}) {
  if (typeof aggregate !== 'function' || !Array.isArray(pipeline)) {
    throw new TypeError('A bounded project-method aggregation is required.')
  }
  if (!Number.isSafeInteger(maxResults) || maxResults < 1) {
    throw new TypeError('A positive project-method result limit is required.')
  }
  const rows = await aggregate(
    [...pipeline, { $limit: maxResults + 1 }],
    { allowDiskUse: false, maxTimeMS: RESOURCE_QUERY_MAX_TIME_MS },
  )
  return assertResultWithinLimit(rows, maxResults, label)
}

async function aggregateProjectMethodScalar({ aggregate, pipeline, label }) {
  const rows = await aggregateBoundedProjectMethodRows({
    aggregate,
    pipeline,
    label,
    maxResults: 1,
  })
  const value = rows[0]?.value
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function monthTotalsPipeline({
  projectIds,
  currentMonthStart,
  currentMonthEnd,
  previousMonthStart,
  previousMonthEnd,
  beforePreviousMonthStart,
  beforePreviousMonthEnd,
}) {
  const boundedMonthSum = (start, end) => ({
    $sum: {
      $cond: [
        { $and: [{ $gte: ['$date', start] }, { $lte: ['$date', end] }] },
        '$hours',
        0,
      ],
    },
  })
  return [
    {
      $match: {
        projectId: { $in: projectIds },
        date: { $gte: beforePreviousMonthStart, $lte: currentMonthEnd },
      },
    },
    {
      $group: {
        _id: null,
        currentMonthHours: boundedMonthSum(currentMonthStart, currentMonthEnd),
        previousMonthHours: boundedMonthSum(previousMonthStart, previousMonthEnd),
        beforePreviousMonthHours: boundedMonthSum(
          beforePreviousMonthStart, beforePreviousMonthEnd,
        ),
      },
    },
  ]
}

async function aggregateProjectMonthTotals(options) {
  const { aggregate } = options
  const rows = await aggregateBoundedProjectMethodRows({
    aggregate,
    pipeline: monthTotalsPipeline(options),
    label: 'Project month totals',
    maxResults: 1,
  })
  const row = rows[0] || {}
  const finite = (value) => (
    typeof value === 'number' && Number.isFinite(value) ? value : 0
  )
  return {
    currentMonthHours: finite(row.currentMonthHours),
    previousMonthHours: finite(row.previousMonthHours),
    beforePreviousMonthHours: finite(row.beforePreviousMonthHours),
  }
}

function bestProjectMatch(projects, query, similarity) {
  if (typeof query !== 'string' || typeof similarity !== 'function') {
    throw new TypeError('A project search query and scorer are required.')
  }
  let best = null
  for (const project of projects) {
    if (typeof project?._id !== 'string' || typeof project?.name !== 'string') continue
    const score = similarity(project.name, query)
    if (!Number.isFinite(score)) continue
    if (!best || score > best.score) best = { id: project._id, score }
  }
  return best?.id || null
}

export {
  TOP_TASK_RESULT_LIMIT,
  aggregateBoundedProjectMethodRows,
  aggregateProjectMethodScalar,
  aggregateProjectMonthTotals,
  bestProjectMatch,
  fetchBoundedProjectMethodRows,
  monthTotalsPipeline,
}
