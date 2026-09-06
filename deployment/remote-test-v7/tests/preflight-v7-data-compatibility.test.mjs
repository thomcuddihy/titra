import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runInNewContext } from 'node:vm'

const require = createRequire(import.meta.url)
const preflight = require('../root-scripts/v7-data-compatibility-preflight.cjs')
const mongoshSource = readFileSync(
  new URL('../root-scripts/v7-data-compatibility-preflight.cjs', import.meta.url),
  'utf8',
)
const shell = readFileSync(
  new URL('../root-scripts/preflight-v7-data-compatibility.sh', import.meta.url),
  'utf8',
)
const productionPreflight = readFileSync(
  new URL('../root-scripts/preflight-production-deploy.sh', import.meta.url),
  'utf8',
)
const deploy = readFileSync(
  new URL('../root-scripts/deploy-production-candidate.sh', import.meta.url),
  'utf8',
)
const backup = readFileSync(
  new URL('../root-scripts/backup-production-db.sh', import.meta.url),
  'utf8',
)

function healthyCounts() {
  return {
    ...preflight.emptyCounts(),
    verification_active_admins: 1,
    verification_usable_admins: 1,
  }
}

function fakeDatabase({ failWith } = {}) {
  return {
    getCollectionInfos() { return [] },
    getCollection(name) {
      if (failWith) throw new Error(failWith)
      return {
        aggregate() {
          return { toArray() { return [] } }
        },
        countDocuments(selector) {
          if (name === 'users' && selector?.$expr?.$and?.length === 2
            && JSON.stringify(selector.$expr.$and[0]).includes('$isAdmin')) return 1
          return 0
        },
        find() {
          return {
            sort() { return this },
            limit() { return this },
            toArray() { return [] },
          }
        },
        getIndexes() { return [] },
      }
    },
  }
}

test('healthy database emits one fixed-schema PASS marker', () => {
  const counts = preflight.inspectDatabase(fakeDatabase(), new Date('2026-09-03T00:00:00Z'))
  assert.deepEqual(counts, healthyCounts())
  assert.equal(preflight.summaryStatus(counts), 'PASS')
  const line = preflight.marker('PASS', counts)
  assert.match(line, /^TITRA_V7_DATA_COMPATIBILITY_PREFLIGHT status=PASS(?: [a-z0-9_]+=[0-9]+)+$/u)
  assert.deepEqual(
    line.split(' ').slice(2).map((entry) => entry.split('=')[0]),
    preflight.COUNT_FIELDS,
  )
})

test('every blocker and warning independently drives the declared policy', () => {
  for (const field of preflight.BLOCK_FIELDS) {
    const counts = healthyCounts()
    counts[field] = 1
    assert.equal(preflight.summaryStatus(counts), 'BLOCK', field)
  }
  for (const field of preflight.WARN_FIELDS) {
    const counts = healthyCounts()
    counts[field] = 1
    assert.equal(preflight.summaryStatus(counts), 'WARN', field)
  }
  for (const field of ['verification_active_admins', 'verification_usable_admins']) {
    const counts = healthyCounts()
    counts[field] = 0
    assert.equal(preflight.summaryStatus(counts), 'BLOCK', field)
  }
})

test('marker cannot reflect persisted values, identifiers, scripts, URLs, or errors', () => {
  const counts = healthyCounts()
  counts.dashboard_all_history = 7
  for (const key of ['userId', 'url', 'token', 'script', 'error']) {
    counts[key] = `private-${key}`
  }
  assert.throws(() => preflight.marker('BLOCK', counts))
  delete counts.userId
  delete counts.url
  delete counts.token
  delete counts.script
  delete counts.error
  const line = preflight.marker('BLOCK', counts)
  assert.doesNotMatch(
    line,
    /private-(?:userId|url|token|script|error)|https?:\/\/|mongodb:\/\//u,
  )
})

test('legacy time-entry rule recognition matches the non-executing v7 policy', () => {
  for (const source of [
    'return true',
    ' /* reviewed */ return\n true; // done\n',
  ]) assert.equal(preflight.timeRuleKind(source), 'allow')
  for (const source of ['return false', '// maintenance\nreturn false;']) {
    assert.equal(preflight.timeRuleKind(source), 'deny')
  }
  for (const source of [
    'return user.isAdmin',
    'while (true) {}',
    `return true; ${' '.repeat(50000)}`,
    `return true;\ud800`,
  ]) assert.equal(preflight.timeRuleKind(source), 'unsafe')
})

