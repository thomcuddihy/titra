import assert from 'node:assert/strict'
import test from 'node:test'

import {
  UNSAFE_LEGACY_SCRIPT_ENV,
  isLiteralAllowTimeEntryRule,
  isLiteralDenyTimeEntryRule,
  isLiteralTimeEntryRule,
  legacyScriptDecision,
  unsafeLegacyScriptsEnabled,
} from './legacyScriptPolicy.js'

test('unsafe legacy scripts require one exact, case-sensitive environment opt-in', () => {
  assert.equal(unsafeLegacyScriptsEnabled({}), false)
  assert.equal(unsafeLegacyScriptsEnabled({ [UNSAFE_LEGACY_SCRIPT_ENV]: 'TRUE' }), false)
  assert.equal(unsafeLegacyScriptsEnabled({ [UNSAFE_LEGACY_SCRIPT_ENV]: '1' }), false)
  assert.equal(unsafeLegacyScriptsEnabled({ [UNSAFE_LEGACY_SCRIPT_ENV]: 'true' }), true)
})

test('the historical literal allow rule is recognized without general code execution', () => {
  for (const rule of [
    'return true',
    ' return true; ',
    '// historical default\nreturn true;',
    '/* explanatory comment */\r\n return\ttrue /* end */ ;',
  ]) assert.equal(isLiteralAllowTimeEntryRule(rule), true, rule)

  for (const rule of [
    '',
    'true',
    'return false;',
    'return Boolean(true);',
    'doSomething(); return true;',
    'return true; fetch("https://example.test")',
    '/* unterminated return true;',
    42,
  ]) assert.equal(isLiteralAllowTimeEntryRule(rule), false, String(rule))
})

test('a literal deny rule is recognized without accepting executable variations', () => {
  for (const rule of [
    'return false',
    ' return false; ',
    '// maintenance window\nreturn false;',
    '/* deny new entries */\r\n return\tfalse /* end */ ;',
  ]) {
    assert.equal(isLiteralDenyTimeEntryRule(rule), true, rule)
    assert.equal(isLiteralTimeEntryRule(rule), true, rule)
  }

  for (const rule of [
    '',
    'false',
    'return Boolean(false);',
    'doSomething(); return false;',
    'return false; fetch("https://example.test")',
    '/* unterminated return false;',
    42,
  ]) assert.equal(isLiteralDenyTimeEntryRule(rule), false, String(rule))
})

test('policy bypasses execution only for exact literal time-entry rules', () => {
  assert.deepEqual(legacyScriptDecision('time-entry-rule', 'return true;', {}), {
    allowed: true, execute: false, literalResult: true, reason: 'literal-allow-rule',
  })
  assert.deepEqual(legacyScriptDecision('time-entry-rule', 'return false;', {}), {
    allowed: true, execute: false, literalResult: false, reason: 'literal-deny-rule',
  })
  assert.deepEqual(legacyScriptDecision('inbound-interface', 'return []', {}), {
    allowed: false, execute: false, reason: 'unsafe-legacy-scripts-disabled',
  })
  assert.deepEqual(legacyScriptDecision('outbound-interface', 'return true', {
    [UNSAFE_LEGACY_SCRIPT_ENV]: 'true',
  }), {
    allowed: true, execute: true, reason: 'explicit-unsafe-opt-in',
  })
})
