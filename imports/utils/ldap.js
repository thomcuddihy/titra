import { Accounts } from 'meteor/accounts-base'
import { SHA256 } from 'meteor/sha'
import { getGlobalSettingAsync } from './server_method_helpers'
import { debugLog } from './debugLog'
import {
  assertBoundedLdapString,
  assertLdapAttributeDescription,
  assertLdapUsername,
  escapeLdapFilterValue,
  escapeLdapFilterTemplateValue,
  escapeLdapHexFilterValue,
  escapeLdapRdnValue,
  interpolateEscapedLdapUsername,
  ldapScalarToString,
  parseLdapAttributeList,
} from './ldapSecurity'

export class LDAP {
  constructor() {
    this.LdapClient = null // Will be imported dynamically
    this.connected = false
    this.options = {
      host: this.constructor.getSettings('LDAP_HOST'),
      port: this.constructor.getSettings('LDAP_PORT'),
      Reconnect: this.constructor.getSettings('LDAP_RECONNECT'),
      timeout: this.constructor.getSettings('LDAP_TIMEOUT') || 10000,
      connect_timeout: this.constructor.getSettings('LDAP_CONNECT_TIMEOUT') || 10000,
      idle_timeout: this.constructor.getSettings('LDAP_IDLE_TIMEOUT'),
      encryption: this.constructor.getSettings('LDAP_ENCRYPTION'),
      ca_cert: this.constructor.getSettings('LDAP_CA_CERT'),
      reject_unauthorized: this.constructor.getSettings('LDAP_REJECT_UNAUTHORIZED') !== undefined ? this.constructor.getSettings('LDAP_REJECT_UNAUTHORIZED') : true,
      Authentication_UserDN: this.constructor.getSettings('LDAP_AUTHENTICATION_USERDN') || this.constructor.getSettings('LDAP_BASEDN'),
      Authentication_Password: this.constructor.getSettings('LDAP_AUTHENTICATION_PASSWORD'),
      Authentication_Fallback: this.constructor.getSettings('LDAP_LOGIN_FALLBACK'),
      BaseDN: this.constructor.getSettings('LDAP_BASEDN'),
      User_Authentication: this.constructor.getSettings('LDAP_USER_AUTHENTICATION') || this.constructor.getSettings('LDAP_USERNAME_FIELD') || 'uid',
      User_Authentication_Field: this.constructor.getSettings('LDAP_USER_AUTHENTICATION_FIELD') || 'uid',
      User_Attributes: this.constructor.getSettings('LDAP_USER_ATTRIBUTES'),
      User_Search_Filter: this.constructor.getSettings('LDAP_USER_SEARCH_FILTER'),
      User_Search_Scope: this.constructor.getSettings('LDAP_USER_SEARCH_SCOPE'),
      User_Search_Field: this.constructor.getSettings('LDAP_USER_SEARCH_FIELD') || this.constructor.getSettings('LDAP_USERNAME_FIELD') || 'uid',
      Search_Page_Size: this.constructor.getSettings('LDAP_SEARCH_PAGE_SIZE'),
      Search_Size_Limit: this.constructor.getSettings('LDAP_SEARCH_SIZE_LIMIT'),
      group_filter_enabled: this.constructor.getSettings('LDAP_GROUP_FILTER_ENABLE'),
      group_filter_object_class: this.constructor.getSettings('LDAP_GROUP_FILTER_OBJECTCLASS'),
      group_filter_group_id_attribute: this.constructor.getSettings('LDAP_GROUP_FILTER_GROUP_ID_ATTRIBUTE'),
      group_filter_group_member_attribute: this.constructor.getSettings('LDAP_GROUP_FILTER_GROUP_MEMBER_ATTRIBUTE'),
      group_filter_group_member_format: this.constructor.getSettings('LDAP_GROUP_FILTER_GROUP_MEMBER_FORMAT'),
      group_filter_group_name: this.constructor.getSettings('LDAP_GROUP_FILTER_GROUP_NAME'),
      UsernameField: LDAP.getSettings('LDAP_USERNAME_FIELD') || 'uid',
    }
  }

  static getSettings(name, ...args) {
    let value = process.env[name]
    if (value !== undefined) {
      if (value === 'true' || value === 'false') {
        value = JSON.parse(value)
      } else if (value !== '' && !isNaN(value)) {
        value = Number(value)
      }
      return value
    }
    debugLog(`Lookup for unset variable: ${name}`)
    return undefined
  }

  // connectSync(...args) {
  //   if (!this._connectSync) {
  //     this._connectSync = Meteor.wrapAsync(this.connectAsync, this)
  //   }
  //   return this._connectSync(...args)
  // }

