import { KNOWN_WRITE_ONLY_SETTING_NAMES } from '../api/globalsettings/globalSettingSecurity.js'

const REDACTED = '[REDACTED]'
const CIRCULAR = '[CIRCULAR]'
const MAX_LOG_DEPTH = 6
const MAX_LOG_ARRAY_ITEMS = 50
const MAX_LOG_OBJECT_KEYS = 50
const MAX_LOG_STRING_CHARS = 2048
const MAX_LOG_JSON_CHARS = 32768

function normalizedFieldName(name) {
  return String(name).toLowerCase().replaceAll(/[^a-z0-9]/g, '')
}

function sensitiveFieldName(name) {
  const normalized = normalizedFieldName(name)
  return normalized === 'email'
    || normalized === 'emails'
    || normalized.includes('password')
    || normalized.includes('passphrase')
    || normalized.includes('secret')
    || normalized.includes('token')
    || normalized.includes('apikey')
    || normalized.includes('authorization')
    || normalized.includes('credential')
    || normalized.includes('privatekey')
    || normalized.includes('accesskey')
    || normalized.includes('processdata')
    // A Wekan integration URL embeds its auth token in the query string. The
    // validated-method transaction mixin runs before project methods seal the
    // value, so this project field must be treated as a credential at the log
    // boundary as well as at rest.
    || normalized === 'wekanurl'
}

function sensitiveSettingName(name) {
  return KNOWN_WRITE_ONLY_SETTING_NAMES.includes(name) || sensitiveFieldName(name)
}

function boundedString(value) {
  if (value.length <= MAX_LOG_STRING_CHARS) return value
  return `${value.slice(0, MAX_LOG_STRING_CHARS)}[TRUNCATED]`
}

function sanitizeTransactionValue(value, options = {}, depth = 0, ancestors = new WeakSet()) {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value
  if (typeof value === 'string') return boundedString(value)
  if (typeof value === 'bigint') return boundedString(value.toString())
  if (typeof value === 'undefined') return null
  if (typeof value === 'function' || typeof value === 'symbol') return '[OMITTED]'
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? '[INVALID DATE]' : value.toISOString()
  }
  if (ArrayBuffer.isView(value)) return `[BINARY ${value.byteLength} BYTES]`
  if (depth >= MAX_LOG_DEPTH) return '[MAX DEPTH]'
  if (ancestors.has(value)) return CIRCULAR

  ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      const result = value.slice(0, MAX_LOG_ARRAY_ITEMS).map((entry) => (
        sanitizeTransactionValue(entry, options, depth + 1, ancestors)
      ))
      if (value.length > MAX_LOG_ARRAY_ITEMS) {
        result.push(`[${value.length - MAX_LOG_ARRAY_ITEMS} MORE ITEMS]`)
      }
      return result
    }

    const entries = Object.entries(value)
    const result = {}
    const settingName = typeof value.name === 'string' ? value.name : undefined
    const redactNamedValue = options.redactAllNamedValues === true
      || sensitiveSettingName(settingName)
      || value.restricted === true
      || (typeof value.type === 'string' && value.type.toLowerCase() === 'password')
    entries.slice(0, MAX_LOG_OBJECT_KEYS).forEach(([key, childValue]) => {
      if (sensitiveFieldName(key) || (key === 'value' && redactNamedValue)) {
        result[key] = REDACTED
      } else {
        result[key] = sanitizeTransactionValue(childValue, options, depth + 1, ancestors)
      }
    })
    if (entries.length > MAX_LOG_OBJECT_KEYS) {
      result.__truncatedKeys = entries.length - MAX_LOG_OBJECT_KEYS
    }
    return result
  } catch {
    return '[UNSERIALIZABLE]'
  } finally {
    ancestors.delete(value)
  }
}

function boundedJson(value) {
  const serialized = JSON.stringify(value)
  if (serialized.length <= MAX_LOG_JSON_CHARS) return serialized
  return JSON.stringify({
    truncated: true,
    originalCharacters: serialized.length,
  })
}

function serializeTransactionArguments(args, methodName) {
  return boundedJson(sanitizeTransactionValue(args, {
    // A client supplies only {name, value} for this method, so future settings
    // cannot reliably carry their server-side restricted/password metadata into
    // the logger. Treat every submitted global-setting value as private.
    redactAllNamedValues: methodName === 'updateGlobalSettings',
  }))
}

function serializeTransactionUser(user) {
  return boundedJson({
    _id: boundedString(String(user?._id || '')),
    name: boundedString(String(user?.profile?.name || '')),
    isAdmin: user?.isAdmin === true,
  })
}

function parsedObject(value) {
  if (typeof value !== 'string' || value.length > MAX_LOG_JSON_CHARS) return undefined
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

function parsedArguments(value) {
  if (typeof value !== 'string') return value
  if (value.length > MAX_LOG_JSON_CHARS) throw new TypeError()
  return JSON.parse(value)
}

/**
 * Re-sanitize stored rows at the publication boundary. This protects an
 * upgraded deployment from exposing legacy rows that pre-date write-time
 * redaction, while malformed legacy JSON fails closed.
 */
function transactionPublicationFields(fields) {
  const storedUser = parsedObject(fields?.user) || {}
  let publishedArgs
  try {
    publishedArgs = serializeTransactionArguments(
      parsedArguments(fields?.args),
      fields?.method,
    )
  } catch {
    publishedArgs = JSON.stringify({ redactedLegacyPayload: true })
  }
  const result = {
    user: serializeTransactionUser({
      _id: storedUser._id,
      profile: { name: storedUser.name || storedUser.profile?.name },
      isAdmin: storedUser.isAdmin,
    }),
    method: boundedString(typeof fields?.method === 'string' ? fields.method : ''),
    args: publishedArgs,
  }
  if (Object.hasOwn(fields || {}, 'timestamp')) result.timestamp = fields.timestamp
  return result
}

export {
  MAX_LOG_ARRAY_ITEMS,
  MAX_LOG_DEPTH,
  MAX_LOG_JSON_CHARS,
  MAX_LOG_OBJECT_KEYS,
  MAX_LOG_STRING_CHARS,
  REDACTED,
  sensitiveFieldName,
  serializeTransactionArguments,
  serializeTransactionUser,
  transactionPublicationFields,
}
