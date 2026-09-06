import { ValidatedMethod } from 'meteor/mdg:validated-method'
import { check, Match } from 'meteor/check'
import { Accounts } from 'meteor/accounts-base'
import { OAuth } from 'meteor/oauth'
import { authenticationMixin, adminAuthenticationMixin, transactionLogMixin } from '../../../utils/server_method_helpers.js'
import {
  getTimerState,
  startTimerAtomic,
  stopTimerAtomic,
} from './timerTransitions.js'
import { appendWriteOnlyProfileSettings } from './settingsSecrets.js'
import {
  normalizeAvatarDataUrl,
  normalizeHexColor,
  normalizeProfileName,
} from '../../../utils/userContentSecurity.js'
import { tokenHashDocument } from '../../../../server/apiTokenSecurity.js'
import SecurityState from './securityState.js'
import {
  AdminSafetyError,
  affectedExactlyOne,
  assertAdministrativeContinuity,
} from './adminSafety.js'
import { requireOAuthEncryptionConfigured } from '../../../utils/oauthEncryptionPolicy.js'

const ADMIN_MUTATION_LEASE_MS = 30 * 1000

async function withAdminMutationLock(callback) {
  const now = new Date()
  const leaseToken = Random.secret(32)
  let acquired
  try {
    acquired = await SecurityState.rawCollection().updateOne({
      _id: 'administrator-mutation-lock',
      $or: [
        { leaseUntil: { $exists: false } },
        { leaseUntil: { $lte: now } },
      ],
    }, {
      $set: {
        leaseToken,
        leaseUntil: new Date(now.getTime() + ADMIN_MUTATION_LEASE_MS),
      },
    }, { upsert: true })
  } catch (error) {
    if (error?.code === 11000) throw new Meteor.Error('admin-operation-busy')
    throw error
  }
  if (!affectedExactlyOne(acquired)) throw new Meteor.Error('admin-operation-busy')
  try {
    return await callback()
  } finally {
    await SecurityState.rawCollection().updateOne({
      _id: 'administrator-mutation-lock', leaseToken,
    }, { $unset: { leaseToken: '', leaseUntil: '' } })
  }
}

function adminSafetyDependencies() {
  return {
    findUser: (userId) => Meteor.users.findOneAsync({ _id: userId }, {
      fields: { _id: 1, isAdmin: 1, inactive: 1 },
    }),
    countActiveAdministrators: () => Meteor.users.find({
      isAdmin: true, inactive: { $ne: true },
    }).countAsync(),
  }
}

async function requireAdministrativeContinuity(targetUserId, removesAccess) {
  try {
    return await assertAdministrativeContinuity(
      { targetUserId, removesAccess }, adminSafetyDependencies(),
    )
  } catch (error) {
    if (error instanceof AdminSafetyError) throw new Meteor.Error(error.code)
    throw error
  }
}

function rethrowUserContentValidation(error) {
  if (error?.code) throw new Meteor.Error(error.code, error.message)
  throw error
}

function timerDependencies(now) {
  return {
    findUser: (selector) => Meteor.users.findOneAsync(selector),
    updateOne: (selector, modifier) => Meteor.users.rawCollection().updateOne(selector, modifier),
    ...(now ? { now } : {}),
  }
}

function validateTimerMetadata({ project, task, startTime, customFields }) {
  for (const value of [project, task, startTime]) {
    if (value != null && (typeof value !== 'string' || value.length > 10000)) {
      throw new Meteor.Error('timer-invalid')
    }
  }
  if (customFields != null) {
    if (!Array.isArray(customFields) || customFields.length > 100
      || JSON.stringify(customFields).length > 100000) throw new Meteor.Error('timer-invalid')
  }
}

function getAPITimer(userId) {
  return getTimerState({ userId }, timerDependencies())
}

function startAPITimer(userId, operationId) {
  return startTimerAtomic({ userId, operationId }, timerDependencies())
}

function stopAPITimer(userId, timerId, expectedRevision) {
  return stopTimerAtomic({ userId, timerId, expectedRevision }, timerDependencies())
}

