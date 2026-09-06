import { check, Match } from 'meteor/check'
import { DDPRateLimiter } from 'meteor/ddp-rate-limiter'
import { checkAuthentication, getGlobalSettingAsync } from '../../../utils/server_method_helpers.js'
import Tasks from '../tasks.js'
import Projects from '../../projects/projects.js'
import CustomFields from '../../customfields/customfields.js'
import {
  applyObserverChange,
  createPublicationReconciler,
  createRestartableDocumentObserver,
} from '../../../utils/reactivePublication.js'
import {
  PERSONAL_SUGGESTION_FIELDS,
  changedTaskFields,
  projectTaskFields,
  taskSearchPublicationDocuments,
  taskFieldsForCaller,
} from './publicationPrivacy.js'
import {
  MAX_PROJECT_TASKS,
  assertProjectId,
  assertTaskSearchFilter,
  assertTaskSearchLimit,
  boundedTaskSearchLimit,
} from './publicationInput.js'
import {
  currentPublicProjectsDisabled,
  stopPublicationOnPublicAccessDisable,
} from '../../projects/server/publicAccessServer.js'
import { canViewProjectUnderPolicy } from '../../projects/server/publicAccessPolicy.js'
import { createActivePublicationGate } from '../../../utils/activePublicationGate.js'

const taskPublicationGate = createActivePublicationGate({
  perUser: 20,
  perPeer: 50,
  total: 500,
})

for (const name of ['allmytasks', 'mytasks', 'projectTasks']) {
  DDPRateLimiter.addRule({
    type: 'subscription',
    name,
    userId(userId) { return typeof userId === 'string' && userId.length > 0 },
  }, 60, 60 * 1000)
  DDPRateLimiter.addRule({
    type: 'subscription',
    name,
    clientAddress(clientAddress) {
      return typeof clientAddress === 'string' && clientAddress.length > 0
    },
  }, 120, 60 * 1000)
}

function acquireTaskPublicationSlot(context) {
  const release = taskPublicationGate.acquire({
    userId: context.userId,
    peerAddress: context.connection?.clientAddress,
  })
  if (!release) {
    throw new Meteor.Error(
      'subscription-limit',
      'Too many active task subscriptions. Close another view and try again.',
    )
  }
  context.onStop(release)
}

const projectAccessFields = { _id: 1, userId: 1, admins: 1, team: 1, public: 1 }

async function configuredTaskCustomFields() {
  const fields = await CustomFields.find({ classname: 'task' }, {
    fields: { name: 1 },
  }).fetchAsync()
  return fields.map((field) => field.name)
}

async function findVisibleProject(projectId, userId, publicDisabled) {
  const project = await Projects.findOneAsync({ _id: projectId }, {
    fields: projectAccessFields,
  })
  return canViewProjectUnderPolicy(project, userId, publicDisabled) ? project : null
}

async function publishProjectTasksForCaller(context, projectId, userId) {
  acquireTaskPublicationSlot(context)
  const publicDisabled = await currentPublicProjectsDisabled()
  await stopPublicationOnPublicAccessDisable(context, publicDisabled)
  let project = await findVisibleProject(projectId, userId, publicDisabled)
  if (!project) return context.ready()
  const customFieldNames = await configuredTaskCustomFields()
  const memberFields = projectTaskFields({ member: true, customFieldNames })
  const documents = new Map()
  const published = new Map()
  let stopped = false
  let failed = false
  let projectHandle
  let taskHandle

  const fail = () => {
    if (failed || stopped) return
    failed = true
    for (const id of published.keys()) context.removed('tasks', id)
    published.clear()
    context.error(new Meteor.Error(
      'task-result-limit',
      `Project task subscriptions may not exceed ${MAX_PROJECT_TASKS} tasks.`,
    ))
  }

  const publishTask = (id) => {
    const task = documents.get(id)
    const visible = canViewProjectUnderPolicy(project, userId, publicDisabled)
    if (!task || !visible) {
      if (published.has(id)) {
        published.delete(id)
        context.removed('tasks', id)
      }
      return
    }
    const safeFields = taskFieldsForCaller(task, project, userId, customFieldNames)
    if (!published.has(id)) context.added('tasks', id, safeFields)
    else {
      const changes = changedTaskFields(published.get(id), safeFields)
      if (Object.keys(changes).length) context.changed('tasks', id, changes)
    }
    published.set(id, safeFields)
  }

  context.onStop(() => {
    stopped = true
    if (projectHandle) projectHandle.stop()
    if (taskHandle) taskHandle.stop()
  })
  projectHandle = await Projects.find({ _id: projectId }, {
    fields: projectAccessFields,
  }).observeChangesAsync({
    added(id, fields) {
      project = { _id: id, ...fields }
      documents.forEach((_task, taskId) => publishTask(taskId))
    },
    changed(_id, fields) {
      Object.entries(fields).forEach(([field, value]) => {
        if (value === undefined) delete project[field]
        else project[field] = value
      })
      documents.forEach((_task, taskId) => publishTask(taskId))
    },
    removed() {
      project = null
      documents.forEach((_task, taskId) => publishTask(taskId))
    },
  })
  if (stopped || failed) {
    projectHandle.stop()
    return undefined
  }
  taskHandle = await Tasks.find({ projectId }, {
    fields: memberFields,
    sort: { _id: 1 },
    limit: MAX_PROJECT_TASKS + 1,
  }).observeChangesAsync({
    added(id, fields) {
      documents.set(id, { _id: id, ...fields })
      if (documents.size > MAX_PROJECT_TASKS) { fail(); return }
      publishTask(id)
    },
    changed(id, fields) {
      const task = documents.get(id) || { _id: id, projectId }
      Object.entries(fields).forEach(([field, value]) => {
        if (value === undefined) delete task[field]
        else task[field] = value
      })
      documents.set(id, task)
      publishTask(id)
    },
    removed(id) {
      documents.delete(id)
      if (published.has(id)) context.removed('tasks', id)
      published.delete(id)
    },
  })
  if (stopped || failed) {
    taskHandle.stop()
    projectHandle.stop()
    return undefined
  }
  context.ready()
  return undefined
}

