// Run with the platform's installed native Rspack binding:
// node deployment/tests/rspack-chunk-cache.mjs
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { rspack } from '@rspack/core'

const root = fileURLToPath(new URL('../../', import.meta.url))
const scope = vm.createContext({
  module: { exports: {} }, __dirname: root, process: { env: {} },
  require(name) {
    if (name === '@meteorjs/rspack') return { defineConfig: config => config }
    if (name === 'path') return path
    throw new Error(`Unexpected config dependency: ${name}`)
  },
})
vm.runInContext(await readFile(path.join(root, 'rspack.config.js'), 'utf8'), scope)
const actual = scope.module.exports({ isClient: true, isProduction: true })
assert.match(actual.output.chunkFilename, /\[contenthash\]/)
assert.equal(actual.optimization.realContentHash, true)

const fixture = await mkdtemp(path.join(tmpdir(), 'titra-chunk-cache-'))
try {
  await writeFile(path.join(fixture, 'entry.js'), 'export const load = () => import(/* webpackChunkName: "locale" */ "./locale.js");\n')
  await writeFile(path.join(fixture, 'locale.js'), 'module.exports = { name: "en-gb", weekdaysMin: ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"] };\n')

  async function compile(moduleIds, chunkFilename, label) {
    const outputPath = path.join(fixture, label)
    const compiler = rspack({
      mode: 'production', target: 'web', context: fixture, entry: './entry.js',
      output: { path: outputPath, filename: 'entry.js', chunkFilename, publicPath: '/' },
      optimization: { moduleIds, chunkIds: 'named', realContentHash: actual.optimization.realContentHash },
    })
    try {
      const stats = await new Promise((resolve, reject) => compiler.run((error, result) => error ? reject(error) : resolve(result)))
      assert.equal(stats.hasErrors(), false, stats.toString({ all: false, errors: true }))
    } finally {
      await new Promise((resolve, reject) => compiler.close(error => error ? reject(error) : resolve()))
    }
    const [filename] = (await readdir(path.join(outputPath, 'build-chunks'))).filter(name => name.endsWith('.js'))
    return { filename, bytes: await readFile(path.join(outputPath, 'build-chunks', filename), 'utf8') }
  }

  // Only module-ID assignment changes; the imported locale source stays equal.
  const oldGraphHash = await compile('natural', 'build-chunks/[id].[chunkhash].js', 'old-graph-hash')
  const newGraphHash = await compile('deterministic', 'build-chunks/[id].[chunkhash].js', 'new-graph-hash')
  assert.notEqual(oldGraphHash.bytes, newGraphHash.bytes)
  console.log(`Graph-hash fixture collision reproduced: ${oldGraphHash.filename === newGraphHash.filename}`)

  const oldContentHash = await compile('natural', actual.output.chunkFilename, 'old-content-hash')
  const newContentHash = await compile('deterministic', actual.output.chunkFilename, 'new-content-hash')
  assert.notEqual(oldContentHash.bytes, newContentHash.bytes)
  assert.notEqual(oldContentHash.filename, newContentHash.filename,
    'Changed module IDs must not reuse the URL of a cached incompatible chunk')
  assert.equal(oldContentHash.bytes, oldGraphHash.bytes)
  assert.equal(newContentHash.bytes, newGraphHash.bytes)
  console.log(`PASS: identical locale source with changed module IDs gets distinct URLs: ${oldContentHash.filename}, ${newContentHash.filename}`)
} finally {
  await rm(fixture, { recursive: true, force: true })
}
