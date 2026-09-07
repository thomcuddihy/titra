import dayjs from 'dayjs'
import utc from 'dayjs/plugin/utc'
import { check, Match } from 'meteor/check'
import { ValidatedMethod } from 'meteor/mdg:validated-method'
import { OAuth } from 'meteor/oauth'
import Timecards from '../../timecards/timecards'
import Projects from '../projects.js'
import Tasks from '../../tasks/tasks.js'
import { addNotification } from '../../notifications/server/addNotification.js'
import { emojify } from '../../../utils/frontend_helpers'
import { periodToDates } from '../../../utils/periodHelpers.js'
import { authenticationMixin, transactionLogMixin, calculateSimilarity } from '../../../utils/server_method_helpers'
import {
  definiteProjectChildNoWrite,
  deleteEmptyProjectWithFence,
  runWithProjectChildWriter,
} from './projectChildFence.js'
import { projectSnapshotSelector } from './projectLifecycle.js'
import {
  publicNameOnlyUser,
  userSelectorForProjectAudience,
} from '../../users/server/projectUserPrivacy.js'
import {
  projectAdministratorMutationSelector,
  projectMutationMatched,
  projectRateModifier,
} from './ddpMutationGuards.js'
import { normalizeProjectPresentationFields } from '../../../utils/userContentSecurity.js'
import {
  currentProjectAudienceClauses,
  currentPublicProjectsDisabled,
} from './publicAccessServer.js'
import {
  PublicProjectPolicyError,
  assertPublicProjectValueAllowed,
  canViewProjectUnderPolicy,
} from './publicAccessPolicy.js'
import normalizeWekanProjectFields from './wekanProjectSettings.js'
import { requireOAuthEncryptionConfigured } from '../../../utils/oauthEncryptionPolicy.js'
import {
  MAX_PROJECT_SCOPE_IDS,
  MAX_RESOURCE_SCOPE_TEXT,
  assertBoundedDateRange,
} from '../../../utils/resourceLimits.js'
import {
  TOP_TASK_RESULT_LIMIT,
  aggregateBoundedProjectMethodRows,
  aggregateProjectMethodScalar,
  aggregateProjectMonthTotals,
  bestProjectMatch,
  fetchBoundedProjectMethodRows,
} from './projectMethodReads.js'

function protectWekanCredential(project) {
  if (typeof project.wekanurl === 'string') {
    requireOAuthEncryptionConfigured()
    project.wekanurl = OAuth.sealSecret(project.wekanurl)
  }
  return project
}

function rethrowProjectPresentationValidation(error) {
  if (error?.code) throw new Meteor.Error(error.code, error.message)
  throw error
}

const forbiddenProjectMutationFields = new Set([
  '_id', 'userId', 'team', 'admins', 'rates', 'projectRevision',
  '_statsRevision', 'lifecycleLock', 'lifecycleWriters', 'archived',
])

function validProjectMutationField(name) {
  return typeof name === 'string' && name.length > 0 && name.length <= 128
    && !name.startsWith('$') && !name.includes('\0')
    && !forbiddenProjectMutationFields.has(name.split('.')[0])
    && !['__proto__', 'prototype', 'constructor'].includes(name.split('.')[0])
}

async function projectVisibleSelector(projectId, userId) {
  return {
    _id: projectId,
    $or: await currentProjectAudienceClauses(userId),
  }
}

async function assertProjectVisible(projectId, userId) {
  const project = await Projects.findOneAsync(await projectVisibleSelector(projectId, userId), {
    fields: { _id: 1 },
  })
  if (!project) throw new Meteor.Error('not-authorized')
}

function projectMutationModifier(modifier = {}) {
  return { ...modifier, $inc: { ...(modifier.$inc || {}), projectRevision: 1 } }
}

