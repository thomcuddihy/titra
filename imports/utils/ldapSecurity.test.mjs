import assert from 'node:assert/strict'
import test from 'node:test'

import {
  MAX_LDAP_IDENTIFIER_BYTES,
  MAX_LDAP_USERNAME_LENGTH,
  assertBoundedLdapString,
  assertLdapAttributeDescription,
  assertLdapUsername,
  escapeLdapFilterValue,
  escapeLdapFilterTemplateValue,
  escapeLdapHexFilterValue,
  escapeLdapRdnValue,
  interpolateEscapedLdapUsername,
  interpolateLdapUsername,
  ldapScalarToString,
  parseLdapAttributeList,
} from './ldapSecurity.js'

test('RFC 4515 escaping neutralizes filter metacharacters and NULs', () => {
  assert.equal(
    escapeLdapFilterValue('*)(uid=*)(|(cn=admin)\\\0'),
    '\\2a\\29\\28uid=\\2a\\29\\28|\\28cn=admin\\29\\5c\\00',
  )
  assert.equal(escapeLdapFilterValue('Jöhn, Example'), 'Jöhn, Example')
})

test('RFC 4514 escaping protects RDN delimiters and boundary characters', () => {
  assert.equal(escapeLdapRdnValue(' #a,b+c=d\\e<>;" '), '\\ #a\\,b\\+c\\=d\\\\e\\<\\>\\;\\"\\ ')
  assert.equal(escapeLdapRdnValue('normal.user'), 'normal.user')
  assert.equal(escapeLdapRdnValue('nul\0tab\t'), 'nul\\00tab\\09')
})

test('binary identifiers become RFC 4515 escaped octets', () => {
  assert.equal(escapeLdapHexFilterValue('2A00285cFF'), '\\2a\\00\\28\\5c\\ff')
  assert.throws(() => escapeLdapHexFilterValue('abc'), /hexadecimal/)
  assert.throws(() => escapeLdapHexFilterValue('zz'), /hexadecimal/)
  assert.throws(() => escapeLdapHexFilterValue('aa'.repeat(MAX_LDAP_IDENTIFIER_BYTES + 1)), /invalid length/)
})

test('username validation rejects ambiguous and resource-exhausting inputs', () => {
  assert.equal(assertLdapUsername('valid.user@example.test'), 'valid.user@example.test')
  assert.throws(() => assertLdapUsername(undefined), /must be a string/)
  assert.throws(() => assertLdapUsername(''), /invalid length/)
  assert.throws(() => assertLdapUsername('x'.repeat(MAX_LDAP_USERNAME_LENGTH + 1)), /invalid length/)
  assert.throws(() => assertLdapUsername('\ud800'), /invalid Unicode/)
})

test('attribute descriptions cannot inject LDAP syntax', () => {
  assert.equal(assertLdapAttributeDescription('sAMAccountName'), 'sAMAccountName')
  assert.equal(assertLdapAttributeDescription('1.2.840.113556.1.4.656'), '1.2.840.113556.1.4.656')
  assert.equal(assertLdapAttributeDescription('cn;lang-en'), 'cn;lang-en')
  assert.throws(() => assertLdapAttributeDescription('uid)(|(uid=*'), /invalid/)
  assert.deepEqual(parseLdapAttributeList('uid, mail,1.2.3'), ['uid', 'mail', '1.2.3'])
  assert.throws(() => parseLdapAttributeList('uid,cn)(uid=*'), /invalid/)
})

test('directory filter values are bounded scalar data', () => {
  assert.equal(ldapScalarToString(['one', 'two']), 'one,two')
  assert.equal(ldapScalarToString(42), '42')
  assert.throws(() => ldapScalarToString({ value: 'secret' }), /must be a string/)
  assert.throws(() => ldapScalarToString([{ value: 'secret' }]), /must be a string/)
  assert.throws(() => ldapScalarToString(Buffer.from([0xff])), /invalid UTF-8/)
  assert.throws(() => assertBoundedLdapString('1234', { maxLength: 3 }), /invalid length/)
})

test('username template interpolation validates before later escaping', () => {
  const value = interpolateLdapUsername('uid=#{username},ou=people', '*)(uid=*)')
  assert.equal(value, 'uid=*)(uid=*),ou=people')
  assert.equal(escapeLdapFilterValue(value), 'uid=\\2a\\29\\28uid=\\2a\\29,ou=people')
  assert.equal(
    escapeLdapFilterTemplateValue('uid=#{username},ou=people', '*)(uid=*)'),
    'uid=\\2a\\29\\28uid=\\2a\\29,ou=people',
  )
  assert.equal(interpolateLdapUsername('uid=#{username}', '$&'), 'uid=$&')
  assert.equal(
    interpolateEscapedLdapUsername('team-*-#{username}', '*)(uid=*)'),
    'team-*-\\2a\\29\\28uid=\\2a\\29',
  )
})