  // searchAllSync(...args) {
  //   if (!this._searchAllSync) {
  //     this._searchAllSync = await this.searchAllAsync
  //   }
  //   return this._searchAllSync(...args)
  // }

  async connectAsync() {
    debugLog('Init setup')

    // Import the new client dynamically
    if (!this.LdapClient) {
      const { default: LdapClient } = await import('ldapjs-client')
      this.LdapClient = LdapClient
    }

    const connectionOptions = {
      url: `${this.options.host}:${this.options.port}`,
      timeout: this.options.timeout,
      connectTimeout: this.options.connect_timeout,
      idleTimeout: this.options.idle_timeout,
      reconnect: this.options.Reconnect,
    }

    const tlsOptions = {
      rejectUnauthorized: this.options.reject_unauthorized,
    }

    if (this.options.ca_cert && this.options.ca_cert !== '') {
      // Split CA cert into array of strings
      const chainLines = this.constructor.getSettings('LDAP_CA_CERT').replace(/\\n/g, '\n').split('\n')
      let cert = []
      const ca = []
      chainLines.forEach((line) => {
        cert.push(line)
        if (line.match(/-END CERTIFICATE-/)) {
          ca.push(cert?.join('\n'))
          cert = []
        }
      })
      tlsOptions.ca = ca
    }

    if (this.options.encryption === 'ssl') {
      connectionOptions.url = `ldaps://${connectionOptions.url}`
      connectionOptions.tlsOptions = tlsOptions
    } else {
      connectionOptions.url = `ldap://${connectionOptions.url}`
    }

    debugLog('Initializing LDAP connection')

    // Create client using new library - no createClient method, use constructor directly
    this.client = new this.LdapClient(connectionOptions)

    // The new library's bind method returns a Promise, so we simplify bindAsync
    this.bindAsync = async (dn, password) => {
      await this.client.bind(dn, password)
      return true
    }

    try {
      // The new library auto-connects when needed, no explicit connect required
      // Just test the connection by attempting to bind if we have credentials
      this.connected = true
      debugLog('LDAP client initialized')
      return true
    } catch (error) {
      debugLog('LDAP connection failed')
      throw error
    }
  }

  getUserFilter(username) {
    const escapedUsername = escapeLdapFilterValue(assertLdapUsername(username))
    const filter = []

    if (this.options.User_Search_Filter !== '' && this.options.User_Search_Filter !== undefined) {
      if (this.options.User_Search_Filter[0] === '(') {
        filter.push(`${this.options.User_Search_Filter}`)
      } else {
        filter.push(`(${this.options.User_Search_Filter})`)
      }
    }
    const searchFields = parseLdapAttributeList(
      this.options.User_Search_Field || this.options.UsernameField,
    )
    const usernameFilter = searchFields.map((item) => `(${item}=${escapedUsername})`)
    if (usernameFilter === undefined || usernameFilter?.length === 0) {
      debugLog('LDAP_User_Search_Field not defined')
    } else if (usernameFilter?.length === 1) {
      filter.push(`${usernameFilter[0]}`)
    } else {
      filter.push(`(|${usernameFilter?.join('')})`)
    }
    return filter?.length > 0 ? `(&${filter?.join('')})` : ''
  }

  async bindUserIfNecessary(username, password) {
    if (this.domainBinded === true) {
      return
    }

    if (!this.options.User_Authentication) {
      return
    }

    if (!this.options.BaseDN) throw new Error('BaseDN is not provided')

    const authenticationField = assertLdapAttributeDescription(this.options.User_Authentication_Field)
    const escapedUsername = escapeLdapRdnValue(assertLdapUsername(username))
    const userDn = `${authenticationField}=${escapedUsername},${this.options.BaseDN}`

    await this.bindAsync(userDn, password)
    this.domainBinded = true
  }

  async bindIfNecessary() {
    if (this.domainBinded === true) {
      return
    }
    debugLog('Binding configured LDAP service account')

    await this.bindAsync(this.options.Authentication_UserDN, this.options.Authentication_Password)
    this.domainBinded = true
  }

  async searchUsersAsync(username, page) {
    assertLdapUsername(username)
    await this.bindIfNecessary()
    const filter = this.getUserFilter(username)
    const sizeLimit = this.options.Search_Size_Limit
    const searchOptions = {
      scope: this.options.User_Search_Scope || 'sub',
    }
    if (filter && filter !== '') {
      searchOptions.filter = filter
    }
    if (sizeLimit && sizeLimit !== '') {
      searchOptions.sizeLimit = sizeLimit
    }
    if (this.options.User_Attributes) searchOptions.attributes = this.options.User_Attributes.split(',')

    if (this.options.Search_Page_Size > 0) {
      searchOptions.paged = {
        pageSize: this.options.Search_Page_Size,
        pagePause: !!page,
      }
    }

    debugLog('Searching LDAP user directory')

    if (page) {
      return this.searchAllPaged(this.options.BaseDN, searchOptions, page)
    }

    return this.searchAllAsync(this.options.BaseDN, searchOptions)
  }

