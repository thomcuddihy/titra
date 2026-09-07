import { ValidatedMethod } from 'meteor/mdg:validated-method'
import { DDPRateLimiter } from 'meteor/ddp-rate-limiter'
import { OAuth } from 'meteor/oauth'
import dayjs from 'dayjs'
import { fetch } from 'meteor/fetch'
import { check, Match } from 'meteor/check'
import { NodeVM } from '../../../utils/vm_sandbox.js'
import { legacyScriptDecision } from '../../../utils/legacyScriptPolicy.js'
import Timecards from '../timecards.js'
import Tasks from '../../tasks/tasks.js'
import Projects from '../../projects/projects.js'
import { refreshPersonalTaskSuggestion } from '../../tasks/server/taskSuggestions.js'
import { t } from '../../../utils/i18n.js'
import { emojify } from '../../../utils/frontend_helpers'
import { sanitizeObject } from '../../../utils/sanitizer.js'
import { timeInUserUnitAsync } from '../../../utils/periodHelpers.js'
import {
  authenticationMixin,
  transactionLogMixin,
  buildTotalHoursForPeriodSelectorAsync,
  buildDailyHoursSelectorAsync,
  buildworkingTimeSelectorAsync,
  workingTimeEntriesMapper,
  buildDetailedTimeEntriesForPeriodSelectorAsync,
  getGlobalSettingAsync,
  calculateSimilarity,
} from '../../../utils/server_method_helpers.js'
import { getOpenAIResponse } from '../../../utils/openai/openai_server.js'
import { fetchOidcJson } from '../../../utils/oidc/oidcSecurity.js'
import { normalizeStoredGoogleAccessToken } from '../../../utils/google/googleOAuthSecurity.js'
import {
  GOOGLE_RESPONSE_MAX_BYTES,
  assertGoogleWorkspaceDateRange,
  googleCalendarEventsUrl,
  googleGmailListUrl,
  googleGmailMessageUrl,
  mapInBoundedBatches,
  normalizeCalendarEventsResponse,
  normalizeGmailListResponse,
  normalizeGmailMessageResponse,
  partitionOpenAIEnrichmentBudget,
} from '../../../utils/google/googleWorkspaceSecurity.js'
import {
  buildTimecardDateFields,
  dateOnlyFromUTCDate,
  dateOnlyRange,
  isDateOnly,
  isStartTime,
  timecardDateAggregationExpression,
} from '../../../utils/timecardDate.js'
import { matchesTimecardDateRevision } from '../../../utils/timecardRevision.js'
import { editOwnedTimecardTask } from './taskEdit.js'
import { editOwnedTimecardDetails } from './detailsEdit.js'
import {
  MAX_BULK_TIMECARD_ENTRIES,
  MAX_WEEK_MUTATION_ENTRIES,
  assertTimecardMutationBatch,
  assertTimecardMutationInput,
} from './mutationInput.js'
import {
  canRegisterTime,
  runAuthorizedTimecardCreateRule,
} from './createAuthorization.js'
import {
  evaluateTimeEntryRule,
  timeEntryRuleInternalError,
} from './timeEntryRuleOutcome.js'
import {
  insertDocumentWithId,
  recoverCreatedDocument,
} from '../../apiidempotency/server/resourceCreate.js'
import {
  createProjectChildWithFence,
  runWithProjectChildWriter,
} from '../../projects/server/projectChildFence.js'
import { runWithProjectStatsInvalidation } from '../../projects/server/projectStatsInvalidation.js'
import {
  assertTimecardDateMigrationUnlocked,
  withTimecardDateWriteLease,
} from '../../timecarddatemigrations/timecarddatemigrations.js'
import { setAuthorizedTimeEntryStates } from './stateMutation.js'
import { currentProjectAudienceClauses } from '../../projects/server/publicAccessServer.js'
import { sendSiwappInvoice } from '../../users/server/taskIntegrationProxy.js'
import {
  MAX_PROJECT_SCOPE_IDS,
  MAX_TIMECARD_PUBLICATION_RECORDS,
  MAX_WEEK_TIMECARD_RECORDS,
  RESOURCE_QUERY_MAX_TIME_MS,
  assertBoundedDateRange,
  assertResultWithinLimit,
  normalizeResourceScope,
} from '../../../utils/resourceLimits.js'
import { createActivePublicationGate } from '../../../utils/activePublicationGate.js'

/* eslint-disable no-await-in-loop */

const timeEntryForbiddenCustomfieldKeys = new Set([
  '_id', 'userId', 'projectId', 'date', 'dateOnly', 'startTime', 'dateRevision',
  'hours', 'task', 'taskRate', 'state', 'lastUsed', 'name', 'createdAt', 'updatedAt',
])
const timecardDateFields = ['date', 'dateOnly', 'startTime', 'dateRevision']

const projectChildFenceDependencies = {
  findOneAndUpdate: (...args) => Projects.rawCollection().findOneAndUpdate(...args),
  findOne: (selector) => Projects.findOneAsync(selector),
  updateOne: (selector, modifier) => Projects.rawCollection().updateOne(selector, modifier),
}
const googleWorkspaceExecutionGate = createActivePublicationGate({
  perUser: 1,
  perPeer: 3,
  total: 10,
})

function localCalendarSuggestion(event) {
  return {
    ...event,
    customer: '',
    date: dayjs(event.startTime).format('YYYY-MM-DD'),
    duration: (Date.parse(event.endTime) - Date.parse(event.startTime)) / 1000 / 60 / 60,
    origin: event.summary,
  }
}

function localEmailSuggestion(message) {
  const summary = message.snippet.substring(0, 50)
  return {
    date: dayjs(new Date(message.internalDate)).format('YYYY-MM-DD'),
    sizeEstimate: message.sizeEstimate,
    recipients: message.recipients,
    subject: message.subject,
    summary,
    customer: '',
    duration: 0.25,
    origin: summary,
  }
}

function attachClosestProject(item, projects) {
  let closest
  for (const project of projects) {
    const score = calculateSimilarity(project.name, item.customer)
    if (score > 0.3 && (!closest || score > closest.score)) closest = { project, score }
  }
  return { ...item, projectID: closest?.project._id || null }
}

async function timecardProjectSelector(projectId, userId) {
  return {
    _id: projectId,
    $or: await currentProjectAudienceClauses(userId),
  }
}

function refreshTaskSuggestion(userId, name) {
  return refreshPersonalTaskSuggestion({ userId, name }, {
    findOne: (selector) => Tasks.findOneAsync(selector),
    insertOne: (document) => Tasks.insertAsync(document),
    updateOne: (selector, modifier) => Tasks.updateAsync(selector, modifier),
  })
}

function timecardDateCompareAndSwapSelector(timecard) {
  const selector = { _id: timecard._id }
  timecardDateFields.forEach((field) => {
    if (Object.prototype.hasOwnProperty.call(timecard, field)) {
      selector[field] = timecard[field]
    } else {
      selector[field] = { $exists: false }
    }
  })
  return selector
}

function assertTimecardWriteSucceeded(result) {
  const affectedCount = result?.matchedCount != null
    ? result.matchedCount + (result.upsertedCount || 0)
    : result?.deletedCount ?? result
  if (affectedCount !== 1) {
    throw new Meteor.Error(
      'timecard-write-conflict',
      'The time entry changed while it was being saved. Reload and try again.',
    )
  }
}

function assertModernTimecardDatePayload(dateOnly) {
  if (!isDateOnly(dateOnly)) {
    throw new Meteor.Error(
      'timecard-date-fields-required',
      'This date format is outdated. Reload the page before saving the time entry.',
    )
  }
}

function assertBulkTimecardDatePayload({
  dateOnly, startTime, preserveLegacyTimestamp,
}) {
  const hasModernDate = isDateOnly(dateOnly) && preserveLegacyTimestamp !== true
  const hasExplicitLegacyDate = preserveLegacyTimestamp === true
    && dateOnly == null
    && startTime == null
  if (!hasModernDate && !hasExplicitLegacyDate) {
    throw new Meteor.Error(
      'timecard-date-fields-required',
      'This date format is outdated. Reload the page before saving the time entry.',
    )
  }
}

