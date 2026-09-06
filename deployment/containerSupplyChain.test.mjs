import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const text = async (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

test('Docker build inputs and Meteor release are pinned consistently', async () => {
  const [dockerfile, meteorRelease] = await Promise.all([
    text('Dockerfile'),
    text('.meteor/release'),
  ])
  const fromLines = dockerfile.split('\n').filter((line) => line.startsWith('FROM '))
  assert.equal(fromLines.length, 3)
  fromLines.forEach((line) => assert.match(line, /@sha256:[a-f0-9]{64}(?:\s|$)/))
  assert.doesNotMatch(dockerfile, /install\.meteor\.com|gobinaries\.com|node-prune/)
  assert.doesNotMatch(dockerfile, /\bnpm\s+audit\b/)
  const configured = dockerfile.match(/^ARG METEOR_RELEASE=([^\s]+)$/m)?.[1]
  assert.equal(`METEOR@${configured}`, meteorRelease.trim())
  assert.match(dockerfile, /tr -d '\\r\\n' < \.meteor\/release/)
  assert.match(dockerfile, /^ARG METEOR_INSTALLER_RELEASE=3\.5$/m)
  assert.match(dockerfile, /Meteor \$\{METEOR_INSTALLER_RELEASE\}/)
  assert.match(dockerfile, /Meteor \$\{METEOR_RELEASE\}/)
  assert.match(dockerfile, /^ARG METEOR_INSTALLER_SHA512=sha512-[A-Za-z0-9+/]+={0,2}$/m)
  assert.match(dockerfile, /Meteor installer integrity mismatch/)
  assert.match(dockerfile, /PATH=\/root\/\.meteor:\$\{PATH\}/)
  assert.match(dockerfile, /meteor node -p 'process\.versions\.modules'/)
  assert.match(dockerfile, /org\.opencontainers\.image\.version=/)
  assert.match(dockerfile, /org\.opencontainers\.image\.revision=/)
  assert.match(dockerfile, /^ARG TITRA_VERSION$/m)
  assert.match(dockerfile, /^ARG VCS_REF$/m)
  assert.match(dockerfile, /^ARG SOURCE_CONTEXT_SHA256$/m)
  assert.match(dockerfile, /org\.opencontainers\.image\.source="https:\/\/github\.com\/titraio\/titra"/)
  assert.match(dockerfile, /io\.titra\.source-context\.sha256="\$\{SOURCE_CONTEXT_SHA256\}"/)
  assert.match(dockerfile, /\^\[0-9a-f\]\{40\}\$/)
  assert.match(dockerfile, /\^\[0-9a-f\]\{64\}\$/)
  assert.doesNotMatch(dockerfile, /^ARG (?:TITRA_VERSION|VCS_REF|SOURCE_CONTEXT_SHA256)=/m)
  assert.match(dockerfile, /^USER node$/m)
  assert.match(dockerfile, /^HEALTHCHECK /m)
  assert.match(dockerfile, /^ENTRYPOINT \["\/docker\/entrypoint\.sh"\]$/m)
  assert.match(dockerfile, /^CMD \["node", "bundle\/main\.js"\]$/m)
})

test('package and lock root metadata describe the same release', async () => {
  const [manifest, lock] = await Promise.all([
    text('package.json').then(JSON.parse),
    text('package-lock.json').then(JSON.parse),
  ])
  assert.equal(lock.name, manifest.name)
  assert.equal(lock.version, manifest.version)
  assert.equal(lock.packages[''].name, manifest.name)
  assert.equal(lock.packages[''].version, manifest.version)
})

test('Meteor server runtime has a complete integrity-pinned shrinkwrap', async () => {
  const [dockerfile, lock] = await Promise.all([
    text('Dockerfile'),
    text('deployment/security-v7/runtime/server/npm-shrinkwrap.json').then(JSON.parse),
  ])
  assert.equal(lock.lockfileVersion, 3)
  assert.equal(lock.name, 'meteor-dev-bundle')
  assert.equal(lock.packages?.['']?.dependencies?.['@mapbox/node-pre-gyp'], '2.0.3')
  assert.equal(lock.packages?.['']?.dependencies?.['node-gyp'], '13.0.2')
  assert.ok(lock.packages?.['node_modules/@mapbox/node-pre-gyp'])
  assert.ok(lock.packages?.['node_modules/node-gyp'])
  for (const [path, value] of Object.entries(lock.packages ?? {})) {
    if (!path || !value.resolved) continue
    assert.match(value.resolved, /^https:\/\//, `${path} must resolve over HTTPS`)
    assert.match(value.integrity ?? '', /^sha(?:1|256|384|512)-/, `${path} needs integrity`)
  }
  assert.match(
    dockerfile,
    /COPY deployment\/security-v7\/runtime\/server\/ \/app\/server-runtime\//,
  )
  assert.match(
    dockerfile,
    /cp server-runtime\/npm-shrinkwrap\.json bundle\/programs\/server\/npm-shrinkwrap\.json/,
  )
  assert.match(dockerfile, /npm ci --omit=dev --prefer-offline --no-audit --no-fund/)
})

test('Meteor email runtime has a versioned integrity-pinned overlay', async () => {
  const [manifest, lock] = await Promise.all([
    text('deployment/security-v7/runtime/email/package.json').then(JSON.parse),
    text('deployment/security-v7/runtime/email/npm-shrinkwrap.json').then(JSON.parse),
  ])
  assert.equal(manifest.name, 'meteor-email-runtime')
  assert.equal(manifest.version, '9.1.1')
  assert.equal(lock.name, manifest.name)
  assert.equal(lock.version, manifest.version)
  assert.equal(lock.packages?.['']?.name, manifest.name)
  assert.equal(lock.packages?.['']?.version, manifest.version)
  for (const [path, value] of Object.entries(lock.packages ?? {})) {
    if (!path || !value.resolved) continue
    assert.match(value.resolved, /^https:\/\//, `${path} must resolve over HTTPS`)
    assert.match(value.integrity ?? '', /^sha(?:1|256|384|512)-/, `${path} needs integrity`)
  }
})

test('secure Compose recipe requires a digest-pinned candidate and drops privilege', async () => {
  const [compose, wrapper, legacyAutoUpdate] = await Promise.all([
    text('docker-compose.v7-secure.yml'),
    text('deployment/run-v7-secure-compose.sh'),
    text('docker-compose-auto-update.yml'),
  ])
  assert.match(compose, /TITRA_IMAGE[^\n]+image@sha256 digest/)
  assert.match(compose, /mongo:7\.0\.40@sha256:[a-f0-9]{64}/)
  assert.match(compose, /read_only: true/)
  assert.match(compose, /no-new-privileges:true/)
  assert.match(compose, /cap_drop:\s*\n\s*- ALL/)
  assert.match(compose, /127\.0\.0\.1:\$\{TITRA_BIND_PORT/)
  assert.match(wrapper, /repository@sha256/)
  assert.match(wrapper, /sha256:\[a-f0-9\]\{64\}/)
  assert.match(wrapper, /secrets file mode must be 0400 or 0600/i)
  assert.match(wrapper, /secrets file must be owned by root/i)
  assert.match(wrapper, /ROOT_URL must be an explicit (?:nonempty )?HTTPS URL/)
  assert.match(legacyAutoUpdate, /profiles:\s*\n\s*- unsafe-auto-update/)
  assert.match(legacyAutoUpdate, /Deprecated for production/)
})

test('Docker context is deny-by-default and admits only reviewed source roots', async () => {
  const [gitignore, dockerignore] = await Promise.all([
    text('.gitignore'),
    text('.dockerignore'),
  ])
  for (const pattern of ['.env', '*.pem', '*.key', 'secrets/', 'credentials/']) {
    assert.match(gitignore, new RegExp(`^${pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'))
  }

  const rules = dockerignore
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
  assert.equal(rules[0], '*')
  const expectedInputs = [
    '!Dockerfile',
    '!.dockerignore',
    '!entrypoint.sh',
    '!package.json',
    '!package-lock.json',
    '!rspack.config.js',
    '!deployment/',
    '!deployment/security-v7/',
    '!deployment/security-v7/eslint-build.config.mjs',
    '!deployment/security-v7/remove-bundled-vulnerabilities.mjs',
    '!deployment/security-v7/runtime/',
    '!deployment/security-v7/runtime/**',
    '!public/',
    '!public/**',
    '!server/',
    '!server/**',
    '!client/',
    '!client/**',
    '!imports/',
    '!imports/**',
    '!.meteor/',
    '!.meteor/**',
  ]
  const admittedInputs = rules.filter((rule) => rule.startsWith('!'))
  assert.deepEqual(admittedInputs, expectedInputs)
  for (const excluded of [
    '.meteor/local/',
    '.meteor/local/**',
    '**/.env',
    '**/.env.*',
    '**/*.pem',
    '**/*.key',
    '**/*.p12',
    '**/*.pfx',
    '**/*.jks',
    '**/secrets/',
    '**/secrets/**',
    '**/credentials/',
    '**/credentials/**',
  ]) assert.ok(rules.includes(excluded), `missing sensitive/generated exclusion: ${excluded}`)
})

test('v7 image builder hashes exactly the hardening files admitted to Docker', async () => {
  const [builder, dockerfile] = await Promise.all([
    text('deployment/build-v7-image.sh'),
    text('Dockerfile'),
  ])

  assert.match(builder, /readonly DEFAULT_REPOSITORY='local\/titra'/)
  assert.match(builder, /readonly DEFAULT_BUILD_VARIANT='hardened1'/)
  assert.match(builder, /--build-variant/)
  assert.match(builder, /TITRA_BUILD_VARIANT/)
  assert.doesNotMatch(builder, /issue250-v7|security1/)
  assert.match(
    builder,
    /"deployment\/security-v7\/eslint-build\.config\.mjs"/,
  )
  assert.match(
    builder,
    /"deployment\/security-v7\/remove-bundled-vulnerabilities\.mjs"/,
  )
  assert.match(builder, /"deployment\/security-v7\/runtime"/)
  assert.doesNotMatch(builder, /^\s+"deployment\/security-v7",$/m)
  assert.match(builder, /build context changed while the image was being built/i)
  assert.match(builder, /--platform=linux\/amd64/)
  assert.match(builder, /--provenance=false/)
  assert.match(builder, /--sbom=false/)
  assert.match(builder, /--pull=false/)
  assert.match(builder, /--network=none/)
  assert.match(builder, /credential-like environment name/)
  assert.match(builder, /--require-portable-candidate/)
  assert.match(dockerfile, /COPY deployment\/security-v7\/eslint-build\.config\.mjs/)
  assert.match(
    dockerfile,
    /meteor npm exec -- eslint \\\s+--config deployment\/security-v7\/eslint-build\.config\.mjs \\\s+client server imports/,
  )
  assert.match(dockerfile, /COPY deployment\/security-v7\/runtime\/server\//)
  assert.match(dockerfile, /COPY deployment\/security-v7\/runtime\/email\//)
  assert.match(dockerfile, /COPY deployment\/security-v7\/remove-bundled-vulnerabilities\.mjs/)
})
