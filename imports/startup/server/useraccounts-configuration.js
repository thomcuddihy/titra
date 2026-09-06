/* eslint-disable no-param-reassign */
import { Accounts } from 'meteor/accounts-base'
import { Random } from 'meteor/random'
import dockerNames from 'docker-names'
import { getGlobalSettingAsync } from '../../utils/server_method_helpers'
import initNewUser from '../../api/projects/setup.js'
import { configureSignedInUserPublication } from '../../api/users/server/signedInUserPrivacy.js'
import SecurityState from '../../api/users/server/securityState.js'
import { reserveInitialAdministrator } from '../../api/users/server/adminSafety.js'
import { shouldLinkExistingOidcAccount } from '../../utils/oidc/oidcSecurity.js'
import { oauthEncryptionKey } from '../../utils/oauthEncryptionPolicy.js'
import {
  anonymousRegistrationAllowed,
  firstUserAdministratorAllowed,
} from '../../api/users/server/registrationPolicy.js'

const accountsConfiguration = {
  ambiguousErrorMessages: true,
  forbidClientAccountCreation: true,
}
const oauthSecretKey = oauthEncryptionKey()
if (oauthSecretKey) accountsConfiguration.oauthSecretKey = oauthSecretKey
Accounts.config(accountsConfiguration)

// Accounts otherwise publishes the signed-in user's profile through its
// implicit null publication. Keep that stream ID-only; the navbar subscribes
// to the exact, live-gated userRoles projection for every UI field.
configureSignedInUserPublication(Accounts)

Accounts.setAdditionalFindUserOnExternalLogin((attempt) => {
  // Email-based account linking changes the authentication boundary. Keep it
  // disabled unless the operator explicitly opts in, and then accept only the
  // provider's validated, explicitly verified OIDC email claim.
  if (shouldLinkExistingOidcAccount(attempt)) {
    return Accounts.findUserByEmail(attempt.serviceData.email)
  }
  return undefined
})
Accounts.validateLoginAttempt((attempt) => !attempt.user?.inactive)
Accounts.onCreateUser(async (options, user) => {
  // faburem:accounts-anonymous registers its DDP login handler as an import
  // side effect. Enforce the operator setting at the server-side account
  // creation boundary so calling that handler directly cannot bypass /try.
  if (options.anonymous && !anonymousRegistrationAllowed(
    await getGlobalSettingAsync('enableAnonymousLogins'),
  )) {
    throw new Meteor.Error('anonymous-registration-disabled', 'Anonymous registration is disabled.')
  }
  const localUser = user
  if (!localUser._id) localUser._id = Random.id()
  if (options.anonymous) {
    options.profile = {
      name: dockerNames.getRandomName(),
      avatarColor: `#${(`000000${Math.floor(0x1000000 * Math.random()).toString(16)}`).slice(-6)}`,
    }
  }
  if (!options.profile?.currentLanguageProject) {
    if (options.profile) {
      options.profile.currentLanguageProject = 'Projekt'
      options.profile.currentLanguageProjectDesc = 'Dieses Projekt wurde automatisch erstellt, Sie können es nach Belieben bearbeiten. Wussten Sie, dass Sie Emojis wie 💰 ⏱ 👍 überall verwenden können?'
    }
  }

  await initNewUser(user._id, options)

  if (options.profile) {
    localUser.profile = options.profile
    delete localUser.profile.currentLanguageProject
    delete localUser.profile.currentLanguageProjectDesc
  }

  if (!localUser.emails && options.emails) {
    localUser.emails = options.emails
  }

  // Never let the first public registrant silently become administrator. A
  // fresh deployment may retain the historical bootstrap behavior only during
  // an isolated setup window with an exact, temporary operator opt-in.
  if (!options.anonymous
      && firstUserAdministratorAllowed(process.env.TITRA_ENABLE_FIRST_USER_ADMIN)
      && await reserveInitialAdministrator({ userId: localUser._id }, {
        countUsers: () => Meteor.users.find({}).countAsync(),
        findActiveAdministrator: () => Meteor.users.findOneAsync({
          isAdmin: true, inactive: { $ne: true },
        }, { fields: { _id: 1 } }),
        claimBootstrap: (userId) => SecurityState.rawCollection().updateOne({
          _id: 'initial-administrator', claimed: { $ne: true },
        }, {
          $set: { claimed: true, userId, claimedAt: new Date() },
        }, { upsert: true }),
      })) {
    localUser.isAdmin = true
  }

  // Handle user action verification for non-anonymous users
  const enableVerification = await getGlobalSettingAsync('enableUserActionVerification')
  if (enableVerification && !options.anonymous && localUser.emails && localUser.emails.length > 0) {
    const { getDefaultVerificationSettingsAsync } = await import('../../utils/server_method_helpers.js')
    const verificationSettings = await getDefaultVerificationSettingsAsync()
    const deadline = new Date()
    deadline.setDate(deadline.getDate() + verificationSettings.verificationPeriod)

    localUser.actionVerification = {
      required: true,
      deadline,
      completed: false,
      secret: Random.secret(32),
      webhookInterfaceId: verificationSettings.webhookInterfaceId,
    }
  }

  return localUser
})
const fromName = await getGlobalSettingAsync('fromName')
const fromAddress = await getGlobalSettingAsync('fromAddress')
Accounts.emailTemplates.from = `${fromName} <${fromAddress}>`
Accounts.emailTemplates.enrollAccount.subject = (user) => `Welcome to Awesome Town, ${user.profile.name}`
Accounts.emailTemplates.resetPassword.from = () => `${fromName} Password Reset <${fromAddress}>`