async function buildWeekTimecardContext(projectId, task, date, userId, dateOnly) {
  const normalizedDateOnly = dateOnly || dateOnlyFromUTCDate(date)
  const dateFields = buildTimecardDateFields(date, normalizedDateOnly)
  const { startDate, endDate } = dateOnlyRange(normalizedDateOnly)
  const taskName = await emojify(task)
  return {
    dateFields,
    taskName,
    selector: {
      userId,
      projectId,
      date: { $gte: startDate, $lte: endDate },
      task: taskName,
    },
  }
}

function assertWeekCellIsUnambiguous(matchingTimecards) {
  if (matchingTimecards.length > 1) {
    throw new Meteor.Error('notifications.week_aggregate_edit_conflict')
  }
}

/**
 * Inserts a new timecard into the Timecards collection.
 * @param {Object} args - The arguments object containing the timecard information.
 * @param {string} args.projectId - The ID of the project for the timecard.
 * @param {string} args.task - The task for the timecard.
 * @param {Date} args.date - The date of the timecard.
 * @param {string} [args.dateOnly] - The calendar date in YYYY-MM-DD format.
 * @param {string} [args.startTime] - The optional start time in HH:mm format.
 * @param {number} args.hours - The number of hours for the timecard.
 * @param {string} [args.userId] - The ID of the user for the timecard.
 * @param {Object} [args.customfields] - The custom fields for the timecard.
 * @throws {Meteor.Error} If user is not authenticated.
 * @returns {String} 'notifications.success' if successful
 * @throws {Meteor.Error} If time entry rule fails.
 * @throws {Meteor.Error} If time entry rule throws an error.
 * @throws {Meteor.Error} If time entry rule is not a function.
 * @throws {Meteor.Error} If time entry rule is not a string.
 * @throws {Meteor.Error} If time entry rule is not a valid JavaScript expression.
 */
async function checkTimeEntryRule({
  userId, projectId, task, state, date, dateOnly, startTime, hours,
}) {
  const dateFields = buildTimecardDateFields(date, dateOnly, startTime)
  const meteorUser = await Meteor.users.findOneAsync({ _id: userId })
  const project = await Projects.findOneAsync({ _id: projectId })
  const rule = await getGlobalSettingAsync('timeEntryRule')
  if (!meteorUser || !project) throw timeEntryRuleInternalError()
  const scriptPolicy = legacyScriptDecision('time-entry-rule', rule)
  if (!scriptPolicy.allowed) {
    throw new Meteor.Error(
      'unsafe-legacy-script-disabled',
      'The configured JavaScript time-entry rule is disabled by the server security policy.',
    )
  }
  if (!scriptPolicy.execute) {
    await evaluateTimeEntryRule(rule, async () => scriptPolicy.literalResult)
    return
  }
  let vm
  try {
    vm = new NodeVM({
      wrapper: 'none',
      timeout: 1000,
      console: 'inherit', // Enable console logging for testing
      sandbox: {
        user: meteorUser.profile,
        project,
        dayjs,
        timecard: {
          projectId,
          task,
          state,
          ...dateFields,
          hours,
        },
      },
    })
  } catch (error) {
    throw timeEntryRuleInternalError()
  }
  await evaluateTimeEntryRule(rule, (source) => vm.run(source))
}

function checkAuthorizedTimeEntryRule(ruleInput) {
  return runAuthorizedTimecardCreateRule({
    projectId: ruleInput.projectId,
    userId: ruleInput.userId,
    ruleInput,
  }, {
    findProject: (selector) => Projects.findOneAsync(selector),
    checkRule: checkTimeEntryRule,
  })
}
/**
 * Inserts a new timecard into the Timecards collection.
 * @param {Object} args - The arguments object containing the timecard information.
 * @param {string} args.projectId - The ID of the project for the timecard.
 * @param {string} args.task - The task for the timecard.
 * @param {Date} args.date - The date of the timecard.
 * @param {number} args.hours - The number of hours for the timecard.
 * @param {string} [args.userId] - The ID of the user for the timecard.
 * @param {number} taskRate - The rate of the task for the time card.
 * @param {Object} [args.customfields] - The custom fields for the timecard.
 * @throws {Meteor.Error} If user is not authenticated.
 * @returns {String} 'notifications.success' if successful
 * @throws {Meteor.Error} If time entry rule fails.
 * @throws {Meteor.Error} If time entry rule throws an error.
 */
async function insertTimeCard(
  projectId,
  task,
  date,
  hours,
  userId,
  taskRate,
  customfields,
  dateOnly,
  startTime,
  options = {},
) {
  await assertTimecardDateMigrationUnlocked()
  const newTimeCard = await buildAPITimeCardDocument({
    projectId, task, date, hours, userId, taskRate, customfields, dateOnly, startTime,
  })
  const taskName = newTimeCard.task
  const updateTaskSuggestion = () => refreshTaskSuggestion(userId, taskName)
  if (!options.timecardId) await updateTaskSuggestion()
  const targetTimecardId = options.timecardId || Random.id()
  const writeTimecard = () => withTimecardDateWriteLease(async () => createProjectChildWithFence({
    selector: await timecardProjectSelector(projectId, userId),
    projectId,
    reservationId: `timecard:${targetTimecardId}`,
    kind: 'timecard-create',
    resourceId: targetTimecardId,
    createChild: async () => {
      if (options.timecardId) {
        return insertDocumentWithId(Timecards, newTimeCard, options.timecardId)
      }
      await Timecards.insertAsync({ ...newTimeCard, _id: targetTimecardId })
      return { resourceId: targetTimecardId, created: true }
    },
    removeCreatedChild: (resourceId) => Timecards.rawCollection().deleteOne({
      _id: resourceId, projectId, userId,
    }),
  }, projectChildFenceDependencies))
  const result = options.invalidateStats === false
    ? await writeTimecard()
    : await runWithProjectStatsInvalidation([projectId], writeTimecard)
  if (options.timecardId) {
    // Suggestions are a derived convenience. Updating them after the atomic
    // target insert lets a retry repair this side effect without duplicating
    // the authoritative time entry.
    await updateTaskSuggestion()
    return options.returnCreationMetadata
      ? { timecardId: result.resourceId, created: result.created }
      : result.resourceId
  }
  return result.resourceId
}

async function buildAPITimeCardDocument({
  projectId, task, date, hours, userId, taskRate, customfields, dateOnly, startTime,
}) {
  const document = {
    ...sanitizeObject(customfields, timeEntryForbiddenCustomfieldKeys),
    userId,
    projectId,
    ...buildTimecardDateFields(date, dateOnly, startTime),
    dateRevision: 0,
    hours,
    task: await emojify(task),
  }
  if (taskRate) document.taskRate = taskRate
  return document
}

async function recoverAPITimeCard(
  projectId,
  task,
  date,
  hours,
  userId,
  taskRate,
  customfields,
  dateOnly,
  startTime,
  timecardId,
) {
  const document = await buildAPITimeCardDocument({
    projectId, task, date, hours, userId, taskRate, customfields, dateOnly, startTime,
  })
  // This is the authoritative recovery read for a previously reserved create.
  // It intentionally has no mutable project/rule/migration/fence checks and no
  // derived suggestion side effect: exact ID + full document equality is the
  // only safe way to confirm a write whose acknowledgement was lost.
  const recovered = await recoverCreatedDocument(Timecards, document, timecardId)
  if (!recovered) return null
  await runWithProjectStatsInvalidation([projectId], async () => {})
  return { timecardId, created: false }
}

async function insertAPITimeCard(
  projectId, task, date, hours, userId, taskRate, customfields, dateOnly, startTime, options = {},
) {
  await assertTimecardDateMigrationUnlocked()
  try {
    await checkAuthorizedTimeEntryRule({
      userId, projectId, task, state: 'new', date, dateOnly, startTime, hours,
    })
  } catch (error) {
    if (error?.error !== 'timecard-rule-blocked') throw error
    throw new Meteor.Error(
      'timecard-rule-blocked',
      'The configured time entry rule prevented this time entry.',
    )
  }
  return insertTimeCard(
    projectId, task, date, hours, userId, taskRate, customfields, dateOnly, startTime, options,
  )
}

