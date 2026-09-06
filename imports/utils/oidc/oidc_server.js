/* eslint-disable i18next/no-literal-string */
import { fetch } from 'meteor/fetch'
import { Meteor } from 'meteor/meteor'
import { OAuth } from 'meteor/oauth'
import { ServiceConfiguration } from 'meteor/service-configuration'
import {
  fetchOidcJson,
  mergeOidcConfiguration,
  normalizeOidcConfiguration,
  normalizeOidcClientSecret,
  normalizeTokenResponse,
  normalizeUserinfo,
} from './oidcSecurity.js'

const SERVICE_NAME = 'oidc'
const AUTHENTICATION_ERROR_CODE = 'oidc-authentication-failed'
const AUTHENTICATION_ERROR_REASON = 'OpenID Connect authentication could not be completed.'

let userAgent = 'Meteor'
if (Meteor.release) userAgent += `/${Meteor.release}`

function safeAuthenticationError() {
  return new Meteor.Error(AUTHENTICATION_ERROR_CODE, AUTHENTICATION_ERROR_REASON)
}

async function getConfiguration() {
  const storedConfiguration = await ServiceConfiguration.configurations.findOneAsync({
    service: SERVICE_NAME,
  })
  if (!storedConfiguration) {
    throw new ServiceConfiguration.ConfigError('Service oidc not configured.')
  }
  const configuration = mergeOidcConfiguration({}, storedConfiguration)
  return normalizeOidcConfiguration(configuration, {
    environment: process.env,
    preservedSecret: storedConfiguration.secret,
  })
}

function validateAuthorizationCode(query) {
  if (
    !query
    || typeof query !== 'object'
    || typeof query.code !== 'string'
    || query.code.length === 0
    || query.code.length > 8192
    || /[\u0000-\u001f\u007f]/u.test(query.code)
  ) throw safeAuthenticationError()
  return query.code
}

async function getToken(query, configuration) {
  const response = await fetchOidcJson(fetch, configuration.tokenEndpoint, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'User-Agent': userAgent,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      code: validateAuthorizationCode(query),
      client_id: configuration.clientId,
      client_secret: normalizeOidcClientSecret(OAuth.openSecret(configuration.secret)),
      redirect_uri: OAuth._redirectUri(SERVICE_NAME, configuration),
      grant_type: 'authorization_code',
    }),
  })
  return normalizeTokenResponse(response)
}

async function getUserInfo(accessToken, configuration) {
  return fetchOidcJson(fetch, configuration.userinfoEndpoint, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      'User-Agent': userAgent,
      Authorization: `Bearer ${accessToken}`,
    },
  })
}

async function createLoginResult(query) {
  const configuration = await getConfiguration()
  const token = await getToken(query, configuration)
  const userinfo = await getUserInfo(token.accessToken, configuration)
  return normalizeUserinfo(userinfo, {
    accessToken: token.accessToken,
    refreshToken: token.refreshToken,
    expiresAt: token.expiresAt,
    claimWhitelist: configuration.idTokenWhitelistFields,
    sealSecret: (secret) => OAuth.sealSecret(secret),
  })
}

async function registerOidc() {
  Accounts.oauth.registerService(SERVICE_NAME)
  OAuth.registerService(SERVICE_NAME, 2, null, async (query) => {
    try {
      return await createLoginResult(query)
    } catch {
      throw safeAuthenticationError()
    }
  })
}

export { registerOidc }
