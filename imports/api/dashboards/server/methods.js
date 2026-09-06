import { ValidatedMethod } from 'meteor/mdg:validated-method'
import { Match } from 'meteor/check'
import { Meteor } from 'meteor/meteor'
import { DDPRateLimiter } from 'meteor/ddp-rate-limiter'
import bcrypt from 'bcrypt'
import { Dashboards } from '../dashboards'
import Projects from '../../projects/projects.js'
import { sanitizeSlug } from '../../../utils/sanitizer'
import {
  assertCanModifyDashboard, authenticationMixin, transactionLogMixin, getGlobalSettingAsync,
} from '../../../utils/server_method_helpers.js'
import {
  MAX_DASHBOARDS_PER_CREATOR,
  createDashboardCreationCoordinator,
  dashboardCreatorQuotaAvailable,
  dashboardInputProblem,
  insertDashboardIfAuthorized,
  loadDashboardCreationAccess,
} from './creationSecurity.js'

// dashboard passwords salt rounds
const saltRounds = 10
const dashboardCreationCoordinator = createDashboardCreationCoordinator()
Meteor.startup(async () => {
  // Dashboard creation relies on these constraints. Do not serve methods when
  // Mongo cannot establish them exactly as reviewed.
  await Promise.all([
    Dashboards.rawCollection().createIndex(
      { slug: 1 },
      {
        unique: true,
        partialFilterExpression: { slug: { $exists: true, $gt: '' } },
      },
    ),
    Dashboards.rawCollection().createIndex({ createdBy: 1, _id: 1 }),
  ])
})

async function assertDashboardCreatorQuota(userId) {
  const existing = await Dashboards.find({ createdBy: userId }, {
    fields: { _id: 1 },
    sort: { _id: 1 },
    limit: MAX_DASHBOARDS_PER_CREATOR,
  }).fetchAsync()
  if (!dashboardCreatorQuotaAvailable(existing.length)) {
    throw new Meteor.Error(
      'dashboard-creator-quota',
      `A user may create at most ${MAX_DASHBOARDS_PER_CREATOR} dashboards.`,
    )
  }
}

for (const name of ['addDashboard', 'updateDashboard']) {
  DDPRateLimiter.addRule({
    type: 'method',
    name,
    userId(userId) { return typeof userId === 'string' && userId.length > 0 },
  }, 10, 60 * 1000)
  DDPRateLimiter.addRule({
    type: 'method',
    name,
    clientAddress(clientAddress) {
      return typeof clientAddress === 'string' && clientAddress.length > 0
    },
  }, 20, 60 * 1000)
}

/**
 * Adds a dashboard.
 *
 * @param {Object} args - The arguments to use when adding the dashboard.
 * @param {string} args.projectId - The ID of the project to associate with the dashboard.
 * @param {string} args.timePeriod - The time period to associate with the dashboard.
 * @param {string} [args.startDate] - The custom start date (required only when timePeriod is "custom").
 * @param {string} [args.endDate] - The custom end date (required only when timePeriod is "custom").
 * @param {string} [args.password] - An optional password used to protect the dashboard. If provided, it will be hashed.
 * @param {string} [args.slug] - An optional custom slug to use in the dashboard URL. Must be unique if provided.
 *
 * @return {Promise<string>} - A promise that resolves to the ID of the added dashboard.
 */

const addDashboard = new ValidatedMethod({
  name: 'addDashboard',
  validate(args) {
    check(args, {
      projectId: String,
      timePeriod: String,
      resourceId: Match.Optional(String),
      customer: Match.Optional(String),
      startDate: Match.Optional(String),
      endDate: Match.Optional(String),
      password: Match.Optional(String),
      slug: Match.Optional(String),
    })
    const problem = dashboardInputProblem(args)
    if (problem) throw new Match.Error(`Invalid dashboard ${problem}`)
  },
  mixins: [authenticationMixin, transactionLogMixin],
  async run({
    projectId, timePeriod, resourceId, customer, startDate, endDate, password, slug,
  }) {
    const findUser = (userId) => Meteor.users.findOneAsync({
      _id: userId,
      inactive: { $ne: true },
    }, {
      fields: {
        isAdmin: 1,
        inactive: 1,
        'profile.timeunit': 1,
        'profile.hoursToDays': 1,
      },
    })
    const findProject = (id) => Projects.findOneAsync({ _id: id }, {
      fields: { userId: 1, admins: 1, team: 1 },
    })
    const initialAccess = await loadDashboardCreationAccess({
      userId: this.userId,
      projectId,
      findUser,
      findProject,
    })
    if (!initialAccess.allowed) {
      throw new Meteor.Error('not-authorized', 'You do not have permission to share this project')
    }
    await assertDashboardCreatorQuota(this.userId)
    const meteorUser = initialAccess.user
    let inserted_slug
    if (slug) {
      const sanitizedSlug = sanitizeSlug(slug)
      const existing = await Dashboards.findOneAsync({ slug: sanitizedSlug })
      if (existing) {
        throw new Meteor.Error('slug-exists', 'This URL is already taken.')
      } else {
        inserted_slug = sanitizedSlug
      }
    } else {
      inserted_slug = null
    }
    let timeunit = await getGlobalSettingAsync('timeunit')
    let hoursToDays = await getGlobalSettingAsync('hoursToDays')
    if (meteorUser.profile?.timeunit) {
      timeunit = meteorUser.profile.timeunit
    }
    if (meteorUser.profile?.hoursToDays) {
      hoursToDays = meteorUser.profile.hoursToDays
    }
    let hashedPassword = null
    if (password) {
      hashedPassword = await bcrypt.hash(password, saltRounds)
    }
    const _id = Random.id()
    const dashboard = {
      _id,
      projectId,
      timePeriod,
      customer,
      resourceId,
      startDate,
      endDate,
      timeunit,
      hoursToDays,
      password: hashedPassword,
      slug: inserted_slug,
      createdBy: this.userId,
      ...(projectId === 'all' ? { allProjectsAuthorized: true } : {}),
    }
    const insertion = await dashboardCreationCoordinator.run(
      this.userId,
      () => insertDashboardIfAuthorized({
        userId: this.userId,
        projectId,
        findUser,
        findProject,
        insert: async () => {
          await assertDashboardCreatorQuota(this.userId)
          return Dashboards.insertAsync(dashboard)
        },
      }),
    )
    if (!insertion.inserted) {
      throw new Meteor.Error('not-authorized', 'You no longer have permission to share this project')
    }
    return _id
  },
})

