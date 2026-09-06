const EMAIL_MAX_LENGTH = 320
const PASSWORD_MAX_LENGTH = 128
const PASSWORD_MIN_LENGTH = 8
const PROJECT_DESCRIPTION_MAX_LENGTH = 4000
const PROJECT_NAME_MAX_LENGTH = 160

class RegistrationInputError extends Error {
  constructor(code) {
    super(code)
    this.name = 'RegistrationInputError'
    this.code = code
  }
}

function boundedWellFormedString(value, { min = 0, max }) {
  return typeof value === 'string'
    && value.length >= min
    && value.length <= max
    && value.isWellFormed()
}

function normalizeSelfRegistration(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new RegistrationInputError('registration-invalid')
  }
  const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : ''
  const name = typeof input.name === 'string' ? input.name.trim() : ''
  const currentLanguageProject = typeof input.currentLanguageProject === 'string'
    ? input.currentLanguageProject.trim() : ''
  const currentLanguageProjectDesc = typeof input.currentLanguageProjectDesc === 'string'
    ? input.currentLanguageProjectDesc.trim() : ''

  // Accounts performs canonical uniqueness checks. This deliberately uses a
  // conservative syntax check without attempting to normalize valid addresses.
  if (!boundedWellFormedString(email, { min: 3, max: EMAIL_MAX_LENGTH })
      || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)
      || !boundedWellFormedString(input.password, {
        min: PASSWORD_MIN_LENGTH, max: PASSWORD_MAX_LENGTH,
      })
      || !boundedWellFormedString(name, { min: 1, max: 160 })
      || !boundedWellFormedString(currentLanguageProject, {
        min: 1, max: PROJECT_NAME_MAX_LENGTH,
      })
      || !boundedWellFormedString(currentLanguageProjectDesc, {
        max: PROJECT_DESCRIPTION_MAX_LENGTH,
      })) {
    throw new RegistrationInputError('registration-invalid')
  }

  return {
    email,
    password: input.password,
    profile: { name, currentLanguageProject, currentLanguageProjectDesc },
  }
}

function selfRegistrationAllowed(disableUserRegistration) {
  return disableUserRegistration !== true
}

// Anonymous accounts are a separate, deliberately opt-in registration path.
// Missing, malformed, or merely truthy configuration must stay closed because
// the anonymous accounts package exposes its login handler over DDP whenever
// its server module is imported.
function anonymousRegistrationAllowed(enableAnonymousLogins) {
  return enableAnonymousLogins === true
}

function firstUserAdministratorAllowed(value) {
  return value === 'true'
}

export {
  anonymousRegistrationAllowed,
  EMAIL_MAX_LENGTH,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  PROJECT_DESCRIPTION_MAX_LENGTH,
  PROJECT_NAME_MAX_LENGTH,
  RegistrationInputError,
  firstUserAdministratorAllowed,
  normalizeSelfRegistration,
  selfRegistrationAllowed,
}