test('index checks accept only absence or the exact startup definition', () => {
  assert.equal(preflight.indexConflictCount([], preflight.API_TOKEN_INDEX), 0)
  assert.equal(preflight.indexConflictCount([
    { ...preflight.API_TOKEN_INDEX, v: 2 },
  ], preflight.API_TOKEN_INDEX), 0)
  assert.equal(preflight.indexConflictCount([
    { ...preflight.API_TOKEN_INDEX, v: 2 },
    { name: 'legacy_sparse_companion', key: preflight.API_TOKEN_INDEX.key, sparse: true },
  ], preflight.API_TOKEN_INDEX), 0)
  assert.equal(preflight.indexConflictCount([
    { name: 'legacy_sparse_companion', key: preflight.API_TOKEN_INDEX.key, sparse: true },
  ], preflight.API_TOKEN_INDEX), 1)
  assert.equal(preflight.indexConflictCount([
    { ...preflight.WEBHOOK_INDEX, unique: false },
  ], preflight.WEBHOOK_INDEX), 1)
  assert.equal(preflight.indexConflictCount([
    { name: 'wrong', key: preflight.WEBHOOK_RECEIPT_INDEX.key, unique: true },
  ], preflight.WEBHOOK_RECEIPT_INDEX), 1)
  const ttl = preflight.OTHER_STARTUP_INDEXES.find(
    ({ expected }) => expected.name === 'api_idempotency_expiry',
  ).expected
  assert.equal(preflight.indexConflictCount([{ ...ttl }], ttl), 0)
  assert.equal(preflight.indexConflictCount([{ ...ttl, expireAfterSeconds: 1 }], ttl), 1)
  assert.equal(preflight.indexConflictCount([{ ...ttl, sparse: true }], ttl), 1)
  assert.equal(preflight.indexConflictCount([{ ...ttl, prepareUnique: true }], ttl), 1)
  assert.equal(preflight.indexConflictCount([{
    ...ttl, storageEngine: { wiredTiger: { configString: 'block_compressor=zlib' } },
  }], ttl), 1)
  const collation = { locale: 'en', strength: 2 }
  assert.equal(preflight.indexConflictCount([{
    ...ttl, collation, __titraCollectionDefaultCollation: collation,
  }], ttl), 0)
  assert.equal(preflight.indexConflictCount([{
    ...ttl, collation,
  }], ttl), 1)
})

test('all startup index contracts and unique predecessor hazards are fixed blockers', () => {
  const names = preflight.OTHER_STARTUP_INDEXES.map(({ expected }) => expected.name)
  for (const name of [
    'api_idempotency_expiry',
    'daily_mail_limit_expiry',
    'webhook_receipt_expiry',
    'timecard_date_migration_preview_context',
    'google_oauth_state_expiry',
  ]) assert.ok(names.includes(name), name)
  for (const field of [
    'dashboard_slug_duplicate_groups',
    'dashboard_slug_key_shape_malformed',
    'personal_task_duplicate_groups',
    'personal_task_key_shape_malformed',
    'migration_backup_duplicate_groups',
    'migration_backup_key_shape_malformed',
    'google_oauth_duplicate_groups',
    'google_oauth_key_shape_malformed',
    'secure_webhook_key_shape_malformed',
    'webhook_receipt_key_shape_malformed',
    'api_token_key_shape_malformed',
    'other_startup_index_conflicts',
  ]) assert.ok(preflight.BLOCK_FIELDS.includes(field), field)

  let capturedPipeline
  const collection = {
    aggregate(pipeline) {
      capturedPipeline = pipeline
      return { toArray: () => [] }
    },
  }
  assert.equal(preflight.uniqueIndexKeyShapeCount(
    collection,
    { key: { $type: 'string' } },
    { $eq: [{ $type: '$key' }, 'string'] },
  ), 0)
  assert.deepEqual(capturedPipeline[1], {
    $match: {
      $expr: { $eq: [{ $eq: [{ $type: '$key' }, 'string'] }, false] },
    },
  })
})

