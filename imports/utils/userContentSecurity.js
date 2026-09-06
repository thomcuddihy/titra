const MAX_PROFILE_NAME_CODE_POINTS = 200
const MAX_PROJECT_NAME_CODE_POINTS = 200
const MAX_PROJECT_DESCRIPTION_CODE_POINTS = 50000
const MAX_AVATAR_DATA_URL_LENGTH = 350000
const DEFAULT_AVATAR_COLOR = '#455A64'
const DEFAULT_PROJECT_COLOR = '#009688'

class UserContentValidationError extends TypeError {
  constructor(code, message) {
    super(message)
    this.name = 'UserContentValidationError'
    this.code = code
  }
}

function isWellFormed(value) {
  if (typeof value?.isWellFormed === 'function') return value.isWellFormed()
  return !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)
}

function codePointLength(value) {
  return [...value].length
}

function validateString(value, {
  code, label, maxCodePoints, required = false,
}) {
  if (typeof value !== 'string' || !isWellFormed(value)
    || codePointLength(value) > maxCodePoints) {
    throw new UserContentValidationError(code, `Invalid ${label}.`)
  }
  if (required && !value.trim()) {
    throw new UserContentValidationError(code, `${label} is required.`)
  }
  return value
}

function normalizeProfileName(value) {
  return validateString(value, {
    code: 'profile-invalid',
    label: 'profile name',
    maxCodePoints: MAX_PROFILE_NAME_CODE_POINTS,
    required: true,
  }).trim()
}

function normalizeProjectName(value) {
  return validateString(value, {
    code: 'project-invalid',
    label: 'project name',
    maxCodePoints: MAX_PROJECT_NAME_CODE_POINTS,
    required: true,
  }).trim()
}

function normalizeProjectDescription(value) {
  return validateString(value, {
    code: 'project-invalid',
    label: 'project description',
    maxCodePoints: MAX_PROJECT_DESCRIPTION_CODE_POINTS,
  }).replace(/\r\n?/g, '\n')
}

function normalizeHexColor(value, {
  code = 'profile-invalid', label = 'color', fallback,
} = {}) {
  if ((value === undefined || value === null || value === '') && fallback) return fallback
  if (typeof value !== 'string' || !/^#[\da-f]{6}$/iu.test(value)) {
    throw new UserContentValidationError(code, `Invalid ${label}.`)
  }
  return value.toUpperCase()
}

function normalizeAvatarDataUrl(value) {
  if (value === undefined || value === null || value === '') return ''
  if (typeof value !== 'string' || value.length > MAX_AVATAR_DATA_URL_LENGTH
    || !/^data:image\/png;base64,(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    throw new UserContentValidationError('profile-invalid', 'Invalid avatar image.')
  }
  return value
}

function safeAvatarDataUrl(value) {
  try {
    return normalizeAvatarDataUrl(value)
  } catch {
    return ''
  }
}

function safeProfileName(value) {
  if (typeof value !== 'string' || !isWellFormed(value)) return ''
  return [...value].slice(0, MAX_PROFILE_NAME_CODE_POINTS).join('').trim()
}

function initialsFromName(value) {
  const name = safeProfileName(value)
  if (!name) return '?'
  return name.split(/\s+/u).slice(0, 2)
    .map((part) => [...part][0])
    .join('')
    .toLocaleUpperCase()
}

function avatarPresentation(user, { fallbackName = '' } = {}) {
  const name = safeProfileName(user?.profile?.name) || safeProfileName(fallbackName)
  let color = DEFAULT_AVATAR_COLOR
  try {
    color = normalizeHexColor(user?.profile?.avatarColor, { fallback: DEFAULT_AVATAR_COLOR })
  } catch {
    // Legacy invalid colours are presented with the safe default.
  }
  return {
    color,
    initials: initialsFromName(name),
    name,
    url: safeAvatarDataUrl(user?.profile?.avatar),
  }
}

function projectDescriptionText(value) {
  if (typeof value === 'string') {
    if (!isWellFormed(value)) return ''
    return [...value].slice(0, MAX_PROJECT_DESCRIPTION_CODE_POINTS).join('')
  }
  if (!value || !Array.isArray(value.ops)) return ''
  let output = ''
  for (const operation of value.ops) {
    if (typeof operation?.insert === 'string' && isWellFormed(operation.insert)) {
      output += operation.insert
      if (codePointLength(output) >= MAX_PROJECT_DESCRIPTION_CODE_POINTS) break
    }
  }
  return [...output].slice(0, MAX_PROJECT_DESCRIPTION_CODE_POINTS).join('')
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function plainTextToSafeHtml(value) {
  return escapeHtml(projectDescriptionText(value)).replace(/\r\n?|\n/gu, '<br>')
}

function normalizeProjectPresentationFields(project) {
  const normalized = { ...project }
  if (Object.prototype.hasOwnProperty.call(normalized, 'name')) {
    normalized.name = normalizeProjectName(normalized.name)
  }
  for (const field of ['desc', 'description']) {
    if (Object.prototype.hasOwnProperty.call(normalized, field)) {
      normalized[field] = normalizeProjectDescription(normalized[field])
    }
  }
  if (Object.prototype.hasOwnProperty.call(normalized, 'color')) {
    normalized.color = normalizeHexColor(normalized.color, {
      code: 'project-invalid',
      label: 'project color',
      fallback: DEFAULT_PROJECT_COLOR,
    })
  }
  return normalized
}

export {
  DEFAULT_AVATAR_COLOR,
  DEFAULT_PROJECT_COLOR,
  MAX_AVATAR_DATA_URL_LENGTH,
  MAX_PROFILE_NAME_CODE_POINTS,
  MAX_PROJECT_DESCRIPTION_CODE_POINTS,
  MAX_PROJECT_NAME_CODE_POINTS,
  UserContentValidationError,
  avatarPresentation,
  escapeHtml,
  initialsFromName,
  normalizeAvatarDataUrl,
  normalizeHexColor,
  normalizeProfileName,
  normalizeProjectDescription,
  normalizeProjectName,
  normalizeProjectPresentationFields,
  plainTextToSafeHtml,
  projectDescriptionText,
  safeAvatarDataUrl,
}