/**
 * Updates a user's settings.
 * @param {Object} args - The arguments object containing the user's settings.
 * @param {string} args.unit - The unit of time to use for the calendar.
 * @param {number} args.startOfWeek - The day of the week to start the week on.
 * @param {string} args.timeunit - The unit of time to use for the time tracking.
 * @param {string} args.timetrackview - The view to use for the time tracking.
 * @param {boolean} args.enableWekan - Whether to enable Wekan integration.
 * @param {number} args.hoursToDays - The number of hours in a day.
 * @param {number} args.precision - The precision to use for time tracking.
 * @param {string} args.siwapptoken - The token to use for Siwapp integration.
 * @param {string} args.siwappurl - The URL to use for Siwapp integration.
 * @param {string} args.dailyStartTime - The daily start time to use for time tracking.
 * @param {string} args.breakStartTime - The break start time to use for time tracking.
 * @param {string} args.breakDuration - The break duration to use for time tracking.
 * @param {string} args.regularWorkingTime - The regular working time to use for time tracking.
 * @param {string} args.APItoken - The API token to use for time tracking.
 * @param {string} args.holidayCountry - The country to use for holiday integration.
 * @param {string} args.holidayState - The state to use for holiday integration.
 * @param {string} args.holidayRegion - The region to use for holiday integration.
 * @param {string} args.zammadtoken - The token to use for Zammad integration.
 * @param {string} args.zammadurl - The URL to use for Zammad integration.
 * @param {string} args.gitlabtoken - The token to use for Gitlab integration.
 * @param {string} args.gitlaburl - The URL to use for Gitlab integration.
 * @param {number} args.rounding - The rounding to use for time tracking.
 * @throws {Meteor.Error} If user is not authenticated.
 * @returns {String} 'notifications.success' if successful
 */
const updateSettings = new ValidatedMethod({
  name: 'updateSettings',
  validate(args) {
    check(args.unit, String)
    check(args.startOfWeek, Number)
    check(args.timeunit, String)
    check(args.timetrackview, String)
    check(args.enableWekan, Boolean)
    check(args.hoursToDays, Number)
    check(args.precision, Number)
    check(args.siwapptoken, Match.Maybe(String))
    check(args.siwappurl, Match.Maybe(String))
    check(args.dailyStartTime, String)
    check(args.breakStartTime, String)
    check(args.breakDuration, String)
    check(args.regularWorkingTime, String)
    check(args.APItoken, Match.Maybe(String))
    check(args.holidayCountry, Match.Maybe(String))
    check(args.holidayState, Match.Maybe(String))
    check(args.holidayRegion, Match.Maybe(String))
    check(args.zammadtoken, Match.Maybe(String))
    check(args.zammadurl, Match.Maybe(String))
    check(args.gitlabtoken, Match.Maybe(String))
    check(args.gitlaburl, Match.Maybe(String))
    check(args.rounding, Match.Maybe(Number))
    check(args.theme, String)
    check(args.language, String)
  },
  mixins: [authenticationMixin, transactionLogMixin],
  async run({
    unit,
    startOfWeek,
    timeunit,
    timetrackview,
    enableWekan,
    hoursToDays,
    precision,
    siwapptoken, siwappurl,
    dailyStartTime, breakStartTime, breakDuration, regularWorkingTime,
    APItoken,
    holidayCountry, holidayState, holidayRegion,
    zammadtoken, zammadurl,
    gitlabtoken, gitlaburl,
    rounding,
    theme,
    language,
  }) {
    const ordinarySettings = {
      'profile.unit': unit,
      'profile.startOfWeek': startOfWeek,
      'profile.timeunit': timeunit,
      'profile.timetrackview': timetrackview,
      'profile.enableWekan': enableWekan,
      'profile.hoursToDays': hoursToDays,
      'profile.precision': precision,
      'profile.siwappurl': siwappurl,
      'profile.holidayCountry': holidayCountry,
      'profile.holidayState': holidayState,
      'profile.holidayRegion': holidayRegion,
      'profile.dailyStartTime': dailyStartTime,
      'profile.breakStartTime': breakStartTime,
      'profile.breakDuration': breakDuration,
      'profile.regularWorkingTime': regularWorkingTime,
      'profile.zammadurl': zammadurl,
      'profile.gitlaburl': gitlaburl,
      'profile.rounding': rounding,
      'profile.theme': theme,
      'profile.language': language,
    }
    let writeOnlySettings
    try {
      const suppliedSecrets = [siwapptoken, zammadtoken, gitlabtoken]
        .some((value) => typeof value === 'string' && value.trim())
      if (suppliedSecrets) requireOAuthEncryptionConfigured()
      writeOnlySettings = appendWriteOnlyProfileSettings(
        ordinarySettings,
        { siwapptoken, zammadtoken, gitlabtoken },
        { sealSecret: (value) => OAuth.sealSecret(value) },
      )
    } catch {
      throw new Meteor.Error('settings-invalid', 'One or more settings are invalid.')
    }
    const modifier = { $set: writeOnlySettings }
    if (typeof APItoken === 'string' && APItoken.trim()) {
      try {
        modifier.$set['services.titraApiToken'] = tokenHashDocument(APItoken)
        modifier.$unset = { 'profile.APItoken': '' }
      } catch (error) {
        if (error instanceof TypeError) {
          throw new Meteor.Error(
            'api-token-invalid',
            'API tokens must be 16-512 URL-safe characters.',
          )
        }
        throw error
      }
    }
    try {
      await Meteor.users.updateAsync({ _id: this.userId }, modifier)
    } catch (error) {
      if (error?.code === 11000 || error?.name === 'MongoServerError' && error?.code === 11000) {
        throw new Meteor.Error('api-token-in-use', 'That API token is already assigned to another user.')
      }
      throw error
    }
  },
})