test('runtime webhook mapping validation is exact and the pinned recipe fails closed', () => {
  const webhook = {
    _id: 'webhook-one',
    endpointId: '0123456789abcdef0123456789abcdef',
    securityVersion: 2,
    mappingVersion: 1,
    active: true,
    verificationPeriod: 30,
    serviceUrl: 'https://verify.example.test/start',
    mappingRules: [{
      eventPointer: '/event', eventEquals: 'complete',
      userIdPointer: '/user/id', action: 'complete',
    }],
  }
  assert.equal(preflight.validRuntimeWebhookConfiguration(webhook), true)
  assert.equal(preflight.validRuntimeWebhookConfiguration({
    ...webhook,
    mappingRules: [{ ...webhook.mappingRules[0], userIdPointer: '/__proto__' }],
  }), false)
  assert.equal(preflight.validRuntimeWebhookConfiguration({
    ...webhook, serviceUrl: 'http://verify.example.test/start',
  }), false)
  assert.equal(preflight.validRuntimeWebhookConfiguration({
    ...webhook, endpointId: [webhook.endpointId],
  }), false)
  for (const field of [
    'secure_webhook_invalid_configurations',
    'secure_webhook_missing_secrets',
    'secure_webhook_candidate_over_limit',
    'verification_unrecoverable_pending',
    'verification_enabled_without_secure_default',
  ]) assert.ok(preflight.BLOCK_FIELDS.includes(field), field)
  assert.match(mongoshSource,
    /Treat every database-only active endpoint as unprovisioned/u)
})

test('OIDC configuration checks mirror the bounded v7 client/server contract', () => {
  const configuration = {
    _id: 'oidc-one',
    service: 'oidc',
    clientId: 'client-one',
    secret: 'secret-one',
    serverUrl: 'https://identity.example.test',
    authorizationEndpoint: '/authorize',
    tokenEndpoint: '/token',
    userinfoEndpoint: '/userinfo',
    requestPermissions: 'openid profile email',
    idTokenWhitelistFields: ['groups'],
    loginStyle: 'popup',
  }
  assert.equal(preflight.validStoredOidcConfiguration(configuration), true)
  assert.equal(preflight.validStoredOidcConfiguration({
    ...configuration, tokenEndpoint: 'http://identity.example.test/token',
  }), false)
  assert.equal(preflight.validStoredOidcConfiguration({
    ...configuration, idTokenWhitelistFields: ['accessToken'],
  }), false)
  assert.equal(preflight.validStoredOidcConfiguration({
    ...configuration, arbitraryServerField: true,
  }), false)
  assert.equal(preflight.validStoredOidcConfiguration({
    ...configuration, secret: { _bsontype: 'ObjectId', value: 'not-a-sealed-secret' },
  }), false)
  assert.equal(preflight.MAX_OIDC_CONFIGURATION_DOCUMENTS, 10)
})

test('stored integration checks reject deterministic v7 endpoint/query failures', () => {
  assert.equal(preflight.validIntegrationBaseUrl('https://tickets.example.test/base'), true)
  assert.equal(preflight.validIntegrationBaseUrl('http://tickets.example.test/base'), false)
  assert.equal(preflight.validIntegrationBaseUrl('https://user:pass@example.test'), false)
  assert.equal(preflight.validGitlabQuery('projects/42/issues?state=opened'), true)
  assert.equal(preflight.validGitlabQuery('../admin'), false)
  assert.equal(preflight.validWekanSelectors(['lane_one', 'lane_two']), true)
  assert.equal(preflight.validWekanSelectors(['../lane']), false)
  assert.equal(preflight.validWekanUrl(
    'https://wekan.example.test/api/boards/board_one/export?authToken=secret-token',
  ), true)
  assert.equal(preflight.validWekanUrl(
    'https://wekan.example.test/api/boards/board_one/export#authToken=secret-token',
  ), false)
  assert.equal(preflight.MAX_INTEGRATION_CANDIDATE_DOCUMENTS, 5000)
})

test('membership, revision, timer, and migration probes guard operators before evaluation', () => {
  const membership = preflight.projectMembershipPipeline()
  assert.ok(membership[0].$match.$expr.$or.length >= 3)
  const revision = preflight.malformedRevisionPipeline('projectRevision')
  assert.deepEqual(revision[0], { $match: { projectRevision: { $exists: true } } })
  assert.equal(revision[2].$match.$expr.$cond[2], true)
  const timer = preflight.timerHistoryMalformedPipeline()
  assert.equal(timer[0].$match['profile.timerStartHistory'].$exists, true)
  assert.deepEqual(preflight.migrationLockActivePipeline().at(-1), { $count: 'count' })
  const malformedLock = preflight.migrationLockMalformedPipeline()
  assert.deepEqual(malformedLock.at(-1), { $count: 'count' })
  assert.match(JSON.stringify(malformedLock), /leaseUntil.*\$\$NOW.*ownerRunId/u)
  for (const field of [
    'project_membership_malformed', 'resource_revisions_malformed',
    'timer_history_malformed', 'timer_history_overflow',
    'active_timer_identity_malformed',
    'migration_lock_active', 'migration_lock_malformed', 'migration_runs_active',
  ]) assert.ok(preflight.BLOCK_FIELDS.includes(field), field)
})

