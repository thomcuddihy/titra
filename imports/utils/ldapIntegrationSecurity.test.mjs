import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

function dataModule(source) {
  return `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
}

async function loadLdapModule() {
  const accountsModule = dataModule(`
    export const Accounts = {
      registerLoginHandler(name, handler) {
        globalThis.__ldapLoginHandlerName = name
        globalThis.__ldapLoginHandler = handler
      },
    }
  `)
  const shaModule = dataModule('export const SHA256 = (value) => value')
  const settingsModule = dataModule('export const getGlobalSettingAsync = async () => true')
  const debugModule = dataModule(`
    export const debugLog = (...args) => globalThis.__ldapDebugCalls.push(args)
  `)
  const securityModule = pathToFileURL(resolve('imports/utils/ldapSecurity.js')).href
  const source = readFileSync('imports/utils/ldap.js', 'utf8')
    .replace("'meteor/accounts-base'", `'${accountsModule}'`)
    .replace("'meteor/sha'", `'${shaModule}'`)
    .replace("'./server_method_helpers'", `'${settingsModule}'`)
    .replace("'./debugLog'", `'${debugModule}'`)
    .replace("'./ldapSecurity'", `'${securityModule}'`)

  globalThis.Meteor = {
    Error: class MeteorError extends Error {
      constructor(error, reason) {
        super(reason)
        this.error = error
      }
    },
  }
  globalThis.__ldapDebugCalls = []
  const module = await import(dataModule(source))
  await Promise.resolve()
  return module
}

const { LDAP } = await loadLdapModule()

test('LDAP user search filters escape hostile usernames in every configured field', () => {
  const ldap = new LDAP()
  ldap.options.User_Search_Filter = '(objectclass=person)'
  ldap.options.User_Search_Field = 'uid,mail'

  assert.equal(
    ldap.getUserFilter('*)(|(uid=admin))'),
    '(&(objectclass=person)(|(uid=\\2a\\29\\28|\\28uid=admin\\29\\29)(mail=\\2a\\29\\28|\\28uid=admin\\29\\29)))',
  )
})

test('LDAP user bind escapes hostile RDN values before constructing a DN', async () => {
  const ldap = new LDAP()
  ldap.options.User_Authentication = 'uid'
  ldap.options.User_Authentication_Field = 'uid'
  ldap.options.BaseDN = 'ou=people,dc=example,dc=test'
  let capturedDn
  ldap.bindAsync = async (dn) => {
    capturedDn = dn
  }

  await ldap.bindUserIfNecessary('evil,ou=admins+role=root', 'secret')

  assert.equal(
    capturedDn,
    'uid=evil\\,ou\\=admins\\+role\\=root,ou=people,dc=example,dc=test',
  )
})

test('LDAP group queries escape hostile directory values and username templates', async () => {
  const ldap = new LDAP()
  ldap.options.group_filter_enabled = true
  ldap.options.group_filter_object_class = 'group'
  ldap.options.group_filter_group_member_attribute = 'member'
  ldap.options.group_filter_group_member_format = 'dn'
  ldap.options.group_filter_group_id_attribute = 'cn'
  ldap.options.BaseDN = 'dc=example,dc=test'
  let capturedFilter
  ldap.searchAllAsync = async (baseDn, options) => {
    assert.equal(baseDn, 'dc=example,dc=test')
    capturedFilter = options.filter
    return [{ cn: 'users' }]
  }

  await ldap.getUserGroups('*)(uid=admin)', {
    dn: 'uid=#{username},ou=people*)(objectclass=*',
  })

  assert.equal(
    capturedFilter,
    '(&(objectclass=group)(member=uid=\\2a\\29\\28uid=admin\\29,ou=people\\2a\\29\\28objectclass=\\2a))',
  )
})

test('LDAP group-name templates escape usernames while preserving configured wildcards', async () => {
  const ldap = new LDAP()
  ldap.options.group_filter_enabled = true
  ldap.options.group_filter_object_class = 'group*'
  ldap.options.group_filter_group_member_attribute = ''
  ldap.options.group_filter_group_id_attribute = 'cn'
  ldap.options.group_filter_group_name = 'team-*-#{username}'
  ldap.options.BaseDN = 'dc=example,dc=test'
  ldap.getUserGroups = async () => []
  let capturedFilter
  ldap.searchAllAsync = async (baseDn, options) => {
    assert.equal(baseDn, 'dc=example,dc=test')
    capturedFilter = options.filter
    return []
  }

  await ldap.isUserInGroup('*)(uid=admin)', {})

  assert.equal(
    capturedFilter,
    '(&(objectclass=group*)(cn=team-*-\\2a\\29\\28uid=admin\\29))',
  )
})

test('LDAP identifier filters use escaped binary octets', async () => {
  const previousIdentifierField = process.env.LDAP_UNIQUE_IDENTIFIER_FIELD
  process.env.LDAP_UNIQUE_IDENTIFIER_FIELD = 'objectGUID'
  try {
    const ldap = new LDAP()
    ldap.bindIfNecessary = async () => undefined
    let capturedFilter
    ldap.searchAllAsync = async (baseDn, options) => {
      capturedFilter = options.filter
      return []
    }

    await ldap.getUserByIdAsync('2a00285cff', 'objectGUID')

    assert.equal(capturedFilter, '(objectGUID=\\2a\\00\\28\\5c\\ff)')
  } finally {
    if (previousIdentifierField === undefined) {
      delete process.env.LDAP_UNIQUE_IDENTIFIER_FIELD
    } else {
      process.env.LDAP_UNIQUE_IDENTIFIER_FIELD = previousIdentifierField
    }
  }
})

test('malformed login requests expose only the generic authentication error', async () => {
  assert.equal(globalThis.__ldapLoginHandlerName, 'ldap')
  globalThis.__ldapDebugCalls.length = 0
  await assert.rejects(
    globalThis.__ldapLoginHandler({
      ldap: true,
      ldapOptions: {},
      username: { $ne: null },
      ldapPass: 'not-logged',
    }),
    (error) => error.error === 'LDAP-login-error'
      && error.message === 'LDAP authentication failed'
      && !error.message.includes('not-logged'),
  )
  assert.doesNotMatch(JSON.stringify(globalThis.__ldapDebugCalls), /not-logged/)
})
