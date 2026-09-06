import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const files = [
  'package-lock.json',
  'deployment/security-v7/runtime/meteor-installer/npm-shrinkwrap.json',
  'deployment/security-v7/runtime/server/npm-shrinkwrap.json',
  'deployment/security-v7/runtime/email/npm-shrinkwrap.json',
]

const floors = new Map([
  ['browserslist', '4.28.8'],
  ['fast-uri', '4.1.4'],
  ['nanoid', '6.0.1'],
  ['nodemailer', '9.0.1'],
  ['postcss', '8.5.27'],
  ['qs', '6.16.0'],
  ['svgo', '4.1.0'],
  ['tar', '7.5.22'],
  ['tmp', '0.2.7'],
  ['underscore', '1.13.8'],
])

function compareVersions(left, right) {
  const a = left.split(/[.+-]/u).map((part) => Number.parseInt(part, 10) || 0)
  const b = right.split(/[.+-]/u).map((part) => Number.parseInt(part, 10) || 0)
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    if ((a[index] || 0) !== (b[index] || 0)) return (a[index] || 0) - (b[index] || 0)
  }
  return 0
}

function packageName(path) {
  const marker = 'node_modules/'
  const index = path.lastIndexOf(marker)
  return index < 0 ? '' : path.slice(index + marker.length)
}

for (const file of files) {
  const lock = JSON.parse(await readFile(file, 'utf8'))
  assert.equal(lock.lockfileVersion, 3, `${file} must use lockfileVersion 3`)
  for (const [path, metadata] of Object.entries(lock.packages || {})) {
    if (!path || !metadata.version) continue
    const name = packageName(path)
    const floor = floors.get(name)
    const bundledQs = file === 'package-lock.json'
      && path === 'node_modules/meteor-node-stubs/node_modules/qs'
      && metadata.inBundle === true
    if (floor && !bundledQs) {
      assert.ok(
        compareVersions(metadata.version, floor) >= 0,
        `${file}: ${path}@${metadata.version} is below the reviewed floor ${floor}`,
      )
    }
    if (name === 'openpgp') {
      assert.equal(
        metadata.version,
        '6.3.1',
        `${file}: ${path} must use the reviewed supported OpenPGP release`,
      )
    }
    if (metadata.resolved?.startsWith('https://registry.npmjs.org/')) {
      assert.match(metadata.integrity || '', /^sha512-/u, `${file}: ${path} lacks SHA-512 integrity`)
    }
    assert.ok(!metadata.resolved?.startsWith('http:'), `${file}: ${path} uses cleartext resolution`)
  }
}

const packageManifest = JSON.parse(await readFile('package.json', 'utf8'))
assert.equal(packageManifest.dependencies.qs, '6.16.0')
assert.equal(packageManifest.overrides.qs, '6.16.0')
assert.equal(packageManifest.overrides['fast-uri'], '4.1.4')
assert.equal(packageManifest.dependencies.tmp, '0.2.7')
assert.equal(packageManifest.overrides.tmp, '0.2.7')

const emailManifest = JSON.parse(await readFile(
  'deployment/security-v7/runtime/email/package.json', 'utf8',
))
assert.equal(emailManifest.overrides.openpgp, '6.3.1')

const dockerfile = await readFile('Dockerfile', 'utf8')
assert.match(dockerfile, /^FROM node:24\.20\.0@sha256:[a-f0-9]{64} AS builder$/mu)
assert.match(dockerfile, /^FROM node:24\.20\.0-alpine@sha256:[a-f0-9]{64} AS (dependencies|runtime)$/mu)
assert.match(dockerfile, /node \/app\/remove-bundled-vulnerabilities\.mjs/u)
assert.doesNotMatch(dockerfile, /curl\s+[^\n]*\|\s*(sh|bash)/u)

const compose = await readFile('docker-compose.yml', 'utf8')
assert.match(compose, /image: mongo:7\.0\.40@sha256:[a-f0-9]{64}/u)
assert.doesNotMatch(compose, /TITRA_ALLOW_LOOPBACK_HTTP_INTEGRATIONS/u)
assert.doesNotMatch(compose, /TITRA_ENABLE_FIRST_USER_ADMIN=true/u)

console.log('Dependency policy check passed: 4 locks, pinned runtimes, supported OpenPGP, safe compose defaults, and known-version floors verified.')
