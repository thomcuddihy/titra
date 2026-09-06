import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const script = readFileSync(
  new URL('../build-v7-mongo-archive.sh', import.meta.url),
  'utf8',
)

function readonlyValue(name) {
  const match = script.match(new RegExp(`^readonly ${name}='([^'\\r\\n]+)'$`, 'mu'))
  assert.ok(match, `missing readonly ${name}`)
  return match[1]
}

test('Mongo dependency is pinned to one reviewed 7.0.40 Linux/amd64 image', () => {
  const sourceRef = readonlyValue('SOURCE_REF')
  const runtimeSourceRef = readonlyValue('RUNTIME_SOURCE_REF')
  const sourceIndexId = readonlyValue('SOURCE_INDEX_ID')
  const runtimeManifestId = readonlyValue('RUNTIME_MANIFEST_ID')
  const attestationManifestId = readonlyValue('ATTESTATION_MANIFEST_ID')

  assert.match(sourceRef, /^mongo:7[.]0[.]40@sha256:[0-9a-f]{64}$/u)
  assert.match(runtimeSourceRef, /^mongo:7[.]0[.]40@sha256:[0-9a-f]{64}$/u)
  assert.equal(sourceRef.split('@')[1], sourceIndexId)
  assert.equal(runtimeSourceRef.split('@')[1], runtimeManifestId)
  assert.match(attestationManifestId, /^sha256:[0-9a-f]{64}$/u)
  assert.notEqual(attestationManifestId, runtimeManifestId)
  assert.equal(readonlyValue('ARCHIVE_REF'), 'mongo:7.0.40')
  assert.equal(readonlyValue('ARCHIVE_NAME'), 'mongo-7.0.40-linux-amd64.tar.gz')
  assert.doesNotMatch(script, /:latest\b/u)
})

test('registry index, runtime child, platform, and local tag are checked before save', () => {
  const rawIndexAt = script.indexOf('buildx imagetools inspect --raw "$SOURCE_REF"')
  const indexDigestAt = script.indexOf('Mongo source-index bytes differ from the reviewed digest')
  const pullAt = script.indexOf('pull --platform linux/amd64 "$RUNTIME_SOURCE_REF"')
  const runtimeIdentityAt = script.indexOf('Pulled Mongo image differs from the reviewed runtime manifest')
  const platformAt = script.indexOf("[[ $platform == 'linux/amd64' ]]")
  const collisionAt = script.indexOf('Existing ${ARCHIVE_REF} tag is neither the reviewed source index nor runtime image')
  const saveAt = script.indexOf('image save "$ARCHIVE_REF" | gzip --best')

  assert.ok(rawIndexAt >= 0)
  assert.ok(indexDigestAt > rawIndexAt)
  assert.ok(pullAt > indexDigestAt)
  assert.ok(runtimeIdentityAt > pullAt)
  assert.ok(platformAt > runtimeIdentityAt)
  assert.ok(collisionAt > platformAt)
  assert.ok(saveAt > collisionAt)
  assert.match(script, /"platform"\) == \{"architecture": "amd64", "os": "linux"\}/u)
  assert.match(script, /vnd[.]docker[.]reference[.]type/u)
  assert.match(script, /vnd[.]docker[.]reference[.]digest/u)
})

test('archive and metadata are independently verified before atomic publication', () => {
  const saveAt = script.indexOf('image save "$ARCHIVE_REF" | gzip --best')
  const verifierCalls = [...script.matchAll(/python3 "\$ARCHIVE_VERIFIER"/gu)]
  const metadataAt = script.indexOf("printf 'format_version=1\\n'")
  const permissionAt = script.indexOf('chmod 0600 -- "$work_root"/*')
  const publishAt = script.indexOf('mv -- "$work_root" "$destination_absolute"')

  assert.equal(verifierCalls.length, 2)
  assert.equal(
    [...script.matchAll(/--expected-attestation-id "\$ATTESTATION_MANIFEST_ID"/gu)].length,
    2,
  )
  assert.match(script, /--identity-output "\$identity"/u)
  assert.ok(verifierCalls[0].index > saveAt)
  assert.ok(verifierCalls[1].index > verifierCalls[0].index)
  assert.ok(metadataAt > verifierCalls[1].index)
  assert.ok(permissionAt > metadataAt)
  assert.ok(publishAt > permissionAt)
  for (const key of [
    'format_version',
    'source_ref',
    'archive_ref',
    'build_engine_image_id',
    'config_image_id',
    'archive_sha256',
    'created_at_utc',
  ]) {
    assert.match(script, new RegExp(`printf '${key}=`))
  }
  assert.match(script, /Destination already exists; review it rather than overwrite/u)
  assert.match(script, /mktemp -d "\$\{destination_parent\}\/\.mongo-7[.]0[.]40-build[.]XXXXXXXX"/u)
  assert.match(script, /rm -rf --one-file-system -- "\$resolved"/u)
})

test('operator-selected Docker executable and destination remain portable inputs', () => {
  assert.match(script, /docker_bin=\$\{DOCKER_BIN:-docker\}/u)
  assert.match(script, /--docker/u)
  assert.match(script, /--destination/u)
  assert.match(script, /DEFAULT_DESTINATION="\$\{SCRIPT_DIR\}\/dist-v7-mongo"/u)
  assert.match(script, /ARCHIVE_VERIFIER="\$\{SCRIPT_DIR\}\/remote-test-v7\/tests\/verify_docker_save_archive[.]py"/u)
  assert.doesNotMatch(script, /(?:\/home\/|[A-Za-z]:\\Users\\)[A-Za-z0-9._-]+/u)
})