  async getUserByIdAsync(id, attribute) {
    await this.bindIfNecessary()

    const Unique_Identifier_Field = parseLdapAttributeList(
      this.constructor.getSettings('LDAP_UNIQUE_IDENTIFIER_FIELD'),
    )
    const escapedIdValue = escapeLdapHexFilterValue(id)

    let filter

    if (attribute) {
      filter = `(${assertLdapAttributeDescription(attribute)}=${escapedIdValue})`
    } else {
      const filterParts = []
      Unique_Identifier_Field.forEach((item) => {
        filterParts.push(`(${item}=${escapedIdValue})`)
      })

      // Create OR filter for multiple fields
      filter = filterParts.length > 1 ? `(|${filterParts.join('')})` : filterParts[0]
    }

    const searchOptions = {
      filter,
      scope: 'sub',
    }

    debugLog('Searching LDAP directory by identifier')

    const result = await this.searchAllAsync(this.options.BaseDN, searchOptions)

    if (!Array.isArray(result) || result.length === 0) {
      return
    }

    if (result?.length > 1) {
      debugLog('LDAP identifier search returned multiple records')
    }
    return result[0]
  }

  async getUserByUsernameSync(username) {
    assertLdapUsername(username)
    await this.bindIfNecessary()

    const searchOptions = {
      filter: this.getUserFilter(username),
      scope: this.options.User_Search_Scope || 'sub',
    }

    debugLog('Searching LDAP directory by username')

    const result = await this.searchAllAsync(this.options.BaseDN, searchOptions)
    if (!Array.isArray(result) || result?.length === 0) {
      return
    }

    if (result?.length > 1) {
      debugLog('LDAP username search returned multiple records')
    }
    return result[0]
  }

  async getUserGroups(username, ldapUser) {
    if (!this.options.group_filter_enabled) {
      return true
    }

    assertLdapUsername(username)
    const filter = ['(&']

    if (this.options.group_filter_object_class !== '') {
      filter.push(`(objectclass=${interpolateEscapedLdapUsername(
        this.options.group_filter_object_class,
        username,
      )})`)
    }

    if (this.options.group_filter_group_member_attribute !== '') {
      const memberAttribute = assertLdapAttributeDescription(
        this.options.group_filter_group_member_attribute,
      )
      const memberFormat = assertLdapAttributeDescription(
        this.options.group_filter_group_member_format,
      )
      const format_value = ldapUser[memberFormat]
      if (format_value) {
        filter.push(`(${memberAttribute}=${escapeLdapFilterTemplateValue(
          format_value,
          username,
        )})`)
      }
    }

    filter.push(')')

    const searchOptions = {
      filter: filter?.join(''),
      scope: 'sub',
    }

    debugLog('Searching LDAP group directory')

    const result = await this.searchAllAsync(this.options.BaseDN, searchOptions)

    if (!Array.isArray(result) || result?.length === 0) {
      return []
    }

    const grp_identifier = assertLdapAttributeDescription(
      this.options.group_filter_group_id_attribute || 'cn',
    )
    const groups = []
    result.map((item) => {
      groups.push(item[grp_identifier])
    })
    return groups
  }

  async isUserInGroup(username, ldapUser) {
    if (!this.options.group_filter_enabled) {
      return true
    }

    assertLdapUsername(username)
    await this.getUserGroups(username, ldapUser)

    const filter = ['(&']

    if (this.options.group_filter_object_class !== '') {
      filter.push(`(objectclass=${interpolateEscapedLdapUsername(
        this.options.group_filter_object_class,
        username,
      )})`)
    }

    if (this.options.group_filter_group_member_attribute !== '') {
      const memberAttribute = assertLdapAttributeDescription(
        this.options.group_filter_group_member_attribute,
      )
      const memberFormat = assertLdapAttributeDescription(
        this.options.group_filter_group_member_format,
      )
      const format_value = ldapUser[memberFormat]
      if (format_value) {
        filter.push(`(${memberAttribute}=${escapeLdapFilterTemplateValue(
          format_value,
          username,
        )})`)
      }
    }

    if (this.options.group_filter_group_id_attribute !== '') {
      const groupIdAttribute = assertLdapAttributeDescription(
        this.options.group_filter_group_id_attribute,
      )
      filter.push(`(${groupIdAttribute}=${interpolateEscapedLdapUsername(
        this.options.group_filter_group_name,
        username,
      )})`)
    }
    filter.push(')')

    const searchOptions = {
      filter: filter?.join(''),
      scope: 'sub',
    }

    debugLog('Checking LDAP group membership')

    const result = await this.searchAllAsync(this.options.BaseDN, searchOptions)

    if (!Array.isArray(result) || result?.length === 0) {
      return false
    }
    return true
  }