/**
 * Resets a user's settings.
 * @throws {Meteor.Error} If user is not authenticated.
 * @returns {String} 'notifications.success' if successful
 */
const resetUserSettings = new ValidatedMethod({
  name: 'resetUserSettings',
  validate: null,
  mixins: [authenticationMixin, transactionLogMixin],
  async run() {
    await Meteor.users.updateAsync({ _id: this.userId }, {
      $unset: {
        'profile.unit': '',
        'profile.startOfWeek': '',
        'profile.timeunit': '',
        'profile.timetrackview': '',
        'profile.enableWekan': '',
        'profile.hoursToDays': '',
        'profile.precision': '',
        'profile.dailyStartTime': '',
        'profile.breakStartTime': '',
        'profile.breakDuration': '',
        'profile.regularWorkingTime': '',
        'profile.siwapptoken': '',
        'profile.siwappurl': '',
        'profile.holidayCountry': '',
        'profile.holidayState': '',
        'profile.holidayRegion': '',
        'profile.zammadtoken': '',
        'profile.zammadurl': '',
        'profile.gitlabtoken': '',
        'profile.gitlaburl': '',
        'profile.rounding': '',
      },
    })
  },
})
/**
 * Updates a user's profile.
 * @param {string} args.name - The name to use for the user.
 * @param {string} args.avatar - The avatar to use for the user.
 * @param {string} args.avatarColor - The avatar color to use for the user.
 * @throws {Meteor.Error} If user is not authenticated.
 * @returns {String} 'notifications.success' if successful
 */
const updateProfile = new ValidatedMethod({
  name: 'updateProfile',
  validate(args) {
    check(args, {
      name: String,
      avatar: Match.Maybe(String),
      avatarColor: Match.Maybe(String),
    })
  },
  mixins: [authenticationMixin, transactionLogMixin],
  async run({
    name, avatar, avatarColor,
  }) {
    let normalizedName
    let normalizedAvatar
    let normalizedAvatarColor
    try {
      normalizedName = normalizeProfileName(name)
      normalizedAvatar = normalizeAvatarDataUrl(avatar)
      normalizedAvatarColor = normalizeHexColor(avatarColor, { fallback: '#455A64' })
    } catch (error) {
      rethrowUserContentValidation(error)
    }
    const user = await Meteor.users.findOneAsync({ _id: this.userId })

    // Check if this is an anonymous user being converted to a named user
    const wasAnonymous = !user.emails || user.emails.length === 0
    const isBecomingNamed = normalizedName.length > 0
    const profileModifier = {
      $set: {
        'profile.name': normalizedName,
        'profile.avatarColor': normalizedAvatarColor,
      },
    }
    if (normalizedAvatar) profileModifier.$set['profile.avatar'] = normalizedAvatar
    else profileModifier.$unset = { 'profile.avatar': '' }
    await Meteor.users.updateAsync({ _id: this.userId }, {
      ...profileModifier,
    })

    // If this was an anonymous user being converted and verification is enabled
    if (wasAnonymous && isBecomingNamed) {
      const { getGlobalSettingAsync, getDefaultVerificationSettingsAsync } = await import('../../../utils/server_method_helpers.js')
      const enableVerification = await getGlobalSettingAsync('enableUserActionVerification')

      if (enableVerification) {
        const verificationSettings = await getDefaultVerificationSettingsAsync()
        const deadline = new Date()
        deadline.setDate(deadline.getDate() + verificationSettings.verificationPeriod)

        await Meteor.users.updateAsync({ _id: this.userId }, {
          $set: {
            'actionVerification.required': true,
            'actionVerification.deadline': deadline,
            'actionVerification.completed': false,
            'actionVerification.webhookInterfaceId': verificationSettings.webhookInterfaceId,
          },
        })
      }
    }
  },
})
/**
 * Try to claim admin rights for the current user
 * @throws {Meteor.Error} If user is not authenticated.
 * @returns {String} 'notifications.success' if successful
 * @throws {Meteor.Error} If user is not the first user on the server.
 */
