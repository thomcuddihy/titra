class TimecardCreateAuthorizationError extends Error {
  constructor() {
    super('Time entry project is not available to this user.')
    this.error = 'not-authorized'
  }
}

function canRegisterTime(project, userId) {
  return project?.public === true
    || project?.userId === userId
    || project?.admins?.includes(userId)
    || project?.team?.includes(userId)
}

/**
 * Resolve project access before evaluating the configurable rule. This order
 * prevents a nonmember from using rule success/failure or timing as an oracle
 * for fields of a private project. The child-writer reservation still repeats
 * this authorization atomically immediately before the database write.
 */
async function runAuthorizedTimecardCreateRule({
  projectId, userId, ruleInput,
}, { findProject, checkRule }) {
  const project = await findProject({ _id: projectId })
  if (!canRegisterTime(project, userId)) throw new TimecardCreateAuthorizationError()
  await checkRule(ruleInput)
  return project
}

export {
  TimecardCreateAuthorizationError,
  canRegisterTime,
  runAuthorizedTimecardCreateRule,
}