  extractLdapEntryData(entry) {
    try {
      const returnValues = {}

      // Handle both old ldapjs format and new ldapjs-client format
      if (entry.attributes && Array.isArray(entry.attributes)) {
        // Old format from ldapjs
        entry.attributes.forEach((attribute) => {
          const { type, values } = attribute
          returnValues[type] = values
        })
        returnValues.dn = entry.objectName || entry.dn
      } else if (entry.dn) {
        // New format from ldapjs-client - entry is likely {dn: string, ...attributes}
        returnValues.dn = entry.dn
        // Copy all other properties as attributes
        Object.keys(entry).forEach((key) => {
          if (key !== 'dn') {
            returnValues[key] = entry[key]
          }
        })
      } else {
        // Fallback - entry might be a plain object with attributes
        Object.assign(returnValues, entry)
      }

      return returnValues
    } catch {
      debugLog('Unable to normalize an LDAP directory entry')
      return undefined
    }
  }

  async searchAllPaged(BaseDN, options, page) {
    await this.bindIfNecessary()

    try {
      // For now, use regular search and simulate paging
      // The new library may handle paging differently or might not support it in the same way
      const searchResult = await this.client.search(BaseDN, options)
      const entries = []

      if (searchResult && Array.isArray(searchResult)) {
        for (const entry of searchResult) {
          const extractedData = this.extractLdapEntryData(entry)
          if (extractedData) {
            entries.push(extractedData)
          }
        }
      }

      // Simulate the page callback pattern from the old library
      const processPage = ({
        entries, title, end, next,
      }) => {
        debugLog(title)
        page(null, entries, {
          end,
          next: next || (() => {}),
        })
      }

      // For now, just return all results as one page
      processPage({
        entries,
        title: 'Complete Results',
        end: true,
      })
    } catch (error) {
      debugLog('LDAP paged search failed')
      page(error)
    }
  }

  async searchAllAsync(BaseDN, options) {
    await this.bindIfNecessary()
    try {
      const searchResult = await this.client.search(BaseDN, options)
      const entries = []

      if (searchResult && Array.isArray(searchResult)) {
        // ldapjs-client returns an array of entries directly
        for (const entry of searchResult) {
          const extractedData = this.extractLdapEntryData(entry)
          if (extractedData) {
            entries.push(extractedData)
          }
        }
      }

      debugLog('Search result count', entries.length)
      return entries
    } catch (error) {
      debugLog('LDAP search failed')
      throw error
    }
  }

  async authAsync(dn, password) {
    debugLog('Authenticating LDAP user')

    try {
      if (typeof password !== 'string' || password === '' || password.length > 16384) {
        throw new Error('Password is not provided')
      }
      await this.bindAsync(dn, password)
      debugLog('LDAP user authenticated')
      return true
    } catch {
      debugLog('LDAP user authentication failed')
      return false
    }
  }

  disconnect() {
    this.connected = false
    this.domainBinded = false
    debugLog('Disconnecting')
    if (this.client) {
      this.client.unbind()
    }
  }
}

function getLdapUsername(ldapUser) {
  const usernameField = LDAP.getSettings('LDAP_USERNAME_FIELD') || 'uid'
  let value

  if (usernameField.indexOf('#{') > -1) {
    value = usernameField.replace(/#{(.+?)}/g, (match, field) => {
      const v = ldapUser[field]
      return Array.isArray(v) ? v[0] : v
    })
  } else {
    value = ldapUser[assertLdapAttributeDescription(usernameField)]
  }

  return assertLdapUsername(ldapScalarToString(value, {
    label: 'LDAP username attribute',
    maxLength: 1024,
  }))
}

function getLdapEmail(ldapUser) {
  const emailField = LDAP.getSettings('LDAP_EMAIL_FIELD') || 'mail'
  let value

  if (emailField?.indexOf('#{') > -1) {
    value = emailField.replace(/#{(.+?)}/g, (match, field) => {
      const v = ldapUser[field]
      return Array.isArray(v) ? v[0] : v
    })
  } else {
    const v = ldapUser[assertLdapAttributeDescription(emailField)]
    value = Array.isArray(v) ? v[0] : v
  }

  if (value === undefined || value === null || value === '') return undefined
  return ldapScalarToString(value, {
    label: 'LDAP email attribute',
    maxLength: 1024,
  })
}