const claimAdmin = new ValidatedMethod({
  name: 'claimAdmin',
  validate: null,
  mixins: [authenticationMixin, transactionLogMixin],
  async run() {
    const meteorUser = await Meteor.users.findOneAsync({ _id: this.userId })
    if (process.env.TITRA_ENABLE_ADMIN_RECOVERY !== 'true') {
      throw new Meteor.Error('admin-recovery-disabled')
    }
    return withAdminMutationLock(async () => {
      if (await Meteor.users.find({ isAdmin: true, inactive: { $ne: true } }).countAsync() !== 0) {
        throw new Meteor.Error('admin-recovery-not-needed')
      }
      const updated = await Meteor.users.updateAsync({
        _id: this.userId, inactive: { $ne: true },
      }, { $set: { isAdmin: true } })
      if (updated !== 1) throw new Meteor.Error('admin-recovery-failed')
      return `Congratulations ${meteorUser.profile.name}, you are now admin.`
    })
  },
})
/**
 * Allow admins to create a new user
 * @throws {Meteor.Error} If user is not authenticated.
 * @returns {String} 'notifications.success' if successful
 * @throws {Meteor.Error} If user is not an admin.
 * @param {String} name - The user's name
 * @param {String} email - The user's email
 * @param {String} password - The user's password
 * @param {Boolean} isAdmin - Whether the user is an admin
 * @param {String} currentLanguageProject - The user's current language project
 * @param {String} currentLanguageProjectDesc - The user's current language project description
*/
const adminCreateUser = new ValidatedMethod({
  name: 'adminCreateUser',
  validate(args) {
    check(args, {
      name: String,
      email: String,
      password: String,
      isAdmin: Boolean,
      currentLanguageProject: String,
      currentLanguageProjectDesc: String,
    })
  },
  mixins: [adminAuthenticationMixin, transactionLogMixin],
  async run({
    name, email, password, isAdmin, currentLanguageProject, currentLanguageProjectDesc,
  }) {
    let normalizedName
    try {
      normalizedName = normalizeProfileName(name)
    } catch (error) {
      rethrowUserContentValidation(error)
    }
    const profile = {
      currentLanguageProject, currentLanguageProjectDesc, name: normalizedName,
    }
    const userId = await Accounts.createUserAsync({
      email, password, profile,
    })
    await Meteor.users.updateAsync({ _id: userId }, { $set: { isAdmin } })
    return userId
  },
})
/**
 * Allow admins to delete a user
 * @throws {Meteor.Error} If user is not authenticated.
 * @returns {String} 'notifications.success' if successful
 * @throws {Meteor.Error} If user is not an admin.
 * @param {String} userId - The user's id
 */
const adminDeleteUser = new ValidatedMethod({
  name: 'adminDeleteUser',
  validate(args) {
    check(args, {
      userId: String,
    })
  },
  mixins: [adminAuthenticationMixin, transactionLogMixin],
  async run({ userId }) {
    await withAdminMutationLock(async () => {
      await requireAdministrativeContinuity(userId, true)
      await Meteor.users.removeAsync({ _id: userId })
    })
  },
})
/**
 * Allow admins to toggle a user's admin status
 * @throws {Meteor.Error} If user is not authenticated.
 * @returns {String} 'notifications.success' if successful
 * @throws {Meteor.Error} If user is not an admin.
 * @param {String} userId - The user's id
 * @param {Boolean} isAdmin - The user's admin status
 */
