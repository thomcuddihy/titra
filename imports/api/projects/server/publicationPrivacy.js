const PUBLIC_PROJECT_FIELDS = Object.freeze({
  _id: 1,
  name: 1,
  description: 1,
  desc: 1,
  color: 1,
  archived: 1,
  public: 1,
  notbillable: 1,
  startDate: 1,
  endDate: 1,
})

const MEMBER_PROJECT_FIELDS = Object.freeze({
  ...PUBLIC_PROJECT_FIELDS,
  userId: 1,
  team: 1,
  admins: 1,
  customer: 1,
  budget: 1,
  target: 1,
  rate: 1,
  rates: 1,
  defaultTask: 1,
  priority: 1,
  selectedWekanList: 1,
  selectedWekanSwimlanes: 1,
  gitlabquery: 1,
  projectRevision: 1,
})

function projectMembershipSelector(userId) {
  return { $or: [{ userId }, { admins: userId }, { team: userId }] }
}

function publicNonmemberSelector(userId) {
  return {
    public: true,
    $nor: [{ userId }, { admins: userId }, { team: userId }],
  }
}

function projectFields({ member, customFieldNames = [] }) {
  if (!member) return { ...PUBLIC_PROJECT_FIELDS }
  const fields = { ...MEMBER_PROJECT_FIELDS }
  customFieldNames.forEach((name) => {
    if (typeof name === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(name)) fields[name] = 1
  })
  return fields
}

function projectFieldsForCaller(project, userId, customFieldNames = []) {
  const member = project?.userId === userId
    || project?.admins?.includes(userId)
    || project?.team?.includes(userId)
  const allowed = projectFields({ member, customFieldNames })
  return Object.fromEntries(Object.keys(allowed)
    .filter((field) => field !== '_id' && Object.prototype.hasOwnProperty.call(project, field))
    .map((field) => [field, project[field]]))
}

function changedProjectFields(previous, current) {
  const changes = {}
  for (const key of new Set([...Object.keys(previous || {}), ...Object.keys(current)])) {
    if (!Object.prototype.hasOwnProperty.call(current, key)) changes[key] = undefined
    else if (!Object.is(previous?.[key], current[key])) changes[key] = current[key]
  }
  return changes
}

function projectStatsForCaller(totals, project, userId) {
  const member = project?.userId === userId
    || project?.admins?.includes(userId)
    || project?.team?.includes(userId)
  const fields = [
    'totalHours', 'currentMonthHours', 'previousMonthHours', 'beforePreviousMonthHours',
  ]
  if (member) fields.push('totalRevenue')
  return Object.fromEntries(fields
    .filter((field) => Object.prototype.hasOwnProperty.call(totals || {}, field))
    .map((field) => [field, totals[field]]))
}

function canViewProject(project, userId) {
  return project?.userId === userId
    || project?.admins?.includes(userId)
    || project?.team?.includes(userId)
    || project?.public === true
}

function projectStatsPublicationDocuments({
  projectId, project, totals, userId, monthNames,
}) {
  if (!project || !totals || !canViewProject(project, userId)) return new Map()
  return new Map([[projectId, {
    ...projectStatsForCaller(totals, project, userId),
    ...monthNames,
  }]])
}

export {
  canViewProject,
  changedProjectFields,
  MEMBER_PROJECT_FIELDS,
  PUBLIC_PROJECT_FIELDS,
  projectFields,
  projectFieldsForCaller,
  projectMembershipSelector,
  projectStatsForCaller,
  projectStatsPublicationDocuments,
  publicNonmemberSelector,
}
