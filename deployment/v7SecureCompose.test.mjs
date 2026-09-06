import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const text = async (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

test('v7 reference Compose is immutable and applies container isolation defaults', async () => {
  const [compose, wrapper] = await Promise.all([
    text('docker-compose.v7-secure.yml'),
    text('deployment/run-v7-secure-compose.sh'),
  ])

  assert.match(compose, /TITRA_IMAGE[^\n]+verified v7 image@sha256 digest/)
  assert.match(compose, /mongo:7\.0\.40@sha256:[a-f0-9]{64}/)
  assert.match(compose, /127\.0\.0\.1:\$\{TITRA_BIND_PORT/)
  assert.match(compose, /read_only: true/)
  assert.match(compose, /no-new-privileges:true/)
  assert.match(compose, /cap_drop:\s*\n\s*- ALL/)
  assert.match(compose, /\/tmp:rw,noexec,nosuid,nodev,size=64m/)
  assert.match(compose, /condition: service_healthy/)
  assert.doesNotMatch(compose, /TITRA_ALLOW_LOOPBACK_HTTP_INTEGRATIONS/)

  assert.match(wrapper, /canonical immutable repository@sha256 reference/)
  assert.match(wrapper, /Secrets file is absent, not regular, or is a symbolic link/)
  assert.match(wrapper, /secrets file must be owned by root/i)
  assert.match(wrapper, /secrets file mode must be 0400 or 0600/i)
  assert.match(wrapper, /ROOT_URL must be an explicit nonempty HTTPS URL/)
  assert.match(wrapper, /TITRA_BIND_PORT must be an integer from 1 to 65535/)
})