const adminToggleUserAdmin = new ValidatedMethod({
  name: 'adminToggleUserAdmin',
  validate(args) {
    check(args, {
      userId: String,
      isAdmin: Boolean,
    })
  },
  mixins: [adminAuthenticationMixin, transactionLogMixin],
  async run({ userId, isAdmin }) {
    await withAdminMutationLock(async () => {
      await requireAdministrativeContinuity(userId, !isAdmin)
      await Meteor.users.updateAsync({ _id: userId }, { $set: { isAdmin } })
    })
  },
})
/**
 * Allow admins to toggle a user's inactive status
 * @throws {Meteor.Error} If user is not authenticated.
 * @returns {String} 'notifications.success' if successful
 * @throws {Meteor.Error} If user is not an admin.
 * @param {String} userId - The user's id
 * @param {Boolean} inactive - The user's inactive status
 */
const adminToggleUserState = new ValidatedMethod({
  name: 'adminToggleUserState',
  validate(args) {
    check(args, {
      userId: String,
      inactive: Boolean,
    })
  },
  mixins: [adminAuthenticationMixin, transactionLogMixin],
  async run({ userId, inactive }) {
    await withAdminMutationLock(async () => {
      await requireAdministrativeContinuity(userId, inactive)
      await Meteor.users.updateAsync({ _id: userId }, { $set: { inactive } })
    })
  },
})
/**
 * Set custom period dates for the current user
 * @throws {Meteor.Error} If user is not authenticated.
 * @returns {String} 'notifications.success' if successful
 * @param {Date} customStartDate - The custom start date
 * @param {Date} customEndDate - The custom end date
 */
const setCustomPeriodDates = new ValidatedMethod({
  name: 'setCustomPeriodDates',
  validate(args) {
    check(args, {
      customStartDate: Date,
      customEndDate: Date,
    })
  },
  mixins: [authenticationMixin, transactionLogMixin],
  async run({ customStartDate, customEndDate }) {
    await Meteor.users.updateAsync({ _id: this.userId }, {
      $set: {
        'profile.customStartDate': customStartDate,
        'profile.customEndDate': customEndDate,
      },
    })
  },
})
/**
 * Start a timer for the current user
 * @throws {Meteor.Error} If user is not authenticated.
 * @returns {String} 'notifications.success' if successful
 * @param {Date} timestamp - The timestamp of the timer
 * @param {String} project - The project of the timer
 * @param {String} task - The task of the timer
 * @param {String} startTime - The start time of the timer
 * @param {Array} customFields - The custom fields of the timer
 */
const setTimer = new ValidatedMethod({
  name: 'setTimer',
  validate(args) {
    check(args, {
      timestamp: Match.Maybe(Date),
      operationId: Match.Maybe(String),
      timerId: Match.Maybe(String),
      expectedRevision: Match.Maybe(Number),
      project: Match.Maybe(String),
      task: Match.Maybe(String),
      startTime: Match.Maybe(String),
      customFields: Match.Maybe(Array),
    })
  },
  mixins: [authenticationMixin, transactionLogMixin],
  async run({
    timestamp, operationId, timerId, expectedRevision,
    project, task, startTime, customFields,
  }) {
    if (timestamp) {
      if (timerId != null || expectedRevision != null) throw new Meteor.Error('timer-invalid')
      validateTimerMetadata({ project, task, startTime, customFields })
      const result = await startTimerAtomic({
        userId: this.userId,
        operationId: operationId || `ddp:${Random.id()}`,
        metadata: { project, task, startTime, customFields },
      }, timerDependencies(() => timestamp))
      return result.payload
    }
    if (operationId != null || project != null || task != null
      || startTime != null || customFields != null) throw new Meteor.Error('timer-invalid')
    const user = await Meteor.users.findOneAsync({ _id: this.userId })
    const resolvedTimerId = timerId === undefined ? (user?.profile?.timerId ?? null) : timerId
    const resolvedRevision = expectedRevision === undefined
      ? (Object.prototype.hasOwnProperty.call(user?.profile || {}, 'timerRevision')
        ? user.profile.timerRevision : null)
      : expectedRevision
    const result = await stopTimerAtomic({
      userId: this.userId,
      timerId: resolvedTimerId,
      expectedRevision: resolvedRevision,
    }, timerDependencies())
    return result.payload
  },
})
/**
 * Get user statistics for the admininistration > users page
 * @throws {Meteor.Error} If user is not authenticated.
 * @returns {Object} The user statistics
 */
