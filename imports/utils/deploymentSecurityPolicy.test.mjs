import assert from 'node:assert/strict'
import test from 'node:test'

import {
  exactRuntimeBoolean,
  normalizeFrameAncestorOrigin,
} from './deploymentSecurityPolicy.js'

test('runtime feature toggles require an exact true value', () => {
  assert.equal(exactRuntimeBoolean(true), true)
  assert.equal(exactRuntimeBoolean('true'), true)
  for (const value of [false, 'false', 'TRUE', 1, {}, null, undefined]) {
    assert.equal(exactRuntimeBoolean(value), false)
  }
})

test('frame ancestors accept one exact HTTP(S) origin and reject CSP syntax injection', () => {
  assert.equal(normalizeFrameAncestorOrigin(undefined), undefined)
  assert.equal(normalizeFrameAncestorOrigin(''), undefined)
  assert.equal(normalizeFrameAncestorOrigin('https://portal.example.test'), 'https://portal.example.test')
  assert.equal(normalizeFrameAncestorOrigin('https://portal.example.test:8443/'), 'https://portal.example.test:8443')
  assert.equal(normalizeFrameAncestorOrigin('http://intranet.example.test'), 'http://intranet.example.test')
  for (const value of [
    "'self' https://attacker.example", '*', 'data:text/html,unsafe',
    'https://portal.example.test/path', 'https://portal.example.test/?next=unsafe',
    'https://user:password@portal.example.test', ' https://portal.example.test', 4,
  ]) assert.throws(() => normalizeFrameAncestorOrigin(value), TypeError)
})
