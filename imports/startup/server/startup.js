import { AccountsAnonymous } from 'meteor/faburem:accounts-anonymous'
import { BrowserPolicy } from 'meteor/browser-policy-content'
import { DDPRateLimiter } from 'meteor/ddp-rate-limiter'
import { ServiceConfiguration } from 'meteor/service-configuration'
import { OAuth } from 'meteor/oauth'
import { WebApp } from 'meteor/webapp'
import { defaultSettings, Globalsettings } from '../../api/globalsettings/globalsettings.js'
import Projects from '../../api/projects/projects.js'
import { getGlobalSettingAsync } from '../../utils/server_method_helpers.js'
import { applyHttpSecurityHeaders } from '../../../server/httpSecurityHeaders.js'
import { oauthEncryptionConfigured } from '../../utils/oauthEncryptionPolicy.js'
import {
  configuredCredentialExists,
  migrateLegacyCredentialEncryption,
} from '../../utils/credentialEncryptionMigration.js'
import {
  exactRuntimeBoolean,
  normalizeFrameAncestorOrigin,
} from '../../utils/deploymentSecurityPolicy.js'
import { perCallerDdpRule } from '../../utils/ddpRateLimitPolicy.js'

WebApp.rawConnectHandlers.use((_request, response, next) => {
  applyHttpSecurityHeaders(response, process.env)
  next()
})

for (const name of ['login', 'forgotPassword', 'resetPassword', 'changePassword']) {
  DDPRateLimiter.addRule({
    type: 'method',
    name,
    clientAddress(clientAddress) { return clientAddress || 'unknown' },
  }, 10, 60 * 1000)
}

Meteor.startup(async () => {
  AccountsAnonymous.init()
  for await (const setting of defaultSettings) {
    if (!await Globalsettings.findOneAsync({ name: setting.name })) {
      await Globalsettings.insertAsync(setting)
    }
  }
  const credentialStores = {
    globalSettings: Globalsettings,
    serviceConfigurations: ServiceConfiguration.configurations,
    users: Meteor.users,
    projects: Projects,
  }
  if (oauthEncryptionConfigured()) {
    const migratedCredentialFields = await migrateLegacyCredentialEncryption({
      ...credentialStores,
      sealSecret: (value) => OAuth.sealSecret(value),
    })
    if (migratedCredentialFields > 0) {
      // Never log secret values or owning identities.
      // eslint-disable-next-line no-console
      console.log(`Protected ${migratedCredentialFields} legacy credential field(s).`)
    }
  } else if (process.env.NODE_ENV === 'production'
      && await configuredCredentialExists(credentialStores)) {
    throw new Error(
      'TITRA_OAUTH_SECRET_KEY is required because integration credentials are configured.',
    )
  } else {
    // Safe only while no stored credential exists: every credential write
    // also fails closed until a key is provisioned.
    // eslint-disable-next-line no-console
    console.warn('TITRA_OAUTH_SECRET_KEY is not configured; credential-backed integrations are disabled.')
  }
  if (Meteor.settings.disablePublic !== undefined) {
    // eslint-disable-next-line i18next/no-literal-string
    await Globalsettings.updateAsync({ name: 'disablePublicProjects' }, { $set: { value: exactRuntimeBoolean(Meteor.settings.disablePublic) } })
  }
  if (Meteor.settings.enableAnonymousLogins !== undefined) {
    // eslint-disable-next-line i18next/no-literal-string
    await Globalsettings.updateAsync({ name: 'enableAnonymousLogins' }, { $set: { value: exactRuntimeBoolean(Meteor.settings.enableAnonymousLogins) } })
  }
  if (await getGlobalSettingAsync('enableOpenIDConnect')) {
    const Oidc = await import('../../utils/oidc/oidc_server')
    if (Accounts.oauth.serviceNames().indexOf('oidc') === -1) {
      Oidc.registerOidc()
    }
  }
  if (await getGlobalSettingAsync('google_clientid') && await getGlobalSettingAsync('google_secret')) {
    await ServiceConfiguration.configurations.upsertAsync({
      service: 'googleapi',
    }, {
      $set: {
        clientId: await getGlobalSettingAsync('google_clientid'),
        secret: await getGlobalSettingAsync('google_secret'),
      },
    })
    const { default: registerGoogleAPI } = await import('../../utils/google/google_server.js')
    await registerGoogleAPI()
  }
  const configuredFrameAncestor = await getGlobalSettingAsync('XFrameOptionsOrigin')
  if (configuredFrameAncestor) {
    try {
      BrowserPolicy.content.allowFrameAncestorsOrigin(
        normalizeFrameAncestorOrigin(configuredFrameAncestor),
      )
    } catch {
      // eslint-disable-next-line no-console
      console.error('Ignored an invalid frame ancestor origin setting.')
    }
  }
  if (process.env.NODE_ENV !== 'development') {
    // eslint-disable-next-line no-console
    console.log(`titra started on port ${process.env.PORT}`)
  }

  // Rate limiting all methods and subscriptions, defaulting to 100 calls per second
  for (const subscription in Meteor.server.publish_handlers) {
    if ({}.hasOwnProperty.call(Meteor.server.publish_handlers, subscription)) {
      DDPRateLimiter.addRule({
        ...perCallerDdpRule('subscription', subscription),
      }, 100, 1000)
    }
  }
  for (const method in Meteor.server.method_handlers) {
    if ({}.hasOwnProperty.call(Meteor.server.method_handlers, method)) {
      DDPRateLimiter.addRule({
        ...perCallerDdpRule('method', method),
      }, 100, 1000)
    }
  }
})
