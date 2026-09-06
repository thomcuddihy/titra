class PublicProjectPolicyError extends Error {
  constructor(code = 'public-projects-disabled') {
    super(code)
    this.name = 'PublicProjectPolicyError'
    this.code = code
  }
}

function publicProjectsDisabled(value) {
  return value === true
}

function projectAudienceClauses(userId, disabled = false) {
  const clauses = [{ userId }, { admins: userId }, { team: userId }]
  if (!disabled) clauses.push({ public: true })
  return clauses
}

function isProjectMemberForPolicy(project, userId) {
  return project?.userId === userId
    || project?.admins?.includes(userId)
    || project?.team?.includes(userId)
}

function canViewProjectUnderPolicy(project, userId, disabled = false) {
  return isProjectMemberForPolicy(project, userId)
    || (!disabled && project?.public === true)
}

function assertPublicProjectValueAllowed(value, disabled = false) {
  if (disabled && value === true) throw new PublicProjectPolicyError()
  return value === true
}

export {
  PublicProjectPolicyError,
  assertPublicProjectValueAllowed,
  canViewProjectUnderPolicy,
  isProjectMemberForPolicy,
  projectAudienceClauses,
  publicProjectsDisabled,
}