async function deleteEmptyProjectForLifecycle(selector, lockId = `delete:${Random.id()}`) {
  return deleteEmptyProjectWithFence({ selector, lockId }, {
    findOneAndUpdate: (...args) => Projects.rawCollection().findOneAndUpdate(...args),
    countTimecards: (projectId) => Timecards.find({ projectId }).countAsync(),
    countProjectTasks: (projectId) => Tasks.find({ projectId }).countAsync(),
    deleteOne: (deleteSelector) => Projects.rawCollection().deleteOne(deleteSelector),
    updateOne: (updateSelector, modifier) => Projects.rawCollection()
      .updateOne(updateSelector, modifier),
  })
}

const projectChildWriterDependencies = {
  findOneAndUpdate: (...args) => Projects.rawCollection().findOneAndUpdate(...args),
  findOne: (selector) => Projects.findOneAsync(selector),
  updateOne: (selector, modifier) => Projects.rawCollection().updateOne(selector, modifier),
}

function aggregateTimecards(pipeline, options) {
  return Timecards.rawCollection().aggregate(pipeline, options).toArray()
}

async function boundedVisibleProjectIds(selector) {
  const projects = await fetchBoundedProjectMethodRows({
    find: (query, options) => Projects.find(query, options).fetchAsync(),
    selector,
    fields: { _id: 1 },
    label: 'Visible projects',
  })
  const projectIds = projects.map((project) => project?._id)
  if (projectIds.some((projectId) => typeof projectId !== 'string' || !projectId)) {
    throw new TypeError('A visible project has an invalid identity.')
  }
  return projectIds
}

async function boundedPeriodRange(period, label) {
  const { startDate, endDate } = await periodToDates(period)
  return assertBoundedDateRange(startDate, endDate, { label })
}