/**
 * Updates an existing dashboard.
 *
 * @param {Object} args - The arguments used to update the dashboard.
 * @param {string} args.dashboardId - The ID of the dashboard to update.
 * @param {string} [args.timePeriod] - The updated time period (e.g., "this_week", "last_month", "custom").
 * @param {string} [args.startDate] - The updated custom start date (required only when timePeriod is "custom").
 * @param {string} [args.endDate] - The updated custom end date (required only when timePeriod is "custom").
 * @param {string} [args.slug] - The updated slug to use for the dashboard URL.
 * @param {string} [args.password] - The updated password for protected dashboards. If provided, it will be hashed.
 *
 * @return {Promise<number>} - A promise that resolves to the number of documents modified.
 */
const updateDashboard = new ValidatedMethod({
  name: 'updateDashboard',
  validate(args) {
    check(args, {
      dashboardId: String,
      timePeriod: Match.Optional(String),
      startDate: Match.Optional(String),
      endDate: Match.Optional(String),
      slug: Match.Optional(String),
      password: Match.Optional(String),
    })
    const problem = dashboardInputProblem(args, { update: true })
    if (problem) throw new Match.Error(`Invalid dashboard ${problem}`)
  },
  mixins: [authenticationMixin, transactionLogMixin],
  async run({
    dashboardId, timePeriod, startDate, endDate, slug, password,
  }) {
    await assertCanModifyDashboard(this.userId, dashboardId)

    const update = {}
    const sanitizedSlug = sanitizeSlug(slug)

    if (slug) {
      const existing = await Dashboards.findOneAsync({ slug: sanitizedSlug })
      if (existing && (existing._id != dashboardId)) {
        throw new Meteor.Error('slug-exists', 'This URL is already taken.')
      }
    }

    if (timePeriod !== undefined) update.timePeriod = timePeriod
    if (startDate !== undefined) update.startDate = startDate
    if (endDate !== undefined) update.endDate = endDate
    if (slug !== undefined) update.slug = sanitizedSlug

    // Hash password if provided
    if (password) {
      update.password = await bcrypt.hash(password, saltRounds)
    }
    return Dashboards.updateAsync(
      { _id: dashboardId },
      { $set: update },
    )
  },
})

/**
 * Removes a dashboard.
 *
 * @param {Object} args
 * @param {string} args.dashboardId - The ID of the dashboard to remove.
 *
 * @return {Number} - Number of documents removed.
 */
const removeDashboard = new ValidatedMethod({
  name: 'removeDashboard',
  validate(args) {
    check(args, {
      dashboardId: String,
    })
  },
  mixins: [authenticationMixin, transactionLogMixin],
  async run({
    dashboardId,
  }) {
    await assertCanModifyDashboard(this.userId, dashboardId)
    const removedCount = await Dashboards.removeAsync(dashboardId)

    return removedCount // usually 1 or 0
  },
})

/**
 * Checks a dashboard slug.
 *
 * @param {Object} args
 * @param {string} args.slug - The slug to check for availability.
 * @param {string} [args.currentDashboardId] - Optional: ID of dashboard to ignore (for edit mode).
 *
 * @return {Boolean} - True if it's available else false.
 */
const checkDashboardSlug = new ValidatedMethod({
  name: 'checkDashboardSlug',
  validate(args) {
    check(args, {
      slug: String,
      currentDashboardId: Match.Optional(String),
    })
  },
  mixins: [authenticationMixin, transactionLogMixin],
  async run({
    slug,
    currentDashboardId,
  }) {
    const sanitizedSlug = sanitizeSlug(slug)
    const query = { slug: sanitizedSlug }
    if (currentDashboardId) {
      query._id = { $ne: currentDashboardId }
    }
    const match = await Dashboards.findOneAsync(query)
    return !match
  },
})

export {
  addDashboard, updateDashboard, removeDashboard, checkDashboardSlug,
}
