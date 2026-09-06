import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import test from 'node:test'

const read = (relative) => readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8')
const common = read('root-scripts/common.sh')
const transition = read('root-scripts/v7-transition.sh')
const deploy = read('root-scripts/deploy-production-candidate.sh')
const backup = read('root-scripts/backup-production-db.sh')
const rollback = read('root-scripts/rollback-production-candidate.sh')
const preflight = read('root-scripts/preflight-production-deploy.sh')
const dataPreflight = read('root-scripts/preflight-v7-data-compatibility.sh')
const dataProbe = read('root-scripts/v7-data-compatibility-preflight.cjs')
const installer = read('root-scripts/install.sh')
const status = read('root-scripts/status.sh')
const loader = read('root-scripts/load-release-images.sh')
const runtime = read('root-scripts/configure-v7-runtime.sh')
const renderedManifest = new URL('../manifest/release.env', import.meta.url)
const manifest = existsSync(renderedManifest)
  ? readFileSync(renderedManifest, 'utf8')
  : read('manifest/release.env.in')
const consoleArgumentIndex = process.argv.indexOf('--console-source')
const consolePath = process.env.TITRA_R7_CONSOLE_SOURCE
  || (consoleArgumentIndex >= 0 ? process.argv[consoleArgumentIndex + 1] : '')
const consoleSource = consolePath
  ? readFileSync(consolePath, 'utf8')
  : readFileSync(new URL('../../remote-console-v7/titra-maintenance-console-r7.sh.in', import.meta.url), 'utf8')

test('r7 source is site-neutral and recognizes all approved transition identities', () => {
  assert.match(common, /INSTALL_ROOT='[^'\r\n]+'/)
  assert.match(installer, /DESTINATION='[^'\r\n]+'/)
  assert.match(manifest, /^RELEASE_FORMAT=7$/m)
  assert.match(manifest, /^RELEASE_PROFILE=[^\r\n]+$/m)
  assert.match(manifest, /^STOCK_IMAGE_ID=[^\r\n]+$/m)
  assert.match(manifest, /^V5_IMAGE_ID=[^\r\n]+$/m)
  assert.match(manifest, /^V6_IMAGE_ID=[^\r\n]+$/m)
  assert.match(manifest, /^V6_CONFIG_IMAGE_ID=[^\r\n]+$/m)
})

test('installer replaces only exhaustively verified packages and has no incident repair exception', () => {
  assert.doesNotMatch(installer, /REPAIRABLE_/)
  assert.match(installer, /Existing installation failed exhaustive checksum verification/)
  assert.match(installer, /acquire_install_exclusive_lock/)
  assert.match(installer, /mv -- "\$DESTINATION" "\$previous"/)
  assert.match(installer, /mv -T -- "\$installing" "\$DESTINATION"/)
  assert.match(installer, /chmod 0640 -- "\$\{installing\}\/root-scripts\/common[.]sh" "\$\{installing\}\/lab\/lib[.]sh"/)
})

test('original production admission remains image-ID bound', () => {
  assert.match(transition, /image_id == "\$\(release_value STOCK_IMAGE_ID\)"/)
  assert.match(deploy, /source_ref=\$\(container_value "\$APP_CONTAINER" '\{\{\.Config\.Image\}\}'\)/)
  assert.doesNotMatch(deploy, /source_ref[^\n]*STOCK_IMAGE/)
})

test('only the four requested forward transitions are admitted', () => {
  assert.match(transition, /stock:v7\|v5:v6\|v5:v7\|v6:v7/)
  assert.match(preflight, /validate_transition "\$source_kind" "\$target"/)
  assert.match(deploy, /validate_transition "\$source_kind" "\$target"/)
  assert.doesNotMatch(transition, /stock:v6|v6:v6|v7:v7/)
})

test('image loading is local, checksum-bound, and never pulls or starts containers', () => {
  assert.match(loader, /docker image load --input "\$v6_archive"/)
  assert.match(loader, /docker image load --input "\$v7_archive"/)
  assert.match(loader, /docker image load --input "\$mongo_archive"/)
  assert.match(loader, /sha256sum --check --strict SHA256SUMS/)
  assert.doesNotMatch(loader, /docker (?:pull|run|start|compose)/)
  assert.match(transition, /V7_LOADED_STATE="\$\{IMAGE_STATE_DIR\}\/loaded-v7[.]env"/)
  assert.doesNotMatch(transition, /v7\) printf[^\n]*LOADED_CANDIDATE_STATE/)
})