/**
 * Publishes all tasks for the current user.
 * @param {String} filter - The string to filter tasks by.
 * @param {String} projectId - The project ID to filter tasks by.
 * @returns {Array} - The list of tasks that match the filter and projectId.
 */
Meteor.publish('mytasks', async function mytasks({ filter, projectId }) {
  await checkAuthentication(this)
  acquireTaskPublicationSlot(this)
  const taskFilter = {}
  if (filter && filter !== undefined && filter !== '') {
    check(filter, String)
    assertTaskSearchFilter(filter)
    taskFilter.name = { $regex: `.*${filter.replace(/[-[\]{}()*+?.,\\/^$|#\s]/g, '\\$&')}.*`, $options: 'i' }
  }
  const limit = boundedTaskSearchLimit(await getGlobalSettingAsync('taskSearchNumResults'))
  const options = { sort: { projectId: -1, lastUsed: -1 }, limit }
  if (!projectId) {
    return Tasks.find({ ...taskFilter, userId: this.userId }, {
      ...options, fields: PERSONAL_SUGGESTION_FIELDS,
    })
  }

  check(projectId, String)
  assertProjectId(projectId)
  const publicDisabled = await currentPublicProjectsDisabled()
  await stopPublicationOnPublicAccessDisable(this, publicDisabled)
  const customFieldNames = await configuredTaskCustomFields()
  const rawFields = {
    ...PERSONAL_SUGGESTION_FIELDS,
    ...projectTaskFields({ member: true, customFieldNames }),
  }
  const projects = new Map()
  const reconciler = createPublicationReconciler({
    collectionName: 'tasks',
    added: (...args) => this.added(...args),
    changed: (...args) => this.changed(...args),
    removed: (...args) => this.removed(...args),
  })
  let initialized = false
  let stopped = false
  let projectHandle
  let visibleMode

  const desiredDocuments = (tasks) => taskSearchPublicationDocuments({
    tasks,
    project: projects.get(projectId),
    projectId,
    userId: this.userId,
    customFieldNames,
    publicDisabled,
  })
  const taskObserver = createRestartableDocumentObserver({
    cursorForScope: (includeProject) => Tasks.find({
      ...taskFilter,
      ...(includeProject
        ? { $or: [{ userId: this.userId }, { projectId }] }
        : { userId: this.userId }),
    }, { ...options, fields: rawFields }),
    documentsChanged: (documents) => {
      if (initialized && !stopped) reconciler.reconcile(desiredDocuments(documents))
    },
  })
  const reconcile = () => {
    if (initialized && !stopped) {
      reconciler.reconcile(desiredDocuments(taskObserver.documents()))
    }
  }
  const refreshTaskObserver = async (force = false) => {
    if (stopped) return
    const includeProject = canViewProjectUnderPolicy(
      projects.get(projectId), this.userId, publicDisabled,
    )
    if (!force && visibleMode === includeProject) return
    visibleMode = includeProject
    await taskObserver.restart(includeProject)
  }
  const projectChanged = () => {
    reconcile()
    if (initialized) {
      refreshTaskObserver().catch((error) => {
        if (stopped) return
        if (typeof this.error === 'function') this.error(error)
        else throw error
      })
    }
  }

  this.onStop(() => {
    stopped = true
    if (projectHandle) projectHandle.stop()
    taskObserver.stop()
  })
  projectHandle = await Projects.find({ _id: projectId }, {
    fields: projectAccessFields,
  }).observeChangesAsync({
    added(id, fields) { projects.set(id, { _id: id, ...fields }); projectChanged() },
    changed(id, fields) { applyObserverChange(projects, id, fields); projectChanged() },
    removed(id) { projects.delete(id); projectChanged() },
  })
  if (stopped) {
    projectHandle.stop()
    return undefined
  }
  initialized = true
  await refreshTaskObserver(true)
  if (stopped) return undefined
  reconcile()
  return this.ready()
})
/**
 * Publishes all tasks for the current user.
 * @param {String} filter - The string to filter tasks by.
 * @param {Number} limit - The number of tasks to return.
 * @returns {Array} - The list of tasks that match the filter.
 */
Meteor.publish('allmytasks', async function mytasks({ filter, limit }) {
  check(filter, Match.Maybe(String))
  check(limit, Number)
  assertTaskSearchFilter(filter)
  assertTaskSearchLimit(limit)
  await checkAuthentication(this)
  acquireTaskPublicationSlot(this)

  if (filter && filter !== undefined) {
    check(filter, String)
    return Tasks.find({ userId: this.userId, name: { $regex: `.*${filter.replace(/[-[\]{}()*+?.,\\/^$|#\s]/g, '\\$&')}.*`, $options: 'i' } }, { fields: PERSONAL_SUGGESTION_FIELDS, limit, sort: { name: 1 } })
  }
  return Tasks.find({ userId: this.userId }, {
    fields: PERSONAL_SUGGESTION_FIELDS, limit, sort: { name: 1 },
  })
})
/**
 * Publishes all tasks for the provided projectId.
 * @param {String} projectId - The project ID to filter tasks by.
 * @returns {Array} - The list of tasks that match the projectId.
 */
Meteor.publish('projectTasks', async function projectTasks({ projectId }) {
  check(projectId, String)
  assertProjectId(projectId)
  await checkAuthentication(this)
  return publishProjectTasksForCaller(this, projectId, this.userId)
})
