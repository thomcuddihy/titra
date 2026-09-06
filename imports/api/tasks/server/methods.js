import { ValidatedMethod } from 'meteor/mdg:validated-method'
import { check, Match } from 'meteor/check'
import Tasks from '../tasks.js'
import Projects from '../../projects/projects.js'
import { sanitizeObject } from '../../../utils/sanitizer.js'
import { authenticationMixin, transactionLogMixin } from '../../../utils/server_method_helpers.js'
import { isDefaultProjectTask } from '../../projects/server/ddpMutationGuards.js'

const taskForbiddenCustomfieldKeys = new Set([
  '_id', 'projectId', 'name', 'start', 'end', 'estimatedHours', 'dependencies', 'isDefaultTask', 'userId', 'createdAt', 'updatedAt',
])

async function requireProjectAdministrator(projectId, userId) {
  const project = await Projects.findOneAsync({
    _id: projectId,
    $or: [{ userId }, { admins: userId }],
  })
  if (!project) throw new Meteor.Error('not-authorized')
  return project
}

async function validateProjectTaskDependencies(projectId, dependencies = [], taskId) {
  if (dependencies.includes(taskId)) throw new Meteor.Error('notifications.task_not_found')
  if (new Set(dependencies).size !== dependencies.length) {
    throw new Meteor.Error('notifications.task_not_found')
  }
  const count = await Tasks.find({
    _id: { $in: dependencies }, projectId,
  }).countAsync()
  if (count !== new Set(dependencies).size) throw new Meteor.Error('notifications.task_not_found')
}

/**
Inserts a new project task into the Tasks collection.
@param {Object} args - The arguments object containing the task information.
@param {string} args.projectId - The ID of the project for the task.
@param {string} args.name - The name of the task.
@param {Date} args.start - The start date of the task.
@param {Date} args.end - The end date of the task.
@param {number} [args.estimatedHours] - The estimated/planned hours for the task.
@param {string[]} [args.dependencies] - An array of task IDs that this task depends on.
*/
const insertProjectTask = new ValidatedMethod({
  name: 'insertProjectTask',
  validate(args) {
    check(args, {
      projectId: String,
      name: String,
      start: Date,
      end: Date,
      estimatedHours: Match.Optional(Number),
      dependencies: Match.Optional([String]),
      customfields: Match.Optional(Object),
    })
  },
  mixins: [authenticationMixin, transactionLogMixin],
  async run({
    projectId, name, start, end, estimatedHours, dependencies, customfields,
  }) {
    await requireProjectAdministrator(projectId, this.userId)
    await validateProjectTaskDependencies(projectId, dependencies)
    const taskId = Random.id()
    await Tasks.insertAsync({
      _id: taskId,
      ...sanitizeObject(customfields, taskForbiddenCustomfieldKeys),
      projectId,
      name,
      start,
      end,
      estimatedHours,
      dependencies,
    })
  },
})
/**
 * Updates a task in the Tasks collection.
 * @param {Object} args - The arguments object containing the task information.
 * @param {string} args.taskId - The ID of the task to update.
 * @param {string} [args.projectId] - The ID of the project for the task.
 * @param {string} [args.name] - The name of the task.
 * @param {Date} [args.start] - The start date of the task.
 * @param {Date} [args.end] - The end date of the task.
 * @param {number} [args.estimatedHours] - The estimated/planned hours for the task.
 * @param {string[]} [args.dependencies] - An array of task IDs that this task depends on.
 * @throws {Meteor.Error} If user is not authenticated.
 * @returns {String} 'notifications.success' if successful
 */
const updateTask = new ValidatedMethod({
  name: 'updateTask',
  validate(args) {
    check(args, {
      taskId: String,
      projectId: Match.Optional(String),
      name: Match.Optional(String),
      start: Match.Optional(Date),
      end: Match.Optional(Date),
      estimatedHours: Match.Optional(Number),
      dependencies: Match.Optional([String]),
      customfields: Match.Optional(Object),
    })
  },
  mixins: [authenticationMixin, transactionLogMixin],
  async run({
    taskId, projectId, name, start, end, estimatedHours, dependencies, customfields,
  }) {
    const task = await Tasks.findOneAsync({ _id: taskId, projectId: { $exists: true } })
    if (!task || (projectId && projectId !== task.projectId)) throw new Meteor.Error('not-authorized')
    const project = await requireProjectAdministrator(task.projectId, this.userId)
    if (isDefaultProjectTask(project, task) && name !== undefined && name !== task.name) {
      throw new Meteor.Error('notifications.task_is_default')
    }
    await validateProjectTaskDependencies(task.projectId, dependencies, taskId)
    const result = await Tasks.rawCollection().updateOne(
      { _id: taskId, projectId: task.projectId },
      { $set: {
        ...sanitizeObject(customfields, taskForbiddenCustomfieldKeys),
        name,
        start,
        end,
        estimatedHours,
        dependencies,
      } },
    )
    if (result?.matchedCount !== 1) throw new Meteor.Error('not-authorized')
  },
})
/**
 * Removes a task from the Tasks collection.
 * @param {Object} args - The arguments object containing the task information.
 * @param {string} args.taskId - The ID of the task to remove.
 * @throws {Meteor.Error} If user is not authenticated.
 * @returns {String} 'notifications.success' if successful
 */
const removeProjectTask = new ValidatedMethod({
  name: 'removeProjectTask',
  validate(args) {
    check(args, {
      taskId: String,
    })
  },
  mixins: [authenticationMixin, transactionLogMixin],
  async run({ taskId }) {
    const task = await Tasks.findOneAsync({ _id: taskId, projectId: { $exists: true } })
    if (!task) throw new Meteor.Error('not-authorized')
    const project = await requireProjectAdministrator(task.projectId, this.userId)
    if (isDefaultProjectTask(project, task)) {
      throw new Meteor.Error('notifications.task_is_default')
    }
    if (await Tasks.find({ projectId: task.projectId, dependencies: taskId }).countAsync() > 0) {
      throw new Meteor.Error('notifications.task_has_dependencies')
    }
    await Tasks.removeAsync({ _id: taskId, projectId: task.projectId })
  },
})

export {
  insertProjectTask, updateTask, removeProjectTask,
}