async function insertIdempotentAPITimeCard(
  projectId,
  task,
  date,
  hours,
  userId,
  taskRate,
  customfields,
  dateOnly,
  startTime,
  timecardId,
) {
  return insertAPITimeCard(
    projectId,
    task,
    date,
    hours,
    userId,
    taskRate,
    customfields,
    dateOnly,
    startTime,
    { timecardId, returnCreationMetadata: true },
  )
}
/**
 * Updates an existing timecard in the Timecards collection.
 * @param {Object} args - The arguments object containing the timecard information.
 * @param {string} args.projectId - The ID of the project for the timecard.
 * @param {string} args.task - The task for the timecard.
 * @param {Date} args.date - The date of the timecard.
 * @param {number} args.hours - The number of hours for the timecard.
 * @param {string} [args.userId] - The ID of the user for the timecard.
 * @param {Object} [args.customfields] - The custom fields for the timecard.
 * @throws {Meteor.Error} If user is not authenticated.
 * @returns {String} 'notifications.success' if successful
 * @throws {Meteor.Error} If time entry rule fails.
 */
async function upsertTimecard(projectId, task, date, hours, userId, dateOnly, options = {}) {
  await assertTimecardDateMigrationUnlocked()
  const { dateFields, taskName, selector } = await buildWeekTimecardContext(
    projectId,
    task,
    date,
    userId,
    dateOnly,
  )
  const writeTimecard = () => withTimecardDateWriteLease(async (assertWriterLease) => {
    // Two rows are sufficient to prove this legacy week cell is ambiguous.
    const matchingTimecards = await Timecards.find(selector, {
      sort: { _id: 1 },
      limit: 2,
    }).fetchAsync()
    assertWeekCellIsUnambiguous(matchingTimecards)
    await refreshTaskSuggestion(userId, taskName)
    if (hours === 0) {
      for (const matchingTimecard of matchingTimecards) {
        await assertWriterLease()
        const removed = await Timecards.rawCollection().deleteOne(
          timecardDateCompareAndSwapSelector(matchingTimecard),
        )
        assertTimecardWriteSucceeded(removed)
      }
    } else if (matchingTimecards.length === 1) {
      // A single legacy entry may encode its start time in date. Updating a week
      // cell must not destroy that timestamp when its timezone is unknown.
      const fieldsForUpdate = !isDateOnly(matchingTimecards[0].dateOnly)
        ? {}
        : dateFields
      await assertWriterLease()
      const updated = await Timecards.rawCollection().updateOne(
        timecardDateCompareAndSwapSelector(matchingTimecards[0]),
        {
          $set: {
            userId,
            projectId,
            ...fieldsForUpdate,
            hours,
            task: taskName,
          },
          $inc: { dateRevision: 1 },
        },
      )
      assertTimecardWriteSucceeded(updated)
    } else {
      await assertWriterLease()
      const newTimecardId = Random.id()
      await createProjectChildWithFence({
        selector: await timecardProjectSelector(projectId, userId),
        projectId,
        reservationId: `timecard-week:${newTimecardId}`,
        kind: 'timecard-week-upsert',
        resourceId: newTimecardId,
        createChild: async () => {
          const updated = await Timecards.rawCollection().updateOne(
            selector,
            {
              $set: {
                userId,
                projectId,
                ...dateFields,
                hours,
                task: taskName,
              },
              $setOnInsert: { _id: newTimecardId },
              $inc: { dateRevision: 1 },
            },
            { upsert: true },
          )
          assertTimecardWriteSucceeded(updated)
          return {
            resourceId: updated.upsertedCount === 1 ? newTimecardId : null,
            created: updated.upsertedCount === 1,
          }
        },
        removeCreatedChild: (resourceId) => Timecards.rawCollection().deleteOne({
          _id: resourceId, projectId, userId,
        }),
      }, projectChildFenceDependencies)
    }
  })
  if (options.invalidateStats === false) await writeTimecard()
  else await runWithProjectStatsInvalidation([projectId], writeTimecard)
  return 'notifications.success'
}

function isProjectAdministrator(project, userId) {
  return project?.userId === userId || project?.admins?.includes(userId)
}

function canUserRegisterTimeForProject(project, userId) {
  return canRegisterTime(project, userId)
}

async function checkProjectAdministratorAndUser(projectId, administratorId, userId) {
  const targetProject = await Projects.findOneAsync({ _id: projectId })
  if (!isProjectAdministrator(targetProject, administratorId)) {
    throw new Meteor.Error('notifications.only_administrator_can_register_time')
  }
  const user = await Meteor.users.findOneAsync({ 'profile.name': userId })
  if (!user) {
    throw new Meteor.Error('notifications.user_not_found')
  }
  if (!canUserRegisterTimeForProject(targetProject, user._id)) {
    throw new Meteor.Error('notifications.user_not_found_in_project')
  }
  return user._id
}

async function resolveBulkTimecardUserId(projectId, requestedUserId, callerUserId) {
  const targetProject = await Projects.findOneAsync({ _id: projectId })
  const targetUserId = requestedUserId || callerUserId
  if (targetUserId !== callerUserId) {
    if (!isProjectAdministrator(targetProject, callerUserId)) {
      throw new Meteor.Error('notifications.only_administrator_can_register_time')
    }
    if (!await Meteor.users.findOneAsync({ _id: targetUserId })) {
      throw new Meteor.Error('notifications.user_not_found')
    }
  }
  if (!canUserRegisterTimeForProject(targetProject, targetUserId)) {
    throw new Meteor.Error('notifications.user_not_found_in_project')
  }
  return targetUserId
}
/**
 * Inserts a new timecard into the Timecards collection.
 * @param {Object} args - The arguments object containing the timecard information.
 * @param {string} args.projectId - The ID of the project for the timecard.
 * @param {string} args.task - The task for the timecard.
 * @param {Date} args.date - The date of the timecard.
 * @param {number} args.hours - The number of hours for the timecard.
 * @param {string} [args.userId] - The ID of the user for the timecard.
 * @param {Object} [args.customfields] - The custom fields for the timecard.
 * @throws {Meteor.Error} If user is not authenticated.
 * @returns {String} 'notifications.success' if successful
 * @throws {Meteor.Error} If time entry rule fails.
 */
const insertTimeCardMethod = new ValidatedMethod({
  name: 'insertTimeCard',
  validate(args) {
    check(args.projectId, Match.Maybe(String))
    check(args.task, String)
    check(args.date, Date)
    check(args.dateOnly, Match.Maybe(Match.Where(isDateOnly)))
    check(args.startTime, Match.Maybe(Match.Where(isStartTime)))
    check(args.hours, Number)
    check(args.taskRate, Match.Maybe(Number))
    check(args.customfields, Match.Maybe(Object))
    check(args.user, String)
    assertTimecardMutationInput(args)
    assertModernTimecardDatePayload(args.dateOnly)
  },
  mixins: [authenticationMixin, transactionLogMixin],
  async run({
    projectId, task, date, dateOnly, startTime, hours, taskRate, customfields, user,
  }) {
    let { userId } = this
    if (user !== userId) {
      userId = await checkProjectAdministratorAndUser(projectId, userId, user)
    }
    await checkAuthorizedTimeEntryRule({
      userId, projectId, task, state: 'new', date, dateOnly, startTime, hours,
    })
    return insertTimeCard(
      projectId,
      task,
      date,
      hours,
      userId,
      taskRate,
      customfields,
      dateOnly,
      startTime,
    )
  },
})
/**
 * Updates an existing timecard in the Timecards collection.
 * @param {Object} args - The arguments object containing the timecard information.
 * @param {string} args.projectId - The ID of the project for the timecard.
 * @param {string} args.task - The task for the timecard.
 * @param {Date} args.date - The date of the timecard.
 * @param {number} args.hours - The number of hours for the timecard.
 * @param {string} [args.userId] - The ID of the user for the timecard.
 * @param {Object} [args.customfields] - The custom fields for the timecard.
 * @throws {Meteor.Error} If user is not authenticated.
 * @returns {String} 'notifications.success' if successful
 * @throws {Meteor.Error} If time entry rule fails.
 * @throws {Meteor.Error} If timecard does not exist.
 */
