import { OAuth } from 'meteor/oauth'
import { Random } from 'meteor/random'
import { ServiceConfiguration } from 'meteor/service-configuration'
import { normalizeOidcClientConfiguration } from './oidcSecurity.js'

const SERVICE_NAME = 'oidc'
const oidcReady = new ReactiveVar(false)
function registerOidc() {
  Accounts.oauth.registerService(SERVICE_NAME)

  Meteor.loginWithOidc = (callback) => {
    const options = {}
    const completeCallback = Accounts.oauth.credentialRequestCompleteHandler((...args) => {
      if (callback) callback(...args)
    })

    const storedConfig = ServiceConfiguration.configurations.findOne({ service: SERVICE_NAME })
    if (!storedConfig) {
      if (completeCallback) {
        completeCallback(
          new ServiceConfiguration.ConfigError('Service oidc not configured.'),
        )
      }
      return
    }

    let config
    try {
      config = normalizeOidcClientConfiguration(storedConfig, {
        environment: typeof process === 'undefined' ? {} : process.env,
      })
    } catch {
      if (completeCallback) {
        completeCallback(new ServiceConfiguration.ConfigError('Service oidc not configured.'))
      }
      return
    }

    const credentialToken = Random.secret()
    const mobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|Windows Phone/i.test(navigator.userAgent)
    const display = mobile ? 'touch' : 'popup'
    const loginStyle = OAuth._loginStyle(SERVICE_NAME, config, options)

    // options
    options.client_id = config.clientId
    options.response_type = 'code'
    options.redirect_uri = OAuth._redirectUri(SERVICE_NAME, config)
//    options.redirectUrl = '/'
    options.state = OAuth._stateParam(loginStyle, credentialToken, options.redirectUrl)
    options.scope = config.requestPermissions.join(' ')

    if (config.loginStyle) {
      options.display = display
    }

    const loginUrl = new URL(config.authorizationEndpoint)
    Object.entries(options).forEach(([key, value]) => loginUrl.searchParams.set(key, value))

    options.popupOptions = options.popupOptions || {}
    const popupOptions = {
      width: options.popupOptions.width || 320,
      height: options.popupOptions.height || 450,
    }

    OAuth.launchLogin({
      loginService: SERVICE_NAME,
      loginStyle,
      loginUrl: loginUrl.toString(),
      credentialRequestCompleteCallback: completeCallback,
      credentialToken,
      popupOptions,
    })
  }
  oidcReady.set(true)
}
export { registerOidc, oidcReady }
