import { check, Match } from 'meteor/check'
import { fetch, Headers } from 'meteor/fetch'
import { ValidatedMethod } from 'meteor/mdg:validated-method'
import { NodeVM } from '../../../utils/vm_sandbox.js'
import { legacyScriptDecision } from '../../../utils/legacyScriptPolicy.js'
import {
  adminAuthenticationMixin, authenticationMixin, transactionLogMixin,
} from '../../../utils/server_method_helpers'
import OutboundInterfaces from '../outboundinterfaces.js'

const PUBLIC_OUTBOUND_INTERFACE_FIELDS = Object.freeze({
  name: 1,
  description: 1,
  faIcon: 1,
  active: 1,
})

const MAX_OUTBOUND_ITEMS = 10000
const MAX_OUTBOUND_DEPTH = 20
const MAX_OUTBOUND_KEYS = 100000
const MAX_OUTBOUND_SERIALIZED_BYTES = 5 * 1024 * 1024
const FORBIDDEN_OUTBOUND_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

function normalizeOutboundData(data) {
  if (!Array.isArray(data) || data.length > MAX_OUTBOUND_ITEMS) {
    throw new TypeError('Invalid outbound interface data.')
  }
  const ancestors = new WeakSet()
  let keys = 0
  const inspect = (value, depth) => {
    if (value === null || typeof value === 'boolean') return
    if (typeof value === 'string') {
      if (!value.isWellFormed()) throw new TypeError('Invalid outbound interface data.')
      return
    }
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw new TypeError('Invalid outbound interface data.')
      return
    }
    if (typeof value !== 'object' || depth > MAX_OUTBOUND_DEPTH
      || ancestors.has(value)) throw new TypeError('Invalid outbound interface data.')
    const prototype = Object.getPrototypeOf(value)
    if (Array.isArray(value)) {
      if (prototype !== Array.prototype) throw new TypeError('Invalid outbound interface data.')
    } else if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('Invalid outbound interface data.')
    }
    const ownKeys = Reflect.ownKeys(value)
    if (ownKeys.some((key) => typeof key !== 'string' || FORBIDDEN_OUTBOUND_KEYS.has(key))) {
      throw new TypeError('Invalid outbound interface data.')
    }
    keys += ownKeys.length
    if (keys > MAX_OUTBOUND_KEYS) throw new TypeError('Invalid outbound interface data.')
    ancestors.add(value)
    ownKeys.forEach((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
        throw new TypeError('Invalid outbound interface data.')
      }
      inspect(descriptor.value, depth + 1)
    })
    ancestors.delete(value)
  }
  inspect(data, 0)
  const serialized = JSON.stringify(data)
  if (Buffer.byteLength(serialized, 'utf8') > MAX_OUTBOUND_SERIALIZED_BYTES) {
    throw new TypeError('Invalid outbound interface data.')
  }
  return JSON.parse(serialized)
}

/**
 * Inserts a new outbound interface into the system.
 *
 * @method outboundinterfaces.insert
 * @param {Object} options - The options for the outbound interface.
 * @param {string} options.name - The name of the outbound interface.
 * @param {string} options.description - The description of the outbound interface.
 * @param {string} [options.processData] - The process data of the outbound interface (optional).
 * @param {string} [options.faIcon] - The font awesome icon of the outbound interface (optional).
 * @param {boolean} options.active - Indicates if the outbound interface is active.
 * @returns {string} - The success notification message.
 */
const outboundinterfacesinsert = new ValidatedMethod({
  name: 'outboundinterfaces.insert',
  validate({
    name, description, processData, active, faIcon,
  }) {
    check(name, String)
    check(description, String)
    check(processData, Match.Maybe(String))
    check(faIcon, Match.Maybe(String))
    check(active, Boolean)
  },
  mixins: [adminAuthenticationMixin, transactionLogMixin],
  async run({
    name, description, processData, active, faIcon,
  }) {
    if (active && !legacyScriptDecision('outbound-interface').allowed) {
      throw new Meteor.Error(
        'unsafe-legacy-script-disabled',
        'Legacy JavaScript interfaces cannot be activated without the server security opt-in.',
      )
    }
    await OutboundInterfaces.insertAsync({
      name,
      description,
      processData,
      active,
      faIcon,
    })
    return 'notifications.success'
  },
})
/**
 * Updates an outbound interface.
 *
 * @method outboundinterfaces.update
 * @param {Object} options - The options for updating the outbound interface.
 * @param {string} options._id - The ID of the outbound interface.
 * @param {string} options.name - The name of the outbound interface.
 * @param {string} options.description - The description of the outbound interface.
 * @param {string} [options.processData] - The processed data of the outbound interface (optional).
 * @param {boolean} options.active - The status of the outbound interface.
 * @param {string} [options.faIcon] - The font awesome icon of the outbound interface (optional).
 * @returns {string} - The success notification message.
 */