const upsertWeek = new ValidatedMethod({
  name: 'upsertWeek',
  validate(args) {
    check(args, Array)
    assertTimecardMutationBatch(args, MAX_WEEK_MUTATION_ENTRIES)
    args.forEach((element) => {
      check(element.projectId, String)
      check(element.task, String)
      check(element.date, Date)
      check(element.dateOnly, Match.Maybe(Match.Where(isDateOnly)))
      check(element.hours, Number)
      assertTimecardMutationInput(element)
      assertModernTimecardDatePayload(element.dateOnly)
    })
  },
  mixins: [authenticationMixin, transactionLogMixin],
  async run(weekArray) {
    await assertTimecardDateMigrationUnlocked()
    await Promise.all(weekArray.map(async (element) => {
      const { selector } = await buildWeekTimecardContext(
        element.projectId,
        element.task,
        element.date,
        this.userId,
        element.dateOnly,
      )
      const matchingTimecards = await Timecards.find(selector, {
        fields: { _id: 1 },
        limit: 2,
      }).fetchAsync()
      assertWeekCellIsUnambiguous(matchingTimecards)
    }))
    await Promise.all(weekArray.map((element) => checkAuthorizedTimeEntryRule({
      userId: this.userId,
      projectId: element.projectId,
      task: element.task,
      state: 'new',
      date: element.date,
      dateOnly: element.dateOnly,
      hours: element.hours,
    })))
    await runWithProjectStatsInvalidation(
      weekArray.map((element) => element.projectId),
      async () => {
        for (const element of weekArray) {
          await upsertTimecard(
            element.projectId,
            element.task,
            element.date,
            element.hours,
            this.userId,
            element.dateOnly,
            { invalidateStats: false },
          )
        }
      },
    )
  },
})
/**
 * Updates an existing timecard in the Timecards collection.
 * @param {Object} args - The arguments object containing the timecard information.
 * @param {string} args.projectId - The ID of the project for the timecard.
 * @param {string} args._id - The ID of the timecard.
 * @param {string} args.task - The task for the timecard.
 * @param {Date} args.date - The date of the timecard.
 * @param {number} args.hours - The number of hours for the timecard.
 * @param {string} [args.userId] - The ID of the user for the timecard.
 * @param {Object} [args.customfields] - The custom fields for the timecard.
 * @throws {Meteor.Error} If user is not authenticated.
 * @returns {String} 'notifications.success' if successful
 * @throws {Meteor.Error} If time entry rule fails.
 * @throws {Meteor.Error} If timecard does not exist.
 */
const updateTimeCard = new ValidatedMethod({
  name: 'updateTimeCard',
  validate(args) {
    check(args.projectId, String)
    check(args._id, String)
    check(args.task, String)
    check(args.date, Date)
    check(args.dateOnly, Match.Maybe(Match.Where(isDateOnly)))
    check(args.startTime, Match.Maybe(Match.Where(isStartTime)))
    check(args.hours, Number)
    check(args.taskRate, Match.Maybe(Number))
    check(args.customfields, Match.Maybe(Object))
    check(args.user, String)
    assertTimecardMutationInput(args)
  },
  mixins: [authenticationMixin, transactionLogMixin],
  async run({
    projectId, _id, task, date, dateOnly, startTime, hours, taskRate, customfields, user,
  }) {
    await assertTimecardDateMigrationUnlocked()
    const callerUserId = this.userId
    let targetUserId = callerUserId
    if (user !== callerUserId) {
      targetUserId = await checkProjectAdministratorAndUser(
        projectId,
        callerUserId,
        user,
      )
    }
    const timecard = await Timecards.findOneAsync({ _id, userId: targetUserId })
    if (!timecard) {
      throw new Meteor.Error('not-authorized')
    }
    if (targetUserId !== callerUserId && timecard.projectId !== projectId) {
      const sourceProject = await Projects.findOneAsync({
        _id: timecard.projectId,
        $or: [
          { userId: callerUserId },
          { admins: { $in: [callerUserId] } },
        ],
      })
      if (!sourceProject) {
        throw new Meteor.Error('notifications.only_administrator_can_register_time')
      }
    }
    if (isDateOnly(timecard?.dateOnly) && !isDateOnly(dateOnly)) {
      assertModernTimecardDatePayload(dateOnly)
    }
    await checkAuthorizedTimeEntryRule({
      userId: targetUserId,
      projectId,
      task,
      state: timecard.state,
      date,
      dateOnly,
      startTime,
      hours,
    })
    const safeCustomfields = sanitizeObject(customfields, timeEntryForbiddenCustomfieldKeys)
    await refreshTaskSuggestion(targetUserId, await emojify(task))
    const fieldsToSet = {
      ...safeCustomfields,
      projectId,
      ...buildTimecardDateFields(date, dateOnly, startTime),
      hours,
      task: await emojify(task),
    }
    const updateSelector = {
      ...timecardDateCompareAndSwapSelector(timecard),
      userId: targetUserId,
      projectId: timecard.projectId,
    }
    const modifier = {
      $set: fieldsToSet,
      $inc: { dateRevision: 1 },
    }
    if (taskRate) {
      fieldsToSet.taskRate = taskRate
    } else {
      modifier.$unset = { taskRate: '' }
    }
    await assertTimecardDateMigrationUnlocked()
    const result = await runWithProjectStatsInvalidation(
      [timecard.projectId, projectId],
      () => withTimecardDateWriteLease(async () => runWithProjectChildWriter({
        selector: await timecardProjectSelector(projectId, targetUserId),
        projectId,
        reservationId: `timecard-update:${_id}:${Random.id()}`,
        kind: 'timecard-update',
        resourceId: _id,
        operation: () => Timecards.rawCollection().updateOne(updateSelector, modifier),
      }, projectChildFenceDependencies)),
    )
    assertTimecardWriteSucceeded(result)
  },
})
/**
 * Deletes an existing timecard in the Timecards collection.
 * @param {Object} args - The arguments object containing the timecard information.
 * @param {string} args.timecardId - The ID of the timecard.
 * @throws {Meteor.Error} If user is not authenticated.
 * @returns {String} 'notifications.success' if successful
 * @throws {Meteor.Error} If time entry rule fails.
 * @throws {Meteor.Error} If timecard does not exist.
 * @throws {Meteor.Error} If timecard is not owned by user.
 */
const deleteTimeCard = new ValidatedMethod({
  name: 'deleteTimeCard',
  validate(args) {
    check(args, {
      timecardId: String,
    })
  },
  mixins: [authenticationMixin, transactionLogMixin],
  async run({ timecardId }) {
    return deleteOwnedTimeCard(timecardId, this.userId)
  },
})

async function deleteOwnedTimeCard(timecardId, userId, expectedDateRevision) {
  await assertTimecardDateMigrationUnlocked()
  const timecard = await Timecards.findOneAsync({ _id: timecardId, userId })
  if (!timecard) {
    throw new Meteor.Error('not-authorized')
  }
  if (expectedDateRevision !== undefined
    && !matchesTimecardDateRevision(timecard, expectedDateRevision)) {
    throw new Meteor.Error(
      'timecard-write-conflict',
      'The time entry changed after it was previewed. Reload and confirm it again.',
    )
  }
  try {
    await checkTimeEntryRule({
      userId,
      projectId: timecard.projectId,
      task: timecard.task,
      state: timecard.state,
      date: timecard.date,
      dateOnly: timecard.dateOnly,
      startTime: timecard.startTime,
      hours: timecard.hours,
    })
  } catch (error) {
    if (error?.error !== 'timecard-rule-blocked') throw error
    throw new Meteor.Error(
      'timecard-rule-blocked',
      'The configured time entry rule prevented this deletion.',
    )
  }
  await assertTimecardDateMigrationUnlocked()
  const result = await runWithProjectStatsInvalidation(
    [timecard.projectId],
    () => withTimecardDateWriteLease(
      () => Timecards.rawCollection().deleteOne({
        ...timecardDateCompareAndSwapSelector(timecard),
        userId,
      }),
    ),
  )
  assertTimecardWriteSucceeded(result)
  return result.deletedCount
}

