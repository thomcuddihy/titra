import { ValidatedMethod } from 'meteor/mdg:validated-method'
import { DDPRateLimiter } from 'meteor/ddp-rate-limiter'
import { check, Match } from 'meteor/check'
import Projects from '../../projects/projects.js'
import { authenticationMixin } from '../../../utils/server_method_helpers.js'
import { aggregateBoundedCustomers } from './customerReadLimits.js'

DDPRateLimiter.addRule({
  type: 'method',
  name: 'getAllCustomers',
  userId(userId) { return typeof userId === 'string' && userId.length > 0 },
}, 60, 60 * 1000)
DDPRateLimiter.addRule({
  type: 'method',
  name: 'getAllCustomers',
  clientAddress(clientAddress) {
    return typeof clientAddress === 'string' && clientAddress.length > 0
  },
}, 120, 60 * 1000)

/**
 * A ValidatedMethod that retrieves all customers from the Projects collection.
 *
 * @typedef {Object} ValidatedMethod
 * @property {string} name - The name of the method.
 * @property {function} validate - The validation function for the method.
 * @property {Array} mixins - An array of mixins to be applied to the method.
 * @property {function} run - The function to be executed when the method is called.
 *
 * @function getAllCustomers
 * @returns {Promise<Array>} - A promise that resolves to an array of customer objects.
 */
const getAllCustomers = new ValidatedMethod({
  name: 'getAllCustomers',
  validate(args) {
    check(args, Match.Maybe({}))
  },
  mixins: [authenticationMixin],
  async run() {
    return aggregateBoundedCustomers({
      aggregate: (pipeline, options) => Projects.rawCollection()
        .aggregate(pipeline, options).toArray(),
      userId: this.userId,
    })
  },
})

export { getAllCustomers }
