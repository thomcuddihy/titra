import { check, Match } from 'meteor/check'
import { Meteor } from 'meteor/meteor'
import { DDPRateLimiter } from 'meteor/ddp-rate-limiter'
import { ValidatedMethod } from 'meteor/mdg:validated-method'
import Holidays from 'date-holidays'
import { authenticationMixin, getUserSettingAsync } from '../../../utils/server_method_helpers.js'
import { createActivePublicationGate } from '../../../utils/activePublicationGate.js'
import {
  boundedHolidayList,
  boundedHolidayMap,
  normalizeHolidayCode,
  normalizeHolidayYear,
} from './holidayReadLimits.js'

const hd = new Holidays()
const holidayExecutionGate = createActivePublicationGate({
  perUser: 5,
  perPeer: 20,
  total: 100,
})
const holidayMethodNames = new Set([
  'getHolidays', 'getHolidayCountries', 'getHolidayStates', 'getHolidayRegions',
])

DDPRateLimiter.addRule({
  type: 'method',
  name(name) { return holidayMethodNames.has(name) },
  userId(userId) { return typeof userId === 'string' && userId.length > 0 },
}, 60, 60 * 1000)
DDPRateLimiter.addRule({
  type: 'method',
  name(name) { return holidayMethodNames.has(name) },
  clientAddress(clientAddress) {
    return typeof clientAddress === 'string' && clientAddress.length > 0
  },
}, 120, 60 * 1000)

async function runBoundedHolidayWork(context, work) {
  const release = holidayExecutionGate.acquire({
    userId: context.userId,
    peerAddress: context.connection?.clientAddress,
  })
  if (!release) {
    throw new Meteor.Error(
      'holiday-work-limit',
      'Too many holiday requests are already running. Try again shortly.',
    )
  }
  try {
    return await work()
  } finally {
    release()
  }
}

/**
 * Retrieves the current holiday based on user settings.
 * @returns {Holidays} The current holiday object.
 */
async function getCurrentHoliday() {
  const country = normalizeHolidayCode(await getUserSettingAsync('holidayCountry'), 'Country', {
    optional: true,
  })
  const state = normalizeHolidayCode(await getUserSettingAsync('holidayState'), 'State', {
    optional: true,
  })
  const region = normalizeHolidayCode(await getUserSettingAsync('holidayRegion'), 'Region', {
    optional: true,
  })
  if (!country) return null
  return new Holidays(country, state, region)
}

/**
@summary Get a list of all holidays.
@return {Array}
Returns a list of holidays.
*/
const getHolidays = new ValidatedMethod({
  name: 'getHolidays',
  validate(args) {
    check(args, Match.Maybe({ year: Match.Maybe(Number) }))
  },
  mixins: [authenticationMixin],
  async run({ year } = {}) {
    return runBoundedHolidayWork(this, async () => {
      const h = await getCurrentHoliday()
      if (!h) return []
      return boundedHolidayList(
        h.getHolidays(normalizeHolidayYear(year)), 'Holiday list',
      )
    })
  },
})
/**
@summary Get a list of all holiday countries.
@return {Array}
Returns a list of holiday countries.
*/
const getHolidayCountries = new ValidatedMethod({
  name: 'getHolidayCountries',
  validate(args) {
    check(args, Match.Maybe({}))
  },
  mixins: [authenticationMixin],
  async run() {
    return runBoundedHolidayWork(
      this, () => boundedHolidayMap(hd.getCountries(), 'Holiday countries'),
    )
  },
})
/**
@summary Get a list of all holiday states.
@param {Object} options
@param {string} options.country - ID of the country to get list of holiday states for
@return {Array} Returns a list of holiday countries.
*/
const getHolidayStates = new ValidatedMethod({
  name: 'getHolidayStates',
  validate(args) {
    check(args, {
      country: String,
    })
  },
  mixins: [authenticationMixin],
  async run({ country }) {
    return runBoundedHolidayWork(this, () => {
      if (!country) return false
      const normalizedCountry = normalizeHolidayCode(country, 'Country')
      return boundedHolidayMap(hd.getStates(normalizedCountry), 'Holiday states')
    })
  },
})
/**
@summary Get a list of all holiday regions.
@param {Object} options
@param {string} options.country - ID of the country to get list of holiday states for
@param {string} options.state - ID of the state to get list of holiday states for
@return {Array} Returns a list of holiday countries.
*/
const getHolidayRegions = new ValidatedMethod({
  name: 'getHolidayRegions',
  validate(args) {
    check(args, {
      country: String,
      state: String,
    })
  },
  mixins: [authenticationMixin],
  async run({ country, state }) {
    return runBoundedHolidayWork(this, () => {
      if (!country || !state) return false
      const normalizedCountry = normalizeHolidayCode(country, 'Country')
      const normalizedState = normalizeHolidayCode(state, 'State')
      return boundedHolidayMap(
        hd.getRegions(normalizedCountry, normalizedState), 'Holiday regions',
      )
    })
  },
})
export {
  getHolidayCountries, getHolidayRegions, getHolidayStates, getHolidays,
}
