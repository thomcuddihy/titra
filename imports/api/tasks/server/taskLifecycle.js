import {
  matchesResourceRevision,
  resourceRevisionETag,
} from '../../../utils/resourceRevision.js'
import { dateOnlyToUTCDate, isDateOnly } from '../../../utils/timecardDate.js'
import { isProjectAdministrator, canViewProject } from '../../projects/server/projectLifecycle.js'
import { taskRecoveryFingerprint } from './taskGraphFence.js'

const PROJECT_TASK_FIELDS = new Set(['name', 'start', 'end', 'estimatedHours', 'dependencies'])

class TaskLifecycleError extends Error {
  constructor(code, reason) {
    super(reason)
    this.error = code
    this.reason = reason
  }
}

const taskError = (code, reason) => new TaskLifecycleError(code, reason)

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value))
}

function deepEqual(left, right) {
  if (Object.is(left, right)) return true
  if (left instanceof Date || right instanceof Date) {
    return left instanceof Date && right instanceof Date && left.getTime() === right.getTime()
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length
      && left.every((item, index) => deepEqual(item, right[index]))
  }
  if (plainObject(left) || plainObject(right)) {
    if (!plainObject(left) || !plainObject(right)) return false
    const leftKeys = Object.keys(left).sort(); const rightKeys = Object.keys(right).sort()
    return leftKeys.length === rightKeys.length
      && leftKeys.every((key, index) => key === rightKeys[index] && deepEqual(left[key], right[key]))
  }
  return false
}

function taskValue(task, field) {
  const value = task[field]
  if (['start', 'end'].includes(field)) {
    return value instanceof Date ? value.toISOString().slice(0, 10) : value ?? null
  }
  if (field === 'dependencies') return Array.isArray(value) ? value : []
  if (field === 'estimatedHours') return value ?? null
  return value ?? null
}

function validateProjectTaskValue(field, value) {
  if (!PROJECT_TASK_FIELDS.has(field)) throw taskError('project-task-invalid', 'Invalid field.')
  if (field === 'name') {
    if (typeof value !== 'string' || !value.trim() || !value.isWellFormed()
      || [...value].length > 1000) throw taskError('project-task-invalid', 'Invalid task name.')
  } else if (['start', 'end'].includes(field)) {
    if (value !== null && !isDateOnly(value)) throw taskError('project-task-invalid', `Invalid ${field}.`)
  } else if (field === 'estimatedHours') {
    if (value !== null && (typeof value !== 'number' || !Number.isFinite(value) || value < 0)) {
      throw taskError('project-task-invalid', 'Invalid estimated hours.')
    }
  } else if (!Array.isArray(value) || value.length > 500
    || value.some((id) => typeof id !== 'string' || !id || id.length > 128)
    || new Set(value).size !== value.length) {
    throw taskError('project-task-invalid', 'Dependencies must be unique task IDs.')
  }
}

function validateProjectTaskDetailsBody(body) {
  if (!plainObject(body) || Object.keys(body).length !== 2
    || !plainObject(body.expected) || !plainObject(body.changes)) {
    throw taskError('project-task-invalid', 'Supply only expected and changes objects.')
  }
  const expectedKeys = Object.keys(body.expected).sort(); const changeKeys = Object.keys(body.changes).sort()
  if (!changeKeys.length || changeKeys.length > PROJECT_TASK_FIELDS.size
    || expectedKeys.length !== changeKeys.length
    || expectedKeys.some((key, index) => key !== changeKeys[index])) {
    throw taskError('project-task-invalid', 'Expected and changed fields must match exactly.')
  }
  changeKeys.forEach((field) => {
    validateProjectTaskValue(field, body.expected[field])
    validateProjectTaskValue(field, body.changes[field])
  })
  return changeKeys
}

function projectTaskSnapshotSelector(task) {
  const selector = { _id: task._id }
  const fields = [
    'projectId', 'projectTaskRevision', 'name', 'start', 'end', 'estimatedHours',
    'dependencies', 'isDefaultTask',
  ]
  fields.forEach((field) => {
    selector[field] = Object.prototype.hasOwnProperty.call(task, field)
      ? { $eq: task[field], $exists: true } : { $exists: false }
  })
  return selector
}