test('dashboard range inventory converts values and enforces the exact 366-day limit', () => {
  const now = new Date('2026-09-03T00:00:00Z')
  const pipeline = preflight.dashboardCustomRangePipeline(now)
  assert.deepEqual(pipeline[0], { $match: { timePeriod: 'custom' } })
  assert.equal(
    pipeline[1].$project.start.$convert.input.$cond[1].toISOString(),
    '2026-09-01T00:00:00.000Z',
  )
  assert.equal(
    pipeline[1].$project.end.$convert.input.$cond[1].toISOString(),
    '2026-09-30T23:59:59.999Z',
  )
  assert.equal(
    pipeline[2].$match.$expr.$or[3].$gt[0].$subtract[0],
    '$end',
  )
  assert.equal(
    pipeline[2].$match.$expr.$or[3].$gt[1],
    preflight.MAX_PUBLIC_DASHBOARD_SPAN_MS,
  )
  assert.deepEqual(pipeline.at(-1), { $count: 'count' })
})

test('dashboard compatibility uses exact scalar period and project shapes', () => {
  const period = preflight.dashboardInvalidPeriodSelector()
  const project = preflight.dashboardInvalidProjectSelector()
  assert.deepEqual(period.$expr.$or[0], {
    $ne: [{ $type: '$timePeriod' }, 'string'],
  })
  assert.deepEqual(project.$expr.$or[0], {
    $ne: [{ $type: '$projectId' }, 'string'],
  })
  assert.equal(period.$expr.$or[1].$eq[0].$in[0], '$timePeriod')
})

test('locked verification selectors retain both deadline and extra conditions', () => {
  const now = new Date('2026-09-03T00:00:00Z')
  const selector = preflight.lockedVerificationSelector(now, { isAdmin: true })
  assert.deepEqual(selector.$and[1], { isAdmin: true })
  const lockedExpression = selector.$and[0].$expr.$and
  assert.deepEqual(lockedExpression[0].$and[0], {
    $eq: [{ $type: '$actionVerification' }, 'object'],
  })
  assert.deepEqual(lockedExpression[2].$or[0], {
    $ne: [{ $type: '$actionVerification.deadline' }, 'date'],
  })
  assert.equal(lockedExpression[2].$or[1].$lt[1], now)

  const pipeline = preflight.unrecoverableLockedPipeline(now, true)
  const locked = pipeline[0].$match.$and[0]
  const explicitReference = pipeline[0].$match.$and[1]
  assert.equal(locked.$expr.$and[2].$or[1].$lt[1], now)
  assert.ok(explicitReference.$expr.$or.some(
    (condition) => JSON.stringify(condition).includes('$actionVerification.webhookInterfaceId'),
  ))
  const malformedPending = preflight.malformedPendingVerificationSelector()
  assert.deepEqual(malformedPending.$expr.$and[1], {
    $ne: [{ $type: '$actionVerification.deadline' }, 'date'],
  })
  const malformedFlags = preflight.verificationMalformedFlagsPipeline()
  assert.deepEqual(malformedFlags[0].$project.malformed.$or[0].$and, [
    { $ne: [{ $type: '$actionVerification' }, 'missing'] },
    { $ne: [{ $type: '$actionVerification' }, 'object'] },
  ])
  assert.doesNotMatch(JSON.stringify(malformedFlags), /\$not/u)
})

test('webhook receipt uniqueness and stranded project fences are exact blockers', () => {
  assert.deepEqual(preflight.WEBHOOK_RECEIPT_INDEX, {
    name: 'webhook_interface_event_unique',
    key: { interfaceId: 1, eventId: 1 },
    unique: true,
  })
  assert.ok(preflight.BLOCK_FIELDS.includes('webhook_receipt_duplicate_groups'))
  assert.ok(preflight.BLOCK_FIELDS.includes('webhook_receipt_index_conflicts'))
  assert.ok(preflight.BLOCK_FIELDS.includes('stranded_project_fences'))
})