/**
Get the statistics of all projects based on the timecards.
@param {Object} params - The parameters for the method
@param {Boolean} [params.includeNotBillableTime] - Whether to include not billable
time in the statistics
@param {Boolean} [params.showArchived] - Whether to show archived projects in the statistics
@returns {Object} - An object that contains the statistics of all projects
*/
const getAllProjectStats = new ValidatedMethod({
  name: 'getAllProjectStats',
  validate(args) {
    check(args.includeNotBillableTime, Match.Maybe(Boolean))
    check(args.showArchived, Match.Maybe(Boolean))
    check(args.period, Match.Maybe(String))
  },
  mixins: [authenticationMixin],
  async run({ includeNotBillableTime, showArchived, period }) {
    const notbillable = includeNotBillableTime
    dayjs.extend(utc)
    const andCondition = [{ $or: await currentProjectAudienceClauses(this.userId) }]
    if (!showArchived) {
      andCondition.push({ $or: [{ archived: false }, { archived: { $exists: false } }] })
    }
    if (!notbillable) {
      andCondition.push({ $or: [{ notbillable }, { notbillable: { $exists: false } }] })
    }
    const projectList = await boundedVisibleProjectIds({ $and: andCondition })
    const currentMonthName = dayjs.utc().format('MMM')
    const currentMonthStart = dayjs.utc().startOf('month')
    const currentMonthEnd = dayjs.utc().endOf('month')
    const previousMonthName = dayjs.utc().subtract(1, 'month').format('MMM')
    const beforePreviousMonthName = dayjs.utc().subtract(2, 'month').format('MMM')
    const previousMonthStart = dayjs.utc().subtract(1, 'month').startOf('month')
    const previousMonthEnd = dayjs.utc().subtract(1, 'month').endOf('month')
    const beforePreviousMonthStart = dayjs.utc().subtract(2, 'month').startOf('month')
    const beforePreviousMonthEnd = dayjs.utc().subtract(2, 'month').endOf('month')
    const totalMatch = { projectId: { $in: projectList } }
    if (period && period !== 'all') {
      const { startDate, endDate } = await boundedPeriodRange(period, 'Project statistics period')
      totalMatch.date = { $gte: startDate, $lte: endDate }
    }
    const totalHours = projectList.length === 0 ? 0 : await aggregateProjectMethodScalar({
      aggregate: aggregateTimecards,
      pipeline: [
        { $match: totalMatch },
        { $group: { _id: null, value: { $sum: '$hours' } } },
      ],
      label: 'Project total hours',
    })
    const monthTotals = projectList.length === 0 ? {
      currentMonthHours: 0,
      previousMonthHours: 0,
      beforePreviousMonthHours: 0,
    } : await aggregateProjectMonthTotals({
      aggregate: aggregateTimecards,
      projectIds: projectList,
      currentMonthStart: currentMonthStart.toDate(),
      currentMonthEnd: currentMonthEnd.toDate(),
      previousMonthStart: previousMonthStart.toDate(),
      previousMonthEnd: previousMonthEnd.toDate(),
      beforePreviousMonthStart: beforePreviousMonthStart.toDate(),
      beforePreviousMonthEnd: beforePreviousMonthEnd.toDate(),
    })
    return {
      totalHours,
      currentMonthName,
      currentMonthHours: monthTotals.currentMonthHours,
      previousMonthName,
      previousMonthHours: monthTotals.previousMonthHours,
      beforePreviousMonthName,
      beforePreviousMonthHours: monthTotals.beforePreviousMonthHours,
    }
  },
})
const getProjectUsers = new ValidatedMethod({
  name: 'getProjectUsers',
  validate(args) {
    check(args, {
      projectId: String,
    })
  },
  mixins: [authenticationMixin, transactionLogMixin],
  async run({ projectId }) {
    const project = await Projects.findOneAsync({ _id: projectId })
    if (!canViewProjectUnderPolicy(
      project, this.userId, await currentPublicProjectsDisabled(),
    )) throw new Meteor.Error('not-authorized')
    const selector = userSelectorForProjectAudience(project, this.userId)
    if (!selector) throw new Meteor.Error('not-authorized')
    const users = await fetchBoundedProjectMethodRows({
      find: (query, options) => Meteor.users.find(query, options).fetchAsync(),
      selector,
      fields: { 'profile.name': 1 },
      sort: { 'profile.name': 1, _id: 1 },
      label: 'Project users',
    })
    return users.map(publicNameOnlyUser).filter(Boolean)
  },
})
/**
 * Update a project by ID
 *
 * @param {Object} options
 * @param {String} options.projectId - The ID of the project to update
 * @param {Array} options.projectArray - An array of attributes and their values
 * to update for the project
 * @throws {Meteor.Error} If the project is not found or the user does not have
 * permission to update the project
 * @return {undefined}
 */
