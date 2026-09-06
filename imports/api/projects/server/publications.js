import dayjs from 'dayjs'
import utc from 'dayjs/plugin/utc'
import { check } from 'meteor/check'
import Projects from '../projects'
import Timecards from '../../timecards/timecards.js'
import { checkAuthentication, getGlobalSettingAsync } from '../../../utils/server_method_helpers.js'
import {
  createProjectStatsTracker,
  observeProjectStats,
} from '../../../utils/projectStats.js'

/**
 * Publishes all projects for the current user.
 * @param {Number} projectLimit - The number of projects to return.
 * @returns {Array} - The list of projects for the current user.
 */
Meteor.publish('myprojects', async function myProjects({ projectLimit } = {}) {
  if(this.userId) {
    await checkAuthentication(this)
  } else {
    return this.ready()
  }
  check(projectLimit, Match.Maybe(Number))
  return projectLimit ? Projects.find({
    $or: [{ userId: this.userId }, { public: true }, { team: this.userId }],
  }, { limit: projectLimit }) : Projects.find({
    $or: [{ userId: this.userId }, { public: true }, { team: this.userId }],
  })
})
/**
 * Publishes a single project based on a provided projectId.
 * @param {String} projectId - The project ID to filter projects by.
 * @returns {Object} - The project that matches the projectId.
 */
Meteor.publish('singleProject', async function singleProject(projectId) {
  check(projectId, String)
  await checkAuthentication(this)
  return Projects.find({
    $or: [{ userId: this.userId },
      { public: true },
      { team: this.userId }],
    _id: projectId,
  })
})
/**
 * Publishes the calculated statistics for a project.
 * @param {String} projectId - The project ID to filter statistics by.
 * @returns {Object} - The statistics object for the project.
 */
Meteor.publish('projectStats', async function projectStats(projectId) {
  check(projectId, String)
  await checkAuthentication(this)
  dayjs.extend(utc)
  if (!this.userId || !await Projects.findOneAsync({
    _id: projectId,
    $or: [{ userId: this.userId }, { public: true }, { team: this.userId }],
  })) {
    return this.ready()
  }
  const project = await Projects.findOneAsync({ _id: projectId })
  const currentMonth = dayjs.utc()
  const monthNames = {
    currentMonthName: currentMonth.format('MMM'),
    previousMonthName: currentMonth.subtract(1, 'month').format('MMM'),
    beforePreviousMonthName: currentMonth.subtract(2, 'month').format('MMM'),
  }
  const monthRanges = {
    currentMonthHours: {
      start: currentMonth.startOf('month').toDate(),
      end: currentMonth.endOf('month').toDate(),
    },
    previousMonthHours: {
      start: currentMonth.subtract(1, 'month').startOf('month').toDate(),
      end: currentMonth.subtract(1, 'month').endOf('month').toDate(),
    },
    beforePreviousMonthHours: {
      start: currentMonth.subtract(2, 'month').startOf('month').toDate(),
      end: currentMonth.subtract(2, 'month').endOf('month').toDate(),
    },
  }
  const tracker = createProjectStatsTracker({
    project,
    monthRanges,
    allowIndividualTaskRates: await getGlobalSettingAsync('allowIndividualTaskRates'),
  })
  const started = await observeProjectStats({
    cursor: Timecards.find({ projectId }, {
      fields: { date: 1, hours: 1, userId: 1, taskRate: 1 },
    }),
    tracker,
    onStop: (callback) => this.onStop(callback),
    publishInitial: (totals) => this.added('projectStats', projectId, {
      ...totals,
      ...monthNames,
    }),
    publishChanged: (totals) => this.changed('projectStats', projectId, totals),
  })
  if (!started) return undefined
  return this.ready()
})
/**
 * Publishes the project name based on the provided projectId.
 * @param {String} _id - The project ID to filter projects by.
 * @returns {String} - The name of the project that matches the projectId.
 */
Meteor.publish('publicProjectName', (_id) => {
  check(_id, String)
  return Projects.find({ _id }, { name: 1 })
})
