const KNOWN_WRITE_ONLY_SETTING_NAMES = Object.freeze([
  'google_clientid',
  'google_secret',
  'openai_apikey',
])
const KNOWN_SEALED_SETTING_NAMES = Object.freeze([
  'google_secret',
  'openai_apikey',
])

const GLOBAL_SETTING_SOURCE_FIELDS = Object.freeze({
  name: 1,
  description: 1,
  type: 1,
  value: 1,
  category: 1,
  restricted: 1,
})

const GLOBAL_SETTING_METADATA_FIELDS = Object.freeze([
  'name',
  'description',
  'type',
  'category',
  'restricted',
])

function isWriteOnlyGlobalSetting(setting) {
  return setting?.restricted === true
    || (typeof setting?.type === 'string' && setting.type.toLowerCase() === 'password')
    || KNOWN_WRITE_ONLY_SETTING_NAMES.includes(setting?.name)
}

function configuredSecretValue(value) {
  if (typeof value === 'string') return value.trim().length > 0
  return value !== undefined && value !== null
}

function settingMetadata(setting) {
  return GLOBAL_SETTING_METADATA_FIELDS.reduce((result, field) => {
    if (Object.hasOwn(setting || {}, field)) result[field] = setting[field]
    return result
  }, {})
}

/**
 * Convert the complete source snapshot into the exact global-settings view a
 * subscriber may see. Restricted settings remain visible to active admins so
 * the editor can replace/reset them, but their value is always write-only.
 */
function globalSettingDocuments({ user, userId, documents }) {
  const administrator = user != null && user._id === userId
    && user.isAdmin === true
    && user.inactive !== true
  const published = new Map()
  documents.forEach((setting, id) => {
    const writeOnly = isWriteOnlyGlobalSetting(setting)
    if (writeOnly && !administrator) return
    const fields = settingMetadata(setting)
    if (writeOnly) fields.configured = configuredSecretValue(setting.value)
    else if (Object.hasOwn(setting, 'value')) fields.value = setting.value
    published.set(id, fields)
  })
  return published
}

function shouldPreserveWriteOnlySetting(setting, submittedValue) {
  return isWriteOnlyGlobalSetting(setting)
    && typeof submittedValue === 'string'
    && submittedValue.trim().length === 0
}

function shouldSealGlobalSetting(name) {
  return KNOWN_SEALED_SETTING_NAMES.includes(name)
}

export {
  GLOBAL_SETTING_SOURCE_FIELDS,
  KNOWN_SEALED_SETTING_NAMES,
  KNOWN_WRITE_ONLY_SETTING_NAMES,
  configuredSecretValue,
  globalSettingDocuments,
  isWriteOnlyGlobalSetting,
  shouldPreserveWriteOnlySetting,
  shouldSealGlobalSetting,
}