function serializeProjectTask(task) {
  return {
    _id: task._id,
    projectId: task.projectId,
    name: taskValue(task, 'name'),
    start: taskValue(task, 'start'),
    end: taskValue(task, 'end'),
    estimatedHours: taskValue(task, 'estimatedHours'),
    dependencies: taskValue(task, 'dependencies'),
    isDefaultTask: task.isDefaultTask === true,
  }
}

async function getProjectTaskPreview({ taskId, userId }, {
  findTask,
  findProject,
  inspectReferences,
  canView = canViewProject,
}) {
  const task = await findTask({ _id: taskId, projectId: { $exists: true } })
  const project = task && await findProject({ _id: task.projectId })
  if (!task || !canView(project, userId)) throw taskError('not-authorized', 'Task not found.')
  return {
    payload: { ...serializeProjectTask(task), references: await inspectReferences(task) },
    etag: resourceRevisionETag('project-task', task),
  }
}

async function editProjectTask({ taskId, userId, body, expectedRevision }, {
  findTask, findProject, validateDependencies, withProjectWriter, updateOne,
}) {
  const fields = validateProjectTaskDetailsBody(body)
  const task = await findTask({ _id: taskId, projectId: { $exists: true } })
  const project = task && await findProject({ _id: task.projectId })
  if (!task || !isProjectAdministrator(project, userId)) throw taskError('not-authorized', 'Task not found.')
  if (!matchesResourceRevision('project-task', task, expectedRevision)
    || fields.some((field) => !deepEqual(taskValue(task, field), body.expected[field]))) {
    throw taskError('project-task-write-conflict', 'Task changed after preview.')
  }
  const isDefaultTask = task.isDefaultTask === true || project.defaultTask === task.name
  if (fields.includes('name') && isDefaultTask
    && body.changes.name !== body.expected.name) {
    throw taskError('project-task-default', 'Unset the project default task before renaming it.')
  }
  const candidate = Object.fromEntries([...PROJECT_TASK_FIELDS]
    .map((field) => [field, taskValue(task, field)]))
  fields.forEach((field) => { candidate[field] = body.changes[field] })
  if (candidate.start && candidate.end && candidate.start > candidate.end) {
    throw taskError('project-task-invalid', 'Task start must not be after its end.')
  }
  if (candidate.dependencies.includes(taskId)) {
    throw taskError('project-task-invalid', 'A task cannot depend on itself.')
  }
  const changedFields = fields.filter(
    (field) => !deepEqual(body.expected[field], body.changes[field]),
  )
  if (changedFields.length && task.projectTaskRevision === Number.MAX_SAFE_INTEGER) {
    throw taskError('project-task-write-conflict', 'Task revision cannot advance.')
  }
  const outcome = await withProjectWriter({ projectId: task.projectId, userId, taskId }, async () => {
    try {
      await validateDependencies(task.projectId, candidate.dependencies, taskId)
    } catch (error) {
      // Resolve a known read/validation failure normally so the fence can
      // release. Only a thrown child-store update remains outcome-unknown.
      return { prewriteError: error }
    }
    if (changedFields.length) {
      const set = {}; const unset = {}
      changedFields.forEach((field) => {
        const value = body.changes[field]
        if (['start', 'end'].includes(field)) {
          if (value === null) unset[field] = ''; else set[field] = dateOnlyToUTCDate(value)
        } else if (value === null) unset[field] = ''
        else set[field] = value
      })
      const modifier = { $set: set, $inc: { projectTaskRevision: 1 } }
      if (Object.keys(unset).length) modifier.$unset = unset
      const result = await updateOne(projectTaskSnapshotSelector(task), modifier)
      if (result?.matchedCount !== 1) return { conflict: true }
    } else {
      try {
        if (!await findTask(projectTaskSnapshotSelector(task))) return { conflict: true }
      } catch (error) {
        return { prewriteError: error }
      }
    }
    const revision = changedFields.length ? (task.projectTaskRevision ?? 0) + 1 : task.projectTaskRevision
    return {
      response: {
        payload: { taskId, changed: changedFields.length > 0, changedFields, current: candidate },
        etag: resourceRevisionETag('project-task', changedFields.length
          ? { projectTaskRevision: revision } : task),
      },
    }
  })
  if (outcome?.prewriteError) throw outcome.prewriteError
  if (outcome?.conflict || !outcome?.response) {
    throw taskError('project-task-write-conflict', 'Task changed after preview.')
  }
  return outcome.response
}

