import { randomBytes } from 'node:crypto'
import { check } from 'meteor/check'
import { ValidatedMethod } from 'meteor/mdg:validated-method'
import {
  adminAuthenticationMixin, authenticationMixin, transactionLogMixin,
} from '../../../utils/server_method_helpers'
import WebhookVerification from '../webhookverification.js'
import { validateWebhookMappingRules } from '../webhookMapping.js'
import {
  ENDPOINT_ID_PATTERN,
  resolveWebhookSecret,
  webhookSecretEnvironmentVariable,
} from '../webhookSecurity.js'

function boundedString(value, label, maximum, { optional = false } = {}) {
  if (optional && (value == null || value === '')) return ''
  if (typeof value !== 'string' || !value.trim() || !value.isWellFormed()
    || [...value].length > maximum) {
    throw new Meteor.Error('webhook-invalid-configuration', `${label} is invalid.`)
  }
  return value
}

const CONFIGURATION_KEYS = new Set([
  'name', 'description', 'verificationPeriod', 'serviceUrl', 'urlParam',
  'verificationType', 'mappingRules', 'active',
])

function validateConfiguration(input) {
  if (!input || Object.getPrototypeOf(input) !== Object.prototype
    || Object.keys(input).length !== CONFIGURATION_KEYS.size
    || Object.keys(input).some((key) => !CONFIGURATION_KEYS.has(key))) {
    throw new Meteor.Error('webhook-invalid-configuration', 'Unexpected configuration fields.')
  }
  const {
    name, description, verificationPeriod, serviceUrl, urlParam,
    verificationType, mappingRules, active,
  } = input
  const normalized = {
    name: boundedString(name, 'Name', 160),
    description: boundedString(description, 'Description', 2000),
    verificationPeriod,
    serviceUrl: boundedString(serviceUrl, 'Service URL', 2048, { optional: true }),
    urlParam: boundedString(urlParam, 'URL parameter', 128, { optional: true })
      || 'client_reference_id',
    verificationType: boundedString(
      verificationType, 'Verification type', 128, { optional: true },
    ),
    mappingRules: validateWebhookMappingRules(mappingRules),
    active,
  }
  if (!Number.isInteger(verificationPeriod) || verificationPeriod < 1
    || verificationPeriod > 3650 || typeof active !== 'boolean') {
    throw new Meteor.Error('webhook-invalid-configuration', 'Invalid verification period or state.')
  }
  if (normalized.serviceUrl) {
    let parsed
    try { parsed = new URL(normalized.serviceUrl) } catch {
      throw new Meteor.Error('webhook-invalid-configuration', 'Service URL is invalid.')
    }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
      throw new Meteor.Error(
        'webhook-invalid-configuration',
        'Service URL must use HTTPS and must not contain credentials.',
      )
    }
  }
  if (!/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(normalized.urlParam)) {
    throw new Meteor.Error('webhook-invalid-configuration', 'URL parameter is invalid.')
  }
  return normalized
}

function createEndpointId() {
  return randomBytes(16).toString('hex')
}

function configurationRevision(webhookInterface) {
  const value = webhookInterface?.configurationRevision
  return Number.isSafeInteger(value) && value >= 0 ? value : 0
}

function revisionSelector(webhookInterface, expectedRevision) {
  const currentRevision = configurationRevision(webhookInterface)
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0
    || expectedRevision >= Number.MAX_SAFE_INTEGER
    || expectedRevision !== currentRevision) {
    throw new Meteor.Error('webhook-write-conflict', 'Webhook interface changed. Reload it.')
  }
  return Object.hasOwn(webhookInterface, 'configurationRevision')
    ? { configurationRevision: expectedRevision }
    : { configurationRevision: { $exists: false } }
}

function assertSecretReady(endpointId) {
  if (!resolveWebhookSecret(endpointId)) {
    throw new Meteor.Error(
      'webhook-secret-not-configured',
      `Provision ${webhookSecretEnvironmentVariable(endpointId)} before activation.`,
    )
  }
}

function publicConfigurationStatus(webhookInterface) {
  const endpointId = webhookInterface.endpointId
  const secureConfiguration = webhookInterface.securityVersion === 2
    && webhookInterface.mappingVersion === 1
    && ENDPOINT_ID_PATTERN.test(endpointId || '')
  const secretConfigured = secureConfiguration && Boolean(resolveWebhookSecret(endpointId))
  return {
    _id: webhookInterface._id,
    endpointId: secureConfiguration ? endpointId : null,
    secretEnvironmentVariable: secureConfiguration
      ? webhookSecretEnvironmentVariable(endpointId) : null,
    secureConfiguration,
    secretConfigured,
    active: webhookInterface.active === true,
    operational: webhookInterface.active === true && secureConfiguration && secretConfigured,
    legacy: !secureConfiguration,
  }
}