async function updateOwnedTimeCardTask(
  timecardId, userId, task, expectedTask, expectedDateRevision,
) {
  return editOwnedTimecardTask({
    timecardId, userId, task, expectedTask, expectedDateRevision,
  }, {
    findTimecard: (selector) => Timecards.findOneAsync(selector),
    canAccessProject: async (projectId, callerUserId) => canUserRegisterTimeForProject(
      await Projects.findOneAsync({ _id: projectId }), callerUserId,
    ),
    checkRule: checkTimeEntryRule,
    assertUnlocked: assertTimecardDateMigrationUnlocked,
    withWriteLease: withTimecardDateWriteLease,
    withProjectWriter: async ({ projectId, userId }, write) => runWithProjectChildWriter({
      selector: await timecardProjectSelector(projectId, userId),
      projectId,
      reservationId: `timecard-task:${timecardId}:${Random.id()}`,
      kind: 'timecard-task-edit',
      resourceId: timecardId,
      operation: write,
    }, projectChildFenceDependencies),
    updateOne: (selector, modifier) => Timecards.rawCollection().updateOne(selector, modifier),
  })
}

async function updateOwnedTimeCardDetails(options) {
  return editOwnedTimecardDetails(options, {
    findTimecard: (selector) => Timecards.findOneAsync(selector),
    canAccessProject: async (projectId, callerUserId) => canUserRegisterTimeForProject(
      await Projects.findOneAsync({ _id: projectId, lifecycleLock: { $exists: false } }),
      callerUserId,
    ),
    checkRule: checkTimeEntryRule,
    assertUnlocked: assertTimecardDateMigrationUnlocked,
    withWriteLease: withTimecardDateWriteLease,
    moveToProjectWithFence: async ({ projectId, userId, write }) => runWithProjectChildWriter({
      selector: await timecardProjectSelector(projectId, userId),
      projectId,
      reservationId: `timecard-move:${options.timecardId}:${Random.id()}`,
      kind: 'timecard-details-move',
      resourceId: options.timecardId,
      operation: write,
    }, projectChildFenceDependencies),
    withStatsInvalidation: runWithProjectStatsInvalidation,
    updateOne: (selector, modifier) => Timecards.rawCollection().updateOne(selector, modifier),
  })
}
/**
 * Creates an invoice in Siwapp through the API and
 * updates the state of a timecard in the Timecards collection.
 * @param {Object} args - The arguments object containing the timecard information.
 * @param {string} args.projectId - The ID of the project.
 * @param {string} args.timePeriod - The time period for the invoice.
 * @param {string} [args.userId] - The ID of the user.
 * @param {string} [args.customer] - The ID of the customer.
 * @param {Object} [args.dates] - The start and end dates for the invoice.
 * @throws {Meteor.Error} If user is not authenticated.
 * @returns {String} 'notifications.success' if successful
 */
const sendToSiwapp = new ValidatedMethod({
  name: 'sendToSiwapp',
  validate(args) {
    check(args.projectId, Match.OneOf(String, Array))
    check(args.timePeriod, String)
    check(args.userId, Match.OneOf(String, Array))
    check(args.customer, Match.OneOf(String, Array))
    check(args.dates, Match.Maybe(Object))
    if (args.timePeriod === 'custom') {
      check(args.dates, Object)
      check(args.dates.startDate, Date)
      check(args.dates.endDate, Date)
    }
  },
  mixins: [authenticationMixin, transactionLogMixin],
  async run({
    projectId, timePeriod, userId, customer, dates,
  }) {
    const meteorUser = await Meteor.users.findOneAsync({ _id: this.userId })
    if (!meteorUser?.profile?.siwappurl || !meteorUser.profile.siwapptoken) {
      throw new Meteor.Error(t('notifications.siwapp_configuration'))
    }
    const timeEntries = []
    const selector = await buildDetailedTimeEntriesForPeriodSelectorAsync({
      projectId,
      search: undefined,
      customer,
      period: timePeriod,
      dates,
      userId,
      limit: undefined,
      page: undefined,
      sort: undefined,
    })
    const projectMap = new Map()
    const selectedTimecards = await Timecards.rawCollection().find(selector[0], {
      projection: { _id: 1, projectId: 1, hours: 1 },
      sort: { _id: 1 },
      limit: MAX_TIMECARD_PUBLICATION_RECORDS + 1,
      maxTimeMS: RESOURCE_QUERY_MAX_TIME_MS,
    }).toArray()
    assertResultWithinLimit(
      selectedTimecards,
      MAX_TIMECARD_PUBLICATION_RECORDS,
      'Invoice time-entry selection',
    )
    for (const timecard of selectedTimecards) {
      timeEntries.push(timecard._id)
      const resource = meteorUser.profile.name
      const projectEntry = projectMap.get(timecard.projectId)
      if (projectEntry) {
        projectEntry.set(
          resource,
          (projectEntry.get(resource) ? projectEntry.get(resource) : 0) + timecard.hours,
        )
      } else {
        projectMap.set(timecard.projectId, new Map().set(resource, timecard.hours))
      }
    }
    const invoiceJSON = {
      data: {
        attributes: {
          name: 'from titra',
          issue_date: dayjs().format('YYYY-MM-DD'),
          draft: true,
        },
        relationships: {
          items: {
            data: [],
          },
        },
      },
    }
    for await (const [project, resources] of projectMap.entries()) {
      const projectElement = await Projects.findOneAsync({ _id: project })
      if (resources.size > 0) {
        for (const [resource, hours] of resources) {
          invoiceJSON.data.relationships.items.data.push({
            attributes: {
              description: `${projectElement.name} (${resource})`,
              quantity: await timeInUserUnitAsync(hours, meteorUser),
              unitary_cost: 0,
            },
          })
        }
      }
    }
    try {
      await sendSiwappInvoice({
        profile: {
          ...meteorUser.profile,
          siwapptoken: OAuth.openSecret(meteorUser.profile.siwapptoken),
        },
        invoice: invoiceJSON,
      })
    } catch {
      throw new Meteor.Error('siwapp-unavailable', 'The invoice service is unavailable.')
    }
    await Timecards.updateAsync(
      { _id: { $in: timeEntries } },
      { $set: { state: 'billed' } },
      { multi: true },
    )
    return 'notifications.siwapp_success'
  },
})
DDPRateLimiter.addRule({
  type: 'method',
  name: 'sendToSiwapp',
  userId(userId) { return typeof userId === 'string' && userId.length > 0 },
}, 5, 60 * 1000)
/**
 * Gets the daily timecards sum for a given period.
 * @param {Object} args - The arguments object containing the timecard information.
 * @param {string} args.projectId - The ID of the project.
 * @param {string} args.userId - The ID of the user.
 * @param {string} args.period - The time period for the invoice.
 * @param {Object} [args.dates] - The start and end dates for the invoice.
 * @param {string} [args.customer] - The ID of the customer.
 * @param {number} [args.limit] - The number of timecards to return.
 * @param {number} [args.page] - The page number.
 * @throws {Meteor.Error} If user is not authenticated.
 * @returns {Object} The daily timecards sum for a given period.
*/
const getDailyTimecards = new ValidatedMethod({
  name: 'getDailyTimecards',
  validate(args) {
    check(args.projectId, Match.OneOf(String, Array))
    check(args.userId, String)
    check(args.period, String)
    check(args.customer, String)
    check(args.limit, Number)
    check(args.dates, Match.Maybe(Object))
    check(args.page, Match.Maybe(Number))
    if (args.period === 'custom') {
      check(args.dates, Object)
      check(args.dates.startDate, Date)
      check(args.dates.endDate, Date)
    }
  },
  mixins: [authenticationMixin],
  async run({
    projectId, userId, period, dates, customer, limit, page,
  }) {
    const aggregationSelector = await buildDailyHoursSelectorAsync(
      projectId,
      period,
      dates,
      userId,
      customer,
      limit,
      page,
    )
    const dailyHoursObject = {}
    const countSelector = await buildDailyHoursSelectorAsync(
      projectId, period, dates, userId, customer, limit, page, { countOnly: true },
    )
    const [countResult] = await Timecards.rawCollection()
      .aggregate(countSelector, { maxTimeMS: RESOURCE_QUERY_MAX_TIME_MS })
      .toArray()
    const totalEntries = countResult?.totalEntries || 0
    const dailyHours = await Timecards.rawCollection().aggregate(
      aggregationSelector,
      { maxTimeMS: RESOURCE_QUERY_MAX_TIME_MS },
    )
      .toArray()
    dailyHoursObject.dailyHours = dailyHours
    dailyHoursObject.totalEntries = totalEntries
    return dailyHoursObject
  },
})
/**
 * Gets the total hours for a given period.
 * @param {Object} args - The arguments object containing the timecard information.
 * @param {string} args.projectId - The ID of the project.
 * @param {string} args.userId - The ID of the user.
 * @param {string} args.period - The time period for the invoice.
 * @param {Object} [args.dates] - The start and end dates for the invoice.
 * @param {string} [args.customer] - The ID of the customer.
 * @param {number} [args.limit] - The number of timecards to return.
 * @param {number} [args.page] - The page number.
 * @throws {Meteor.Error} If user is not authenticated.
 * @returns {Object} The total hours for a given period.
 */