async function deleteProjectTask({
  taskId, userId, expectedName, acknowledgeRecordedEntries, expectedRevision,
}, { findTask, findProject, deleteTaskWithFence }) {
  const task = await findTask({ _id: taskId, projectId: { $exists: true } })
  const project = task && await findProject({ _id: task.projectId })
  if (!task || !isProjectAdministrator(project, userId)) throw taskError('not-authorized', 'Task not found.')
  if (!matchesResourceRevision('project-task', task, expectedRevision) || task.name !== expectedName) {
    throw taskError('project-task-write-conflict', 'Task changed after preview.')
  }
  const fenced = await deleteTaskWithFence({
    task,
    project,
    userId,
    taskFingerprint: taskRecoveryFingerprint(task),
    acknowledgeRecordedEntries,
    expectedTaskSelector: projectTaskSnapshotSelector(task),
  })
  if (fenced?.status === 'default') {
    throw taskError('project-task-default', 'Unset the project default task before deleting it.')
  }
  if (fenced?.status === 'dependent') {
    throw taskError('project-task-dependent', 'Remove task dependencies before deleting it.')
  }
  if (fenced?.status === 'recorded') {
    throw taskError('project-task-recorded', 'Acknowledge that historical records keep this task name.')
  }
  if (fenced?.status !== 'deleted') {
    throw taskError('project-task-write-conflict', 'Task changed after preview.')
  }
  return { taskId, deleted: true, references: fenced.state }
}

function suggestionSnapshotSelector(suggestion) {
  const selector = { _id: suggestion._id, userId: suggestion.userId, projectId: null }
  for (const field of ['name', 'lastUsed', 'taskSuggestionRevision']) {
    selector[field] = Object.prototype.hasOwnProperty.call(suggestion, field)
      ? { $eq: suggestion[field], $exists: true } : { $exists: false }
  }
  return selector
}

function serializeSuggestion(suggestion, usage) {
  return {
    _id: suggestion._id,
    name: suggestion.name,
    lastUsed: suggestion.lastUsed ?? null,
    usage: {
      recordCount: usage?.recordCount ?? 0,
      totalHours: usage?.totalHours ?? 0,
      lastRecordedAt: usage?.lastRecordedAt ?? null,
      projectCount: usage?.projectCount ?? 0,
    },
  }
}

async function getTaskSuggestionPreview({ suggestionId, userId }, { findSuggestion, getUsage }) {
  const suggestion = await findSuggestion({
    _id: suggestionId, userId, projectId: null,
  })
  if (!suggestion) throw taskError('not-authorized', 'Task suggestion not found.')
  return {
    payload: serializeSuggestion(suggestion, await getUsage(userId, suggestion.name)),
    etag: resourceRevisionETag('task-suggestion', suggestion),
  }
}

async function deleteTaskSuggestion({
  suggestionId, userId, expectedName, acknowledgeReferencedRecords, expectedRevision,
}, { findSuggestion, getUsage, deleteOne }) {
  const suggestion = await findSuggestion({
    _id: suggestionId, userId, projectId: null,
  })
  if (!suggestion) throw taskError('not-authorized', 'Task suggestion not found.')
  if (!matchesResourceRevision('task-suggestion', suggestion, expectedRevision)
    || suggestion.name !== expectedName) {
    throw taskError('task-suggestion-write-conflict', 'Suggestion changed after preview.')
  }
  const usage = await getUsage(userId, suggestion.name)
  if ((usage?.recordCount ?? 0) > 0 && acknowledgeReferencedRecords !== true) {
    throw taskError('task-suggestion-referenced', 'Acknowledge records that still use this name.')
  }
  const result = await deleteOne(suggestionSnapshotSelector(suggestion))
  if (result?.deletedCount !== 1) {
    throw taskError('task-suggestion-write-conflict', 'Suggestion changed after preview.')
  }
  return { suggestionId, deleted: true, usage: serializeSuggestion(suggestion, usage).usage }
}

export {
  TaskLifecycleError,
  deleteProjectTask,
  deleteTaskSuggestion,
  editProjectTask,
  getProjectTaskPreview,
  getTaskSuggestionPreview,
  projectTaskSnapshotSelector,
  serializeProjectTask,
  serializeSuggestion,
  suggestionSnapshotSelector,
  validateProjectTaskDetailsBody,
}