const updateProject = new ValidatedMethod({
  name: 'updateProject',
  validate(args) {
    check(args, {
      projectId: String,
      projectArray: Array,
    })
  },
  mixins: [authenticationMixin, transactionLogMixin],
  async run({ projectId, projectArray }) {
    let updateJSON = {}
    for (const projectAttribute of projectArray) {
      if (!projectAttribute || !validProjectMutationField(projectAttribute.name)) {
        throw new Meteor.Error('not-authorized')
      }
      updateJSON[projectAttribute.name] = projectAttribute.value
    }
    try {
      updateJSON = protectWekanCredential(normalizeWekanProjectFields(updateJSON))
    } catch {
      throw new Meteor.Error('project-integration-invalid', 'Invalid project integration settings.')
    }
    if (!Object.prototype.hasOwnProperty.call(updateJSON, 'name')) {
      throw new Meteor.Error('project-invalid', 'Project name is required.')
    }
    try {
      Object.assign(updateJSON, normalizeProjectPresentationFields(updateJSON))
      updateJSON.name = await emojify(updateJSON.name)
      Object.assign(updateJSON, normalizeProjectPresentationFields(updateJSON))
    } catch (error) {
      rethrowProjectPresentationValidation(error)
    }
    try {
      updateJSON.public = assertPublicProjectValueAllowed(
        updateJSON.public, await currentPublicProjectsDisabled(),
      )
    } catch (error) {
      if (error instanceof PublicProjectPolicyError) throw new Meteor.Error(error.code)
      throw error
    }
    if (!updateJSON.notbillable) {
      updateJSON.notbillable = false
    } else {
      updateJSON.notbillable = true
    }
    if (updateJSON.startDate) {
      updateJSON.startDate = new Date(updateJSON.startDate)
    }
    if (updateJSON.endDate) {
      updateJSON.endDate = new Date(updateJSON.endDate)
    }
    await Projects.updateAsync({
      $or: [{ userId: this.userId }, { admins: { $in: [this.userId] } }],
      _id: projectId,
      lifecycleLock: { $exists: false },
    }, projectMutationModifier({ $set: updateJSON }))
  },
})
/**
 * Create a new project
 * @param {Object} options
 * @param {Array} options.projectArray - An array of attributes and their values
 * to create for the project
 * @throws {Meteor.Error} If the user is not authenticated
 * @return {String} The ID of the newly created project
*/
const createProject = new ValidatedMethod({
  name: 'createProject',
  validate(args) {
    check(args, {
      projectArray: Array,
    })
  },
  mixins: [authenticationMixin, transactionLogMixin],
  async run({ projectArray }) {
    let updateJSON = {}
    for (const projectAttribute of projectArray) {
      if (!projectAttribute || !validProjectMutationField(projectAttribute.name)) {
        throw new Meteor.Error('not-authorized')
      }
      updateJSON[projectAttribute.name] = projectAttribute.value
    }
    try {
      updateJSON = protectWekanCredential(normalizeWekanProjectFields(updateJSON))
    } catch {
      throw new Meteor.Error('project-integration-invalid', 'Invalid project integration settings.')
    }
    if (!Object.prototype.hasOwnProperty.call(updateJSON, 'name')) {
      throw new Meteor.Error('project-invalid', 'Project name is required.')
    }
    try {
      updateJSON.public = assertPublicProjectValueAllowed(
        updateJSON.public, await currentPublicProjectsDisabled(),
      )
    } catch (error) {
      if (error instanceof PublicProjectPolicyError) throw new Meteor.Error(error.code)
      throw error
    }
    if(updateJSON.startDate) {
      updateJSON.startDate = new Date(updateJSON.startDate)
    }
    if(updateJSON.endDate) {
      updateJSON.endDate = new Date(updateJSON.endDate)
    }
    try {
      Object.assign(updateJSON, normalizeProjectPresentationFields(updateJSON))
      updateJSON.name = await emojify(updateJSON.name)
      Object.assign(updateJSON, normalizeProjectPresentationFields(updateJSON))
    } catch (error) {
      rethrowProjectPresentationValidation(error)
    }
    updateJSON._id = Random.id()
    updateJSON.userId = this.userId
    updateJSON.projectRevision = 0
    await Projects.insertAsync(updateJSON)
    return updateJSON._id
  },
})
/**
 * Delete a project by ID
 * @param {Object} options
 * @param {String} options.projectId - The ID of the project to delete
 * @throws {Meteor.Error} If the project is not found or the user does not have
 * permission to delete the project
 * @return {undefined}
 */
const deleteProject = new ValidatedMethod({
  name: 'deleteProject',
  validate(args) {
    check(args, {
      projectId: String,
    })
  },
  mixins: [authenticationMixin, transactionLogMixin],
  async run({ projectId }) {
    const project = await Projects.findOneAsync({ _id: projectId, userId: this.userId })
    if (!project) throw new Meteor.Error('not-authorized')
    const result = await deleteEmptyProjectForLifecycle(projectSnapshotSelector(project))
    if (result.status === 'not-empty') {
      throw new Meteor.Error('project-not-empty', 'Only empty projects can be deleted; archive it instead.')
    }
    if (result.status !== 'deleted') throw new Meteor.Error('project-write-conflict')
    return true
  },
})
/**
 * Archive a project by ID
 * @param {Object} options
 * @param {String} options.projectId - The ID of the project to archive
 * @throws {Meteor.Error} If the project is not found or the user does not have
 * permission to archive the project
 * @return {undefined}
 */
