import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('./vm_sandbox.js', import.meta.url), 'utf8')
  .replace("import { Meteor } from 'meteor/meteor'", `
    const Meteor = { Error: class MeteorError extends Error {
      constructor(code, message) { super(message); this.error = code }
    } }
  `)
const { NodeSandbox, validateSandboxCode } = await import(
  `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`,
)

test('upstream Script syntax validation accepts rule bodies without executing them', () => {
  assert.doesNotThrow(() => validateSandboxCode('return true;'))
  assert.doesNotThrow(() => validateSandboxCode('throw new Error("not executed");'))
  assert.throws(() => validateSandboxCode('return (;'), { error: 'syntax-error' })
})

test('upstream property-chain checks reject known legacy sandbox escape forms', () => {
  for (const code of [
    'return this["constructor"];',
    'return this["process"];',
    'return this.Function;',
    'return Function["constructor"];',
    'return process["arbitraryProperty"];',
  ]) {
    assert.throws(() => validateSandboxCode(code), {
      error: 'malicious-code-detected',
    }, code)
  }
})

test('legacy sandbox no longer exposes fs even through an explicit or wildcard allowlist', () => {
  for (const allowed of [['*'], ['fs']]) {
    const requireModule = NodeSandbox.prototype.createRequireFunction(allowed)
    assert.throws(() => requireModule('fs'), /Module 'fs' is not allowed/)
  }
})