const adminUserStats = new ValidatedMethod({
  name: 'adminUserStats',
  validate: null,
  mixins: [adminAuthenticationMixin],
  async run() {
    return {
      totalUsers: await Meteor.users.find({}).countAsync(),
      newUsers: await Meteor.users
        .find({ createdAt: { $gt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } })
        .countAsync(),
      adminUsers: await Meteor.users.find({ isAdmin: true }).countAsync(),
      inactiveUsers: await Meteor.users.find({ inactive: true }).countAsync(),
    }
  },
})

/**
 * Get current user's action verification status
 * @throws {Meteor.Error} If user is not authenticated.
 * @returns {Object} The verification status
 */
const getUserVerificationStatus = new ValidatedMethod({
  name: 'getUserVerificationStatus',
  validate: null,
  mixins: [authenticationMixin],
  async run() {
    const user = await Meteor.users.findOneAsync({ _id: this.userId })

    if (!user.actionVerification?.required) {
      return { required: false }
    }

    const now = new Date()
    const deadline = new Date(user.actionVerification.deadline)
    const daysRemaining = Math.ceil((deadline - now) / (1000 * 60 * 60 * 24))

    return {
      required: true,
      completed: user.actionVerification.completed,
      deadline: user.actionVerification.deadline,
      daysRemaining: Math.max(0, daysRemaining),
      overdue: now > deadline && !user.actionVerification.completed,
    }
  },
})

/**
 * Get the verification URL for the current user
 * @throws {Meteor.Error} If user is not authenticated.
 * @returns {String} The verification URL with userId parameter
 */
const getUserVerificationUrl = new ValidatedMethod({
  name: 'getUserVerificationUrl',
  validate: null,
  mixins: [authenticationMixin],
  async run() {
    const user = await Meteor.users.findOneAsync({ _id: this.userId })
    
    if (!user.actionVerification?.required || user.actionVerification.completed) {
      throw new Meteor.Error('verification-not-required', 'Action verification not required or already completed')
    }

    // Get the webhook interface associated with this user's verification
    let webhookInterfaceId = user.actionVerification.webhookInterfaceId
    
    // If no webhook interface is associated, use the first active one for backward compatibility
    if (!webhookInterfaceId) {
      const { getDefaultVerificationSettingsAsync } = await import('../../../utils/server_method_helpers.js')
      const verificationSettings = await getDefaultVerificationSettingsAsync()
      webhookInterfaceId = verificationSettings.webhookInterfaceId
      
      // Update the user to associate them with this webhook interface
      if (webhookInterfaceId) {
        await Meteor.users.updateAsync({ _id: this.userId }, {
          $set: { 'actionVerification.webhookInterfaceId': webhookInterfaceId }
        })
      }
    }

    if (!webhookInterfaceId) {
      throw new Meteor.Error('no-webhook-configured', 'No active webhook verification interface configured')
    }

    // Get the webhook interface configuration
    const WebhookVerification = (await import('../../webhookverification/webhookverification.js')).default
    const webhookInterface = await WebhookVerification.findOneAsync({
      _id: webhookInterfaceId,
      active: true,
      securityVersion: 2,
      mappingVersion: 1,
      removedAt: { $exists: false },
    })
    
    if (!webhookInterface) {
      throw new Meteor.Error('webhook-not-found', 'Associated webhook verification interface not found or inactive')
    }

    const serviceUrl = webhookInterface.serviceUrl
    if (!serviceUrl) {
      throw new Meteor.Error('service-url-not-configured', 'Verification service URL not configured for this webhook interface')
    }

    // Construct URL using the webhook interface's URL parameter configuration
    const url = new URL(serviceUrl)
    const urlParam = webhookInterface.urlParam || 'client_reference_id'
    url.searchParams.set(urlParam, this.userId)

    return url.toString()
  },
})

export {
  claimAdmin,
  adminCreateUser,
  adminDeleteUser,
  adminToggleUserAdmin,
  adminToggleUserState,
  setCustomPeriodDates,
  setTimer,
  getAPITimer,
  startAPITimer,
  stopAPITimer,
  updateProfile,
  updateSettings,
  resetUserSettings,
  adminUserStats,
  getUserVerificationStatus,
  getUserVerificationUrl,
}