const getTotalHoursForPeriod = new ValidatedMethod({
  name: 'getTotalHoursForPeriod',
  validate(args) {
    check(args.projectId, Match.OneOf(String, Array))
    check(args.userId, String)
    check(args.period, String)
    check(args.customer, String)
    check(args.limit, Number)
    check(args.dates, Match.Maybe(Object))
    check(args.page, Match.Maybe(Number))
    if (args.period === 'custom') {
      check(args.dates, Object)
      check(args.dates.startDate, Date)
      check(args.dates.endDate, Date)
    }
  },
  mixins: [authenticationMixin],
  async run({
    projectId, userId, period, dates, customer, limit, page,
  }) {
    const aggregationSelector = await buildTotalHoursForPeriodSelectorAsync(
      projectId,
      period,
      dates,
      userId,
      customer,
      limit,
      page,
    )
    const totalHoursObject = {}
    const countSelector = await buildTotalHoursForPeriodSelectorAsync(
      projectId, period, dates, userId, customer, limit, page, { countOnly: true },
    )
    const [countResult] = await Timecards.rawCollection()
      .aggregate(countSelector, { maxTimeMS: RESOURCE_QUERY_MAX_TIME_MS })
      .toArray()
    const totalEntries = countResult?.totalEntries || 0
    const totalHours = await Timecards.rawCollection().aggregate(
      aggregationSelector,
      { maxTimeMS: RESOURCE_QUERY_MAX_TIME_MS },
    )
      .toArray()
    for (const entry of totalHours) {
      entry.totalHours = Number(JSON.parse(JSON.stringify(entry)).totalHours.$numberDecimal)
    }
    totalHoursObject.totalHours = totalHours
    totalHoursObject.totalEntries = totalEntries
    return totalHoursObject
  },
})
/**
 * Gets the working hours for a given period.
 * @param {Object} args - The arguments object containing the timecard information.
 * @param {string} args.projectId - The ID of the project.
 * @param {string} args.userId - The ID of the user.
 * @param {string} args.period - The time period for the invoice.
 * @param {Object} [args.dates] - The start and end dates for the invoice.
 * @param {number} [args.limit] - The number of timecards to return.
 * @param {number} [args.page] - The page number.
 * @throws {Meteor.Error} If user is not authenticated.
 * @returns {Object} The working hours for a given period.
 */
const getWorkingHoursForPeriod = new ValidatedMethod({
  name: 'getWorkingHoursForPeriod',
  validate(args) {
    check(args.projectId, Match.OneOf(String, Array))
    check(args.userId, String)
    check(args.period, String)
    check(args.limit, Number)
    check(args.dates, Match.Maybe(Object))
    check(args.page, Match.Maybe(Number))
    if (args.period === 'custom') {
      check(args.dates, Object)
      check(args.dates.startDate, Date)
      check(args.dates.endDate, Date)
    }
  },
  mixins: [authenticationMixin],
  async run({
    projectId, userId, period, dates, limit, page,
  }) {
    const aggregationSelector = await buildworkingTimeSelectorAsync(
      projectId,
      period,
      dates,
      userId,
      limit,
      page,
    )
    const countSelector = await buildworkingTimeSelectorAsync(
      projectId, period, dates, userId, limit, page, { countOnly: true },
    )
    const [countResult] = await Timecards.rawCollection()
      .aggregate(countSelector, { maxTimeMS: RESOURCE_QUERY_MAX_TIME_MS })
      .toArray()
    const totalEntries = countResult?.totalEntries || 0
    const workingHoursObject = {}
    workingHoursObject.totalEntries = totalEntries
    const workingHoursTimeCardsRaw = await Timecards.rawCollection().aggregate(
      aggregationSelector,
      { maxTimeMS: RESOURCE_QUERY_MAX_TIME_MS },
    )
      .toArray()
    const userIds = [...new Set(workingHoursTimeCardsRaw.map((entry) => entry._id.userId))]
    const users = await Meteor.users.find({ _id: { $in: userIds } }, {
      fields: { profile: 1 },
    }).fetchAsync()
    const settingNames = [
      'addBreakToWorkingTime',
      'breakDuration',
      'breakStartTime',
      'dailyStartTime',
      'regularWorkingTime',
    ]
    const settingValues = await Promise.all(settingNames.map(getGlobalSettingAsync))
    const mappingContext = {
      usersById: new Map(users.map((user) => [user._id, user])),
      settings: Object.fromEntries(settingNames.map((name, index) => [name, settingValues[index]])),
    }
    const workingHours = await Promise.all(workingHoursTimeCardsRaw
      .map((entry) => workingTimeEntriesMapper(entry, mappingContext)))
    workingHoursObject.workingHours = workingHours
    return workingHoursObject
  },
})
/**
 * Sets the time entry state for a list of time entries
 * @param {Object} args - The arguments object containing the timecard information.
 * @param {string[]} args.timeEntries - The IDs of the time entries.
 * @param {string} args.state - The state to set the time entries to.
 * @throws {Meteor.Error} If user is not authenticated.
 * @returns {undefined}
 */
const setTimeEntriesState = new ValidatedMethod({
  name: 'setTimeEntriesState',
  validate(args) {
    check(args, {
      timeEntries: Array,
      state: String,
    })
    for (const timeEntryId of args.timeEntries) {
      check(timeEntryId, String)
    }
  },
  mixins: [authenticationMixin, transactionLogMixin],
  async run({ timeEntries, state }) {
    return setAuthorizedTimeEntryStates({
      callerId: this.userId,
      timeEntries,
      state,
    }, {
      findTimeEntries: (selector, options) => Timecards.find(selector, options).fetchAsync(),
      findAdministeredProjectIds: async (selector, options) => (await Projects
        .find(selector, options).fetchAsync()).map((project) => project._id),
      updateTimeEntries: (selector, modifier) => Timecards.rawCollection()
        .updateMany(selector, modifier),
    })
  },
})
/**
 * Deletes timecards for a given project, task, and date range.
 * @param {Object} args - The arguments object containing the timecard information.
 * @param {string} args.projectId - The ID of the project.
 * @param {string} args.task - The task associated with the timecards.
 * @param {Date} args.startDate - The start date of the timecard range.
 * @param {Date} args.endDate - The end date of the timecard range.
 * @throws {Meteor.Error} If user is not authenticated.
 * @returns {undefined}
 */
