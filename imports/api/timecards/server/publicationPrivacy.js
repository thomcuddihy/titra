const PUBLIC_TIMECARD_FIELDS = Object.freeze({
  _id: 1,
  userId: 1,
  projectId: 1,
  date: 1,
  hours: 1,
  task: 1,
})

const MEMBER_TIMECARD_FIELDS = Object.freeze({
  ...PUBLIC_TIMECARD_FIELDS,
  state: 1,
  taskRate: 1,
})

function isProjectMember(project, userId) {
  return project?.userId === userId
    || project?.admins?.includes(userId)
    || project?.team?.includes(userId)
}

function canViewProject(project, userId) {
  return isProjectMember(project, userId) || project?.public === true
}

function timecardFields({ member, customFieldNames = [] }) {
  if (!member) return { ...PUBLIC_TIMECARD_FIELDS }
  const fields = { ...MEMBER_TIMECARD_FIELDS }
  customFieldNames.forEach((name) => {
    if (typeof name === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(name)) fields[name] = 1
  })
  return fields
}

function timecardFieldsForCaller(
  timecard, project, userId, customFieldNames = [], ownsRecord = false,
) {
  const allowed = timecardFields({
    member: ownsRecord || isProjectMember(project, userId),
    customFieldNames,
  })
  return Object.fromEntries(Object.keys(allowed)
    .filter((field) => field !== '_id'
      && Object.prototype.hasOwnProperty.call(timecard || {}, field))
    .map((field) => [field, timecard[field]]))
}

function timecardPublicationDocuments({
  timecards,
  projects,
  userId,
  customFieldNames = [],
  includeOwnedRecords = false,
}) {
  return new Map([...timecards]
    .filter(([, timecard]) => (includeOwnedRecords && timecard.userId === userId)
      || canViewProject(projects.get(timecard.projectId), userId))
    .map(([id, timecard]) => {
      const ownsRecord = includeOwnedRecords && timecard.userId === userId
      return [
        id,
        timecardFieldsForCaller(
          timecard, projects.get(timecard.projectId), userId, customFieldNames, ownsRecord,
        ),
      ]
    }))
}

function timecardCountPublicationDocuments({ timecards, projects, userId, countsId }) {
  return new Map([[countsId, {
    count: [...timecards.values()].filter((timecard) => canViewProject(
      projects.get(timecard.projectId), userId,
    )).length,
  }]])
}

function partitionVisibleProjectIds(projects, userId) {
  const member = []
  const publicOnly = []
  for (const project of projects || []) {
    if (isProjectMember(project, userId)) member.push(project._id)
    else if (project?.public === true) publicOnly.push(project._id)
  }
  return { member, publicOnly }
}

function visibleProjectIds(projects, userId) {
  const partitioned = partitionVisibleProjectIds(projects, userId)
  return [...partitioned.member, ...partitioned.publicOnly]
}

function projectIdsFromTimecardSelector(selector) {
  if (!selector || typeof selector !== 'object') return []
  if (selector.projectId?.$in && Array.isArray(selector.projectId.$in)) {
    return selector.projectId.$in.filter((id) => typeof id === 'string')
  }
  if (typeof selector.projectId === 'string') return [selector.projectId]
  if (Array.isArray(selector.$and)) {
    return [...new Set(selector.$and.flatMap(projectIdsFromTimecardSelector))]
  }
  return []
}

function scopeSelectorToProjects(selector, projectIds) {
  return { $and: [selector, { projectId: { $in: projectIds } }] }
}

export {
  MEMBER_TIMECARD_FIELDS,
  PUBLIC_TIMECARD_FIELDS,
  canViewProject,
  isProjectMember,
  partitionVisibleProjectIds,
  projectIdsFromTimecardSelector,
  scopeSelectorToProjects,
  timecardCountPublicationDocuments,
  timecardFields,
  timecardFieldsForCaller,
  timecardPublicationDocuments,
  visibleProjectIds,
}
