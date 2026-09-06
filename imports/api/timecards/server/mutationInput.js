const MAX_TIMECARD_TASK_CODE_POINTS = 1000
const MAX_WEEK_MUTATION_ENTRIES = 31
const MAX_BULK_TIMECARD_ENTRIES = 1000

function assertTimecardMutationBatch(entries, maximum) {
  if (!Array.isArray(entries) || entries.length > maximum) {
    throw new TypeError('The time entry batch is too large.')
  }
}

function assertTimecardMutationInput({ projectId, task, date, hours, taskRate }) {
  if ((projectId != null && (typeof projectId !== 'string' || !projectId
      || projectId.length > 128 || !projectId.isWellFormed()))
    || typeof task !== 'string' || !task.trim() || !task.isWellFormed()
    || [...task].length > MAX_TIMECARD_TASK_CODE_POINTS
    || !(date instanceof Date) || !Number.isFinite(date.getTime())
    || typeof hours !== 'number' || !Number.isFinite(hours)
    || (taskRate != null
      && (typeof taskRate !== 'number' || !Number.isFinite(taskRate)))
  ) throw new TypeError('Invalid time entry values.')
}

export {
  MAX_BULK_TIMECARD_ENTRIES,
  MAX_TIMECARD_TASK_CODE_POINTS,
  MAX_WEEK_MUTATION_ENTRIES,
  assertTimecardMutationBatch,
  assertTimecardMutationInput,
}
