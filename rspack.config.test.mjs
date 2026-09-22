import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import vm from 'node:vm'

const source = readFileSync(new URL('./rspack.config.js', import.meta.url), 'utf8')
function configuration(Meteor, env = {}) {
  const context = vm.createContext({
    module: { exports: {} },
    __dirname: '/fixture/titra',
    process: { env },
    require(name) {
      if (name === '@meteorjs/rspack') return { defineConfig: config => config }
      if (name === 'path') return path
      throw new Error(`Unexpected dependency ${name}`)
    },
  })
  vm.runInContext(source, context)
  return context.module.exports(Meteor)
}

test('production browser chunks use final-content hashes, not reusable graph hashes', () => {
  const config = configuration({ isClient: true, isProduction: true })
  assert.equal(config.output.chunkFilename, 'build-chunks/[id].[contenthash].js')
  assert.equal(config.optimization.realContentHash, true)
  assert.doesNotMatch(config.output.chunkFilename, /\[chunkhash\]/)
  assert.equal(config.output.filename, undefined, 'Meteor still owns its entry filename')
})

test('client chunk fix leaves development and server output decisions to Meteor', () => {
  for (const Meteor of [
    { isClient: true, isProduction: false },
    { isClient: false, isServer: true, isProduction: true },
  ]) {
    const config = configuration(Meteor)
    assert.equal(config.output, undefined)
    assert.equal(config.optimization, undefined)
  }
})

test('content-hashed chunks preserve explicit and isolated Meteor output contexts', () => {
  const production = { isClient: true, isProduction: true }
  const cases = [
    [{ ...production, chunksContext: 'custom-chunks' }, { RSPACK_CHUNKS_CONTEXT: 'ignored' }, 'custom-chunks'],
    [production, { RSPACK_CHUNKS_CONTEXT: 'environment-chunks' }, 'environment-chunks'],
    [production, { METEOR_LOCAL_DIR: '/fixture/.meteor/local-test' }, 'build-chunks-local-test'],
    [production, { METEOR_LOCAL_DIR: 'C:\\fixture\\.meteor\\local-test' }, 'build-chunks-local-test'],
  ]
  for (const [Meteor, env, directory] of cases) {
    assert.equal(configuration(Meteor, env).output.chunkFilename, `${directory}/[id].[contenthash].js`)
  }
})
