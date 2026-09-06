import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const rootFile = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

const securityVariables = [
  'TITRA_OAUTH_SECRET_KEY',
  'TITRA_PRIVATE_INTEGRATION_HOSTS',
  'TITRA_ALLOW_LOOPBACK_HTTP_INTEGRATIONS',
  'TITRA_OIDC_ALLOW_INSECURE_LOOPBACK',
  'TITRA_OIDC_ALLOW_VERIFIED_EMAIL_LINKING',
  'TITRA_ENABLE_UNSAFE_LEGACY_SCRIPTS',
  'TITRA_ENABLE_HSTS',
  'TITRA_OPENAI_MODEL',
  'TITRA_ENABLE_FIRST_USER_ADMIN',
  'TITRA_ENABLE_ADMIN_RECOVERY',
]

test('Compose passes every documented security setting without embedding a value', async () => {
  const [compose, example, securityGuide] = await Promise.all([
    rootFile('docker-compose.yml'),
    rootFile('.env.example'),
    rootFile('SECURITY.md'),
  ])

  for (const variable of securityVariables) {
    assert.match(compose, new RegExp(`- ${variable}=\\$\\{${variable}:-}`))
    assert.match(example, new RegExp(`^${variable}=`, 'm'))
    assert.ok(securityGuide.includes(`\`${variable}\``))
  }

  assert.doesNotMatch(example, /^TITRA_OAUTH_SECRET_KEY=\S+/m)
  assert.match(securityGuide, /exact lowercase value `true`/)
  assert.match(securityGuide, /mode `0600`/)
})
