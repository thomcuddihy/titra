import { Accounts } from 'meteor/accounts-base'
import { check } from 'meteor/check'
import { DDPRateLimiter } from 'meteor/ddp-rate-limiter'
import { Meteor } from 'meteor/meteor'
import { ValidatedMethod } from 'meteor/mdg:validated-method'
import { getGlobalSettingAsync } from '../../../utils/server_method_helpers.js'
import {
  RegistrationInputError,
  normalizeSelfRegistration,
  selfRegistrationAllowed,
} from './registrationPolicy.js'

const registerUser = new ValidatedMethod({
  name: 'registerUser',
  validate(args) {
    check(args, {
      email: String,
      password: String,
      name: String,
      currentLanguageProject: String,
      currentLanguageProjectDesc: String,
    })
  },
  async run(args) {
    if (this.userId || !selfRegistrationAllowed(
      await getGlobalSettingAsync('disableUserRegistration'),
    )) {
      throw new Meteor.Error('registration-disabled', 'Self-registration is disabled.')
    }
    let account
    try {
      account = normalizeSelfRegistration(args)
    } catch (error) {
      if (error instanceof RegistrationInputError) {
        throw new Meteor.Error('registration-invalid', 'Registration details are invalid.')
      }
      throw error
    }
    try {
      return await Accounts.createUserAsync(account)
    } catch (error) {
      // Do not disclose whether an address already has an account.
      throw new Meteor.Error('registration-failed', 'The account could not be created.')
    }
  },
})

DDPRateLimiter.addRule({
  type: 'method',
  name: 'registerUser',
  connectionId(connectionId) { return connectionId },
}, 5, 60 * 60 * 1000)

// A connection-only bucket can be reset by reconnecting. Keep that narrow
// bucket and additionally cap signup attempts by the server-observed address.
DDPRateLimiter.addRule({
  type: 'method',
  name: 'registerUser',
  clientAddress(clientAddress) { return clientAddress || 'unknown' },
}, 5, 60 * 60 * 1000)

export { registerUser }
