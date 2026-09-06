import { check, Match } from 'meteor/check'
import { fetch } from 'meteor/fetch'
import { ValidatedMethod } from 'meteor/mdg:validated-method'
import { NodeVM } from '../../../utils/vm_sandbox.js'
import { legacyScriptDecision } from '../../../utils/legacyScriptPolicy.js'
import {
  adminAuthenticationMixin, authenticationMixin, transactionLogMixin,
} from '../../../utils/server_method_helpers'
import {
  SIGNED_IN_PROFILE_FIELDS,
  signedInBrowserProfile,
} from '../../users/server/signedInUserPrivacy.js'
import InboundInterfaces from '../inboundinterfaces.js'
import Projects from '../../projects/projects.js'
import {
  MEMBER_PROJECT_FIELDS,
  projectFieldsForCaller,
} from '../../projects/server/publicationPrivacy.js'
import { currentProjectAudienceClauses } from '../../projects/server/publicAccessServer.js'

const PUBLIC_INBOUND_INTERFACE_FIELDS = Object.freeze({
  name: 1,
  description: 1,
  active: 1,
})

const MAX_INBOUND_TASKS = 1000
const MAX_INBOUND_TASK_NAME_LENGTH = 1000
const MAX_INBOUND_TASK_DESCRIPTION_LENGTH = 10000

function normalizeInboundTasks(tasks) {
  if (!Array.isArray(tasks) || tasks.length > MAX_INBOUND_TASKS) {
    throw new TypeError('Invalid inbound interface result.')
  }
  return tasks.map((task) => {
    if (!task || typeof task !== 'object' || Array.isArray(task)
      || typeof task.name !== 'string' || !task.name.isWellFormed()
      || task.name.length > MAX_INBOUND_TASK_NAME_LENGTH
      || (task.description != null && (typeof task.description !== 'string'
        || !task.description.isWellFormed()
        || task.description.length > MAX_INBOUND_TASK_DESCRIPTION_LENGTH))) {
      throw new TypeError('Invalid inbound interface result.')
    }
    return {
      name: task.name,
      description: task.description ?? '',
    }
  })
}

/**
 * Method for inserting a new inbound interface.
 *
 * @method inboundinterfacesinsert
 * @param {Object} options - The options for inserting a new inbound interface.
 * @param {string} options.name - The name of the inbound interface.
 * @param {string} options.description - The description of the inbound interface.
 * @param {string} [options.processData] - The process data of the inbound interface (optional).
 * @param {boolean} options.active - The active status of the inbound interface.
 * @returns {string} - The success notification message.
 */
const inboundinterfacesinsert = new ValidatedMethod({
  name: 'inboundinterfaces.insert',
  validate({
    name, description, processData, active,
  }) {
    check(name, String)
    check(description, String)
    check(processData, Match.Maybe(String))
    check(active, Boolean)
  },
  mixins: [adminAuthenticationMixin, transactionLogMixin],
  async run({
    name, description, processData, active,
  }) {
    if (active && !legacyScriptDecision('inbound-interface').allowed) {
      throw new Meteor.Error(
        'unsafe-legacy-script-disabled',
        'Legacy JavaScript interfaces cannot be activated without the server security opt-in.',
      )
    }
    await InboundInterfaces.insertAsync({
      name,
      description,
      processData,
      active,
    })
    return 'notifications.success'
  },
})
/**
 * Updates an inbound interface.
 *
 * @method inboundinterfacesupdate
 * @param {Object} options - The options for updating the inbound interface.
 * @param {string} options._id - The ID of the inbound interface.
 * @param {string} options.name - The name of the inbound interface.
 * @param {string} options.description - The description of the inbound interface.
 * @param {string} options.processData - The process data of the inbound interface.
 * @param {boolean} options.active - The active status of the inbound interface.
 * @returns {string} - The success notification message.
 */