const archiveProject = new ValidatedMethod({
  name: 'archiveProject',
  validate(args) {
    check(args, {
      projectId: String,
    })
  },
  mixins: [authenticationMixin, transactionLogMixin],
  async run({ projectId }) {
    await Projects.updateAsync(
      {
        _id: projectId,
        $or: [{ userId: this.userId }, { admins: { $in: [this.userId] } }],
        lifecycleLock: { $exists: false },
      },
      projectMutationModifier({ $set: { archived: true } }),
    )
    return true
  },
})
/**
 * Restore a project by ID
 * @param {Object} options
 * @param {String} options.projectId - The ID of the project to restore
 * @throws {Meteor.Error} If the project is not found or the user does not have
 * permission to restore the project
 * @return {undefined}
 */
const restoreProject = new ValidatedMethod({
  name: 'restoreProject',
  validate(args) {
    check(args, {
      projectId: String,
    })
  },
  mixins: [authenticationMixin, transactionLogMixin],
  async run({ projectId }) {
    await Projects.updateAsync(
      {
        _id: projectId,
        $or: [{ userId: this.userId }, { admins: { $in: [this.userId] } }],
        lifecycleLock: { $exists: false },
      },
      projectMutationModifier({ $set: { archived: false } }),
    )
    return true
  },
})
const getTopTasks = new ValidatedMethod({
  name: 'getTopTasks',
  validate(args) {
    check(args, {
      projectId: String,
      includeNotBillableTime: Match.Maybe(Boolean),
      showArchived: Match.Maybe(Boolean),
    })
  },
  mixins: [authenticationMixin],
  async run({ projectId, includeNotBillableTime, showArchived }) {
    let timecardSelector
    if (projectId === 'all') {
      const notbillable = includeNotBillableTime
      const andCondition = [{ $or: await currentProjectAudienceClauses(this.userId) }]
      if (!showArchived) {
        andCondition.push({ $or: [{ archived: false }, { archived: { $exists: false } }] })
      }
      if (!notbillable) {
        andCondition.push({ $or: [{ notbillable }, { notbillable: { $exists: false } }] })
      }
      const projectList = await boundedVisibleProjectIds({ $and: andCondition })
      if (projectList.length === 0) return []
      timecardSelector = { projectId: { $in: projectList } }
    } else {
      await assertProjectVisible(projectId, this.userId)
      timecardSelector = { projectId }
    }
    return aggregateBoundedProjectMethodRows({
      aggregate: aggregateTimecards,
      pipeline: [
        { $match: timecardSelector },
        { $group: { _id: '$task', count: { $sum: '$hours' } } },
        { $sort: { count: -1, _id: 1 } },
        { $limit: TOP_TASK_RESULT_LIMIT },
      ],
      label: 'Top tasks',
      maxResults: TOP_TASK_RESULT_LIMIT,
    })
  },
})

