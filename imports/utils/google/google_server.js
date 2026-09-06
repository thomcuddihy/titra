import { fetch } from 'meteor/fetch'
import { Meteor } from 'meteor/meteor'
import { Mongo } from 'meteor/mongo'
import { OAuth } from 'meteor/oauth'
import { Random } from 'meteor/random'
import { ServiceConfiguration } from 'meteor/service-configuration'
import { DDPRateLimiter } from 'meteor/ddp-rate-limiter'
import {
  GoogleOAuthStateError,
  affectedExactlyOne,
  consumeGoogleOAuthState,
  issueGoogleOAuthState,
} from './googleOAuthState.js'
import { fetchOidcJson } from '../oidc/oidcSecurity.js'
import {
  GoogleOAuthSecurityError,
  normalizeGoogleAuthorizationCode,
  normalizeGoogleTokenResponse,
  sealGoogleServiceData,
} from './googleOAuthSecurity.js'
import { requireOAuthEncryptionConfigured } from '../oauthEncryptionPolicy.js'

const GoogleOAuthStates = new Mongo.Collection('googleOAuthStates')
let authorizationMethodRegistered = false

function stateDependencies() {
  return {
    findActiveUser: (userId) => Meteor.users.findOneAsync({
      _id: userId,
      inactive: { $ne: true },
    }, { fields: { _id: 1 } }),
    generateCredentialToken: () => Random.secret(),
    replaceBinding: ({ userId, ...binding }) => GoogleOAuthStates.rawCollection().updateOne(
      { _id: userId },
      { $set: { ...binding, userId } },
      { upsert: true },
    ),
    findBinding: ({ tokenHash, consumedAt }) => GoogleOAuthStates.findOneAsync({
      tokenHash,
      expiresAt: { $gt: consumedAt },
    }),
    removeBinding: ({ bindingId, tokenHash, consumedAt }) => (
      GoogleOAuthStates.rawCollection().deleteOne({
        _id: bindingId,
        tokenHash,
        expiresAt: { $gt: consumedAt },
      })
    ),
  }
}

function safeStateError(error) {
  const code = error instanceof GoogleOAuthStateError
    ? error.code : 'google-oauth-state-unavailable'
  return new Meteor.Error(code, 'Google authorization could not be completed.')
}

function registerAuthorizationMethod() {
  if (authorizationMethodRegistered) return
  authorizationMethodRegistered = true
  Meteor.methods({
    async 'googleapi.beginAuthorization'() {
      try {
        return await issueGoogleOAuthState(
          { userId: this.userId }, stateDependencies(),
        )
      } catch (error) {
        throw safeStateError(error)
      }
    },
  })
  DDPRateLimiter.addRule({
    type: 'method',
    name: 'googleapi.beginAuthorization',
    userId() { return true },
    connectionId() { return true },
  }, 5, 60 * 1000)
}

async function ensureStateIndexes() {
  await Promise.all([
    GoogleOAuthStates.rawCollection().createIndex(
      { tokenHash: 1 }, { unique: true, name: 'google_oauth_token_hash' },
    ),
    GoogleOAuthStates.rawCollection().createIndex(
      { expiresAt: 1 }, { expireAfterSeconds: 0, name: 'google_oauth_state_expiry' },
    ),
  ])
}

const registerGoogleAPI = async () => {
  // OAuth replay protection is not optional: establish its unique and expiry
  // indexes before exposing either the DDP method or OAuth service.
  await ensureStateIndexes()
  registerAuthorizationMethod()
  OAuth.registerService('googleapi', 2, null, async (query) => {
    let userId
    try {
      userId = await consumeGoogleOAuthState({
        credentialToken: OAuth._credentialTokenFromQuery(query),
      }, stateDependencies())
    } catch (error) {
      throw safeStateError(error)
    }
    const config = await ServiceConfiguration.configurations.findOneAsync({
      service: 'googleapi',
    })
    if (!config) throw new ServiceConfiguration.ConfigError()
    try {
      requireOAuthEncryptionConfigured()
      const content = new URLSearchParams({
        code: normalizeGoogleAuthorizationCode(query.code),
        client_id: config.clientId,
        client_secret: OAuth.openSecret(config.secret),
        redirect_uri: OAuth._redirectUri('googleapi', config),
        grant_type: 'authorization_code',
      })
      const response = await fetchOidcJson(fetch, 'https://accounts.google.com/o/oauth2/token', {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: content,
      })
      const tokens = normalizeGoogleTokenResponse(response)
      const serviceData = sealGoogleServiceData(tokens, userId, OAuth.sealSecret)
      const returnValue = { serviceData }
      const updateResult = await Meteor.users.updateAsync({
        _id: userId,
        inactive: { $ne: true },
      }, { $set: {
        'services.googleapi': returnValue,
        'profile.googleAPIexpiresAt': serviceData.expiresAt,
      } })
      if (!affectedExactlyOne(updateResult)) {
        throw new GoogleOAuthSecurityError('google-oauth-authentication-required')
      }
    } catch (error) {
      const code = error instanceof GoogleOAuthSecurityError
        ? error.code : 'google-oauth-token-exchange-failed'
      throw new Meteor.Error(code, 'Google authorization could not be completed.')
    }
    return { serviceData: {} }
  })
}
export default registerGoogleAPI
