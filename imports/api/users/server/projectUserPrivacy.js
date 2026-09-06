const ADMIN_USER_LIST_FIELDS = Object.freeze({
  'profile.name': 1,
  'profile.avatar': 1,
  'profile.avatarColor': 1,
  'emails.address': 1,
  isAdmin: 1,
  createdAt: 1,
  inactive: 1,
})

function projectRole(project, userId) {
  if (!project || typeof userId !== 'string') return 'none'
  if (project.userId === userId) return 'owner'
  if (project.admins?.includes(userId)) return 'admin'
  if (project.team?.includes(userId)) return 'member'
  if (project.public === true) return 'public'
  return 'none'
}

function projectMemberIds(project) {
  return [...new Set([
    project?.userId,
    ...(project?.admins || []),
    ...(project?.team || []),
  ].filter((value) => typeof value === 'string' && value))]
}

function publicNameOnlyUser(user) {
  if (!user || user.inactive === true || typeof user._id !== 'string') return null
  return {
    _id: user._id,
    profile: { name: typeof user.profile?.name === 'string' ? user.profile.name : '' },
  }
}

function userSelectorForProjectAudience(project, callerUserId) {
  const role = projectRole(project, callerUserId)
  if (role === 'none') return null
  if (role === 'owner' || role === 'admin') return { inactive: { $ne: true } }
  if (role === 'member') {
    return { _id: { $in: projectMemberIds(project) }, inactive: { $ne: true } }
  }
  return { _id: callerUserId, inactive: { $ne: true } }
}

function allowedProjectResourceUserIds(projects, timecards, callerUserId) {
  const projectById = new Map((projects || []).map((project) => [project._id, project]))
  const allowed = new Set()
  for (const timecard of timecards || []) {
    const project = projectById.get(timecard.projectId)
    const role = projectRole(project, callerUserId)
    if (role === 'owner' || role === 'admin') allowed.add(timecard.userId)
    else if (role === 'member' && projectMemberIds(project).includes(timecard.userId)) {
      allowed.add(timecard.userId)
    } else if (role === 'public' && timecard.userId === callerUserId) {
      allowed.add(callerUserId)
    }
  }
  return [...allowed].filter((value) => typeof value === 'string' && value)
}

function canViewDashboardResource(dashboard, project, callerUserId) {
  if (!dashboard || !project || dashboard.projectId !== project._id
    || typeof dashboard.resourceId !== 'string' || !dashboard.resourceId) return false
  return ['owner', 'admin', 'member'].includes(projectRole(project, callerUserId))
}

function collectionValues(value) {
  if (value instanceof Map) return [...value.values()]
  return Array.isArray(value) ? value : []
}

function activeNameUsers(users) {
  return new Map(collectionValues(users).map(publicNameOnlyUser)
    .filter(Boolean).map((user) => [user._id, user]))
}

function projectAudienceUserRows({ projects, timecards, users, callerUserId }) {
  const projectRows = collectionValues(projects)
  const activeUsers = activeNameUsers(users)
  return allowedProjectResourceUserIds(
    projectRows, collectionValues(timecards), callerUserId,
  ).map((userId) => activeUsers.get(userId)).filter(Boolean)
    .sort((left, right) => left.profile.name.localeCompare(right.profile.name)
      || left._id.localeCompare(right._id))
}

function projectUsersPublicationDocuments({
  publicationId, projects, timecards, users, callerUserId,
}) {
  if (!collectionValues(projects).some(
    (project) => projectRole(project, callerUserId) !== 'none',
  )) return new Map()
  return new Map([[publicationId, {
    users: projectAudienceUserRows({ projects, timecards, users, callerUserId }),
  }]])
}

function projectResourcesPublicationDocuments({ projects, timecards, users, callerUserId }) {
  return new Map(projectAudienceUserRows({
    projects, timecards, users, callerUserId,
  }).map((user) => [user._id, { name: user.profile.name }]))
}

function projectTeamPublicationDocuments({
  projects, users, requestedUserIds, callerUserId,
}) {
  const permittedIds = new Set(collectionValues(projects)
    .filter((project) => ['owner', 'admin', 'member'].includes(projectRole(project, callerUserId)))
    .flatMap(projectMemberIds))
  const activeUsers = activeNameUsers(users)
  return new Map([...new Set(requestedUserIds || [])]
    .filter((userId) => permittedIds.has(userId) && activeUsers.has(userId))
    .map((userId) => [userId, { profile: { name: activeUsers.get(userId).profile.name } }]))
}

function dashboardUserPublicationDocuments({ dashboard, project, users, callerUserId }) {
  if (!canViewDashboardResource(dashboard, project, callerUserId)) return new Map()
  const user = activeNameUsers(users).get(dashboard.resourceId)
  return user ? new Map([[user._id, { profile: { name: user.profile.name } }]]) : new Map()
}

export {
  ADMIN_USER_LIST_FIELDS,
  allowedProjectResourceUserIds,
  canViewDashboardResource,
  dashboardUserPublicationDocuments,
  projectMemberIds,
  projectResourcesPublicationDocuments,
  projectRole,
  projectTeamPublicationDocuments,
  projectUsersPublicationDocuments,
  publicNameOnlyUser,
  userSelectorForProjectAudience,
}
