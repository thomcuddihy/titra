import {
  matchesResourceRevision,
  resourceRevisionETag,
} from '../../../utils/resourceRevision.js'
import { isDateOnly, dateOnlyToUTCDate } from '../../../utils/timecardDate.js'

const PROJECT_DETAIL_FIELDS = new Set([
  'name', 'description', 'color', 'customer', 'rate', 'budget',
  'startDate', 'endDate', 'public', 'notbillable',
])

class ProjectLifecycleError extends Error {
  constructor(code, reason) {
    super(reason)
    this.error = code
    this.reason = reason
  }
}

const projectError = (code, reason) => new ProjectLifecycleError(code, reason)

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value))
}

function isProjectOwner(project, userId) {
  return project?.userId === userId
}

function isProjectAdministrator(project, userId) {
  return isProjectOwner(project, userId) || project?.admins?.includes(userId)
}

function isProjectMember(project, userId) {
  return isProjectAdministrator(project, userId) || project?.team?.includes(userId)
}

function canViewProject(project, userId) {
  return isProjectMember(project, userId) || project?.public === true
}

function projectDescriptionText(value) {
  if (typeof value === 'string') {
    return value.isWellFormed() ? [...value].slice(0, 50000).join('') : ''
  }
  if (!value || !Array.isArray(value.ops)) return ''
  let result = ''
  for (const operation of value.ops) {
    if (typeof operation?.insert === 'string' && operation.insert.isWellFormed()) {
      result += operation.insert
      if ([...result].length >= 50000) break
    }
  }
  return [...result].slice(0, 50000).join('')
}

function normalizeDetail(project, field) {
  if (field === 'description') {
    const value = project.description ?? project.desc
    return value == null ? null : projectDescriptionText(value)
  }
  if (['rate', 'budget', 'startDate', 'endDate'].includes(field)) {
    const value = project[field]
    if (value == null) return null
    if (value instanceof Date) return value.toISOString().slice(0, 10)
    return value
  }
  if (['public', 'notbillable'].includes(field)) return project[field] === true
  return project[field] ?? null
}