const deleteTimeCardsForWeek = new ValidatedMethod({
  name: 'deleteTimeCardsForWeek',
  validate(args) {
    check(args, {
      projectId: String,
      task: String,
      startDate: Date,
      endDate: Date,
      startDateOnly: Match.Maybe(Match.Where(isDateOnly)),
      endDateOnly: Match.Maybe(Match.Where(isDateOnly)),
    })
    assertModernTimecardDatePayload(args.startDateOnly)
    assertModernTimecardDatePayload(args.endDateOnly)
  },
  mixins: [authenticationMixin, transactionLogMixin],
  async run({
    projectId, task, startDateOnly, endDateOnly,
  }) {
    await assertTimecardDateMigrationUnlocked()
    const { startDate, endDate } = dateOnlyRange(startDateOnly, endDateOnly)
    assertBoundedDateRange(startDate, endDate, {
      label: 'Week deletion range',
      maxDays: 31,
    })
    const selector = {
      userId: this.userId,
      projectId,
      task,
      date: { $gte: startDate, $lte: endDate },
    }
    await runWithProjectStatsInvalidation(
      [projectId],
      () => withTimecardDateWriteLease(async (assertWriterLease) => {
        const matchingTimecards = await Timecards.find(selector, {
          fields: {
            date: 1, dateOnly: 1, startTime: 1, dateRevision: 1,
          },
          sort: { _id: 1 },
          limit: MAX_WEEK_TIMECARD_RECORDS + 1,
        }).fetchAsync()
        assertResultWithinLimit(
          matchingTimecards,
          MAX_WEEK_TIMECARD_RECORDS,
          'Week deletion',
        )
        for (const timecard of matchingTimecards) {
          await assertWriterLease()
          const result = await Timecards.rawCollection().deleteOne(
            {
              ...timecardDateCompareAndSwapSelector(timecard),
              userId: this.userId,
            },
          )
          assertTimecardWriteSucceeded(result)
        }
      }),
    )
  },
})

/**
 * Gets the Google Workspace data for a given date range.
 * @param {Object} args - The arguments object containing the date range.
 * @param {Date} args.startDate - The start date of the date range.
 * @param {Date} args.endDate - The end date of the date range.
 * @throws {Meteor.Error} If user is not authenticated.
 * @returns {Object} The Google Workspace data for the given date range.
 */
const getGoogleWorkspaceData = new ValidatedMethod({
  name: 'getGoogleWorkspaceData',
  validate(args) {
    check(args, {
      startDate: Date,
      endDate: Date,
    })
  },
  mixins: [authenticationMixin],
  async run({ startDate, endDate }) {
    const releaseExecutionSlot = googleWorkspaceExecutionGate.acquire({
      userId: this.userId,
      peerAddress: this.connection?.clientAddress,
    })
    if (!releaseExecutionSlot) {
      throw new Meteor.Error(
        'google-workspace-busy',
        'A Google Workspace import is already running. Try again later.',
      )
    }
    try {
      try {
        assertGoogleWorkspaceDateRange(startDate, endDate)
      } catch {
        throw new Meteor.Error(
          'google-workspace-invalid-range',
          'Select a valid date range of no more than 31 days.',
        )
      }
      const meteorUser = await Meteor.userAsync()
      const serviceData = meteorUser?.services?.googleapi?.serviceData
      let googleAccessToken
      try {
        googleAccessToken = normalizeStoredGoogleAccessToken(
          OAuth.openSecret(serviceData?.accessToken),
        )
      } catch {
        throw new Meteor.Error(
          'google-workspace-authorization-required',
          'Google Workspace authorization is required.',
        )
      }
      let eventResponse = []
      const openAIEnabled = Boolean(await getGlobalSettingAsync('openai_apikey'))
      if (serviceData) {
        const googleRequestOptions = {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${googleAccessToken}`,
            Accept: 'application/json',
          },
        }
        const jsonEvents = await fetchOidcJson(
          fetch, googleCalendarEventsUrl(startDate, endDate), googleRequestOptions,
          { maximumBytes: GOOGLE_RESPONSE_MAX_BYTES },
        )
        const fetchedEvents = normalizeCalendarEventsResponse(jsonEvents)
        const emailIds = normalizeGmailListResponse(await fetchOidcJson(
          fetch, googleGmailListUrl(startDate, endDate), googleRequestOptions,
          { maximumBytes: GOOGLE_RESPONSE_MAX_BYTES },
        ))
        const enrichmentBudget = openAIEnabled
          ? partitionOpenAIEnrichmentBudget(fetchedEvents.length, emailIds.length)
          : { calendarEvents: 0, gmailMessages: 0 }
        if (enrichmentBudget.calendarEvents) {
          const enrichedEvents = await mapInBoundedBatches(
            fetchedEvents.slice(0, enrichmentBudget.calendarEvents),
            async (eventData) => getOpenAIResponse(`Based on the following JSON representation of a calendar event, respond with a JSON object summarizing the event with as few words as possible. Add the date of the event and the duration in hours and try to identify the customer based on the majority of attendee e-mail addresses. Include the original un-altered summary in the origin field. Use the following schema for the return JSON:
            \`Interface event {summary: string, duration:number, customer:string, date:date, origin:string}\`
            ${JSON.stringify(eventData)}`),
            10,
          )
          eventResponse = [
            ...enrichedEvents,
            ...fetchedEvents.slice(enrichmentBudget.calendarEvents)
              .map(localCalendarSuggestion),
          ]
        } else eventResponse = fetchedEvents.map(localCalendarSuggestion)
        let fetchedMessages = []
        let remainingMessageEnrichments = enrichmentBudget.gmailMessages
        if (emailIds.length) {
          fetchedMessages = await mapInBoundedBatches(emailIds, async (emailId) => {
            const jsonMessage = normalizeGmailMessageResponse(await fetchOidcJson(
              fetch, googleGmailMessageUrl(emailId), googleRequestOptions,
              { maximumBytes: GOOGLE_RESPONSE_MAX_BYTES },
            ))
            const returnMessage = localEmailSuggestion(jsonMessage)
            if (openAIEnabled && remainingMessageEnrichments > 0) {
              remainingMessageEnrichments -= 1
              return getOpenAIResponse(`Based on the email representation in JSON format, respond with a JSON object with the following schema where you estimate the time it took to write the email in hours based on the snippet and sizeEstimate in bytes where 0.25 hours is the minimum and add it to the duration field, use date format "YYYY-MM-DD" for dates, summarize the content with as few words as possible, do not include the snippet in the summary, guess the customer company name based on the majority of recipient's mail address domain. Include the original un-altered summary in the origin field. Use the following schema for the return JSON:
              \`Interface message {summary:string,customer:string,date:date,duration:number,origin:string}\`
              ${JSON.stringify(jsonMessage)}`)
            }
            return returnMessage
          }, 10)
        }
        let returnEvents = eventResponse
        let returnMessages = fetchedMessages
        if (openAIEnabled) {
          const projects = await Projects.find({
            $and: [
              { $or: await currentProjectAudienceClauses(this.userId) },
              { $or: [{ archived: false }, { archived: { $exists: false } }] },
            ],
          }, {
            fields: { _id: 1, name: 1 },
            sort: { _id: 1 },
            limit: MAX_PROJECT_SCOPE_IDS + 1,
          }).fetchAsync()
          assertResultWithinLimit(
            projects,
            MAX_PROJECT_SCOPE_IDS,
            'Workspace project matching',
          )
          returnEvents = eventResponse.map((event) => attachClosestProject(event, projects))
          returnMessages = fetchedMessages
            .map((message) => attachClosestProject(message, projects))
        }
        return { returnEvents, returnMessages }
      }
      throw new Meteor.Error('You need to authorize Google API access for titra first.')
    } finally {
      releaseExecutionSlot()
    }
  },
})
DDPRateLimiter.addRule({
  type: 'method',
  name: 'getGoogleWorkspaceData',
  userId(userId) { return typeof userId === 'string' && userId.length > 0 },
}, 1, 60 * 1000)
DDPRateLimiter.addRule({
  type: 'method',
  name: 'getGoogleWorkspaceData',
  clientAddress(clientAddress) {
    return typeof clientAddress === 'string' && clientAddress.length > 0
  },
}, 3, 60 * 1000)
/**
 * Retrieves user time cards for a specific period, filtered by project and task.
 *
 * @method userTimeCardsForPeriodByProjectByTask
 * @param {Object} args - The arguments for the method.
 * @param {Date} args.startDate - The start date of the period.
 * @param {Date} args.endDate - The end date of the period.
 * @param {String} args.projectId - The ID of the project.
 * @returns {Promise<Array>} - A promise that resolves to an array of time card entries.
 */