const getProjectDistribution = new ValidatedMethod({
  name: 'getProjectDistribution',
  validate(args) {
    check(args, {
      projectId: String,
      includeNotBillableTime: Match.Maybe(Boolean),
      showArchived: Match.Maybe(Boolean),
      period: Match.Maybe(String),
    })
  },
  mixins: [authenticationMixin],
  async run({ projectId, includeNotBillableTime, showArchived, period }) {
    let timecardSelector
    let maxResults
    if (projectId === 'all') {
      const notbillable = includeNotBillableTime
      const andCondition = [{ $or: await currentProjectAudienceClauses(this.userId) }]
      if (!showArchived) {
        andCondition.push({ $or: [{ archived: false }, { archived: { $exists: false } }] })
      }
      if (!notbillable) {
        andCondition.push({ $or: [{ notbillable }, { notbillable: { $exists: false } }] })
      }
      const projectList = await boundedVisibleProjectIds({ $and: andCondition })
      if (projectList.length === 0) return []
      timecardSelector = { projectId: { $in: projectList } }
      maxResults = MAX_PROJECT_SCOPE_IDS
      if (period && period !== 'all') {
        const { startDate, endDate } = await boundedPeriodRange(
          period, 'Project distribution period',
        )
        timecardSelector.date = { $gte: startDate, $lte: endDate }
      }
    } else {
      await assertProjectVisible(projectId, this.userId)
      timecardSelector = { projectId }
      maxResults = 1
      if (period && period !== 'all') {
        const { startDate, endDate } = await boundedPeriodRange(
          period, 'Project distribution period',
        )
        timecardSelector.date = { $gte: startDate, $lte: endDate }
      }
    }
    return aggregateBoundedProjectMethodRows({
      aggregate: aggregateTimecards,
      pipeline: [
        { $match: timecardSelector },
        { $group: { _id: '$projectId', count: { $sum: '$hours' } } },
        { $sort: { _id: 1 } },
      ],
      label: 'Project distribution',
      maxResults,
    })
  },
})
/**
 * Add a team member to a project
 * @param {Object} options
 * @param {String} options.projectId - The ID of the project to add the team member to
 * @param {String} options.eMail - The eMail of the user to add to the project
 * @throws {Meteor.Error} If the project is not found or the user does not have
 * permission to add a team member to the project
 * @return {undefined}
 */
const addTeamMember = new ValidatedMethod({
  name: 'addTeamMember',
  validate(args) {
    check(args, {
      projectId: String,
      eMail: String,
    })
  },
  mixins: [authenticationMixin, transactionLogMixin],
  async run({ projectId, eMail }) {
    const targetProject = await Projects.findOneAsync({ _id: projectId })
    if (!targetProject
      || !(targetProject.userId === this.userId
        || targetProject.admins?.indexOf(this.userId) >= 0)) {
      throw new Meteor.Error('notifications.only_owner_can_add_team_members')
    }
    const targetUser = await Meteor.users.findOneAsync({ 'emails.0.address': eMail, inactive: { $ne: true } })
    if (targetUser) {
      const result = await Projects.rawCollection().updateOne(
        projectAdministratorMutationSelector(targetProject._id, this.userId),
        projectMutationModifier({ $addToSet: { team: targetUser._id } }),
      )
      if (!projectMutationMatched(result)) {
        throw new Meteor.Error('notifications.only_owner_can_add_team_members')
      }
      await addNotification(`You have been invited to collaborate on the titra project '${targetProject.name}'`, targetUser._id)
      return 'notifications.team_member_added_success'
    }
    throw new Meteor.Error('notifications.user_not_found')
  },
})
/**
 * Remove a team member from a project
 * @param {Object} options
 * @param {String} options.projectId - The ID of the project to remove the team member from
 * @param {String} options.userId - The ID of the user to remove from the project
 * @throws {Meteor.Error} If the project is not found or the user does not have
 * permission to remove a team member from the project
 * @return {undefined}
 */
const removeTeamMember = new ValidatedMethod({
  name: 'removeTeamMember',
  validate(args) {
    check(args, {
      projectId: String,
      userId: String,
    })
  },
  mixins: [authenticationMixin, transactionLogMixin],
  async run({ projectId, userId }) {
    const targetProject = await Projects.findOneAsync({ _id: projectId })
    if (!targetProject
      || !(targetProject.userId === this.userId
        || targetProject.admins?.indexOf(this.userId) >= 0)) {
      throw new Meteor.Error('notifications.only_owner_can_remove_team_members')
    }
    const result = await Projects.rawCollection().updateOne(
      projectAdministratorMutationSelector(targetProject._id, this.userId),
      projectMutationModifier({ $pull: { team: userId, admins: userId } }),
    )
    if (!projectMutationMatched(result)) {
      throw new Meteor.Error('notifications.only_owner_can_remove_team_members')
    }
    return 'notifications.team_member_removed_success'
  },
})
/**
 * Change the role of a team member
 * @param {Object} options
 * @param {String} options.projectId - The ID of the project to change the team member's role in
 * @param {String} options.userId - The ID of the user to change the role of
 * @param {Boolean} options.administrator - Whether the user should be an administrator
 * @throws {Meteor.Error} If the project is not found or the user does not have
 * permission to change the role of a team member
 * @return {undefined}
 */