test('Mongo lab dependency is rendered from reviewed release inputs', () => {
  assert.match(manifest, /^MONGO_TEST_IMAGE=[^\r\n]+$/m)
  assert.match(manifest, /^MONGO_TEST_IMAGE_ID=[^\r\n]+$/m)
  assert.match(manifest, /^MONGO_CONFIG_IMAGE_ID=[^\r\n]+$/m)
  assert.match(manifest, /^MONGO_SOURCE_DIGEST=[^\r\n]+$/m)
  assert.match(manifest, /^MONGO_IMAGE_ARCHIVE=[^\r\n]+$/m)
})

test('v7 runtime key is generated once, hidden, and retained on configuration changes', () => {
  assert.match(installer, /if \[\[ -e \$V7_RUNTIME_CONFIG \|\| -L \$V7_RUNTIME_CONFIG \]\]/)
  assert.match(installer, /openssl rand -base64 16/)
  assert.match(installer, /oauth_secret_key=%s/)
  assert.match(runtime, /OAuth encryption key retained unchanged/)
  assert.match(runtime, /value hidden/)
  assert.doesNotMatch(status, /printf[^\n]*oauth_secret_key/)
})

test('private integration hosts are exact and passed only to v7', () => {
  assert.match(transition, /validate_private_integration_hosts/)
  assert.match(transition, /TITRA_PRIVATE_INTEGRATION_HOSTS/)
  assert.match(transition, /TITRA_OAUTH_SECRET_KEY/)
  assert.match(transition, /V6 intermediate must use only the single-instance recovery gate/)
  assert.match(transition, /Stock\/v5 source rollback override must omit v7-only security settings/)
  assert.doesNotMatch(transition, /TITRA_ALLOW_LOOPBACK_HTTP_INTEGRATIONS/)
})

test('temporary admin bootstrap and recovery flags fail closed', () => {
  assert.match(transition, /validate_no_unsafe_production_bootstrap_flags/)
  assert.match(transition, /TITRA_ENABLE_\(FIRST_USER_ADMIN\|ADMIN_RECOVERY\)/)
  assert.match(preflight, /validate_no_unsafe_production_bootstrap_flags/)
  assert.match(deploy, /validate_no_unsafe_production_bootstrap_flags/)
  assert.match(rollback, /validate_no_unsafe_production_bootstrap_flags/)
})

