const DEFAULT_MAX_LDAP_VALUE_LENGTH = 4096
export const MAX_LDAP_USERNAME_LENGTH = 1024
export const MAX_LDAP_IDENTIFIER_BYTES = 4096

function assertWellFormedUnicode(value, label) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff) {
        throw new TypeError(`${label} contains invalid Unicode`)
      }
      index += 1
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new TypeError(`${label} contains invalid Unicode`)
    }
  }
}

export function assertBoundedLdapString(value, {
  label = 'LDAP value',
  maxLength = DEFAULT_MAX_LDAP_VALUE_LENGTH,
  allowEmpty = false,
} = {}) {
  if (typeof value !== 'string') {
    throw new TypeError(`${label} must be a string`)
  }
  if ((!allowEmpty && value.length === 0) || value.length > maxLength) {
    throw new TypeError(`${label} has an invalid length`)
  }
  assertWellFormedUnicode(value, label)
  return value
}

export function assertLdapUsername(username) {
  return assertBoundedLdapString(username, {
    label: 'LDAP username',
    maxLength: MAX_LDAP_USERNAME_LENGTH,
  })
}

export function assertLdapAttributeDescription(attribute) {
  const value = assertBoundedLdapString(
    typeof attribute === 'string' ? attribute.trim() : attribute,
    {
      label: 'LDAP attribute description',
      maxLength: 256,
    },
  )
  const keyString = '[A-Za-z][A-Za-z0-9-]*'
  const numericoid = '[0-9]+(?:\\.[0-9]+)+'
  const option = '(?:;[A-Za-z0-9-]+)*'
  const attributePattern = new RegExp(`^(?:${keyString}|${numericoid})${option}$`)
  if (!attributePattern.test(value)) {
    throw new TypeError('LDAP attribute description is invalid')
  }
  return value
}

export function parseLdapAttributeList(value) {
  return assertBoundedLdapString(value, {
    label: 'LDAP attribute list',
    maxLength: 2048,
  }).split(',').map(assertLdapAttributeDescription)
}

export function ldapScalarToString(value, {
  label = 'LDAP value',
  maxLength = DEFAULT_MAX_LDAP_VALUE_LENGTH,
} = {}) {
  const normalizeScalar = (scalar) => {
    if (typeof Buffer !== 'undefined' && Buffer.isBuffer(scalar)) {
      try {
        return new TextDecoder('utf-8', { fatal: true }).decode(scalar)
      } catch {
        throw new TypeError(`${label} contains invalid UTF-8`)
      }
    }
    if (typeof scalar === 'number' || typeof scalar === 'boolean' || typeof scalar === 'bigint') {
      return String(scalar)
    }
    if (typeof scalar !== 'string') {
      throw new TypeError(`${label} must be a string`)
    }
    return scalar
  }
  const scalar = Array.isArray(value)
    ? value.map(normalizeScalar).join(',')
    : normalizeScalar(value)
  return assertBoundedLdapString(scalar, { label, maxLength })
}

export function escapeLdapFilterValue(value) {
  const stringValue = ldapScalarToString(value)
  return stringValue.replace(/[\\*()\0]/g, (character) => {
    switch (character) {
      case '\\': return '\\5c'
      case '*': return '\\2a'
      case '(': return '\\28'
      case ')': return '\\29'
      default: return '\\00'
    }
  })
}

export function escapeLdapRdnValue(value) {
  const stringValue = ldapScalarToString(value)
  const characters = Array.from(stringValue)
  const leadingSpaces = characters.findIndex((character) => character !== ' ')
  const effectiveLeadingSpaces = leadingSpaces === -1 ? characters.length : leadingSpaces
  let trailingSpaces = 0
  while (characters.at(-(trailingSpaces + 1)) === ' ') trailingSpaces += 1

  return characters.map((character, index) => {
    const codePoint = character.codePointAt(0)
    const isBoundarySpace = character === ' '
      && (index < effectiveLeadingSpaces || index >= characters.length - trailingSpaces)
    if (isBoundarySpace || (character === '#' && index === 0)) {
      return `\\${character}`
    }
    if (character === '\0' || codePoint < 0x20 || codePoint === 0x7f) {
      return Array.from(Buffer.from(character, 'utf8'))
        .map((byte) => `\\${byte.toString(16).padStart(2, '0')}`)
        .join('')
    }
    if ([',', '+', '"', '\\', '<', '>', ';', '='].includes(character)) {
      return `\\${character}`
    }
    return character
  }).join('')
}

export function escapeLdapHexFilterValue(identifier) {
  const value = assertBoundedLdapString(identifier, {
    label: 'LDAP identifier',
    maxLength: MAX_LDAP_IDENTIFIER_BYTES * 2,
  })
  if (value.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(value)) {
    throw new TypeError('LDAP identifier must be hexadecimal')
  }
  return value.match(/.{2}/g).map((octet) => `\\${octet.toLowerCase()}`).join('')
}

export function interpolateLdapUsername(template, username) {
  const boundedTemplate = assertBoundedLdapString(template, {
    label: 'LDAP group filter template',
  })
  const boundedUsername = assertLdapUsername(username)
  return boundedTemplate.replace(/#{username}/g, () => boundedUsername)
}

export function interpolateEscapedLdapUsername(template, username) {
  const boundedTemplate = assertBoundedLdapString(template, {
    label: 'LDAP group filter template',
  })
  const escapedUsername = escapeLdapFilterValue(assertLdapUsername(username))
  return boundedTemplate.replace(/#{username}/g, () => escapedUsername)
}

export function escapeLdapFilterTemplateValue(value, username) {
  const scalarValue = ldapScalarToString(value)
  return escapeLdapFilterValue(interpolateLdapUsername(scalarValue, username))
}
