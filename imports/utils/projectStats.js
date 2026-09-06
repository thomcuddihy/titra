const statisticFields = [
  'totalHours',
  'totalRevenue',
  'currentMonthHours',
  'previousMonthHours',
  'beforePreviousMonthHours',
]
const contributionFields = ['date', 'hours', 'userId', 'taskRate']

function emptyTotals() {
  return Object.fromEntries(statisticFields.map((field) => [field, 0]))
}

function finiteNumber(value) {
  const number = Number.parseFloat(value)
  return Number.isFinite(number) ? number : 0
}

function numericExpression(input) {
  return { $convert: { input, to: 'double', onError: 0, onNull: 0 } }
}

/**
 * Build a constant-memory project statistics aggregation. MongoDB returns one
 * scalar document rather than making the application retain every historical
 * timecard in a live observer.
 */
function buildProjectStatsAggregation({ project, monthRanges, allowIndividualTaskRates }) {
  const hours = numericExpression('$hours')
  const rateBranches = Object.entries(project?.rates || {})
    .filter(([, rate]) => Boolean(rate))
    .map(([userId, rate]) => ({
      case: { $eq: ['$userId', userId] },
      then: finiteNumber(rate),
    }))
  const userRate = rateBranches.length ? {
    $switch: {
      branches: rateBranches,
      default: finiteNumber(project?.rate),
    },
  } : finiteNumber(project?.rate)
  const rate = allowIndividualTaskRates
    ? { $cond: ['$taskRate', numericExpression('$taskRate'), userRate] }
    : userRate
  const group = {
    _id: null,
    totalHours: { $sum: hours },
    totalRevenue: { $sum: { $multiply: [hours, rate] } },
  }
  Object.entries(monthRanges).forEach(([field, range]) => {
    group[field] = {
      $sum: {
        $cond: [
          { $and: [{ $gte: ['$date', range.start] }, { $lte: ['$date', range.end] }] },
          hours,
          0,
        ],
      },
    }
  })
  return [
    { $match: { projectId: project._id } },
    { $group: group },
    { $project: { _id: 0, ...Object.fromEntries(statisticFields.map((field) => [field, 1])) } },
  ]
}

/** Retain only the fields that can affect a project's hours and revenue. */
function snapshotFields(fields) {
  return Object.fromEntries(contributionFields
    .filter((field) => fields[field] !== undefined)
    .map((field) => [
      field,
      fields[field] instanceof Date ? new Date(fields[field].getTime()) : fields[field],
    ]))
}

/**
 * Maintain old contributions so changed/removed observer events never add an
 * entire record twice or need to fetch a record that has already been deleted.
 */
function createProjectStatsTracker({ project, monthRanges, allowIndividualTaskRates }) {
  const records = new Map()
  let totals = emptyTotals()

  function contribution(fields) {
    const value = emptyTotals()
    value.totalHours = finiteNumber(fields.hours)
    // Preserve the existing truthy task-rate/user-rate/project-rate precedence.
    const rate = allowIndividualTaskRates && fields.taskRate
      ? fields.taskRate
      : project.rates?.[fields.userId] || project.rate
    value.totalRevenue = value.totalHours * finiteNumber(rate)
    const timestamp = new Date(fields.date).getTime()
    Object.entries(monthRanges).forEach(([field, range]) => {
      if (timestamp >= range.start.getTime() && timestamp <= range.end.getTime()) {
        value[field] = value.totalHours
      }
    })
    return value
  }

  function replace(id, fields) {
    const previous = records.get(id)?.contribution || emptyTotals()
    const storedFields = snapshotFields(fields)
    const next = contribution(storedFields)
    records.set(id, { fields: storedFields, contribution: next })
    let changed = false
    statisticFields.forEach((field) => {
      if (next[field] !== previous[field]) {
        totals[field] += next[field] - previous[field]
        changed = true
      }
    })
    return changed
  }

  return {
    added(id, fields) {
      return replace(id, fields)
    },
    changed(id, fields) {
      const previous = records.get(id)
      if (!previous) return false
      return replace(id, { ...previous.fields, ...fields })
    },
    removed(id) {
      const previous = records.get(id)
      if (!previous) return false
      records.delete(id)
      const changed = statisticFields.some((field) => previous.contribution[field] !== 0)
      statisticFields.forEach((field) => {
        totals[field] -= previous.contribution[field]
      })
      // Avoid residual floating-point rounding after the final record is removed.
      if (!records.size) totals = emptyTotals()
      return changed
    },
    snapshot() {
      return { ...totals }
    },
    clear() {
      records.clear()
      totals = emptyTotals()
    },
  }
}

/** Initialize and maintain one publication from a single consistent observer. */
async function observeProjectStats({
  cursor, tracker, onStop, publishInitial, publishChanged,
}) {
  let initializing = true
  let stopped = false
  let handle
  onStop(() => {
    if (stopped) return
    stopped = true
    if (handle) handle.stop()
    tracker.clear()
  })

  function applyEvent(method, id, fields) {
    if (stopped) return
    const changed = tracker[method](id, fields)
    if (!initializing && changed) publishChanged(tracker.snapshot())
  }

  try {
    handle = await cursor.observeChangesAsync({
      added: (id, fields) => applyEvent('added', id, fields),
      changed: (id, fields) => applyEvent('changed', id, fields),
      removed: (id) => applyEvent('removed', id),
    })
  } catch (error) {
    stopped = true
    tracker.clear()
    throw error
  }

  if (stopped) {
    handle.stop()
    return false
  }
  initializing = false
  try {
    publishInitial(tracker.snapshot())
  } catch (error) {
    stopped = true
    handle.stop()
    tracker.clear()
    throw error
  }
  return true
}

export {
  buildProjectStatsAggregation,
  createProjectStatsTracker,
  emptyTotals,
  observeProjectStats,
}
