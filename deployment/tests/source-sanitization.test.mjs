import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, extname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const deploymentRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const self = fileURLToPath(import.meta.url)

function filesBelow(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    return entry.isDirectory() ? filesBelow(path) : [path]
  })
}

test('only an unrendered release manifest is tracked', () => {
  assert.equal(existsSync(join(deploymentRoot, 'remote-test-v7/manifest/release.env')), false)
  const template = join(deploymentRoot, 'remote-test-v7/manifest/release.env.in')
  assert.equal(statSync(template).isFile(), true)
  assert.match(readFileSync(template, 'utf8'), /__V7_PACKAGE_RELEASE_ID__/)
  assert.match(readFileSync(template, 'utf8'), /__V7_RELEASE_PROFILE__/)
})

test('release profiles are explicit and local release inputs are ignored', () => {
  const builder = readFileSync(join(deploymentRoot, 'build-v7-release.sh'), 'utf8')
  const ignore = readFileSync(join(deploymentRoot, '.gitignore'), 'utf8')
  assert.match(builder, /release_profile='hardened'/)
  assert.match(builder, /--release-profile/)
  assert.match(builder, /ctx\$\{source_context_sha:0:12\}-\$\{release_profile\}-amd64/)
  assert.match(ignore, /^release-config[.]\*$/m)
  assert.match(ignore, /^remote-test-v7\/manifest\/release[.]env$/m)
  assert.match(ignore, /^[.]env[.]\*$/m)
})

test('release builder supplies every tracked template token', () => {
  const builder = readFileSync(join(deploymentRoot, 'build-v7-release.sh'), 'utf8')
  const tokenPattern = /__V7_[A-Za-z0-9_]+__/gu
  const templateFiles = filesBelow(deploymentRoot).filter((path) =>
    !path.includes(`${join('deployment', 'tests')}`)
      && /(?:[.]in|[.]sh|[.]yml)$/u.test(path),
  )
  const tokens = new Set(templateFiles.flatMap((path) =>
    readFileSync(path, 'utf8').match(tokenPattern) ?? [],
  ))
  for (const token of tokens) {
    assert.match(builder, new RegExp(token), `builder does not supply ${token}`)
  }
})

test('source tree contains no generated or private deployment material', () => {
  const forbiddenExtensions = new Set(['.log', '.pyc', '.receipt'])
  const forbiddenNames = /(?:^|\/)(?:dist-v[^/]*|test-artifacts|verification-v[^/]*|__pycache__)(?:\/|$)/u
  const archiveName = /[.](?:tar|tar[.]gz|tgz)(?:[.]sha256)?$/u
  for (const path of filesBelow(deploymentRoot)) {
    const name = relative(deploymentRoot, path).replaceAll('\\', '/')
    assert.equal(forbiddenNames.test(name), false, `generated path tracked: ${name}`)
    assert.equal(forbiddenExtensions.has(extname(name)), false, `private output tracked: ${name}`)
    assert.equal(archiveName.test(name), false, `archive tracked: ${name}`)
  }
})

test('templates contain no rendered host, personal path, image ID, or fork identity', () => {
  const checks = [
    /github[.]com\/(?!titraio\/titra(?:[/'"\s]|$))/iu,
    /(?:\/home\/|[A-Za-z]:\\Users\\)[A-Za-z0-9._-]+/u,
    /sha256:[0-9a-f]{64}/u,
  ]
  for (const path of filesBelow(deploymentRoot)) {
    if (path === self || /test_verify_docker_save_archive[.]py$/u.test(path)) continue
    if (!/\.(?:sh|in|mjs|cjs|py|md|yml|example)$/u.test(path)) continue
    const text = readFileSync(path, 'utf8')
    for (const check of checks) {
      assert.equal(check.test(text), false, `rendered/private value in ${relative(deploymentRoot, path)}`)
    }
  }
})