function validateProjectDetail(field, value, { expected = false } = {}) {
  if (!PROJECT_DETAIL_FIELDS.has(field)) throw projectError('project-invalid', 'Invalid field.')
  if (field === 'name') {
    if (typeof value !== 'string' || !value.trim() || !value.isWellFormed()
      || [...value].length > 200) throw projectError('project-invalid', 'Invalid name.')
  } else if (field === 'description') {
    if (value !== null && (typeof value !== 'string' || !value.isWellFormed()
      || [...value].length > 50000)) throw projectError('project-invalid', 'Invalid description.')
  } else if (field === 'color') {
    if (value !== null && (typeof value !== 'string' || !/^#[\da-f]{6}$/i.test(value))) {
      throw projectError('project-invalid', 'Invalid color.')
    }
  } else if (field === 'customer') {
    if (value !== null && (typeof value !== 'string' || !value.isWellFormed()
      || [...value].length > 500)) throw projectError('project-invalid', 'Invalid customer.')
  } else if (['rate', 'budget'].includes(field)) {
    if (value !== null && (typeof value !== 'number' || !Number.isFinite(value) || value < 0)) {
      throw projectError('project-invalid', `Invalid ${field}.`)
    }
  } else if (['startDate', 'endDate'].includes(field)) {
    if (value !== null && !isDateOnly(value)) throw projectError('project-invalid', `Invalid ${field}.`)
  } else if (typeof value !== 'boolean') {
    throw projectError('project-invalid', `Invalid ${field}.`)
  }
  if (!expected && value === undefined) throw projectError('project-invalid', 'Missing value.')
}

function validateProjectDetailsBody(body) {
  if (!plainObject(body) || Object.keys(body).length !== 2
    || !plainObject(body.expected) || !plainObject(body.changes)) {
    throw projectError('project-invalid', 'Supply only expected and changes objects.')
  }
  const expectedKeys = Object.keys(body.expected).sort()
  const changeKeys = Object.keys(body.changes).sort()
  if (!changeKeys.length || changeKeys.length > PROJECT_DETAIL_FIELDS.size
    || expectedKeys.length !== changeKeys.length
    || expectedKeys.some((key, index) => key !== changeKeys[index])) {
    throw projectError('project-invalid', 'Expected and changed fields must match exactly.')
  }
  changeKeys.forEach((field) => {
    validateProjectDetail(field, body.expected[field], { expected: true })
    validateProjectDetail(field, body.changes[field])
  })
  return changeKeys
}

function projectSnapshotSelector(project) {
  const selector = { _id: project._id }
  const fields = [
    'userId', 'admins', 'team', 'projectRevision', 'name', 'description', 'desc',
    'color', 'customer', 'rate', 'budget', 'startDate', 'endDate', 'public',
    'notbillable', 'archived', 'defaultTask', 'rates', 'priority', 'lifecycleLock',
  ]
  fields.forEach((field) => {
    selector[field] = Object.prototype.hasOwnProperty.call(project, field)
      ? { $eq: project[field], $exists: true }
      : { $exists: false }
  })
  return selector
}

function serializeProjectForCaller(project, userId) {
  if (!canViewProject(project, userId)) return null
  const details = Object.fromEntries(
    [...PROJECT_DETAIL_FIELDS].map((field) => [field, normalizeDetail(project, field)]),
  )
  const base = {
    _id: project._id,
    ...details,
    archived: project.archived === true,
    role: isProjectOwner(project, userId) ? 'owner'
      : project.admins?.includes(userId) ? 'admin'
        : project.team?.includes(userId) ? 'member' : 'public',
  }
  if (isProjectMember(project, userId)) {
    return {
      ...base,
      userId: project.userId,
      team: [...new Set(project.team || [])],
      admins: [...new Set(project.admins || [])],
      defaultTask: project.defaultTask ?? null,
      priority: project.priority ?? null,
    }
  }
  // Public visibility never discloses membership, per-user rates, integration
  // settings, billing/customer data, or arbitrary project fields.
  return {
    _id: base._id,
    name: base.name,
    description: base.description,
    color: base.color,
    archived: base.archived,
    public: base.public,
    notbillable: base.notbillable,
    startDate: base.startDate,
    endDate: base.endDate,
  }
}

async function getProjectLifecyclePreview({ projectId, userId }, { findProject }) {
  if (typeof projectId !== 'string' || !projectId || projectId.length > 128
    || typeof userId !== 'string' || !userId) throw projectError('project-invalid', 'Invalid project ID.')
  const project = await findProject({ _id: projectId })
  const payload = serializeProjectForCaller(project, userId)
  if (!payload) throw projectError('not-authorized', 'Project not found.')
  return { payload, etag: resourceRevisionETag('project', project) }
}

async function editProjectDetails({ projectId, userId, body, expectedRevision }, {
  findProject, updateOne,
}) {
  const fields = validateProjectDetailsBody(body)
  const project = await findProject({ _id: projectId })
  if (!project || project.lifecycleLock || !isProjectAdministrator(project, userId)) {
    throw projectError('not-authorized', 'Project not found.')
  }
  if (!matchesResourceRevision('project', project, expectedRevision)
    || fields.some((field) => !Object.is(normalizeDetail(project, field), body.expected[field]))) {
    throw projectError('project-write-conflict', 'Project changed after preview.')
  }
  const candidate = Object.fromEntries([...PROJECT_DETAIL_FIELDS]
    .map((field) => [field, normalizeDetail(project, field)]))
  fields.forEach((field) => { candidate[field] = body.changes[field] })
  if (candidate.startDate && candidate.endDate && candidate.startDate > candidate.endDate) {
    throw projectError('project-invalid', 'Project start date must not be after its end date.')
  }
  const changedFields = fields.filter((field) => !Object.is(body.expected[field], body.changes[field]))
  if (changedFields.length && project.projectRevision === Number.MAX_SAFE_INTEGER) {
    throw projectError('project-write-conflict', 'Project revision cannot advance.')
  }
  if (changedFields.length) {
    const set = {}
    const unset = {}
    changedFields.forEach((field) => {
      const value = body.changes[field]
      if (field === 'description') {
        if (value === null) { unset.description = ''; unset.desc = '' } else {
          set.description = value; set.desc = value
        }
      } else if (['startDate', 'endDate'].includes(field)) {
        if (value === null) unset[field] = ''
        else set[field] = dateOnlyToUTCDate(value)
      } else if (value === null) unset[field] = ''
      else set[field] = value
    })
    const modifier = { $set: set, $inc: { projectRevision: 1 } }
    if (Object.keys(unset).length) modifier.$unset = unset
    const result = await updateOne(projectSnapshotSelector(project), modifier)
    if (result?.matchedCount !== 1) throw projectError('project-write-conflict', 'Project changed after preview.')
  } else if (!await findProject(projectSnapshotSelector(project))) {
    throw projectError('project-write-conflict', 'Project changed after preview.')
  }
  const nextRevision = changedFields.length ? (project.projectRevision ?? 0) + 1 : project.projectRevision
  return {
    payload: { projectId, changed: changedFields.length > 0, changedFields, current: candidate },
    etag: resourceRevisionETag('project', changedFields.length
      ? { projectRevision: nextRevision } : project),
  }
}

async function setProjectArchived({
  projectId, userId, archived, expectedArchived, expectedRevision,
}, { findProject, updateOne }) {
  if (typeof archived !== 'boolean' || typeof expectedArchived !== 'boolean') {
    throw projectError('project-invalid', 'Archived values must be booleans.')
  }
  const project = await findProject({ _id: projectId })
  if (!project || project.lifecycleLock || !isProjectAdministrator(project, userId)) {
    throw projectError('not-authorized', 'Project not found.')
  }
  if (!matchesResourceRevision('project', project, expectedRevision)
    || (project.archived === true) !== expectedArchived) {
    throw projectError('project-write-conflict', 'Project changed after preview.')
  }
  const changed = archived !== expectedArchived
  if (changed && project.projectRevision === Number.MAX_SAFE_INTEGER) {
    throw projectError('project-write-conflict', 'Project revision cannot advance.')
  }
  if (changed) {
    const result = await updateOne(projectSnapshotSelector(project), {
      $set: { archived }, $inc: { projectRevision: 1 },
    })
    if (result?.matchedCount !== 1) throw projectError('project-write-conflict', 'Project changed after preview.')
  }
  const revision = changed ? (project.projectRevision ?? 0) + 1 : project.projectRevision
  return {
    payload: { projectId, archived, changed },
    etag: resourceRevisionETag('project', changed ? { projectRevision: revision } : project),
  }
}

async function deleteEmptyOwnedProject({
  projectId, userId, expectedName, expectedRevision,
}, { findProject, deleteEmptyProject }) {
  if (typeof expectedName !== 'string') throw projectError('project-invalid', 'Expected name is required.')
  const project = await findProject({ _id: projectId })
  if (!project || project.lifecycleLock || !isProjectOwner(project, userId)) {
    throw projectError('not-authorized', 'Project not found.')
  }
  if (!matchesResourceRevision('project', project, expectedRevision) || project.name !== expectedName) {
    throw projectError('project-write-conflict', 'Project changed after preview.')
  }
  // This dependency must fence child creation while checking both collections;
  // a count-then-remove sequence without such a fence is not sufficient.
  const result = await deleteEmptyProject(projectSnapshotSelector(project))
  if (result?.status === 'not-empty') {
    throw projectError('project-not-empty', 'Only empty projects can be deleted; archive it instead.')
  }
  if (result?.status !== 'deleted') throw projectError('project-write-conflict', 'Project changed after preview.')
  return { projectId, deleted: true, counts: { timecards: 0, projectTasks: 0 } }
}

export {
  ProjectLifecycleError,
  canViewProject,
  deleteEmptyOwnedProject,
  editProjectDetails,
  getProjectLifecyclePreview,
  isProjectAdministrator,
  isProjectMember,
  isProjectOwner,
  projectSnapshotSelector,
  serializeProjectForCaller,
  setProjectArchived,
  validateProjectDetailsBody,
}
