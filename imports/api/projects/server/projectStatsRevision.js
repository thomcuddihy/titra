function normalizedProjectIds(projectIds) {
  const values = typeof projectIds === 'function' ? projectIds() : projectIds
  if (!values) return []
  const candidates = typeof values === 'string' ? [values] : [...values]
  return [...new Set(candidates.filter(
    (projectId) => typeof projectId === 'string' && projectId.length > 0,
  ))]
}

async function invalidateProjectStats(projectIds, { updateMany }) {
  if (typeof updateMany !== 'function') {
    throw new TypeError('A project revision writer is required.')
  }
  const ids = normalizedProjectIds(projectIds)
  if (!ids.length) return { projectIds: [], matchedCount: 0, modifiedCount: 0 }
  const result = await updateMany(
    { _id: { $in: ids } },
    { $inc: { _statsRevision: 1 } },
  )
  return { projectIds: ids, ...result }
}

/**
 * Refresh derived statistics after a write attempt. The invalidation runs even
 * when the database driver reports an error because the authoritative write may
 * have completed before its acknowledgement was lost. A refresh failure never
 * replaces the primary write error.
 */
async function runWithProjectStatsInvalidation(projectIds, operation, {
  invalidate,
  logInvalidationError = (error) => console.error(
    'Unable to invalidate project statistics after a timecard write', error,
  ),
}) {
  let result
  let operationError
  try {
    result = await operation()
  } catch (error) {
    operationError = error
  }

  try {
    await invalidate(projectIds)
  } catch (error) {
    logInvalidationError(error)
  }

  if (operationError) throw operationError
  return result
}

export {
  invalidateProjectStats,
  normalizedProjectIds,
  runWithProjectStatsInvalidation,
}