const webhookverificationinsert = new ValidatedMethod({
  name: 'webhookverification.insert',
  validate(args) { check(args, Object) },
  mixins: [adminAuthenticationMixin, transactionLogMixin],
  async run(args) {
    const configuration = validateConfiguration(args)
    const endpointId = createEndpointId()
    if (configuration.active) {
      throw new Meteor.Error(
        'webhook-activation-requires-provisioning',
        'Create the interface inactive, provision its displayed secret environment variable, restart, then activate it.',
      )
    }
    const _id = await WebhookVerification.insertAsync({
      ...configuration,
      active: false,
      endpointId,
      securityVersion: 2,
      mappingVersion: 1,
      configurationRevision: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    return {
      _id,
      endpointId,
      secretEnvironmentVariable: webhookSecretEnvironmentVariable(endpointId),
      active: false,
      configurationRevision: 0,
    }
  },
})

const webhookverificationupdate = new ValidatedMethod({
  name: 'webhookverification.update',
  validate(args) {
    check(args, Object)
    check(args._id, String)
    check(args.expectedRevision, Number)
  },
  mixins: [adminAuthenticationMixin, transactionLogMixin],
  async run({ _id, expectedRevision, ...args }) {
    const current = await WebhookVerification.findOneAsync({ _id, removedAt: { $exists: false } })
    if (!current) throw new Meteor.Error('webhook-not-found', 'Webhook interface not found.')
    const guardedRevision = revisionSelector(current, expectedRevision)
    const configuration = validateConfiguration(args)
    const migrating = current.securityVersion !== 2 || current.mappingVersion !== 1
      || !ENDPOINT_ID_PATTERN.test(current.endpointId || '')
    const endpointId = migrating ? createEndpointId() : current.endpointId
    if (configuration.active && migrating) {
      throw new Meteor.Error(
        'webhook-activation-requires-provisioning',
        'Save the remapped interface inactive, provision its new secret, restart, then activate it.',
      )
    }
    if (configuration.active) assertSecretReady(endpointId)
    const result = await WebhookVerification.updateAsync({
      _id,
      removedAt: { $exists: false },
      ...guardedRevision,
    }, {
      $set: {
        ...configuration,
        active: migrating ? false : configuration.active,
        endpointId,
        securityVersion: 2,
        mappingVersion: 1,
        updatedAt: new Date(),
      },
      $inc: { configurationRevision: 1 },
      $unset: { allowedDomains: '', processData: '' },
    })
    if (result !== 1) throw new Meteor.Error('webhook-write-conflict', 'Webhook interface changed.')
    return {
      _id,
      endpointId,
      secretEnvironmentVariable: webhookSecretEnvironmentVariable(endpointId),
      active: migrating ? false : configuration.active,
      configurationRevision: expectedRevision + 1,
    }
  },
})

const webhookverificationremove = new ValidatedMethod({
  name: 'webhookverification.remove',
  validate({ _id, acknowledgeReferencedUsers }) {
    check(_id, String)
    check(acknowledgeReferencedUsers, Boolean)
  },
  mixins: [adminAuthenticationMixin, transactionLogMixin],
  async run({ _id, acknowledgeReferencedUsers }) {
    const referencedUsers = await Meteor.users.find({
      'actionVerification.webhookInterfaceId': _id,
    }).countAsync()
    if (referencedUsers > 0 && acknowledgeReferencedUsers !== true) {
      throw new Meteor.Error(
        'webhook-interface-referenced',
        `${referencedUsers} user(s) still reference this interface. Explicit acknowledgement is required.`,
      )
    }
    const result = await WebhookVerification.updateAsync({
      _id, removedAt: { $exists: false },
    }, {
      $set: { active: false, removedAt: new Date(), updatedAt: new Date() },
    })
    if (result !== 1) throw new Meteor.Error('webhook-not-found', 'Webhook interface not found.')
    return { _id, removed: true, referencedUsers }
  },
})

const getWebhookVerification = new ValidatedMethod({
  name: 'webhookverification.get',
  validate: null,
  mixins: [authenticationMixin],
  async run() {
    return WebhookVerification.find({
      active: true,
      securityVersion: 2,
      mappingVersion: 1,
      removedAt: { $exists: false },
    }, {
      fields: { name: 1, verificationType: 1 },
    }).fetchAsync()
  },
})

const webhookverificationstatus = new ValidatedMethod({
  name: 'webhookverification.status',
  validate: null,
  mixins: [adminAuthenticationMixin],
  async run() {
    const interfaces = await WebhookVerification.find({ removedAt: { $exists: false } }, {
      fields: { endpointId: 1, securityVersion: 1, mappingVersion: 1, active: 1 },
    }).fetchAsync()
    return Promise.all(interfaces.map(async (webhookInterface) => ({
      ...publicConfigurationStatus(webhookInterface),
      referencedUsers: await Meteor.users.find({
        'actionVerification.webhookInterfaceId': webhookInterface._id,
      }).countAsync(),
    })))
  },
})

const getDefaultVerificationType = new ValidatedMethod({
  name: 'webhookverification.getdefaulttype',
  validate: null,
  mixins: [authenticationMixin],
  async run() {
    const user = await Meteor.users.findOneAsync({ _id: this.userId })
    if (user?.actionVerification?.required && user.actionVerification.webhookInterfaceId) {
      const associated = await WebhookVerification.findOneAsync({
        _id: user.actionVerification.webhookInterfaceId,
        active: true,
        securityVersion: 2,
        mappingVersion: 1,
        removedAt: { $exists: false },
      }, { fields: { verificationType: 1 } })
      return associated?.verificationType || ''
    }
    return ''
  },
})

export {
  getDefaultVerificationType,
  getWebhookVerification,
  publicConfigurationStatus,
  configurationRevision,
  revisionSelector,
  validateConfiguration,
  webhookverificationinsert,
  webhookverificationremove,
  webhookverificationstatus,
  webhookverificationupdate,
}
