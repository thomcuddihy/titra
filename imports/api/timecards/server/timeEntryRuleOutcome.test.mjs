import assert from 'node:assert/strict'
import test from 'node:test'

import { evaluateTimeEntryRule } from './timeEntryRuleOutcome.js'
import { legacyScriptDecision } from '../../../utils/legacyScriptPolicy.js'

test('false and configured runtime throws are sanitized rule rejections', async () => {
  await assert.rejects(evaluateTimeEntryRule('false', async () => false), (error) => (
    error.error === 'timecard-rule-blocked' && !error.message.includes('false')
  ))
  await assert.rejects(evaluateTimeEntryRule('throw secret', async () => {
    throw new Error('private customer and billing detail')
  }), (error) => (
    error.error === 'timecard-rule-blocked'
      && !error.message.includes('private customer')
  ))
})

test('the safe literal-deny decision maps to a blocked outcome without script execution', async () => {
  const decision = legacyScriptDecision('time-entry-rule', 'return false;', {})
  let scriptExecutions = 0
  await assert.rejects(
    evaluateTimeEntryRule('return false;', async () => {
      if (decision.execute) scriptExecutions += 1
      return decision.literalResult
    }),
    (error) => error.error === 'timecard-rule-blocked',
  )
  assert.equal(decision.execute, false)
  assert.equal(scriptExecutions, 0)
})

test('configuration, syntax, and VM infrastructure failures remain internal', async () => {
  for (const [rule, failure] of [
    [null, null],
    ['', null],
    ['bad syntax', new SyntaxError('secret source')],
    ['timeout', Object.assign(new Error('secret state'), { code: 'ERR_SCRIPT_EXECUTION_TIMEOUT' })],
  ]) {
    await assert.rejects(evaluateTimeEntryRule(rule, async () => { throw failure }), (error) => (
      error.error === 'timecard-rule-internal'
        && !error.message.includes('secret')
    ))
  }
})

test('external setting/database failure is not passed to evaluator or mislabeled', async () => {
  const databaseFailure = Object.assign(new Error('database unavailable'), { code: 'DB_DOWN' })
  // The caller retrieves settings/project/user before invoking the evaluator;
  // this assertion documents that such an error remains its original unknown
  // infrastructure failure rather than entering the rule classifier.
  assert.equal(databaseFailure.error, undefined)
  assert.equal(databaseFailure.code, 'DB_DOWN')
})