test('security setting type/duplicate counts block fail-open persisted state', () => {
  assert.deepEqual(preflight.SECURITY_BOOLEAN_SETTINGS, [
    'disablePublicProjects',
    'disableUserRegistration',
    'enableAnonymousLogins',
    'enableOpenIDConnect',
    'enableUserActionVerification',
  ])
  assert.ok(preflight.BLOCK_FIELDS.includes('security_toggle_malformed'))
  assert.ok(preflight.BLOCK_FIELDS.includes('security_toggle_duplicate_groups'))
  assert.ok(preflight.BLOCK_FIELDS.includes('admin_inactive_flags_malformed'))
  assert.ok(preflight.WARN_FIELDS.includes('nonboolean_active_admin_flags'))
  assert.deepEqual(preflight.strictAdminExpression(), {
    $and: [
      { $eq: [{ $type: '$isAdmin' }, 'bool'] },
      { $eq: ['$isAdmin', true] },
    ],
  })
})

test('credential startup work has explicit conservative cardinality ceilings', () => {
  assert.equal(preflight.MAX_CREDENTIAL_CANDIDATE_DOCUMENTS, 5000)
  assert.equal(preflight.MAX_PLAINTEXT_CREDENTIAL_FIELDS, 1000)
  assert.equal(preflight.MAX_DEFAULT_PLAINTEXT_CREDENTIAL_BYTES, 4096)
  assert.equal(preflight.MAX_OAUTH_TOKEN_PLAINTEXT_BYTES, 16384)
  assert.equal(preflight.MAX_TIME_RULE_DOCUMENTS, 100)
  for (const store of preflight.CREDENTIAL_STORES) {
    for (const path of store.paths) {
      const expected = /services[.](?:googleapi[.]serviceData|oidc)[.](?:accessToken|refreshToken)$/u
        .test(path) ? 16384 : 4096
      assert.equal(preflight.credentialPlaintextLimit(path), expected, path)
      const selector = preflight.oversizedPlaintextCredential(path)
      assert.equal(selector.$expr.$gt[0].$strLenBytes.$cond[1], `$${path}`)
      assert.equal(selector.$expr.$gt[1], expected)
    }
  }
  assert.ok(preflight.BLOCK_FIELDS.includes('credential_candidate_over_limit'))
  assert.ok(preflight.BLOCK_FIELDS.includes('plaintext_credential_over_limit'))
  assert.ok(preflight.BLOCK_FIELDS.includes('credential_object_fields'))
  assert.ok(preflight.BLOCK_FIELDS.includes('credential_oversized_plaintext_fields'))
  assert.ok(!preflight.WARN_FIELDS.includes('credential_object_fields'))
})

test('credential inspection applies every path-aware plaintext size blocker', () => {
  const selectors = []
  const database = {
    getCollection(collection) {
      return {
        countDocuments(selector) {
          selectors.push({ collection, selector })
          return 0
        },
      }
    },
  }
  const result = preflight.inspectCredentials(database)
  assert.equal(result.credential_oversized_plaintext_fields, 0)
  const limits = selectors.flatMap(({ selector }) => {
    const condition = selector.$expr ? selector : selector.$and?.at(-1)
    return condition?.$expr?.$gt?.[0]?.$strLenBytes ? [condition.$expr.$gt[1]] : []
  }).sort((left, right) => left - right)
  assert.deepEqual(limits, [
    4096, 4096, 4096, 4096, 4096, 4096,
    16384, 16384, 16384, 16384,
  ])
})

test('database exceptions produce only a fixed error marker and status', () => {
  const output = []
  let status
  preflight.runMongosh(
    fakeDatabase({ failWith: 'user-secret https://private.example mongodb://password' }),
    (line) => output.push(line),
    (value) => { status = value },
  )
  assert.equal(status, 43)
  assert.deepEqual(output, [preflight.marker('ERROR', preflight.emptyCounts(1))])
  assert.doesNotMatch(output[0], /user-secret|private[.]example|mongodb/u)
})

test('mongosh globals execute even when a module global exists', () => {
  const sandbox = {
    db: fakeDatabase(),
    lines: [],
    exitStatus: null,
    module: { exports: {} },
  }
  sandbox.print = (line) => sandbox.lines.push(line)
  sandbox.quit = (status) => { sandbox.exitStatus = status }
  runInNewContext(mongoshSource, sandbox)
  assert.equal(sandbox.exitStatus, 0)
  assert.equal(sandbox.lines.length, 1)
  assert.match(sandbox.lines[0], /^TITRA_V7_DATA_COMPATIBILITY_PREFLIGHT status=PASS /u)
})

