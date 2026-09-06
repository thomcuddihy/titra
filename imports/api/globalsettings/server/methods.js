import { ValidatedMethod } from 'meteor/mdg:validated-method'
import { OAuth } from 'meteor/oauth'
import { ServiceConfiguration } from 'meteor/service-configuration'
import { defaultSettings, Globalsettings } from '../globalsettings.js'
import { adminAuthenticationMixin, transactionLogMixin } from '../../../utils/server_method_helpers.js'
import { registerOidc } from '../../../utils/oidc/oidc_server.js'
import { validateSandboxCode } from '../../../utils/vm_sandbox.js'
import {
  isLiteralTimeEntryRule,
  unsafeLegacyScriptsEnabled,
} from '../../../utils/legacyScriptPolicy.js'
import {
  shouldPreserveWriteOnlySetting,
  shouldSealGlobalSetting,
} from '../globalSettingSecurity.js'
import {
  STORED_CONFIGURATION_KEYS,
  mergeOidcConfiguration,
  normalizeOidcConfiguration,
} from '../../../utils/oidc/oidcSecurity.js'
import { requireOAuthEncryptionConfigured } from '../../../utils/oauthEncryptionPolicy.js'
/**
@summary Updates global settings
@param {Array} settingsArray - Array of settings to update
@throws {Meteor.Error} If user is not an administrator
@returns {String} 'notifications.success' if successful
*/
const updateGlobalSettings = new ValidatedMethod({
  name: 'updateGlobalSettings',
  validate(settingsArray) {
    check(settingsArray, Array)
  },
  mixins: [adminAuthenticationMixin, transactionLogMixin],
  async run(settingsArray) {
    for (const setting of settingsArray) {
      check(setting, Object)
      check(setting.name, String)
      check(setting.value, Match.OneOf(String, Number, Boolean))
      // Special validation for timeEntryRule to prevent code injection
      if (setting.name === 'timeEntryRule' && typeof setting.value === 'string') {
        if (!isLiteralTimeEntryRule(setting.value) && !unsafeLegacyScriptsEnabled()) {
          throw new Meteor.Error(
            'unsafe-legacy-script-disabled',
            'Custom JavaScript time-entry rules require the explicit unsafe legacy-script server opt-in.',
          )
        }
        if (!isLiteralTimeEntryRule(setting.value)) validateSandboxCode(setting.value)
      }
      // Secret settings are write-only in the administration client. A blank
      // placeholder therefore means "leave the stored credential unchanged".
      // Determine secrecy from the stored definition, never client metadata.
      // eslint-disable-next-line no-await-in-loop
      const storedSetting = await Globalsettings.findOneAsync({ name: setting.name }, {
        fields: { _id: 1, name: 1, type: 1, restricted: 1 },
      })
      if (!storedSetting || shouldPreserveWriteOnlySetting(storedSetting, setting.value)) {
        // eslint-disable-next-line no-continue
        continue
      }
      // eslint-disable-next-line no-await-in-loop
      if (shouldSealGlobalSetting(storedSetting.name)) {
        try {
          requireOAuthEncryptionConfigured()
        } catch {
          throw new Meteor.Error(
            'oauth-encryption-required',
            'Configure persistent OAuth credential encryption before saving secrets.',
          )
        }
      }
      const nextValue = shouldSealGlobalSetting(storedSetting.name)
        ? OAuth.sealSecret(setting.value) : setting.value
      await Globalsettings.updateAsync(
        { _id: storedSetting._id },
        { $set: { value: nextValue } },
      )
    }
  },
})
/**
@summary Resets all the global settings to their default values
*/
const resetSettings = new ValidatedMethod({
  name: 'resetSettings',
  validate: null,
  mixins: [adminAuthenticationMixin, transactionLogMixin],
  async run() {
    for (const setting of defaultSettings) {
      // eslint-disable-next-line no-await-in-loop
      await Globalsettings.removeAsync({ name: setting.name })
      // eslint-disable-next-line no-await-in-loop
      await Globalsettings.insertAsync(setting)
    }
  },
})
/**
Reset global setting with a specified name
@param {Object} options
@param {string} options.name - Name of the global setting to be reset
*/
const resetGlobalsetting = new ValidatedMethod({
  name: 'resetGlobalsetting',
  validate(args) {
    check(args, {
      name: String,
    })
  },
  mixins: [adminAuthenticationMixin, transactionLogMixin],
  async run({ name }) {
    await Globalsettings.removeAsync({ name })
    for (const setting of defaultSettings) {
      if (setting.name === name) {
        // eslint-disable-next-line no-await-in-loop
        await Globalsettings.insertAsync(setting)
        break
      }
    }
  },
})
/**
@summary Updates the OIDC settings in the server
@param {Object} configuration - The updated OIDC configuration object
@returns {undefined}
*/
const updateOidcSettings = new ValidatedMethod({
  name: 'updateOidcSettings',
  validate({ configuration }) {
    check(configuration, Object)
  },
  mixins: [adminAuthenticationMixin, transactionLogMixin],
  async run({ configuration }) {
    const existing = await ServiceConfiguration.configurations.findOneAsync({ service: 'oidc' })
    let normalized
    try {
      const merged = mergeOidcConfiguration(configuration, existing || {})
      const suppliedSecret = Object.prototype.hasOwnProperty.call(configuration, 'secret')
        ? configuration.secret : undefined
      if (suppliedSecret !== undefined && typeof suppliedSecret !== 'string') throw new Error()
      const replacesSecret = typeof suppliedSecret === 'string' && suppliedSecret.trim() !== ''
      if (replacesSecret) merged.secret = suppliedSecret
      normalized = normalizeOidcConfiguration(merged, {
        environment: process.env,
        preservedSecret: replacesSecret ? undefined : existing?.secret,
      })
      if (replacesSecret || typeof existing?.secret === 'string') {
        requireOAuthEncryptionConfigured()
        normalized.secret = OAuth.sealSecret(normalized.secret)
      }
    } catch {
      throw new Meteor.Error(
        'invalid-oidc-configuration',
        'The OpenID Connect configuration is invalid.',
      )
    }

    const modifier = { $set: normalized }
    const obsoleteFields = Object.keys(existing || {}).filter(
      (key) => key !== '_id' && !STORED_CONFIGURATION_KEYS.includes(key),
    )
    if (obsoleteFields.length > 0) {
      modifier.$unset = Object.fromEntries(obsoleteFields.map((key) => [key, '']))
    }
    await ServiceConfiguration.configurations.upsertAsync({ service: 'oidc' }, modifier)

    try {
      if (Accounts.oauth.serviceNames().indexOf('oidc') === -1) await registerOidc()
    } catch {
      throw new Meteor.Error(
        'oidc-registration-failed',
        'The OpenID Connect service could not be enabled.',
      )
    }
  },
})
/**
@summary Get the list of global setting categories.
@returns {Array} An array of global setting categories
@throws {Meteor.Error} If the user is not authorized
*/
const getGlobalsettingCategories = new ValidatedMethod({
  name: 'getGlobalsettingCategories',
  validate: null,
  mixins: [adminAuthenticationMixin],
  async run() {
    return Globalsettings.rawCollection().aggregate([{ $group: { _id: '$category' } }, { $sort: { _id: 1 } }]).toArray()
  },
})

export {
  resetSettings,
  updateOidcSettings,
  getGlobalsettingCategories,
  updateGlobalSettings,
  resetGlobalsetting,
}