const outboundinterfacesupdate = new ValidatedMethod({
  name: 'outboundinterfaces.update',
  validate({
    _id,
    name,
    description,
    processData,
    faIcon,
    active,
  }) {
    check(_id, String)
    check(name, String)
    check(description, String)
    check(processData, Match.Maybe(String))
    check(active, Boolean)
    check(faIcon, Match.Maybe(String))
  },
  mixins: [adminAuthenticationMixin, transactionLogMixin],
  async run({
    _id,
    name,
    description,
    processData,
    faIcon,
    active,
  }) {
    if (active && !legacyScriptDecision('outbound-interface').allowed) {
      throw new Meteor.Error(
        'unsafe-legacy-script-disabled',
        'Legacy JavaScript interfaces cannot be activated without the server security opt-in.',
      )
    }
    await OutboundInterfaces.updateAsync({ _id }, {
      $set: {
        name,
        description,
        processData,
        active,
        faIcon,
      },
    })
    return 'notifications.success'
  },
})
/**
 * Removes an outbound interface.
 *
 * @method outboundinterfaces.remove
 * @param {Object} options - The options for removing the outbound interface.
 * @param {string} options._id - The ID of the outbound interface to be removed.
 * @returns {string} The success notification message.
 */
const outboundinterfacesremove = new ValidatedMethod({
  name: 'outboundinterfaces.remove',
  validate({ _id }) {
    check(_id, String)
  },
  mixins: [adminAuthenticationMixin, transactionLogMixin],
  async run({ _id }) {
    await OutboundInterfaces.removeAsync({ _id })
    return 'notifications.success'
  },
})

/**
 * Runs the outbound interface processData script with the given ID and data.
 *
 * @param {Object} options - The options for running the outbound interface.
 * @param {string} options._id - The ID of the outbound interface.
 * @param {Array} options.data - The data to be processed by the outbound interface.
 * @returns {string|boolean} - The result of running the outbound interface, or false if
 * the outbound interface script threw an error.
 */
const outboundinterfacesrun = new ValidatedMethod({
  name: 'outboundinterfaces.run',
  validate({ _id, data }) {
    check(_id, String)
    check(data, Array)
  },
  mixins: [authenticationMixin],
  async run({ _id, data }) {
    if (!legacyScriptDecision('outbound-interface').allowed) {
      throw new Meteor.Error(
        'unsafe-legacy-script-disabled',
        'Legacy JavaScript interfaces are disabled by the server security policy.',
      )
    }
    const outboundInterface = await OutboundInterfaces.findOneAsync({
      _id,
      active: true,
      processData: { $type: 'string' },
    }, { fields: { processData: 1 } })
    if (!outboundInterface) {
      throw new Meteor.Error('not-authorized', 'Interface is not available.')
    }
    let safeData
    try {
      safeData = normalizeOutboundData(data)
    } catch {
      throw new Meteor.Error('interface-invalid-data', 'Interface data is invalid.')
    }
    const vm = new NodeVM({
      sandbox: {
        fetch,
        data: safeData,
        Headers,
      },
    })
    try {
      await vm.run(outboundInterface.processData)
      return 'notifications.success'
    } catch {
      throw new Meteor.Error('interface-execution-failed', 'Interface execution failed.')
    }
  },
})
/**
 * Retrieves the active outbound interfaces.
 *
 * @method outboundinterfaces.get
 * @mixes authenticationMixin
 * @returns {Array} An array of active outbound interfaces.
 */
const getOutboundInterfaces = new ValidatedMethod({
  name: 'outboundinterfaces.get',
  validate: null,
  mixins: [authenticationMixin],
  async run() {
    if (!legacyScriptDecision('outbound-interface').allowed) return []
    return OutboundInterfaces
      .find({ active: true }, { fields: PUBLIC_OUTBOUND_INTERFACE_FIELDS }).fetchAsync()
  },
})
export {
  outboundinterfacesinsert,
  outboundinterfacesupdate,
  outboundinterfacesremove,
  outboundinterfacesrun,
  getOutboundInterfaces,
  normalizeOutboundData,
}