test('root wrapper accepts only the fixed count schema and suppresses raw output', () => {
  const fieldsMatch = shell.match(/readonly -a count_fields=\(\n([\s\S]*?)\n\)/u)
  assert.ok(fieldsMatch)
  const shellFields = fieldsMatch[1].trim().split(/\s+/u)
  assert.deepEqual(shellFields, preflight.COUNT_FIELDS)
  assert.match(shell, /require_secure_regular_file "\$probe"/u)
  assert.match(shell, /mongosh "\$PROD_DATABASE" --quiet --norc --file \/dev\/stdin/u)
  assert.match(shell, /> "\$output_file" 2>&1/u)
  assert.match(shell, /grep -E "\$marker_pattern" "\$output_file"/u)
  assert.match(shell, /LOCK_INHERITED == true/u)
  assert.ok((shell.match(/assert_exact_app_stopped "\$expected_app_container"/gu) || []).length >= 2)
  assert.match(shell, /assert_mongo_identity "\$mongo_before"/u)
  assert.doesNotMatch(shell, /(?:cat|head|tail|sed)\s+(?:--\s+)?"?\$output_file/u)
  assert.doesNotMatch(shell, /mongosh[^\n]*(?:--eval|--file\s+"?\$probe)/u)
  assert.match(shell, /printf '%s\\n' "\$marker" >\/dev\/tty/u)
  assert.match(shell, /ACKNOWLEDGE V7 DATA COMPATIBILITY WARNINGS/u)
  assert.match(shell, /warning_digest=.*sha256sum/u)
  assert.match(shell, /marker_count migration_lock_active/u)
})

test('preview and continuous-stop authoritative gates are v7-only and precede the switch', () => {
  assert.match(productionPreflight,
    /if \[\[ \$target == v7 \]\]; then\s+"\$\{SCRIPT_DIR\}\/preflight-v7-data-compatibility[.]sh" --preview\s+fi/u)

  const backupPhaseAt = deploy.indexOf("current_phase='fresh-verified-predeploy-backup'")
  const ownerAt = deploy.indexOf('app_stopped=true', backupPhaseAt)
  const stoppedAt = deploy.indexOf('assert_exact_app_stopped "$expected_source_container"', ownerAt)
  const preserveAt = deploy.indexOf("current_phase='preserve-source-image'", stoppedAt)
  const suggestionAt = deploy.indexOf('preflight-personal-task-suggestions.sh" --require-app-stopped')
  const compatibilityAt = deploy.indexOf('preflight-v7-data-compatibility.sh" --require-app-stopped')
  const stoppedRecheckAt = deploy.indexOf('assert_exact_app_stopped "$expected_source_container"', compatibilityAt)
  const switchAt = deploy.indexOf("current_phase='application-switch'")
  assert.match(deploy,
    /backup-production-db[.]sh" --ticket "\$ticket" \\[\r\n]+\s*--leave-app-stopped --dry-run/u)
  assert.match(deploy,
    /backup-production-db[.]sh" --ticket "\$ticket" \\[\r\n]+\s*--leave-app-stopped \\[\r\n]+\s*--confirm/u)
  assert.ok(backupPhaseAt >= 0 && ownerAt > backupPhaseAt && stoppedAt > ownerAt)
  assert.ok(preserveAt > stoppedAt && suggestionAt > preserveAt && compatibilityAt > suggestionAt)
  assert.ok(stoppedRecheckAt > compatibilityAt && switchAt > stoppedRecheckAt)
  const stoppedWindow = deploy.slice(stoppedAt, switchAt)
  assert.doesNotMatch(stoppedWindow, /docker (?:start|stop) /u)
})

test('backup can transfer an exact stopped source only under the inherited lock', () => {
  assert.match(backup, /--leave-app-stopped requires an inherited exclusive operator lock/u)
  assert.ok((backup.match(/LOCK_INHERITED == true/gu) || []).length >= 2)
  assert.match(backup, /assert_exact_app_stopped "\$expected_app_container_id"/u)
  assert.match(backup, /Application handoff: exact source container remains stopped/u)
  assert.match(backup, /the parent holds the same exclusive/u)
  assert.match(backup, /if \[\[ \$app_stopped == true \]\]; then/u)
  assert.match(backup, /start_existing_app_container "\$expected_app_container_id"/u)
})