function getLdapFullname(ldapUser) {
  const fullnameField = LDAP.getSettings('LDAP_FULLNAME_FIELD') || 'cn'
  let value

  if (fullnameField.indexOf('#{') > -1) {
    value = fullnameField.replace(/#{(.+?)}/g, (match, field) => {
      const v = ldapUser[field]
      return Array.isArray(v) ? v[0] : v
    })
  } else {
    value = ldapUser[assertLdapAttributeDescription(fullnameField)]
  }

  if (value === undefined || value === null || value === '') return undefined
  return ldapScalarToString(value, {
    label: 'LDAP full name attribute',
    maxLength: 4096,
  })
}

function getLdapUserUniqueID(ldapUser) {
  let Unique_Identifier_Field = LDAP.getSettings('LDAP_UNIQUE_IDENTIFIER_FIELD') || LDAP.getSettings('LDAP_USERNAME_FIELD') || 'uid'

  if (Unique_Identifier_Field !== '' && Unique_Identifier_Field !== undefined) {
    Unique_Identifier_Field = parseLdapAttributeList(Unique_Identifier_Field)
  } else {
    Unique_Identifier_Field = []
  }

  let User_Search_Field = LDAP.getSettings('LDAP_USER_SEARCH_FIELD')

  if (User_Search_Field !== '' && User_Search_Field !== undefined) {
    User_Search_Field = parseLdapAttributeList(User_Search_Field)
  } else {
    User_Search_Field = []
  }

  Unique_Identifier_Field = Unique_Identifier_Field.concat(User_Search_Field)

  if (Unique_Identifier_Field?.length > 0) {
    Unique_Identifier_Field = Unique_Identifier_Field
      .find((field) => !isEmpty(ldapUser[field]))
    if (Unique_Identifier_Field) {
      debugLog('LDAP unique identifier attribute selected')
      let identifier = ldapUser[Unique_Identifier_Field]
      if (Array.isArray(identifier) && identifier.length === 1) identifier = identifier[0]
      const identifierValue = Buffer.isBuffer(identifier)
        ? identifier.toString('hex')
        : ldapScalarToString(identifier, {
          label: 'LDAP unique identifier',
          maxLength: 8192,
        })
      Unique_Identifier_Field = {
        attribute: assertLdapAttributeDescription(Unique_Identifier_Field),
        value: assertBoundedLdapString(identifierValue, {
          label: 'LDAP unique identifier',
          maxLength: 8192,
        }),
      }
    }
    return Unique_Identifier_Field
  }
}

function fallbackDefaultAccountSystem(bind, username, password) {
  if (typeof username === 'string') {
    if (username.indexOf('@') === -1) {
      username = { username }
    } else {
      username = { email: username }
    }
  }

  const loginRequest = {
    user: username,
    password: {
      digest: SHA256(password),
      algorithm: 'sha-256',
    },
  }
  return Accounts._runLoginHandlers(bind, loginRequest)
}

function withGenericLdapAuthenticationError(handler) {
  return async function wrappedLdapLoginHandler(loginRequest) {
    try {
      return await handler.call(this, loginRequest)
    } catch {
      debugLog('LDAP login failed')
      throw new Meteor.Error('LDAP-login-error', 'LDAP authentication failed')
    }
  }
}

