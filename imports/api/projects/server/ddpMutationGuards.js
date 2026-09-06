function projectAdministratorMutationSelector(projectId, userId) {
  if (typeof projectId !== 'string' || !projectId
    || typeof userId !== 'string' || !userId) {
    throw new TypeError('Project and caller IDs are required.')
  }
  return {
    _id: projectId,
    $or: [{ userId }, { admins: userId }],
    lifecycleLock: { $exists: false },
    taskGraphLock: { $exists: false },
    $and: [
      {
        $or: [
          { lifecycleWriters: { $exists: false } },
          { lifecycleWriters: { $size: 0 } },
        ],
      },
      {
        $or: [
          { lifecycleWriterMetadata: { $exists: false } },
          { lifecycleWriterMetadata: { $size: 0 } },
        ],
      },
    ],
  }
}

function projectMutationMatched(result) {
  if (result === 1) return true
  return result?.matchedCount === 1
}

function isDefaultProjectTask(project, task) {
  return task?.isDefaultTask === true
    || (typeof task?.name === 'string' && project?.defaultTask === task.name)
}

function projectRateModifier(userId, rate) {
  if (typeof userId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(userId)
    || typeof rate !== 'number' || !Number.isFinite(rate)) {
    throw new TypeError('A safe user ID and finite rate are required.')
  }
  const field = `rates.${userId}`
  return rate > 0 ? { $set: { [field]: rate } } : { $unset: { [field]: '' } }
}

export {
  isDefaultProjectTask,
  projectAdministratorMutationSelector,
  projectMutationMatched,
  projectRateModifier,
}
