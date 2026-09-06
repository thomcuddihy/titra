const writeOnlyProfileSettings = Object.freeze([
  'siwapptoken',
  'zammadtoken',
  'gitlabtoken',
])

const MAX_WRITE_ONLY_SECRET_LENGTH = 4096

function validWriteOnlySecret(value) {
  return value.length <= MAX_WRITE_ONLY_SECRET_LENGTH
    && value.isWellFormed()
    && ![...value].some((character) => {
      const codePoint = character.codePointAt(0)
      return codePoint <= 31 || codePoint === 127
    })
}

/**
 * Secret inputs are write-only placeholders in settings forms. Omitting one,
 * or submitting a blank value because the browser was not sent the secret,
 * must never erase the stored credential. A deliberate non-blank replacement
 * remains an ordinary exact-value update.
 */
function appendWriteOnlyProfileSettings(set, settings, { sealSecret } = {}) {
  const result = { ...set }
  writeOnlyProfileSettings.forEach((field) => {
    const value = settings?.[field]
    if (typeof value === 'string' && value.trim()) {
      if (!validWriteOnlySecret(value)) throw new TypeError('Invalid write-only secret.')
      if (typeof sealSecret !== 'function') throw new TypeError('A credential sealer is required.')
      result[`profile.${field}`] = sealSecret(value)
    }
  })
  return result
}

export {
  appendWriteOnlyProfileSettings,
  MAX_WRITE_ONLY_SECRET_LENGTH,
  validWriteOnlySecret,
  writeOnlyProfileSettings,
}