const userTimeCardsForPeriodByProjectByTaskMethod = new ValidatedMethod({
  name: 'userTimeCardsForPeriodByProjectByTask',
  validate(args) {
    check(args.startDate, Date)
    check(args.endDate, Date)
    check(args.projectId, String)
  },
  mixins: [authenticationMixin],
  async run({ startDate, endDate, projectId }) {
    const projectScope = normalizeResourceScope(projectId, 'Project', { allowAll: false })
    assertBoundedDateRange(startDate, endDate, {
      label: 'Week-table range',
      maxDays: 31,
    })
    const selector = {
      projectId: projectScope.value,
      userId: this.userId,
      date: { $gte: startDate, $lte: endDate },
    }
    const count = await Timecards.rawCollection().countDocuments(selector, {
      limit: MAX_WEEK_TIMECARD_RECORDS + 1,
      maxTimeMS: RESOURCE_QUERY_MAX_TIME_MS,
    })
    if (count > MAX_WEEK_TIMECARD_RECORDS) {
      throw new Meteor.Error(
        'result-too-large',
        `The selected week contains more than ${MAX_WEEK_TIMECARD_RECORDS} time entries.`,
      )
    }
    return Timecards.rawCollection().aggregate([
      {
        $match: selector,
      },
      {
        $sort: {
          task: -1,
          date: 1,
          _id: 1,
        },
      },
      { $limit: MAX_WEEK_TIMECARD_RECORDS },
      {
        $group: {
          _id: { $concat: ['$projectId', '|', '$task'] },
          entries: { $push: '$$ROOT' },
        },
      }], { maxTimeMS: RESOURCE_QUERY_MAX_TIME_MS }).toArray()
  },
})
/**
 * Calculates the total hours worked per day for a given week.
 *
 * @method getTotalForWeekPerDay
 * @param {Object} args - The arguments for the method.
 * @param {Date} args.startDate - The start date of the week.
 * @param {Date} args.endDate - The end date of the week.
 * @returns {Promise<Array>} A promise resolving to daily dates and total hours.
 */
const getTotalForWeekPerDay = new ValidatedMethod({
  name: 'getTotalForWeekPerDay',
  validate(args) {
    check(args.startDate, Date)
    check(args.endDate, Date)
  },
  mixins: [authenticationMixin],
  async run({ startDate, endDate }) {
    assertBoundedDateRange(startDate, endDate, { label: 'Weekly totals range', maxDays: 31 })
    return Timecards.rawCollection().aggregate([
      {
        $match: {
          userId: this.userId,
          date: { $gte: startDate, $lte: endDate },
        },
      },
      {
        $group: {
          _id: { date: timecardDateAggregationExpression() },
          totalForDate: { $sum: '$hours' },
        },
      }], { maxTimeMS: RESOURCE_QUERY_MAX_TIME_MS }).toArray()
  },
})
/**
 * Calculates the total number of hours tracked in a given week.
 *
 * @param {Object} args - The arguments for calculating the week total.
 * @param {Date} args.startDate - The start date of the week.
 * @param {Date} args.endDate - The end date of the week.
 * @returns {number} The total number of hours tracked in the week.
 */
const getWeekTotal = new ValidatedMethod({
  name: 'getWeekTotal',
  validate(args) {
    check(args.startDate, Date)
    check(args.endDate, Date)
  },
  mixins: [authenticationMixin],
  async run({ startDate, endDate }) {
    assertBoundedDateRange(startDate, endDate, { label: 'Week total range', maxDays: 31 })
    const aggregatedweek = await Timecards.rawCollection().aggregate([
      {
        $match: {
          userId: this.userId,
          date: { $gte: startDate, $lte: endDate },
        },
      },
      {
        $group: {
          _id: `${startDate}-${endDate}`,
          total: { $sum: '$hours' },
        },
      }], { maxTimeMS: RESOURCE_QUERY_MAX_TIME_MS }).toArray()
    return aggregatedweek[0]?.total
  },
})
/**
 * Bulk inserts multiple timecards into the Timecards collection.
 *
 * @method bulkInsertTimecards
 * @param {Object} args - The arguments for the method.
 * @param {Array} args.timecards - An array of timecard objects to be inserted.
 * @param {string} args.timecards[].projectId - The ID of the project for the timecard.
 * @param {string} args.timecards[].task - The task for the timecard.
 * @param {Date} args.timecards[].date - The date of the timecard.
 * @param {number} args.timecards[].hours - The number of hours for the timecard.
 * @param {string} [args.timecards[].userId] - The ID of the user for the timecard (optional).
 * @param {Object} [args.timecards[].customfields] - Custom fields for the timecard (optional).
 * @throws {Meteor.Error} If the user is not authenticated.
 * @throws {Meteor.Error} If validation fails for any timecard.
 * @returns {Object} An object containing the success message.
 */
const bulkInsertTimecards = new ValidatedMethod({
  name: 'bulkInsertTimecards',
  validate(args) {
    check(args, {
      timecards: Array,
    })
    assertTimecardMutationBatch(args.timecards, MAX_BULK_TIMECARD_ENTRIES)
    args.timecards.forEach((timecard) => {
      check(timecard, {
        projectId: String,
        task: String,
        date: Date,
        dateOnly: Match.Maybe(Match.Where(isDateOnly)),
        startTime: Match.Maybe(Match.Where(isStartTime)),
        preserveLegacyTimestamp: Match.Maybe(Boolean),
        hours: Number,
        userId: Match.Maybe(String), // Optional userId
        customfields: Match.Maybe(Object), // Optional custom fields
      })
      assertTimecardMutationInput(timecard)
      assertBulkTimecardDatePayload(timecard)
    })
  },
  mixins: [authenticationMixin, transactionLogMixin],
  async run({ timecards }) {
    const preparedTimecards = []
    const insertedTimecards = []
    for (const timecard of timecards) {
      const {
        projectId, task, date, dateOnly, startTime, hours, customfields,
      } = timecard
      const userId = await resolveBulkTimecardUserId(
        projectId,
        timecard.userId,
        this.userId,
      )
      await checkAuthorizedTimeEntryRule({
        userId,
        projectId,
        task,
        state: 'new',
        date,
        dateOnly,
        startTime,
        hours,
      })
      preparedTimecards.push({
        projectId, task, date, dateOnly, startTime, hours, customfields, userId,
      })
    }
    await runWithProjectStatsInvalidation(
      preparedTimecards.map((timecard) => timecard.projectId),
      async () => {
        for (const timecard of preparedTimecards) {
          const {
            projectId, task, date, dateOnly, startTime, hours, customfields, userId,
          } = timecard
          const timecardId = await insertTimeCard(
            projectId,
            task,
            date,
            hours,
            userId,
            null,
            customfields,
            dateOnly,
            startTime,
            { invalidateStats: false },
          )
          insertedTimecards.push(timecardId)
        }
      },
    )
    return {
      success: true,
      message: `${insertedTimecards.length} timecards successfully inserted.`,
    }
  },
})
export {
  checkTimeEntryRule,
  deleteOwnedTimeCard,
  updateOwnedTimeCardTask,
  updateOwnedTimeCardDetails,
  insertAPITimeCard,
  insertIdempotentAPITimeCard,
  recoverAPITimeCard,
  insertTimeCard,
  insertTimeCardMethod,
  upsertTimecard,
  upsertWeek,
  updateTimeCard,
  deleteTimeCard,
  deleteTimeCardsForWeek,
  setTimeEntriesState,
  getWorkingHoursForPeriod,
  getTotalHoursForPeriod,
  getDailyTimecards,
  sendToSiwapp,
  checkProjectAdministratorAndUser,
  getGoogleWorkspaceData,
  userTimeCardsForPeriodByProjectByTaskMethod,
  getWeekTotal,
  getTotalForWeekPerDay,
  bulkInsertTimecards,
}