const inboundinterfacesupdate = new ValidatedMethod({
  name: 'inboundinterfaces.update',
  validate({
    _id,
    name,
    description,
    processData,
    active,
  }) {
    check(_id, String)
    check(name, String)
    check(description, String)
    check(processData, String)
    check(active, Boolean)
  },
  mixins: [adminAuthenticationMixin, transactionLogMixin],
  async run({
    _id,
    name,
    description,
    processData,
    active,
  }) {
    if (active && !legacyScriptDecision('inbound-interface').allowed) {
      throw new Meteor.Error(
        'unsafe-legacy-script-disabled',
        'Legacy JavaScript interfaces cannot be activated without the server security opt-in.',
      )
    }
    await InboundInterfaces.updateAsync({ _id }, {
      $set: {
        name,
        description,
        processData,
        active,
      },
    })
    return 'notifications.success'
  },
})
/**
 * Removes an inbound interface.
 *
 * @method inboundinterfacesremove
 * @param {Object} options - The options for removing the inbound interface.
 * @param {string} options._id - The ID of the inbound interface to be removed.
 * @returns {string} - A success notification message.
 */
const inboundinterfacesremove = new ValidatedMethod({
  name: 'inboundinterfaces.remove',
  validate({ _id }) {
    check(_id, String)
  },
  mixins: [adminAuthenticationMixin, transactionLogMixin],
  async run({ _id }) {
    await InboundInterfaces.removeAsync({ _id })
    return 'notifications.success'
  },
})
/**
 * Retrieves the active inbound interfaces.
 *
 * @method inboundinterfaces.get
 * @mixes authenticationMixin
 * @returns {Array} An array of active inbound interfaces.
 */
const getInboundInterfaces = new ValidatedMethod({
  name: 'inboundinterfaces.get',
  validate: null,
  mixins: [authenticationMixin],
  async run() {
    if (!legacyScriptDecision('inbound-interface').allowed) return []
    return InboundInterfaces
      .find({ active: true }, { fields: PUBLIC_INBOUND_INTERFACE_FIELDS }).fetchAsync()
  },
})
/**
 * Retrieves tasks from the inbound interface.
 *
 * @method inboundinterfaces.getTasks
 * @param {Object} options - The options for retrieving tasks.
 * @param {string} options._id - The ID of the inbound interface.
 * @param {string} options.projectId - The ID of the project.
 * @throws {Meteor.Error} If there is an error retrieving tasks.
 * @returns {Array} An array of tasks.
 */
const getTasksFromInboundInterface = new ValidatedMethod({
  name: 'inboundinterfaces.getTasks',
  validate({ _id, projectId }) {
    check(_id, String)
    check(projectId, String)
  },
  mixins: [authenticationMixin],
  async run({ _id, projectId }) {
    if (!legacyScriptDecision('inbound-interface').allowed) {
      throw new Meteor.Error(
        'unsafe-legacy-script-disabled',
        'Legacy JavaScript interfaces are disabled by the server security policy.',
      )
    }
    const meteorUser = await Meteor.users.findOneAsync({
      _id: this.userId,
      inactive: { $ne: true },
    }, { fields: SIGNED_IN_PROFILE_FIELDS })
    const project = await Projects.findOneAsync({
      _id: projectId,
      $or: await currentProjectAudienceClauses(this.userId),
    }, { fields: MEMBER_PROJECT_FIELDS })
    if (!meteorUser || !project) {
      throw new Meteor.Error('not-authorized', 'Interface or project is not available.')
    }
    // Keep the active-script read last so a stale interface listing cannot
    // start a script after an administrator has disabled it.
    const inboundInterface = await InboundInterfaces.findOneAsync({
      _id,
      active: true,
      processData: { $type: 'string' },
    }, { fields: { processData: 1 } })
    if (!inboundInterface) {
      throw new Meteor.Error('not-authorized', 'Interface or project is not available.')
    }
    const vm = new NodeVM({
      wrapper: 'none',
      timeout: 1000,
      sandbox: {
        user: signedInBrowserProfile(meteorUser),
        project: {
          _id: project._id,
          ...projectFieldsForCaller(project, this.userId),
        },
        fetch,
      },
      require: {
        external: true,
        builtin: ['*'],
      },
    })
    try {
      const result = await vm.run(inboundInterface.processData)
      return normalizeInboundTasks(result)
    } catch {
      // Stored programs are trusted administrator code for compatibility, but
      // their internal errors and upstream responses are not caller-visible.
      throw new Meteor.Error('interface-execution-failed', 'Interface execution failed.')
    }
  },
})
export {
  inboundinterfacesinsert,
  inboundinterfacesupdate,
  inboundinterfacesremove,
  getInboundInterfaces,
  getTasksFromInboundInterface,
  normalizeInboundTasks,
}