getGlobalSettingAsync('enableLDAP').then((ldapEnabled) => {
  if (ldapEnabled) {
    Accounts.registerLoginHandler('ldap', withGenericLdapAuthenticationError(async function (loginRequest) {
      if (!loginRequest || !loginRequest.ldap || !loginRequest.ldapOptions) {
        return undefined
      }

      debugLog('Starting LDAP login')

      let loginUsername
      let loginPassword
      try {
        loginUsername = assertLdapUsername(loginRequest.username)
        loginPassword = assertBoundedLdapString(loginRequest.ldapPass, {
          label: 'LDAP password',
          maxLength: 16384,
        })
      } catch {
        debugLog('Rejected malformed LDAP login request')
        throw new Meteor.Error('LDAP-login-error', 'LDAP authentication failed')
      }

      const self = this
      const ldap = new LDAP()
      let ldapUser

      try {
        await ldap.connectAsync()
        const user_authentication = LDAP.getSettings('LDAP_USER_AUTHENTICATION') || LDAP.getSettings('LDAP_USERNAME_FIELD') || 'uid'
        if (user_authentication && user_authentication !== 'none') {
          await ldap.bindUserIfNecessary(loginUsername, loginPassword)
          const tempLdapUser = await ldap.searchUsersAsync(loginUsername)
          ldapUser = tempLdapUser[0]
        } else {
          const users = await ldap.searchUsersAsync(loginUsername)
          if (users?.length !== 1) {
            debugLog('LDAP login search did not return exactly one record')
            throw new Error('User not Found')
          }

          if (await ldap.isUserInGroup(loginUsername, users[0])) {
            ldapUser = users[0]
          } else {
            throw new Error('User not in a valid group')
          }
          const userDn = assertBoundedLdapString(ldapUser.dn, {
            label: 'LDAP user DN',
            maxLength: 8192,
          })
          if (await ldap.authAsync(userDn, loginPassword) !== true) {
            ldapUser = null
            debugLog('LDAP password verification failed')
          }
        }
      } catch {
        debugLog('LDAP authentication lookup failed')
      }

      if (!ldapUser) {
        if (LDAP.getSettings('LDAP_LOGIN_FALLBACK') === true) {
          return fallbackDefaultAccountSystem(self, loginUsername, loginPassword)
        }

        throw new Meteor.Error('LDAP-login-error', 'LDAP authentication failed')
      }

      // Look to see if user already exists

      let userQuery

      const Unique_Identifier_Field = getLdapUserUniqueID(ldapUser)
      let user
      // Attempt to find user by unique identifier

      if (Unique_Identifier_Field) {
        userQuery = {
          'services.ldap.id': Unique_Identifier_Field.value,
        }

        debugLog('Looking up local account by LDAP identifier')

        user = await Meteor.users.findOneAsync(userQuery)
      }

      // Attempt to find user by username

      let username
      let email

      if (LDAP.getSettings('LDAP_USERNAME_FIELD') !== '') {
        username = getLdapUsername(ldapUser)
      } else {
        username = loginUsername
      }

      if (LDAP.getSettings('LDAP_EMAIL_FIELD') !== '') {
        email = getLdapEmail(ldapUser)
      }

      if (!user) {
        if (email && LDAP.getSettings('LDAP_EMAIL_MATCH_REQUIRE') === true) {
          if (LDAP.getSettings('LDAP_EMAIL_MATCH_VERIFIED') === true) {
            userQuery = {
              _id: username,
              'emails.0.address': email,
              'emails.0.verified': true,
            }
          } else {
            userQuery = {
              _id: username,
              'emails.0.address': email,
            }
          }
        } else {
          userQuery = {
            username,
          }
        }

        user = await Meteor.users.findOneAsync(userQuery)
      }

      // Attempt to find user by e-mail address only

      if (!user && email && LDAP.getSettings('LDAP_EMAIL_MATCH_ENABLE') === true) {
        debugLog('Looking up local account by LDAP email')

        if (LDAP.getSettings('LDAP_EMAIL_MATCH_VERIFIED') === true) {
          userQuery = {
            'emails.0.address': email,
            'emails.0.verified': true,
          }
        } else {
          userQuery = {
            'emails.0.address': email,
          }
        }

        user = await Meteor.users.findOneAsync(userQuery)
      }

      // Login user if they exist
      if (user) {
        if (user.authenticationMethod !== 'ldap' && LDAP.getSettings('LDAP_MERGE_EXISTING_USERS') !== true) {
          debugLog('User exists without "authenticationMethod : ldap"')
          throw new Meteor.Error('LDAP-login-error', 'LDAP authentication failed')
        }

        debugLog('Logging user')

        const stampedToken = Accounts._generateStampedLoginToken()
        const update_data = {
          $push: {
            'services.resume.loginTokens': Accounts._hashStampedToken(stampedToken),
          },
        }

        if (LDAP.getSettings('LDAP_SYNC_ADMIN_STATUS') === true) {
          debugLog('Updating admin status')
          const targetGroups = LDAP.getSettings('LDAP_SYNC_ADMIN_GROUPS').split(',')
          const groups = (await ldap.getUserGroups(username, ldapUser))
            .filter((value) => targetGroups.includes(value))

          user.isAdmin = groups?.length > 0
          await Meteor.users.updateAsync({ _id: user._id }, { $set: { isAdmin: user.isAdmin } })
        }

        await Meteor.users.updateAsync(user._id, update_data)

        syncUserData(user, ldapUser)

        if (LDAP.getSettings('LDAP_LOGIN_FALLBACK') === true) {
          await Accounts.setPasswordAsync(user._id, loginPassword, { logout: false })
        }

        return {
          userId: user._id,
          token: stampedToken.token,
        }
      }

      // Create new user

      debugLog('Creating local account for authenticated LDAP user')

      if (LDAP.getSettings('LDAP_USERNAME_FIELD') === '') {
        username = undefined
      }

      const fallbackPassword = LDAP.getSettings('LDAP_LOGIN_FALLBACK') === true
        ? loginPassword
        : undefined
      const result = await addLdapUser(ldapUser, username, fallbackPassword)

      if (result instanceof Error) {
        throw result
      }

      if (LDAP.getSettings('LDAP_SYNC_ADMIN_STATUS') === true) {
        debugLog('Updating admin status')
        const targetGroups = LDAP.getSettings('LDAP_SYNC_ADMIN_GROUPS').split(',')
        const groups = (await ldap.getUserGroups(username || loginUsername, ldapUser))
          .filter((value) => targetGroups.includes(value))

        result.isAdmin = groups?.length > 0
        await Meteor.users.updateAsync({ _id: result.userId }, { $set: { isAdmin: result.isAdmin } })
      }
      return result
    }))
  }
})
// Object.defineProperty(Object.prototype, 'getLDAPValue', {
//   value(prop) {
//     if (!prop) {
//       return
//     }
//     const self = this
//     for (const key in self) {
//       if (key.toLowerCase() == prop.toLowerCase()) {
//         return self[key]
//       }
//     }
//   },
//   enumerable: false,
// })

