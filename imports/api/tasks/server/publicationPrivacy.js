const PUBLIC_PROJECT_TASK_FIELDS = Object.freeze({
  _id: 1,
  projectId: 1,
  name: 1,
  start: 1,
  end: 1,
  estimatedHours: 1,
  dependencies: 1,
  isDefaultTask: 1,
})

const PERSONAL_SUGGESTION_FIELDS = Object.freeze({
  _id: 1,
  userId: 1,
  name: 1,
  lastUsed: 1,
})

function isProjectMember(project, userId) {
  return project?.userId === userId
    || project?.admins?.includes(userId)
    || project?.team?.includes(userId)
}

function canViewProject(project, userId, publicDisabled = false) {
  return isProjectMember(project, userId) || (!publicDisabled && project?.public === true)
}

function projectTaskFields({ member, customFieldNames = [] }) {
  const fields = { ...PUBLIC_PROJECT_TASK_FIELDS }
  if (member) {
    customFieldNames.forEach((name) => {
      if (typeof name === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(name)) fields[name] = 1
    })
  }
  return fields
}

function taskFieldsForCaller(task, project, userId, customFieldNames = []) {
  const allowed = projectTaskFields({ member: isProjectMember(project, userId), customFieldNames })
  return Object.fromEntries(Object.keys(allowed)
    .filter((field) => field !== '_id' && Object.prototype.hasOwnProperty.call(task, field))
    .map((field) => [field, task[field]]))
}

function personalSuggestionFields(task) {
  return Object.fromEntries(Object.keys(PERSONAL_SUGGESTION_FIELDS)
    .filter((field) => field !== '_id'
      && Object.prototype.hasOwnProperty.call(task || {}, field))
    .map((field) => [field, task[field]]))
}

function taskSearchPublicationDocuments({
  tasks, project, projectId, userId, customFieldNames = [], publicDisabled = false,
}) {
  const desired = new Map()
  tasks.forEach((task, id) => {
    if (task.projectId === projectId) {
      if (canViewProject(project, userId, publicDisabled)) {
        desired.set(id, taskFieldsForCaller(task, project, userId, customFieldNames))
      }
    } else if (task.userId === userId) desired.set(id, personalSuggestionFields(task))
  })
  return desired
}

function changedTaskFields(previous, current) {
  const changes = {}
  for (const key of new Set([...Object.keys(previous || {}), ...Object.keys(current)])) {
    if (!Object.prototype.hasOwnProperty.call(current, key)) changes[key] = undefined
    else if (!Object.is(previous?.[key], current[key])) changes[key] = current[key]
  }
  return changes
}

export {
  PERSONAL_SUGGESTION_FIELDS,
  PUBLIC_PROJECT_TASK_FIELDS,
  canViewProject,
  changedTaskFields,
  isProjectMember,
  personalSuggestionFields,
  projectTaskFields,
  taskSearchPublicationDocuments,
  taskFieldsForCaller,
}
