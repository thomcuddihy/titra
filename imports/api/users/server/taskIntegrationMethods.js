import { check, Match } from 'meteor/check'
import { DDPRateLimiter } from 'meteor/ddp-rate-limiter'
import { Meteor } from 'meteor/meteor'
import { OAuth } from 'meteor/oauth'
import { ValidatedMethod } from 'meteor/mdg:validated-method'
import Projects from '../../projects/projects.js'
import { Globalsettings } from '../../globalsettings/globalsettings.js'
import { authenticationMixin } from '../../../utils/server_method_helpers.js'
import {
  inspectWekanConfiguration,
  requestTaskIntegrationSuggestions,
  requestWekanTaskSuggestions,
} from './taskIntegrationProxy.js'

const METHOD_NAME = 'taskIntegrations.listSuggestions'
const INSPECT_WEKAN_METHOD_NAME = 'taskIntegrations.inspectWekan'
const PROVIDER_SETTING = Object.freeze({
  zammad: 'enableZammad',
  gitlab: 'enableGitlab',
  wekan: 'enableWekan',
})

async function integrationEnabled(provider) {
  const name = PROVIDER_SETTING[provider]
  if (!name) return false
  return (await Globalsettings.findOneAsync({ name }, { fields: { value: 1 } }))?.value === true
}

const listTaskIntegrationSuggestions = new ValidatedMethod({
  name: METHOD_NAME,
  validate(args) {
    check(args, { provider: String, projectId: String })
  },
  mixins: [authenticationMixin],
  async run({ provider, projectId }) {
    try {
      if (!Object.hasOwn(PROVIDER_SETTING, provider)
        || !/^[A-Za-z0-9_-]{1,128}$/.test(projectId)) throw new Error('invalid-request')
      if (!await integrationEnabled(provider)) throw new Error('disabled')
      if (provider === 'wekan' && Meteor.settings?.public?.sandstorm) {
        throw new Error('sandstorm-unsupported')
      }
      const userFields = provider === 'wekan' ? { _id: 1 } : {
        [`profile.${provider}url`]: 1,
        [`profile.${provider}token`]: 1,
      }
      const [project, user] = await Promise.all([
        Projects.findOneAsync({
          _id: projectId,
          $or: [{ userId: this.userId }, { admins: this.userId }, { team: this.userId }],
        }, {
          fields: {
            _id: 1,
            gitlabquery: 1,
            wekanurl: 1,
            selectedWekanList: 1,
            selectedWekanSwimlanes: 1,
          },
        }),
        Meteor.users.findOneAsync({
          _id: this.userId,
          inactive: { $ne: true },
        }, { fields: userFields }),
      ])
      if (!project || !user) throw new Error('not-authorized')
      if (provider === 'wekan') {
        // Wekan is globally enabled by default; an unconfigured project is not an error.
        if (!project.wekanurl) return []
        return await requestWekanTaskSuggestions({
          ...project, wekanurl: OAuth.openSecret(project.wekanurl),
        })
      }
      const profile = {
        ...user.profile,
        [`${provider}token`]: OAuth.openSecret(user.profile?.[`${provider}token`]),
      }
      return await requestTaskIntegrationSuggestions({ provider, project, profile })
    } catch {
      // Do not disclose credentials, endpoint topology, membership, or upstream responses.
      throw new Meteor.Error(
        'integration-unavailable',
        'Task suggestions are temporarily unavailable.',
      )
    }
  },
})

const inspectWekan = new ValidatedMethod({
  name: INSPECT_WEKAN_METHOD_NAME,
  validate(args) {
    check(args, { projectId: String, replacementUrl: Match.Maybe(String) })
  },
  mixins: [authenticationMixin],
  async run({ projectId, replacementUrl }) {
    try {
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(projectId)
        || !await integrationEnabled('wekan')
        || Meteor.settings?.public?.sandstorm) throw new Error('invalid-request')
      const project = await Projects.findOneAsync({
        _id: projectId,
        $or: [{ userId: this.userId }, { admins: this.userId }],
      }, { fields: { _id: 1, wekanurl: 1 } })
      if (!project) throw new Error('not-authorized')
      const requestedUrl = typeof replacementUrl === 'string' && replacementUrl.length > 0
        ? replacementUrl : OAuth.openSecret(project.wekanurl)
      return await inspectWekanConfiguration(requestedUrl)
    } catch {
      // The caller must not learn whether access, DNS, validation, or upstream I/O failed.
      throw new Meteor.Error(
        'integration-unavailable',
        'Wekan settings are temporarily unavailable.',
      )
    }
  },
})

// This stricter rule is cumulative with the installation-wide DDP limit.
DDPRateLimiter.addRule({
  type: 'method',
  name: METHOD_NAME,
  userId(userId) { return typeof userId === 'string' && userId.length > 0 },
}, 20, 60 * 1000)

DDPRateLimiter.addRule({
  type: 'method',
  name: INSPECT_WEKAN_METHOD_NAME,
  userId(userId) { return typeof userId === 'string' && userId.length > 0 },
}, 5, 60 * 1000)

export {
  INSPECT_WEKAN_METHOD_NAME,
  inspectWekan,
  listTaskIntegrationSuggestions,
  METHOD_NAME,
}