const isEmpty = (obj) => [Object, Array]
  .includes((obj || {}).constructor) && !Object.entries((obj || {})).length

function templateVarHandler(variable, object) {
  const templateRegex = /#{([\w\-]+)}/gi
  let match = templateRegex.exec(variable)
  let tmpVariable = variable

  if (match == null) {
    if (!object.hasOwnProperty(variable)) {
      return
    }
    return object[variable]
  }
  while (match != null) {
    const tmplVar = match[0]
    const tmplAttrName = match[1]

    if (!object.hasOwnProperty(tmplAttrName)) {
      return
    }

    const attrVal = object[tmplAttrName]
    tmpVariable = tmpVariable.replace(tmplVar, attrVal)
    match = templateRegex.exec(variable)
  }
  return tmpVariable
}

function getPropertyValue(obj, key) {
  try {
    return key.split('.').reduce((acc, el) => acc[el], obj)
  } catch (err) {
    return undefined
  }
}

function getDataToSyncUserData(ldapUser, user) {
  const syncUserData = LDAP.getSettings('LDAP_SYNC_USER_DATA')
  const syncUserDataFieldMap = LDAP.getSettings('LDAP_SYNC_USER_DATA_FIELDMAP')?.trim()

  const userData = {}

  if (syncUserData && syncUserDataFieldMap) {
    const whitelistedUserFields = ['email', 'name', 'customFields']
    const fieldMap = JSON.parse(syncUserDataFieldMap)
    const emailList = []
    fieldMap.map((userField, ldapField) => {
      debugLog(`Mapping field ${ldapField} -> ${userField}`)
      switch (userField) {
        case 'email':
          if (!ldapUser.hasOwnProperty(ldapField)) {
            debugLog(`user does not have attribute: ${ldapField}`)
            return
          }

          if (ldapUser[ldapField] === Object(ldapUser[ldapField])) {
            ldapUser[ldapField].map((item) => {
              emailList.push({ address: item, verified: true })
            })
          } else {
            emailList.push({ address: ldapUser[ldapField], verified: true })
          }
          break

        default:
          const [outerKey, innerKeys] = userField.split(/\.(.+)/)

          if (!whitelistedUserFields.find((el) => el === outerKey)) {
            debugLog(`user attribute not whitelisted: ${userField}`)
            return
          }

          if (outerKey === 'customFields') {
            let customFieldsMeta

            try {
              customFieldsMeta = JSON.parse(LDAP.getSettings('Accounts_CustomFields'))
            } catch (e) {
              debugLog('Invalid JSON for Custom Fields')
              return
            }

            if (!getPropertyValue(customFieldsMeta, innerKeys)) {
              debugLog(`user attribute does not exist: ${userField}`)
              return
            }
          }
          const tmpUserField = getPropertyValue(user, userField)
          const tmpLdapField = templateVarHandler(ldapField, ldapUser)

          if (tmpLdapField && tmpUserField !== tmpLdapField) {
          // creates the object structure instead of just assigning 'tmpLdapField' to
          // 'userData[userField]' in order to avoid the "cannot use the part (...)
          // to traverse the element" (MongoDB) error that can happen. Do not handle
          // arrays.
          // TODO: Find a better solution.
            const dKeys = userField.split('.')
            const lastKey = dKeys[dKeys.length - 1]
            dKeys.reduce(
              (obj, currKey) => ((currKey === lastKey)
                ? obj[currKey] = tmpLdapField
                : obj[currKey] = obj[currKey] || {}),
              userData,
            )
            debugLog(`Mapped LDAP data to user.${userField}`)
          }
      }
    })

    if (emailList?.length > 0) {
      if (JSON.stringify(user.emails) !== JSON.stringify(emailList)) {
        userData.emails = emailList
      }
    }
  }

  const uniqueId = getLdapUserUniqueID(ldapUser)

  if (uniqueId
    && (!user.services
      || !user.services.ldap
      || user.services.ldap.id !== uniqueId.value
      || user.services.ldap.idAttribute !== uniqueId.attribute)) {
    userData['services.ldap.id'] = uniqueId.value
    userData['services.ldap.idAttribute'] = uniqueId.attribute
  }

  if (user.authenticationMethod !== 'ldap') {
    userData.ldap = true
  }

  if (Object.keys(userData).length) {
    return userData
  }
}

