import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  DEFAULT_OPENAI_MODEL,
  OpenAISecurityError,
  normalizeOpenAIAPIKey,
  normalizeOpenAIModel,
  normalizeOpenAIPrompt,
  parseOpenAIJsonResult,
} from './openaiSecurity.js'

const rejects = (callback) => assert.throws(callback, OpenAISecurityError)

test('OpenAI credentials, prompts and model IDs are bounded and control-safe', () => {
  assert.equal(normalizeOpenAIAPIKey('sk-safe_value'), 'sk-safe_value')
  assert.equal(normalizeOpenAIPrompt('Summarize this'), 'Summarize this')
  assert.equal(normalizeOpenAIModel(), DEFAULT_OPENAI_MODEL)
  assert.equal(normalizeOpenAIModel('gpt-5.6-luna'), 'gpt-5.6-luna')
  for (const key of ['', null, 'secret\nheader', 'x'.repeat(4097)]) {
    rejects(() => normalizeOpenAIAPIKey(key))
  }
  for (const prompt of ['', null, '\ud800', 'x'.repeat(100001)]) {
    rejects(() => normalizeOpenAIPrompt(prompt))
  }
  for (const model of ['', '../model', 'model header', 'x'.repeat(129)]) {
    rejects(() => normalizeOpenAIModel(model))
  }
})

test('assistant output must be one bounded JSON object with safe structure', () => {
  assert.deepEqual(parseOpenAIJsonResult({
    choices: [{ message: { content: '{"summary":"Safe","duration":1.25}' } }],
  }), { summary: 'Safe', duration: 1.25 })
  for (const response of [
    null,
    {},
    { choices: [] },
    { choices: [{ message: { content: '' } }] },
    { choices: [{ message: { content: 'not json' } }] },
    { choices: [{ message: { content: '[1,2]' } }] },
    { choices: [{ message: { content: `{"value":"${'x'.repeat(65537)}"}` } }] },
  ]) rejects(() => parseOpenAIJsonResult(response))
})

test('OpenAI server fails closed, seals configuration and uses the supported model', () => {
  const source = readFileSync(new URL('./openai_server.js', import.meta.url), 'utf8')
  const settings = readFileSync(
    new URL('../../api/globalsettings/server/methods.js', import.meta.url), 'utf8',
  )
  assert.match(source, /fetchOidcJson/u)
  assert.match(source, /OAuth\.openSecret/u)
  assert.match(source, /DEFAULT_OPENAI_MODEL/u)
  assert.match(source, /response_format/u)
  assert.doesNotMatch(source, /throw new Meteor\.Error\([^\n]+e\.message/u)
  assert.match(settings, /shouldSealGlobalSetting/u)
  assert.match(settings, /OAuth\.sealSecret\(setting\.value\)/u)
})