const changeProjectRole = new ValidatedMethod({
  name: 'changeProjectRole',
  validate(args) {
    check(args, {
      projectId: String,
      userId: String,
      administrator: Boolean,
    })
  },
  mixins: [authenticationMixin, transactionLogMixin],
  async run({ projectId, userId, administrator }) {
    const targetProject = await Projects.findOneAsync({ _id: projectId })
    if (!targetProject
      || !(targetProject.userId === this.userId
        || targetProject.admins?.indexOf(this.userId) >= 0)) {
      throw new Meteor.Error('notifications.only_owner_can_remove_team_members')
    }
    const modifier = administrator
      ? { $addToSet: { admins: userId } }
      : { $pull: { admins: userId } }
    const result = await Projects.rawCollection().updateOne(
      projectAdministratorMutationSelector(targetProject._id, this.userId),
      projectMutationModifier(modifier),
    )
    if (!projectMutationMatched(result)) {
      throw new Meteor.Error('notifications.only_owner_can_remove_team_members')
    }
    return 'notifications.access_rights_updated'
  },
})
/**
 * Update the priority of a project
 * @param {Object} options
 * @param {String} options.projectId - The ID of the project to update the priority of
 * @param {Number} options.priority - The new priority of the project
 * @throws {Meteor.Error} If the project is not found or the user does not have
 * permission to update the priority of the project
 * @return {undefined}
 */
const updatePriority = new ValidatedMethod({
  name: 'updatePriority',
  validate(args) {
    check(args, {
      projectId: String,
      priority: Number,
    })
  },
  mixins: [authenticationMixin, transactionLogMixin],
  async run({ projectId, priority }) {
    await Projects.updateAsync(
      {
        _id: projectId,
        $or: [{ userId: this.userId }, { admins: { $in: [this.userId] } }],
        lifecycleLock: { $exists: false },
      },
      projectMutationModifier({ $set: { priority } }),
    )
    return 'notifications.project_priority_success'
  },
})
/**
 * Update the default task of a project
 * @param {Object} options
 * @param {String} options.projectId - The ID of the project to update the default task of
 * @param {String} options.taskId - The ID of the task to set as the default task
 * @throws {Meteor.Error} If the project is not found or the user does not have
 * permission to update the default task of the project
 * @return {undefined}
 */