test('v7 cutover has count-only preview and stopped authoritative data gates', () => {
  assert.match(preflight, /preflight-v7-data-compatibility[.]sh" --preview/)
  assert.match(deploy, /preflight-v7-data-compatibility[.]sh" --require-app-stopped/)
  assert.match(dataPreflight, /LOCK_INHERITED == true/)
  assert.match(dataPreflight, /--quiet --norc --file \/dev\/stdin/)
  assert.match(dataPreflight, /> "\$output_file" 2>&1/)
  assert.match(dataPreflight, /marker_pattern\+='\$'/)
  assert.match(dataProbe, /TITRA_V7_DATA_COMPATIBILITY_PREFLIGHT/)
  assert.match(dataProbe, /MAX_CREDENTIAL_CANDIDATE_DOCUMENTS = 5000/)
  assert.match(dataProbe, /MAX_INTEGRATION_CANDIDATE_DOCUMENTS = 5000/)
  assert.match(dataProbe, /MAX_WEBHOOK_CONFIGURATION_DOCUMENTS = 1000/)
  assert.match(dataProbe, /verification_unrecoverable_pending/)
  assert.match(dataProbe, /secure_webhook_missing_secrets/)
  assert.match(dataProbe, /'credential_object_fields'/)
  assert.match(dataProbe, /'credential_oversized_plaintext_fields'/)
  assert.match(dataProbe, /'admin_inactive_flags_malformed'/)
  assert.match(dataProbe, /'dashboard_slug_key_shape_malformed'/)
  assert.match(dataProbe, /function verificationMalformedFlagsPipeline/)
  assert.match(dataProbe, /Treat every database-only active endpoint as unprovisioned/)
  assert.match(dataPreflight, /printf '%s\\n' "\$marker" >\/dev\/tty/)
  assert.match(dataPreflight, /ACKNOWLEDGE V7 DATA COMPATIBILITY WARNINGS/)
  assert.match(dataPreflight, /warning_digest=.*sha256sum/)
  assert.doesNotMatch(dataPreflight, /(?:cat|head|tail|sed)\s+"?\$output_file/)
})

test('deployment binds source image, database backup, target, and runtime fingerprint', () => {
  assert.match(deploy, /preserve_source_image "\$source_kind" "\$source_ref" "\$source_id"/)
  assert.match(deploy, /backup_archive_sha256=/)
  assert.match(deploy, /source_state_sha256=/)
  assert.match(deploy, /runtime_config_sha256=/)
  assert.match(deploy, /runtime_config_backup=/)
  assert.match(deploy, /capture-runtime-key-backup/)
  assert.match(deploy, /write_record "\$receipt_file" result 'SUCCEEDED'/)
  assert.match(backup, /--leave-app-stopped requires an inherited exclusive operator lock/)
  assert.match(backup, /Application handoff: exact source container remains stopped/)
  assert.match(deploy, /--leave-app-stopped --dry-run/)
  assert.match(deploy, /--leave-app-stopped \\[\r\n]+\s*--confirm/)
  assert.match(deploy, /== "\$expected_source_container"/)
  assert.match(deploy, /mongo_identity_snapshot 2>\/dev\/null \|\| true/)
  const stoppedWindow = deploy.slice(
    deploy.indexOf('assert_exact_app_stopped "$expected_source_container"',
      deploy.indexOf("current_phase='fresh-verified-predeploy-backup'")),
    deploy.indexOf("current_phase='application-switch'"),
  )
  assert.doesNotMatch(stoppedWindow, /docker (?:start|stop) /)
})

test('Mongo identity tolerates an omitted optional IPv6 address without weakening required network identity', () => {
  assert.doesNotMatch(common, /GlobalIPv7Address/)
  assert.match(common, /\{\{with index \$network "GlobalIPv6Address"\}\}/)
  assert.match(
    common,
    /\$name \$network[.]NetworkID \$network[.]EndpointID \$network[.]IPAddress/,
  )
  assert.match(common, /\[\[ -n \$mounts && -n \$networks \]\] \|\| die/)
})

test('Compose capabilities are proven read-only before any production inspection or mutation', () => {
  const capabilityStart = common.indexOf('validate_compose_cli_capabilities()')
  const capabilityEnd = common.indexOf('\n}\n\ncanonical_hostname()', capabilityStart)
  const capabilityGate = common.slice(capabilityStart, capabilityEnd)
  assert.ok(capabilityStart >= 0 && capabilityEnd > capabilityStart)
  assert.match(capabilityGate, /docker compose up --help/)
  for (const option of ['--pull', '--no-deps', '--force-recreate', '--detach', '--no-start']) {
    assert.match(capabilityGate, new RegExp(`'${option}'`))
  }
  assert.match(capabilityGate, /--env-file \/dev\/null/)
  assert.match(capabilityGate, /--project-name titra-r7-capability-probe/)
  assert.match(capabilityGate, /--file - \\\r?\n\s*config/)
  assert.match(capabilityGate, /pull_policy: never/)
  assert.doesNotMatch(
    capabilityGate.replace('docker compose up --help', ''),
    /docker (?:compose )?(?:create|run|start|stop|restart|up|down|pull|push|build|volume|network|image (?:load|rm)|container rm)\b/,
  )

  const contextStart = common.indexOf('validate_production_context()')
  const contextEnd = common.indexOf('\n}', contextStart)
  const productionContext = common.slice(contextStart, contextEnd)
  const runtimeAt = productionContext.indexOf('require_runtime_commands')
  const capabilityAt = productionContext.indexOf('validate_compose_cli_capabilities')
  const hostAt = productionContext.indexOf('validate_host')
  assert.ok(runtimeAt >= 0 && capabilityAt > runtimeAt && hostAt > capabilityAt)

  const recoveryStart = transition.indexOf('validate_production_recovery_context()')
  const recoveryEnd = transition.indexOf('\n}', recoveryStart)
  const recoveryContext = transition.slice(recoveryStart, recoveryEnd)
  const recoveryRuntimeAt = recoveryContext.indexOf('require_runtime_commands')
  const recoveryCapabilityAt = recoveryContext.indexOf('validate_compose_cli_capabilities')
  const recoveryHostAt = recoveryContext.indexOf('validate_host')
  assert.ok(
    recoveryRuntimeAt >= 0
      && recoveryCapabilityAt > recoveryRuntimeAt
      && recoveryHostAt > recoveryCapabilityAt,
  )
})

test('candidate failure after switch is fail-closed', () => {
  assert.match(deploy, /full-receipt-bound-rollback-required-app-left-stopped/)
  assert.match(deploy, /docker stop --time 60 "\$APP_CONTAINER"/)
  assert.doesNotMatch(deploy, /automatic.*application-only/i)
  assert.match(rollback, /receipt-bound failed post-switch attempt/)
  assert.match(rollback, /result == 'FAILED'/)
  assert.match(rollback, /full-receipt-bound-rollback-required-app-left-stopped/)
  assert.match(rollback, /stopped-application-pre-rollback-safety-backup/)
})

test('rollback is full database plus exact source, with no app-only escape hatch', () => {
  assert.match(rollback, /There is no\s+application-only rollback mode/)
  assert.match(rollback, /FULL ROLLBACK TITRA/)
  assert.match(rollback, /drop_production_database/)
  assert.match(rollback, /restore_archive_to_production "\$pinned_archive"/)
  assert.match(rollback, /ensure_preserved_source_loaded/)
  assert.match(rollback, /deployment_runtime_backup/)
  assert.match(rollback, /mv -- "\$runtime_restore_temporary" "\$V7_RUNTIME_CONFIG"/)
  assert.match(rollback, /database summary is not byte-for-byte identical/i)
  assert.doesNotMatch(rollback, /acknowledge-migrated-data-remains|WITHOUT DATABASE RESTORE/)
})

test('rollback takes a current-state safety backup before destructive restore', () => {
  const backupAt = rollback.indexOf("current_phase='fresh-current-state-safety-backup'")
  const stopAt = rollback.indexOf("current_phase='stop-target-and-recreate-source-stopped'")
  const restoreAt = rollback.indexOf("current_phase='destructive-database-restore'")
  assert.ok(backupAt >= 0 && stopAt > backupAt && restoreAt > stopAt)
  assert.match(rollback, /safety_backup_id=/)
  assert.match(rollback, /--leave-app-stopped --dry-run/)
  assert.match(rollback, /--leave-app-stopped \\[\r\n]+\s*--confirm/)
  assert.match(rollback, /exact-target-restarted-before-restore/)
  assert.match(rollback, /target_replacement_started == true/)
  const continuouslyStopped = rollback.slice(
    rollback.indexOf('assert_exact_app_stopped "$pre_restore_target_container_id"', backupAt),
    restoreAt,
  )
  assert.doesNotMatch(continuouslyStopped, /docker start /)
})

test('console exposes status, configuration, every path, and full rollback', () => {
  assert.match(consoleSource, /Preview a supported deployment path/)
  assert.match(consoleSource, /Deploy v6 or v7 through a supported path/)
  assert.match(consoleSource, /Full rollback \(source application and predeployment database\)/)
  assert.match(consoleSource, /Configure exact private integration hosts/)
  assert.match(status, /stock -> v7; v5 -> v6; v5 -> v7; v6 -> v7/)
})

test('all mutating paths use exact confirmations and root-only logs', () => {
  assert.match(deploy, /Required deployment confirmation:/)
  assert.match(rollback, /Required rollback confirmation:/)
  assert.match(deploy, /install -d -o root -g root -m 0700/)
  assert.match(rollback, /install -d -o root -g root -m 0700/)
  assert.match(consoleSource, /AUDIT_ROOT="\$\{STATE_ROOT\}\/logs-v7\/interactive-console"/)
  assert.match(transition, /require_no_unfinished_v7_operations/)
  assert.match(transition, /unfinished_predecessor_operation_count/)
  assert.match(transition, /production-deployments-v6/)
  assert.match(deploy, /require_no_unfinished_v7_operations/)
  assert.match(rollback, /require_no_unfinished_v7_operations/)
})
