const UNSAFE_LEGACY_SCRIPT_ENV = 'TITRA_ENABLE_UNSAFE_LEGACY_SCRIPTS'

// Only comments, whitespace and one literal `return true` or `return false`
// statement are accepted here. This deliberately is not a general JavaScript
// parser: the purpose is to recognize Titra's historical no-op default and a
// fail-closed maintenance rule without executing administrator-supplied code
// in the application process.
const COMMENT_OR_SPACE = String.raw`(?:\s+|\/\/[^\r\n]*(?:\r\n?|\n|$)|\/\*[\s\S]*?\*\/)`
const LITERAL_ALLOW_RULE = new RegExp(
  String.raw`^(?:${COMMENT_OR_SPACE})*return\s+true(?:${COMMENT_OR_SPACE})*;?(?:${COMMENT_OR_SPACE})*$`,
)
const LITERAL_DENY_RULE = new RegExp(
  String.raw`^(?:${COMMENT_OR_SPACE})*return\s+false(?:${COMMENT_OR_SPACE})*;?(?:${COMMENT_OR_SPACE})*$`,
)

function unsafeLegacyScriptsEnabled(environment = globalThis.process?.env) {
  return environment?.[UNSAFE_LEGACY_SCRIPT_ENV] === 'true'
}

function isLiteralAllowTimeEntryRule(source) {
  return typeof source === 'string'
    && source.length <= 50000
    && source.isWellFormed()
    && LITERAL_ALLOW_RULE.test(source)
}

function isLiteralDenyTimeEntryRule(source) {
  return typeof source === 'string'
    && source.length <= 50000
    && source.isWellFormed()
    && LITERAL_DENY_RULE.test(source)
}

function isLiteralTimeEntryRule(source) {
  return isLiteralAllowTimeEntryRule(source) || isLiteralDenyTimeEntryRule(source)
}

function legacyScriptDecision(kind, source, environment = globalThis.process?.env) {
  if (kind === 'time-entry-rule' && isLiteralAllowTimeEntryRule(source)) {
    return Object.freeze({
      allowed: true, execute: false, literalResult: true, reason: 'literal-allow-rule',
    })
  }
  if (kind === 'time-entry-rule' && isLiteralDenyTimeEntryRule(source)) {
    return Object.freeze({
      allowed: true, execute: false, literalResult: false, reason: 'literal-deny-rule',
    })
  }
  if (unsafeLegacyScriptsEnabled(environment)) {
    return Object.freeze({ allowed: true, execute: true, reason: 'explicit-unsafe-opt-in' })
  }
  return Object.freeze({ allowed: false, execute: false, reason: 'unsafe-legacy-scripts-disabled' })
}

export {
  UNSAFE_LEGACY_SCRIPT_ENV,
  isLiteralAllowTimeEntryRule,
  isLiteralDenyTimeEntryRule,
  isLiteralTimeEntryRule,
  legacyScriptDecision,
  unsafeLegacyScriptsEnabled,
}
