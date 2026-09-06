const DEFAULT_OPENAI_MODEL = 'gpt-5.6-luna'
const MAX_API_KEY_LENGTH = 4096
const MAX_PROMPT_CODE_POINTS = 100000
const MAX_RESPONSE_CONTENT_LENGTH = 64 * 1024

class OpenAISecurityError extends Error {
  constructor(code = 'openai-invalid-response') {
    super('The language-model request could not be completed.')
    this.name = 'OpenAISecurityError'
    this.code = code
  }
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function isWellFormed(value) {
  if (typeof value?.isWellFormed === 'function') return value.isWellFormed()
  return !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)
}

function normalizeOpenAIAPIKey(value) {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > MAX_API_KEY_LENGTH
    || /[\u0000-\u0020\u007f]/u.test(value)
  ) throw new OpenAISecurityError('openai-key-invalid')
  return value
}

function normalizeOpenAIPrompt(value) {
  if (
    typeof value !== 'string'
    || value.length === 0
    || !isWellFormed(value)
    || [...value].length > MAX_PROMPT_CODE_POINTS
  ) throw new OpenAISecurityError('openai-prompt-invalid')
  return value
}

function normalizeOpenAIModel(value = DEFAULT_OPENAI_MODEL) {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > 128
    || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value)
  ) throw new OpenAISecurityError('openai-model-invalid')
  return value
}

function validateJsonValue(value, depth = 0) {
  if (depth > 8) throw new OpenAISecurityError()
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new OpenAISecurityError()
    return
  }
  if (Array.isArray(value)) {
    if (value.length > 256) throw new OpenAISecurityError()
    value.forEach((item) => validateJsonValue(item, depth + 1))
    return
  }
  if (!isPlainObject(value) || Object.keys(value).length > 128) {
    throw new OpenAISecurityError()
  }
  for (const [key, child] of Object.entries(value)) {
    if (
      key === '__proto__'
      || key === 'constructor'
      || key === 'prototype'
      || key.length > 256
    ) throw new OpenAISecurityError()
    validateJsonValue(child, depth + 1)
  }
}

function parseOpenAIJsonResult(response) {
  if (!isPlainObject(response) || !Array.isArray(response.choices) || !response.choices[0]) {
    throw new OpenAISecurityError()
  }
  const content = response.choices[0]?.message?.content
  if (
    typeof content !== 'string'
    || content.length === 0
    || content.length > MAX_RESPONSE_CONTENT_LENGTH
    || !isWellFormed(content)
  ) throw new OpenAISecurityError()
  let parsed
  try {
    parsed = JSON.parse(content)
  } catch {
    throw new OpenAISecurityError()
  }
  if (!isPlainObject(parsed)) throw new OpenAISecurityError()
  validateJsonValue(parsed)
  return parsed
}

export {
  DEFAULT_OPENAI_MODEL,
  MAX_RESPONSE_CONTENT_LENGTH,
  OpenAISecurityError,
  normalizeOpenAIAPIKey,
  normalizeOpenAIModel,
  normalizeOpenAIPrompt,
  parseOpenAIJsonResult,
}