async function syncUserData(user, ldapUser) {
  debugLog('Syncing user data')

  if (LDAP.getSettings('LDAP_USERNAME_FIELD') !== '') {
    const username = getLdapUsername(ldapUser)
    if (user && user._id && username !== user.username) {
      debugLog('Syncing LDAP username')
      await Meteor.users.findOneAsync({ _id: user._id }, { $set: { username } })
    }
  }

  if (LDAP.getSettings('LDAP_FULLNAME_FIELD') !== '') {
    const fullname = getLdapFullname(ldapUser)
    if (user && user._id && fullname !== '') {
      debugLog('Syncing LDAP full name')
      await Meteor.users.updateAsync({ _id: user._id }, { $set: { 'profile.fullname': fullname } })
    }
  }

  if (LDAP.getSettings('LDAP_EMAIL_FIELD') !== '') {
    const email = getLdapEmail(ldapUser)
    if (user && user._id && email !== '') {
      debugLog('Syncing LDAP email')
      await Meteor.users.updateAsync({
        _id: user._id,
      }, {
        $set: {
          'emails.0.address': email,
        },
      })
    }
  }
}

async function addLdapUser(ldapUser, username, password) {
  const uniqueId = getLdapUserUniqueID(ldapUser)

  const userObject = {
  }

  if (username) {
    userObject.username = username
  }

  const userData = getDataToSyncUserData(ldapUser, {})

  if (userData && userData.emails && userData.emails[0] && userData.emails[0].address) {
    if (Array.isArray(userData.emails[0].address)) {
      userObject.email = userData.emails[0].address[0]
    } else {
      userObject.email = userData.emails[0].address
    }
  } else if (ldapUser.mail && ldapUser.mail.indexOf('@') > -1) {
    userObject.email = ldapUser.mail
  } else if (LDAP.getSettings('LDAP_DEFAULT_DOMAIN') !== '') {
    userObject.email = `${username || uniqueId.value}@${LDAP.getSettings('LDAP_DEFAULT_DOMAIN')}`
  } else {
    const error = new Meteor.Error('LDAP-login-error', 'LDAP authentication failed')
    debugLog('Authenticated LDAP user does not have a usable email address')
    throw error
  }
  // handle special case for titra to sync profile.name
  // and initial project description as this is a mandatory field for us
  if (getLdapFullname(ldapUser)) {
    userObject.profile = {}
    userObject.profile.name = getLdapFullname(ldapUser)
    userObject.profile.currentLanguageProject = 'Project'
    userObject.profile.currentLanguageProjectDesc = { ops: [{ insert: 'This project has been automatically created for you, feel free to change it! Did you know that you can use emojis like 💰 ⏱ 👍 everywhere?' }] }
  }
  if (password) {
    userObject.password = password
  }

  try {
    // This creates the account with password service
    userObject.ldap = true
    userObject._id = await Accounts.createUserAsync(userObject)
    debugLog('New local LDAP user created')
    // Add the services.ldap identifiers
    await Meteor.users.updateAsync({ _id: userObject._id }, {
      $set: {
        'services.ldap': { id: uniqueId.value },
        'emails.0.verified': true,
        authenticationMethod: 'ldap',
      },
    })
  } catch {
    debugLog('Unable to create local LDAP user')
    return new Meteor.Error('LDAP-login-error', 'LDAP authentication failed')
  }

  await syncUserData(userObject, ldapUser)

  return {
    userId: userObject._id,
  }
}