const setDefaultTaskForProject = new ValidatedMethod({
  name: 'setDefaultTaskForProject',
  validate(args) {
    check(args, {
      projectId: String,
      taskId: String,
    })
  },
  mixins: [authenticationMixin, transactionLogMixin],
  async run({ projectId, taskId }) {
    const project = await Projects.findOneAsync({
      _id: projectId,
      $or: [{ userId: this.userId }, { admins: { $in: [this.userId] } }],
      lifecycleLock: { $exists: false },
    })
    if (!project) {
      throw new Meteor.Error('notifications.project_not_found')
    }
    return runWithProjectChildWriter({
      selector: {
        _id: projectId,
        $or: [{ userId: this.userId }, { admins: { $in: [this.userId] } }],
      },
      projectId,
      reservationId: `task-default:${taskId}:${Random.id()}`,
      kind: 'project-default-task',
      resourceId: taskId,
      operation: async () => {
        const task = await Tasks.findOneAsync({ _id: taskId, projectId })
        if (!task) {
          throw definiteProjectChildNoWrite(
            new Meteor.Error('notifications.task_not_found'),
          )
        }
        if (task.isDefaultTask) {
          await Projects.updateAsync({
            _id: projectId, lifecycleLock: { $exists: false },
          }, projectMutationModifier({ $unset: { defaultTask: 1 } }))
          await Tasks.updateAsync({ _id: taskId, projectId }, {
            $set: { isDefaultTask: false }, $inc: { projectTaskRevision: 1 },
          })
          return 'notifications.default_task_success'
        }
        await Projects.updateAsync({
          _id: projectId, lifecycleLock: { $exists: false },
        }, projectMutationModifier({ $set: { defaultTask: task.name } }))
        await Tasks.updateAsync({ projectId, isDefaultTask: true, _id: { $ne: taskId } }, {
          $set: { isDefaultTask: false }, $inc: { projectTaskRevision: 1 },
        }, { multi: true })
        await Tasks.updateAsync({ _id: taskId, projectId }, {
          $set: { isDefaultTask: true }, $inc: { projectTaskRevision: 1 },
        })
        return 'notifications.default_task_success'
      },
    }, projectChildWriterDependencies)
  },
})

/**
 * Set the rate for a user in a project
 * @param {Object} options
 * @param {String} options.projectId - The ID of the project to set the rate for the user in
 * @param {String} options.userId - The ID of the user to set the rate for
 * @param {Number} options.rate - The rate to set for the user
 * @throws {Meteor.Error} If the project is not found or the user does not have
 * permission to set the rate for the user
 * @return {undefined}
 */
const setRateForUser = new ValidatedMethod({
  name: 'setRateForUser',
  validate(args) {
    check(args, {
      projectId: String,
      userId: String,
      rate: Number,
    })
  },
  mixins: [authenticationMixin, transactionLogMixin],
  async run({ projectId, userId, rate }) {
    let modifier
    try {
      modifier = projectRateModifier(userId, rate)
    } catch (error) {
      throw new Meteor.Error('notifications.project_not_found')
    }
    const result = await Projects.rawCollection().updateOne(
      projectAdministratorMutationSelector(projectId, this.userId),
      projectMutationModifier(modifier),
    )
    if (!projectMutationMatched(result)) {
      throw new Meteor.Error('notifications.project_not_found')
    }
    return 'notifications.rate_success'
  },
})

/**
 * Searches for a project based on the provided query.
 *
 * @param {Object} args - The arguments for the method.
 * @param {string} args.query - The query string to search for.
 * @returns {string|null} - The ID of the project with the highest
 * similarity score to the query, or null if no projects are found.
 */
const searchForProject = new ValidatedMethod({
  name: 'searchForProject',
  validate(args) {
    check(args, {
      query: String,
    })
  },
  mixins: [authenticationMixin],
  async run({ query }) {
    if (query.length > MAX_RESOURCE_SCOPE_TEXT * 2
      || !query.isWellFormed() || [...query].length > MAX_RESOURCE_SCOPE_TEXT) {
      throw new Meteor.Error('project-search-invalid')
    }
    const projects = await fetchBoundedProjectMethodRows({
      find: (selector, options) => Projects.find(selector, options).fetchAsync(),
      selector: {
        $and: [
          { $or: await currentProjectAudienceClauses(this.userId) },
          { $or: [{ archived: false }, { archived: { $exists: false } }] },
        ],
      },
      fields: { _id: 1, name: 1 },
      label: 'Project search',
    })
    return bestProjectMatch(projects, query, calculateSimilarity)
  },
})

export {
  deleteEmptyProjectForLifecycle,
  getAllProjectStats,
  getProjectUsers,
  createProject,
  updateProject,
  deleteProject,
  archiveProject,
  restoreProject,
  getTopTasks,
  getProjectDistribution,
  addTeamMember,
  removeTeamMember,
  changeProjectRole,
  updatePriority,
  setDefaultTaskForProject,
  setRateForUser,
  searchForProject,
}
