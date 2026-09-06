'use strict'

/*
 * Read-only, count-only upgrade compatibility inventory for a pre-v7 Titra
 * database.  This file is executed directly by mongosh and is also a CommonJS
 * module so its policy and redaction behavior can be unit tested offline.
 *
 * Never add document identifiers, names, URLs, tokens, script bodies, or Mongo
 * exception text to the marker.  The root wrapper discards every other byte of
 * mongosh output and accepts exactly one fixed-schema marker.
 */

const MARKER = 'TITRA_V7_DATA_COMPATIBILITY_PREFLIGHT'
const QUERY_TIMEOUT_MS = 120000
const MAX_TIME_RULE_DOCUMENTS = 100
// Startup currently projects each matching credential store into a whole
// array.  Stop well before an installation can turn the one-time migration
// into an unreviewed availability event; larger sites need a clone rehearsal.
const MAX_CREDENTIAL_CANDIDATE_DOCUMENTS = 5000
// Non-empty legacy values are sealed one field at a time.  This lower ceiling
// bounds sequential startup writes independently of the projected-read bound.
const MAX_PLAINTEXT_CREDENTIAL_FIELDS = 1000
const MAX_DEFAULT_PLAINTEXT_CREDENTIAL_BYTES = 4096
const MAX_OAUTH_TOKEN_PLAINTEXT_BYTES = 16384
const MAX_INTEGRATION_CANDIDATE_DOCUMENTS = 5000
const MAX_OIDC_CONFIGURATION_DOCUMENTS = 10
const MAX_WEBHOOK_CONFIGURATION_DOCUMENTS = 1000
const MAX_PUBLIC_DASHBOARD_SPAN_MS = 366 * 24 * 60 * 60 * 1000
const MAX_TIMER_START_HISTORY = 4096
const MAX_SAFE_REVISION = Number.MAX_SAFE_INTEGER
const ADMIN_MUTATION_LEASE_MS = 30 * 1000
const ADMIN_MUTATION_LEASE_GRACE_MS = ADMIN_MUTATION_LEASE_MS * 2

const BOUNDED_DASHBOARD_PERIODS = Object.freeze([
  'currentMonth',
  'currentWeek',
  'currentYear',
  'lastMonth',
  'last3months',
  'lastWeek',
  'lastYear',
  'custom',
])

const SECURITY_BOOLEAN_SETTINGS = Object.freeze([
  'disablePublicProjects',
  'disableUserRegistration',
  'enableAnonymousLogins',
  'enableOpenIDConnect',
  'enableUserActionVerification',
])

const USER_CREDENTIAL_PATHS = Object.freeze([
  'profile.siwapptoken',
  'profile.zammadtoken',
  'profile.gitlabtoken',
  'services.googleapi.serviceData.accessToken',
  'services.googleapi.serviceData.refreshToken',
  'services.oidc.accessToken',
  'services.oidc.refreshToken',
])

const LONG_OAUTH_TOKEN_PATHS = Object.freeze([
  'services.googleapi.serviceData.accessToken',
  'services.googleapi.serviceData.refreshToken',
  'services.oidc.accessToken',
  'services.oidc.refreshToken',
])

const CREDENTIAL_STORES = Object.freeze([
  Object.freeze({
    collection: 'globalsettings',
    selector: { name: { $in: ['google_secret', 'openai_apikey'] } },
    paths: Object.freeze(['value']),
  }),
  Object.freeze({
    collection: 'meteor_accounts_loginServiceConfiguration',
    selector: { service: { $in: ['googleapi', 'oidc'] } },
    paths: Object.freeze(['secret']),
  }),
  Object.freeze({ collection: 'projects', selector: {}, paths: Object.freeze(['wekanurl']) }),
  Object.freeze({ collection: 'users', selector: {}, paths: USER_CREDENTIAL_PATHS }),
])

const COUNT_FIELDS = Object.freeze([
  'probe_errors',
  'dashboard_all_history',
  'dashboard_invalid_period',
  'dashboard_all_projects_untrusted',
  'dashboard_invalid_custom_range',
  'dashboard_invalid_project',
  'project_legacy_markup_descriptions',
  'dashboard_slug_duplicate_groups',
  'dashboard_slug_key_shape_malformed',
  'dashboard_slug_index_conflicts',
  'personal_task_duplicate_groups',
  'personal_task_key_shape_malformed',
  'personal_task_index_conflicts',
  'verification_overdue_active',
  'verification_malformed_pending',
  'verification_malformed_flags',
  'verification_unrecoverable_locked',
  'verification_unrecoverable_pending',
  'verification_locked_admins',
  'verification_active_admins',
  'verification_usable_admins',
  'verification_enabled_without_secure_default',
  'security_toggle_malformed',
  'security_toggle_duplicate_groups',
  'admin_inactive_flags_malformed',
  'nonboolean_active_admin_flags',
  'admin_mutation_lock_active',
  'admin_mutation_lock_long',
  'admin_mutation_lock_malformed',
  'legacy_inbound_active',
  'legacy_outbound_active',
  'legacy_webhook_active',
  'secure_webhook_duplicate_groups',
  'secure_webhook_key_shape_malformed',
  'secure_webhook_index_conflicts',
  'secure_webhook_invalid_configurations',
  'secure_webhook_missing_secrets',
  'secure_webhook_candidate_over_limit',
  'webhook_receipt_duplicate_groups',
  'webhook_receipt_key_shape_malformed',
  'webhook_receipt_index_conflicts',
  'migration_backup_duplicate_groups',
  'migration_backup_key_shape_malformed',
  'migration_backup_index_conflicts',
  'google_oauth_duplicate_groups',
  'google_oauth_key_shape_malformed',
  'google_oauth_index_conflicts',
  'other_startup_index_conflicts',
  'stranded_project_fences',
  'project_membership_malformed',
  'resource_revisions_malformed',
  'timer_history_malformed',
  'timer_history_overflow',
  'active_timer_identity_malformed',
  'migration_lock_active',
  'migration_lock_malformed',
  'migration_runs_active',
  'time_rule_documents',
  'time_rule_unsafe',
  'time_rule_literal_deny',
  'time_rule_overflow',
  'plaintext_credential_fields',
  'credential_candidate_documents',
  'credential_malformed_fields',
  'credential_object_fields',
  'credential_oversized_plaintext_fields',
  'credential_candidate_over_limit',
  'plaintext_credential_over_limit',
  'plaintext_api_tokens',
  'invalid_plaintext_api_tokens',
  'duplicate_plaintext_api_token_groups',
  'duplicate_hashed_api_token_groups',
  'malformed_hashed_api_tokens',
  'api_token_key_shape_malformed',
  'api_token_index_conflicts',
  'oidc_config_documents',
  'oidc_invalid_enabled',
  'oidc_invalid_dormant',
  'oidc_config_overflow',
  'integration_candidate_documents',
  'integration_invalid_configurations',
  'integration_candidate_over_limit',
  'wekan_sandstorm_urls',
  'insecure_http_integration_urls',
])

const BLOCK_FIELDS = Object.freeze([
  'probe_errors',
  'dashboard_all_history',
  'dashboard_invalid_period',
  'dashboard_all_projects_untrusted',
  'dashboard_invalid_custom_range',
  'dashboard_invalid_project',
  'dashboard_slug_duplicate_groups',
  'dashboard_slug_key_shape_malformed',
  'dashboard_slug_index_conflicts',
  'personal_task_duplicate_groups',
  'personal_task_key_shape_malformed',
  'personal_task_index_conflicts',
  'verification_malformed_pending',
  'verification_malformed_flags',
  'verification_unrecoverable_locked',
  'verification_unrecoverable_pending',
  'verification_enabled_without_secure_default',
  'security_toggle_malformed',
  'security_toggle_duplicate_groups',
  'admin_inactive_flags_malformed',
  'admin_mutation_lock_long',
  'admin_mutation_lock_malformed',
  'legacy_inbound_active',
  'legacy_outbound_active',
  'legacy_webhook_active',
  'secure_webhook_duplicate_groups',
  'secure_webhook_key_shape_malformed',
  'secure_webhook_index_conflicts',
  'secure_webhook_invalid_configurations',
  'secure_webhook_missing_secrets',
  'secure_webhook_candidate_over_limit',
  'webhook_receipt_duplicate_groups',
  'webhook_receipt_key_shape_malformed',
  'webhook_receipt_index_conflicts',
  'migration_backup_duplicate_groups',
  'migration_backup_key_shape_malformed',
  'migration_backup_index_conflicts',
  'google_oauth_duplicate_groups',
  'google_oauth_key_shape_malformed',
  'google_oauth_index_conflicts',
  'other_startup_index_conflicts',
  'stranded_project_fences',
  'project_membership_malformed',
  'resource_revisions_malformed',
  'timer_history_malformed',
  'timer_history_overflow',
  'active_timer_identity_malformed',
  'migration_lock_active',
  'migration_lock_malformed',
  'migration_runs_active',
  'time_rule_unsafe',
  'time_rule_overflow',
  'credential_malformed_fields',
  'credential_object_fields',
  'credential_oversized_plaintext_fields',
  'credential_candidate_over_limit',
  'plaintext_credential_over_limit',
  'invalid_plaintext_api_tokens',
  'duplicate_plaintext_api_token_groups',
  'duplicate_hashed_api_token_groups',
  'malformed_hashed_api_tokens',
  'api_token_key_shape_malformed',
  'api_token_index_conflicts',
  'oidc_invalid_enabled',
  'oidc_config_overflow',
  'integration_invalid_configurations',
  'integration_candidate_over_limit',
  'wekan_sandstorm_urls',
  'insecure_http_integration_urls',
])

const WARN_FIELDS = Object.freeze([
  'project_legacy_markup_descriptions',
  'verification_overdue_active',
  'verification_locked_admins',
  'nonboolean_active_admin_flags',
  'admin_mutation_lock_active',
  'time_rule_literal_deny',
  'plaintext_credential_fields',
  'plaintext_api_tokens',
  'oidc_invalid_dormant',
])

const API_TOKEN_INDEX = Object.freeze({
  name: 'user_titra_api_token_sha256_unique',
  key: { 'services.titraApiToken.sha256': 1 },
  unique: true,
  partialFilterExpression: {
    'services.titraApiToken.version': 1,
    'services.titraApiToken.sha256': { $type: 'string' },
  },
})

const WEBHOOK_INDEX = Object.freeze({
  name: 'webhook_secure_endpoint_unique',
  key: { endpointId: 1 },
  unique: true,
  partialFilterExpression: {
    endpointId: { $type: 'string' },
    securityVersion: 2,
    mappingVersion: 1,
  },
})

const WEBHOOK_RECEIPT_INDEX = Object.freeze({
  name: 'webhook_interface_event_unique',
  key: { interfaceId: 1, eventId: 1 },
  unique: true,
})

const DASHBOARD_SLUG_INDEX = Object.freeze({
  name: 'slug_1',
  key: { slug: 1 },
  unique: true,
  partialFilterExpression: { slug: { $exists: true, $gt: '' } },
})

const PERSONAL_TASK_INDEX = Object.freeze({
  name: 'task_personal_suggestion_user_name_unique',
  key: { userId: 1, name: 1 },
  unique: true,
  partialFilterExpression: {
    projectId: null,
    userId: { $type: 'string' },
    name: { $type: 'string' },
  },
})

const MIGRATION_BACKUP_INDEX = Object.freeze({
  name: 'runId_1_timecardId_1',
  key: { runId: 1, timecardId: 1 },
  unique: true,
})

const GOOGLE_OAUTH_INDEX = Object.freeze({
  name: 'google_oauth_token_hash',
  key: { tokenHash: 1 },
  unique: true,
})

const OTHER_STARTUP_INDEXES = Object.freeze([
  ['apiIdempotency', { name: 'api_idempotency_expiry', key: { expiresAt: 1 }, expireAfterSeconds: 0 }],
  ['apiIdempotency', { name: 'api_idempotency_status_updated', key: { status: 1, updatedAt: 1 } }],
  ['apiIdempotency', { name: 'api_idempotency_owner_operation_created', key: { userId: 1, operation: 1, createdAt: -1 } }],
  ['timecards', { name: 'api_timecards_owner_date_id', key: { userId: 1, date: 1, _id: 1 } }],
  ['timecards', { name: 'api_timecards_project_date_id', key: { projectId: 1, date: 1, _id: 1 } }],
  ['timecards', { name: 'api_timecards_project_user', key: { projectId: 1, userId: 1 } }],
  ['timecards', { name: 'api_timecards_project_task', key: { projectId: 1, task: 1 } }],
  ['tasks', { name: 'api_tasks_project_id', key: { projectId: 1, _id: 1 } }],
  ['dailymaillimit', { name: 'daily_mail_limit_expiry', key: { expiresAt: 1 }, expireAfterSeconds: 0 }],
  ['dailymaillimit', {
    name: 'daily_mail_legacy_lookup',
    key: { email: 1, timestamp: 1 },
    partialFilterExpression: { email: { $type: 'string' }, timestamp: { $type: 'date' } },
  }],
  ['webhookreceipts', { name: 'webhook_receipt_expiry', key: { expiresAt: 1 }, expireAfterSeconds: 0 }],
  ['dashboards', { name: 'createdBy_1__id_1', key: { createdBy: 1, _id: 1 } }],
  ['googleOAuthStates', { name: 'google_oauth_state_expiry', key: { expiresAt: 1 }, expireAfterSeconds: 0 }],
  ['timecards', { name: 'timecard_date_migration_option_preview', key: { dateOnly: 1, date: -1, _id: 1 } }],
  ['timecardDateMigrationRuns', { name: 'createdAt_-1', key: { createdAt: -1 } }],
  ['timecardDateMigrationRuns', { name: 'status_1_updatedAt_-1', key: { status: 1, updatedAt: -1 } }],
  ['timecardDateMigrationBackups', { name: 'runId_1_status_1_timecardId_1', key: { runId: 1, status: 1, timecardId: 1 } }],
  ['timecardDateMigrationBackups', { name: 'runId_1_classification_1_timecardId_1', key: { runId: 1, classification: 1, timecardId: 1 } }],
  ['timecardDateMigrationBackups', { name: 'runId_1_original.date_-1_timecardId_1', key: { runId: 1, 'original.date': -1, timecardId: 1 } }],
  ['timecardDateMigrationBackups', {
    name: 'timecard_date_migration_preview_context',
    key: { runId: 1, 'original.userId': 1, 'original.projectId': 1, 'original.task': 1, timecardId: 1 },
  }],
  ['timecardDateMigrationBackups', {
    name: 'timecard_date_migration_preview_classification',
    key: { runId: 1, classification: 1, 'original.date': 1, timecardId: 1 },
  }],
  ['timecardDateMigrationBackups', {
    name: 'timecard_date_migration_preview_day_shift',
    key: { runId: 1, 'preview.dayShift': 1, 'original.date': 1, timecardId: 1 },
  }],
].map(([collection, expected]) => Object.freeze({
  collection,
  expected: Object.freeze({ unique: false, ...expected }),
})))

const COMMENT_OR_SPACE = String.raw`(?:\s+|\/\/[^\r\n]*(?:\r\n?|\n|$)|\/\*[\s\S]*?\*\/)`
const LITERAL_ALLOW_RULE = new RegExp(
  String.raw`^(?:${COMMENT_OR_SPACE})*return\s+true(?:${COMMENT_OR_SPACE})*;?(?:${COMMENT_OR_SPACE})*$`,
)
const LITERAL_DENY_RULE = new RegExp(
  String.raw`^(?:${COMMENT_OR_SPACE})*return\s+false(?:${COMMENT_OR_SPACE})*;?(?:${COMMENT_OR_SPACE})*$`,
)

function count(value) {
  return Number.isSafeInteger(value) && value >= 0
}

function safeAdd(left, right) {
  if (!count(left) || !count(right) || !Number.isSafeInteger(left + right)) {
    throw new TypeError('Invalid compatibility count')
  }
  return left + right
}

function plainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || value instanceof Date || typeof value._bsontype === 'string') return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
    // mongosh materializes BSON documents in another VM realm. They retain
    // the ordinary-object tag but not this script's Object.prototype identity.
    || Object.prototype.toString.call(value) === '[object Object]'
}

function sameDocument(left, right) {
  if (left === right) return true
  if (!plainObject(left) || !plainObject(right)) return false
  const leftKeys = Object.keys(left).sort()
  const rightKeys = Object.keys(right).sort()
  if (leftKeys.length !== rightKeys.length
    || leftKeys.some((key, index) => key !== rightKeys[index])) return false
  return leftKeys.every((key) => sameDocument(left[key], right[key]))
}

function sameIndexKey(left, right) {
  if (!plainObject(left) || !plainObject(right)) return false
  const leftKeys = Object.keys(left)
  const rightKeys = Object.keys(right)
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index] && left[key] === right[key])
}

function indexConflictCount(indexes, expected) {
  if (!Array.isArray(indexes)) throw new TypeError('Unexpected index inventory')
  const named = indexes.filter((index) => plainObject(index)
    && index.name === expected.name)
  if (named.length === 0) {
    // A same-key predecessor can make createIndex reject the requested name
    // or options.  In its absence startup can safely create the target index.
    return indexes.some((index) => plainObject(index)
      && sameIndexKey(index.key, expected.key)) ? 1 : 0
  }
  if (named.length === 1) {
    const [index] = named
    const expectedCollation = Object.prototype.hasOwnProperty.call(expected, 'collation')
      ? expected.collation : index.__titraCollectionDefaultCollation
    if (sameIndexKey(index.key, expected.key)
      && Boolean(index.unique) === Boolean(expected.unique)
      && Boolean(index.sparse) === Boolean(expected.sparse)
      && Boolean(index.hidden) === Boolean(expected.hidden)
      && Boolean(index.prepareUnique) === Boolean(expected.prepareUnique)
      && sameDocument(index.partialFilterExpression, expected.partialFilterExpression)
      && sameDocument(index.expireAfterSeconds, expected.expireAfterSeconds)
      && sameDocument(index.storageEngine, expected.storageEngine)
      && sameDocument(index.collation, expectedCollation)) return 0
  }
  // Differently named same-key companions are legal and harmless once the
  // exact target index exists; only the target's own contract is authoritative.
  return 1
}

function startupIndexConflictCount(database) {
  const cache = new Map()
  const indexesFor = (collectionName) => {
    if (!cache.has(collectionName)) {
      cache.set(collectionName, collectionIndexes(database, collectionName))
    }
    return cache.get(collectionName)
  }
  return OTHER_STARTUP_INDEXES.reduce((total, { collection, expected }) => safeAdd(
    total, indexConflictCount(indexesFor(collection), expected),
  ), 0)
}

function collectionIndexes(database, collectionName) {
  if (!database || typeof database.getCollectionInfos !== 'function'
    || typeof collectionName !== 'string' || !collectionName) {
    throw new TypeError('Invalid collection index inventory request')
  }
  // getIndexes fails with NamespaceNotFound for collections first introduced
  // by v7.  This bounded exact-name inventory distinguishes safe absence from
  // a real index inspection failure without creating the collection.
  const infos = database.getCollectionInfos({ name: collectionName })
  if (!Array.isArray(infos) || infos.length > 1
    || infos.some((info) => !plainObject(info) || info.name !== collectionName)) {
    throw new TypeError('Unexpected collection inventory')
  }
  if (infos.length === 0) return []
  const indexes = database.getCollection(collectionName).getIndexes()
  if (!Array.isArray(indexes)) throw new TypeError('Unexpected collection index list')
  const defaultCollation = infos[0]?.options?.collation
  return indexes.map((index) => ({
    ...index,
    __titraCollectionDefaultCollation: defaultCollation,
  }))
}

function exactType(path, type) {
  return { $expr: { $eq: [{ $type: `$${path}` }, type] } }
}

function exactNonemptyString(path) {
  return {
    $expr: {
      $and: [
        { $eq: [{ $type: `$${path}` }, 'string'] },
        { $ne: [`$${path}`, ''] },
      ],
    },
  }
}

function credentialPlaintextLimit(path) {
  if (typeof path !== 'string' || !path) throw new TypeError('Invalid credential path')
  return LONG_OAUTH_TOKEN_PATHS.includes(path)
    ? MAX_OAUTH_TOKEN_PLAINTEXT_BYTES : MAX_DEFAULT_PLAINTEXT_CREDENTIAL_BYTES
}

function oversizedPlaintextCredential(path) {
  const limit = credentialPlaintextLimit(path)
  return {
    $expr: {
      $gt: [
        {
          // Mongo cannot calculate JavaScript UTF-16 string length directly.
          // UTF-8 bytes are a conservative ceiling: this can block a heavily
          // non-ASCII value early, but cannot miss a runtime-oversized value.
          $strLenBytes: {
            $cond: [
              { $eq: [{ $type: `$${path}` }, 'string'] },
              `$${path}`,
              '',
            ],
          },
        },
        limit,
      ],
    },
  }
}

function malformedConfiguredValue(path) {
  return {
    $expr: {
      $and: [
        { $not: [{ $in: [{ $type: `$${path}` }, ['missing', 'null', 'string', 'object']] }] },
        { $ne: [`$${path}`, ''] },
      ],
    },
  }
}

function mergeSelector(selector, condition) {
  return Object.keys(selector).length === 0 ? condition : { $and: [selector, condition] }
}

function collectionCount(collection, selector) {
  const result = collection.countDocuments(selector, { maxTimeMS: QUERY_TIMEOUT_MS })
  if (!count(result)) throw new TypeError('Unexpected Mongo count')
  return result
}

function oneRowCount(collection, pipeline) {
  const rows = collection.aggregate(pipeline, {
    allowDiskUse: true,
    maxTimeMS: QUERY_TIMEOUT_MS,
  }).toArray()
  if (!Array.isArray(rows) || rows.length > 1) throw new TypeError('Unexpected aggregate result')
  if (rows.length === 0) return 0
  if (!plainObject(rows[0]) || Object.keys(rows[0]).length !== 1 || !count(rows[0].count)) {
    throw new TypeError('Invalid aggregate count')
  }
  return rows[0].count
}

function duplicateGroupCount(collection, match, groupId) {
  return oneRowCount(collection, [
    { $match: match },
    { $group: { _id: groupId, documents: { $sum: 1 } } },
    { $match: { documents: { $gt: 1 } } },
    { $count: 'count' },
  ])
}

function uniqueIndexKeyShapeCount(collection, partialMatch, exactShapeExpression) {
  return oneRowCount(collection, [
    { $match: partialMatch },
    { $match: { $expr: { $eq: [exactShapeExpression, false] } } },
    { $count: 'count' },
  ])
}

function exactStringExpression(path, { nonempty = false } = {}) {
  const conditions = [{ $eq: [{ $type: `$${path}` }, 'string'] }]
  if (nonempty) conditions.push({ $ne: [`$${path}`, ''] })
  return conditions.length === 1 ? conditions[0] : { $and: conditions }
}

function inspectIndexState(database) {
  const dashboards = database.getCollection('dashboards')
  const tasks = database.getCollection('tasks')
  const backups = database.getCollection('timecardDateMigrationBackups')
  const googleStates = database.getCollection('googleOAuthStates')
  return {
    dashboard_slug_duplicate_groups: duplicateGroupCount(
      dashboards, { $expr: exactStringExpression('slug', { nonempty: true }) }, '$slug',
    ),
    dashboard_slug_key_shape_malformed: uniqueIndexKeyShapeCount(
      dashboards,
      DASHBOARD_SLUG_INDEX.partialFilterExpression,
      exactStringExpression('slug', { nonempty: true }),
    ),
    dashboard_slug_index_conflicts: indexConflictCount(
      collectionIndexes(database, 'dashboards'), DASHBOARD_SLUG_INDEX,
    ),
    personal_task_duplicate_groups: duplicateGroupCount(tasks, {
      $expr: {
        $and: [
          { $in: [{ $type: '$projectId' }, ['missing', 'null']] },
          exactStringExpression('userId'),
          exactStringExpression('name'),
        ],
      },
    }, { userId: '$userId', name: '$name' }),
    personal_task_key_shape_malformed: uniqueIndexKeyShapeCount(
      tasks,
      PERSONAL_TASK_INDEX.partialFilterExpression,
      {
        $and: [
          { $in: [{ $type: '$projectId' }, ['missing', 'null']] },
          exactStringExpression('userId'),
          exactStringExpression('name'),
        ],
      },
    ),
    personal_task_index_conflicts: indexConflictCount(
      collectionIndexes(database, 'tasks'), PERSONAL_TASK_INDEX,
    ),
    migration_backup_duplicate_groups: duplicateGroupCount(
      backups, {
        $expr: {
          $and: [exactStringExpression('runId'), exactStringExpression('timecardId')],
        },
      }, { runId: '$runId', timecardId: '$timecardId' },
    ),
    migration_backup_key_shape_malformed: uniqueIndexKeyShapeCount(
      backups, {}, {
        $and: [exactStringExpression('runId'), exactStringExpression('timecardId')],
      },
    ),
    migration_backup_index_conflicts: indexConflictCount(
      collectionIndexes(database, 'timecardDateMigrationBackups'),
      MIGRATION_BACKUP_INDEX,
    ),
    google_oauth_duplicate_groups: duplicateGroupCount(
      googleStates, { $expr: exactStringExpression('tokenHash') }, '$tokenHash',
    ),
    google_oauth_key_shape_malformed: uniqueIndexKeyShapeCount(
      googleStates, {}, exactStringExpression('tokenHash'),
    ),
    google_oauth_index_conflicts: indexConflictCount(
      collectionIndexes(database, 'googleOAuthStates'), GOOGLE_OAUTH_INDEX,
    ),
    other_startup_index_conflicts: startupIndexConflictCount(database),
  }
}

function projectDescriptionReviewPipeline() {
  return [
    {
      $project: {
        _id: 0,
        effectiveDescription: {
          $cond: [
            { $in: [{ $type: '$description' }, ['missing', 'null']] },
            '$desc',
            '$description',
          ],
        },
      },
    },
    {
      $project: {
        _id: 0,
        review: {
          $let: {
            vars: { valueType: { $type: '$effectiveDescription' } },
            in: {
              $cond: [
                { $eq: ['$$valueType', 'string'] },
                {
                  $or: [
                    {
                      $regexMatch: {
                        input: '$effectiveDescription',
                        regex: /<\/?[A-Za-z][^>]*>/,
                      },
                    },
                    { $gt: [{ $strLenCP: '$effectiveDescription' }, 50000] },
                  ],
                },
                { $not: [{ $in: ['$$valueType', ['missing', 'null']] }] },
              ],
            },
          },
        },
      },
    },
    { $match: { review: true } },
    { $count: 'count' },
  ]
}

function inspectAdminMutationLock(securityState, now) {
  const longAfter = new Date(now.getTime() + ADMIN_MUTATION_LEASE_GRACE_MS)
  const base = { _id: 'administrator-mutation-lock' }
  return {
    admin_mutation_lock_active: collectionCount(securityState, {
      ...base, leaseUntil: { $type: 'date', $gt: now },
    }),
    admin_mutation_lock_long: collectionCount(securityState, {
      ...base, leaseUntil: { $type: 'date', $gt: longAfter },
    }),
    admin_mutation_lock_malformed: collectionCount(securityState, {
      ...base,
      leaseUntil: { $exists: true },
      $expr: { $ne: [{ $type: '$leaseUntil' }, 'date'] },
    }),
  }
}

function malformedMemberArrayExpression(path) {
  return {
    $let: {
      vars: {
        value: `$${path}`,
        valueType: { $type: `$${path}` },
      },
      in: {
        $cond: [
          { $in: ['$$valueType', ['missing', 'null']] },
          false,
          {
            $cond: [
              { $eq: ['$$valueType', 'array'] },
              {
                $anyElementTrue: {
                  $map: {
                    input: '$$value',
                    as: 'member',
                    in: {
                      $cond: [
                        { $eq: [{ $type: '$$member' }, 'string'] },
                        {
                          $or: [
                            { $eq: ['$$member', ''] },
                            { $gt: [{ $strLenCP: '$$member' }, 128] },
                          ],
                        },
                        true,
                      ],
                    },
                  },
                },
              },
              true,
            ],
          },
        ],
      },
    },
  }
}

function projectMembershipPipeline() {
  return [
    {
      $match: {
        $expr: {
          $or: [
            {
              $cond: [
                { $eq: [{ $type: '$userId' }, 'string'] },
                {
                  $or: [
                    { $eq: ['$userId', ''] },
                    { $gt: [{ $strLenCP: '$userId' }, 128] },
                  ],
                },
                true,
              ],
            },
            malformedMemberArrayExpression('team'),
            malformedMemberArrayExpression('admins'),
          ],
        },
      },
    },
    { $count: 'count' },
  ]
}

function malformedRevisionPipeline(path, selector = {}) {
  return [
    { $match: mergeSelector(selector, { [path]: { $exists: true } }) },
    { $project: { _id: 0, value: `$${path}`, valueType: { $type: `$${path}` } } },
    {
      $match: {
        $expr: {
          $cond: [
            { $in: ['$valueType', ['int', 'long', 'double']] },
            {
              $or: [
                { $in: [{ $toString: '$value' }, ['NaN', 'Infinity', '-Infinity']] },
                { $lt: ['$value', 0] },
                { $gte: ['$value', MAX_SAFE_REVISION] },
                { $ne: ['$value', { $trunc: '$value' }] },
              ],
            },
            true,
          ],
        },
      },
    },
    { $count: 'count' },
  ]
}

function inspectResourceRevisions(database) {
  const specifications = [
    ['projects', 'projectRevision', {}],
    ['tasks', 'projectTaskRevision', { projectId: { $type: 'string' } }],
    ['tasks', 'taskSuggestionRevision', { projectId: null }],
    ['timecards', 'dateRevision', {}],
    ['users', 'profile.timerRevision', {}],
    ['webhookverification', 'configurationRevision', {}],
  ]
  return specifications.reduce((total, [collectionName, path, selector]) => safeAdd(
    total,
    oneRowCount(
      database.getCollection(collectionName), malformedRevisionPipeline(path, selector),
    ),
  ), 0)
}

function timerHistoryMalformedPipeline() {
  const entryMalformed = {
    $cond: [
      { $eq: [{ $type: '$$entry' }, 'object'] },
      {
        $or: [
          {
            $not: [{
              $setEquals: [
                {
                  $map: {
                    input: { $objectToArray: '$$entry' },
                    as: 'part',
                    in: '$$part.k',
                  },
                },
                ['operationId', 'expiresAt'],
              ],
            }],
          },
          {
            $not: [{
              $regexMatch: {
                input: {
                  $cond: [
                    { $eq: [{ $type: '$$entry.operationId' }, 'string'] },
                    '$$entry.operationId',
                    '',
                  ],
                },
                regex: /^[A-Za-z0-9._:-]{8,128}$/,
              },
            }],
          },
          { $ne: [{ $type: '$$entry.expiresAt' }, 'date'] },
        ],
      },
      true,
    ],
  }
  return [
    { $match: { 'profile.timerStartHistory': { $exists: true } } },
    {
      $project: {
        _id: 0,
        malformed: {
          $let: {
            vars: {
              history: '$profile.timerStartHistory',
              historyType: { $type: '$profile.timerStartHistory' },
            },
            in: {
              $cond: [
                { $eq: ['$$historyType', 'array'] },
                {
                  $cond: [
                    { $lte: [{ $size: '$$history' }, MAX_TIMER_START_HISTORY] },
                    {
                      $anyElementTrue: {
                        $map: { input: '$$history', as: 'entry', in: entryMalformed },
                      },
                    },
                    false,
                  ],
                },
                true,
              ],
            },
          },
        },
      },
    },
    { $match: { malformed: true } },
    { $count: 'count' },
  ]
}

function migrationLockMalformedPipeline() {
  const malformedWriter = {
    $cond: [
      { $eq: [{ $type: '$$writer' }, 'object'] },
      {
        $or: [
          { $ne: [{ $type: '$$writer.token' }, 'string'] },
          { $eq: ['$$writer.token', ''] },
          { $ne: [{ $type: '$$writer.acquiredAt' }, 'date'] },
          { $ne: [{ $type: '$$writer.leaseUntil' }, 'date'] },
        ],
      },
      true,
    ],
  }
  const optionalTypeInvalid = (path, allowed) => ({
    $not: [{ $in: [{ $type: `$${path}` }, ['missing', 'null', ...allowed]] }],
  })
  return [
    { $match: { _id: 'timecard-date-migration' } },
    {
      $match: {
        $expr: {
          $or: [
            optionalTypeInvalid('leaseUntil', ['date']),
            optionalTypeInvalid('ownerRunId', ['string']),
            optionalTypeInvalid('fence', ['int', 'long', 'double']),
            optionalTypeInvalid('activeWriters', ['array']),
            {
              $cond: [
                { $eq: [{ $type: '$ownerRunId' }, 'string'] },
                { $eq: ['$ownerRunId', ''] },
                false,
              ],
            },
            {
              $and: [
                { $eq: [{ $type: '$leaseUntil' }, 'date'] },
                { $gt: ['$leaseUntil', '$$NOW'] },
                {
                  $not: [{
                    $and: [
                      { $eq: [{ $type: '$ownerRunId' }, 'string'] },
                      { $ne: ['$ownerRunId', ''] },
                    ],
                  }],
                },
              ],
            },
            {
              $cond: [
                { $in: [{ $type: '$fence' }, ['int', 'long', 'double']] },
                {
                  $or: [
                    { $in: [{ $toString: '$fence' }, ['NaN', 'Infinity', '-Infinity']] },
                    { $lt: ['$fence', 0] },
                    { $gte: ['$fence', MAX_SAFE_REVISION] },
                    { $ne: ['$fence', { $trunc: '$fence' }] },
                  ],
                },
                false,
              ],
            },
            {
              $cond: [
                { $eq: [{ $type: '$activeWriters' }, 'array'] },
                {
                  $anyElementTrue: {
                    $map: {
                      input: '$activeWriters', as: 'writer', in: malformedWriter,
                    },
                  },
                },
                false,
              ],
            },
          ],
        },
      },
    },
    { $count: 'count' },
  ]
}

function migrationLockActivePipeline() {
  return [
    { $match: { _id: 'timecard-date-migration' } },
    {
      $match: {
        $expr: {
          $or: [
            {
              $and: [
                { $eq: [{ $type: '$ownerRunId' }, 'string'] },
                { $ne: ['$ownerRunId', ''] },
                { $eq: [{ $type: '$leaseUntil' }, 'date'] },
                { $gt: ['$leaseUntil', '$$NOW'] },
              ],
            },
            {
              $cond: [
                { $eq: [{ $type: '$activeWriters' }, 'array'] },
                {
                  $anyElementTrue: {
                    $map: {
                      input: '$activeWriters',
                      as: 'writer',
                      in: {
                        $cond: [
                          { $eq: [{ $type: '$$writer' }, 'object'] },
                          {
                            $and: [
                              { $eq: [{ $type: '$$writer.leaseUntil' }, 'date'] },
                              { $gt: ['$$writer.leaseUntil', '$$NOW'] },
                            ],
                          },
                          false,
                        ],
                      },
                    },
                  },
                },
                false,
              ],
            },
          ],
        },
      },
    },
    { $count: 'count' },
  ]
}

function inspectMigrationState(database) {
  const locks = database.getCollection('timecardDateMigrationLocks')
  const runs = database.getCollection('timecardDateMigrationRuns')
  return {
    migration_lock_active: oneRowCount(locks, migrationLockActivePipeline()),
    migration_lock_malformed: oneRowCount(locks, migrationLockMalformedPipeline()),
    migration_runs_active: collectionCount(runs, {
      status: { $in: ['freezing', 'applying', 'restoring'] },
    }),
  }
}

function dashboardCustomRangePipeline(now = new Date()) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new TypeError('Dashboard-range clock is invalid')
  }
  // The v7 publication defaults a missing/falsy custom endpoint to the current
  // month.  Production containers run UTC, so use explicit UTC month bounds
  // rather than incorrectly classifying an operable legacy dashboard.
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
  const monthEnd = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth() + 1, 1,
  ) - 1)
  const valueOrDefault = (path, fallback) => ({
    $cond: [
      {
        $or: [
          { $in: [{ $type: `$${path}` }, ['missing', 'null']] },
          { $eq: [`$${path}`, ''] },
          { $eq: [`$${path}`, false] },
          { $eq: [`$${path}`, 0] },
        ],
      },
      fallback,
      `$${path}`,
    ],
  })
  return [
    { $match: { timePeriod: 'custom' } },
    {
      $project: {
        _id: 0,
        start: {
          $convert: {
            input: valueOrDefault('startDate', monthStart),
            to: 'date', onError: null, onNull: null,
          },
        },
        end: {
          $convert: {
            input: valueOrDefault('endDate', monthEnd),
            to: 'date', onError: null, onNull: null,
          },
        },
      },
    },
    {
      $match: {
        $expr: {
          $or: [
            { $eq: ['$start', null] },
            { $eq: ['$end', null] },
            { $lt: ['$end', '$start'] },
            { $gt: [{ $subtract: ['$end', '$start'] }, MAX_PUBLIC_DASHBOARD_SPAN_MS] },
          ],
        },
      },
    },
    { $count: 'count' },
  ]
}

function dashboardInvalidPeriodSelector() {
  return {
    $expr: {
      $or: [
        { $ne: [{ $type: '$timePeriod' }, 'string'] },
        { $eq: [{ $in: ['$timePeriod', [...BOUNDED_DASHBOARD_PERIODS, 'all']] }, false] },
      ],
    },
  }
}

function dashboardInvalidProjectSelector() {
  return {
    $expr: {
      $or: [
        { $ne: [{ $type: '$projectId' }, 'string'] },
        { $eq: ['$projectId', ''] },
      ],
    },
  }
}

function pendingVerificationExpression() {
  const requiredType = { $type: '$actionVerification.required' }
  const completedType = { $type: '$actionVerification.completed' }
  return {
    $and: [
      { $eq: [{ $type: '$actionVerification' }, 'object'] },
      { $eq: [requiredType, 'bool'] },
      { $eq: ['$actionVerification.required', true] },
      {
        $or: [
          { $ne: [completedType, 'bool'] },
          { $eq: ['$actionVerification.completed', false] },
        ],
      },
    ],
  }
}

function activeUserExpression() {
  return {
    $or: [
      { $eq: [{ $type: '$inactive' }, 'missing'] },
      {
        $and: [
          { $eq: [{ $type: '$inactive' }, 'bool'] },
          { $eq: ['$inactive', false] },
        ],
      },
    ],
  }
}

function strictAdminExpression() {
  return {
    $and: [
      { $eq: [{ $type: '$isAdmin' }, 'bool'] },
      { $eq: ['$isAdmin', true] },
    ],
  }
}

function malformedPendingVerificationSelector() {
  return {
    $expr: {
      $and: [
        pendingVerificationExpression(),
        { $ne: [{ $type: '$actionVerification.deadline' }, 'date'] },
      ],
    },
  }
}

function overdueVerificationSelector(now) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new TypeError('Verification clock is invalid')
  }
  return {
    $expr: {
      $and: [
        pendingVerificationExpression(),
        activeUserExpression(),
        { $eq: [{ $type: '$actionVerification.deadline' }, 'date'] },
        { $lt: ['$actionVerification.deadline', now] },
      ],
    },
  }
}

function lockedVerificationSelector(now, extra = {}) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new TypeError('Verification clock is invalid')
  }
  const deadlineType = { $type: '$actionVerification.deadline' }
  const selector = {
    $expr: {
      $and: [
        pendingVerificationExpression(),
        activeUserExpression(),
        {
          $or: [
            { $ne: [deadlineType, 'date'] },
            { $lt: ['$actionVerification.deadline', now] },
          ],
        },
      ],
    },
  }
  return mergeSelector(selector, extra)
}

function verificationMalformedFlagsPipeline() {
  const topType = { $type: '$actionVerification' }
  const requiredType = { $type: '$actionVerification.required' }
  const completedType = { $type: '$actionVerification.completed' }
  return [
    {
      $project: {
        _id: 0,
        malformed: {
          $or: [
            {
              $and: [
                { $ne: [topType, 'missing'] },
                { $ne: [topType, 'object'] },
              ],
            },
            {
              $and: [
                { $eq: [topType, 'object'] },
                { $ne: [requiredType, 'missing'] },
                { $ne: [requiredType, 'bool'] },
              ],
            },
            {
              $and: [
                { $eq: [topType, 'object'] },
                { $ne: [completedType, 'missing'] },
                { $ne: [completedType, 'bool'] },
              ],
            },
          ],
        },
      },
    },
    { $match: { malformed: true } },
    { $count: 'count' },
  ]
}

function secureWebhookSelector() {
  return {
    removedAt: { $exists: false },
    $expr: {
      $and: [
        { $eq: ['$active', true] },
        { $eq: ['$securityVersion', 2] },
        { $eq: ['$mappingVersion', 1] },
        exactStringExpression('endpointId'),
        {
          $regexMatch: {
            input: {
              $cond: [exactStringExpression('endpointId'), '$endpointId', ''],
            },
            regex: /^[0-9a-f]{32}$/,
          },
        },
        exactStringExpression('serviceUrl'),
        {
          $regexMatch: {
            input: {
              $cond: [exactStringExpression('serviceUrl'), '$serviceUrl', ''],
            },
            regex: /^https:\/\//i,
          },
        },
      ],
    },
  }
}

function runtimeWebhookSecretNames() {
  // The pinned transition override cannot securely preserve or provision the
  // endpoint-specific environment secrets from a predecessor-only override.
  // Treat every database-only active endpoint as unprovisioned. A later
  // release may replace this with a root-owned, receipt-bound secret store.
  return new Set()
}

function validWebhookPointer(pointer) {
  if (typeof pointer !== 'string' || !pointer.startsWith('/') || pointer.length > 512) {
    return false
  }
  const parts = pointer.slice(1).split('/')
  if (parts.length > 64) return false
  return parts.every((part) => {
    if (/~(?:[^01]|$)/u.test(part)) return false
    const decoded = part.replaceAll('~1', '/').replaceAll('~0', '~')
    return decoded.length > 0
      && !['__proto__', 'prototype', 'constructor'].includes(decoded)
  })
}

function validWebhookMappingRules(rules) {
  if (!Array.isArray(rules) || rules.length < 1 || rules.length > 32) return false
  return rules.every((rule) => {
    const keys = plainObject(rule) ? Object.keys(rule).sort() : []
    const expectedKeys = ['action', 'eventEquals', 'eventPointer', 'userIdPointer']
    if (!plainObject(rule) || keys.length !== expectedKeys.length
      || keys.some((key, index) => key !== expectedKeys[index])) return false
    const eventEquals = rule.eventEquals
    const scalar = eventEquals === null
      || (typeof eventEquals === 'string' && wellFormedString(eventEquals)
        && [...eventEquals].length <= 512)
      || typeof eventEquals === 'boolean'
      || (typeof eventEquals === 'number' && Number.isFinite(eventEquals))
    return scalar && ['complete', 'revoke'].includes(rule.action)
      && validWebhookPointer(rule.eventPointer)
      && validWebhookPointer(rule.userIdPointer)
  })
}

function validRuntimeWebhookConfiguration(webhook) {
  if (!plainObject(webhook)
    || typeof webhook._id !== 'string' || !webhook._id
    || typeof webhook.endpointId !== 'string'
    || !/^[0-9a-f]{32}$/u.test(webhook.endpointId)
    || webhook.securityVersion !== 2 || webhook.mappingVersion !== 1
    || webhook.active !== true || webhook.removedAt !== undefined
    || !Number.isInteger(webhook.verificationPeriod)
    || webhook.verificationPeriod < 1 || webhook.verificationPeriod > 3650
    || !validWebhookMappingRules(webhook.mappingRules)) return false
  if (typeof webhook.serviceUrl !== 'string' || !webhook.serviceUrl) return false
  try {
    const serviceUrl = new URL(webhook.serviceUrl)
    if (serviceUrl.protocol !== 'https:' || serviceUrl.username || serviceUrl.password) return false
  } catch {
    return false
  }
  const urlParam = webhook.urlParam || 'client_reference_id'
  return typeof urlParam === 'string'
    && /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/u.test(urlParam)
}

function pendingVerificationSelector(extra = {}) {
  return mergeSelector({ $expr: pendingVerificationExpression() }, extra)
}

function webhookReferenceTypeExpression() {
  return { $type: '$actionVerification.webhookInterfaceId' }
}

function invalidExplicitWebhookReferenceExpression(validInterfaceIds) {
  const referenceType = webhookReferenceTypeExpression()
  return {
    $and: [
      { $eq: [referenceType, 'string'] },
      { $ne: ['$actionVerification.webhookInterfaceId', ''] },
      { $eq: [{ $in: ['$actionVerification.webhookInterfaceId', validInterfaceIds] }, false] },
    ],
  }
}

function malformedWebhookReferenceExpression() {
  const referenceType = webhookReferenceTypeExpression()
  return {
    $and: [
      { $ne: [referenceType, 'missing'] },
      { $ne: [referenceType, 'null'] },
      { $ne: [referenceType, 'string'] },
    ],
  }
}

function defaultWebhookReferenceExpression() {
  const referenceType = webhookReferenceTypeExpression()
  return {
    $or: [
      { $eq: [referenceType, 'missing'] },
      { $eq: [referenceType, 'null'] },
      {
        $and: [
          { $eq: [referenceType, 'string'] },
          { $eq: ['$actionVerification.webhookInterfaceId', ''] },
        ],
      },
    ],
  }
}

function unrecoverableVerificationCount(users, validInterfaceIds, hasDefault, extra = {}) {
  if (!Array.isArray(validInterfaceIds)
    || validInterfaceIds.some((value) => typeof value !== 'string')) {
    throw new TypeError('Invalid webhook interface inventory')
  }
  let result = collectionCount(users, pendingVerificationSelector(mergeSelector(
    extra, { $expr: invalidExplicitWebhookReferenceExpression(validInterfaceIds) },
  )))
  result = safeAdd(result, collectionCount(users, pendingVerificationSelector(
    mergeSelector(extra, { $expr: malformedWebhookReferenceExpression() }),
  )))
  if (!hasDefault) {
    result = safeAdd(result, collectionCount(users, pendingVerificationSelector(
      mergeSelector(extra, { $expr: defaultWebhookReferenceExpression() }),
    )))
  }
  return result
}

function inspectSecureWebhookRuntime(webhooks, users, now) {
  const selector = secureWebhookSelector()
  const documentCount = collectionCount(webhooks, selector)
  if (documentCount > MAX_WEBHOOK_CONFIGURATION_DOCUMENTS) {
    return {
      secure_webhook_invalid_configurations: 0,
      secure_webhook_missing_secrets: 0,
      secure_webhook_candidate_over_limit: 1,
      verification_unrecoverable_locked: 0,
      verification_unrecoverable_pending: 0,
      validWebhookCount: 0,
    }
  }
  const documents = webhooks.find(selector, {
    _id: 1, endpointId: 1, securityVersion: 1, mappingVersion: 1, active: 1,
    removedAt: 1, verificationPeriod: 1, serviceUrl: 1, urlParam: 1,
    mappingRules: 1,
  }).sort({ _id: 1 }).limit(MAX_WEBHOOK_CONFIGURATION_DOCUMENTS + 1).toArray()
  if (!Array.isArray(documents) || documents.length !== documentCount
    || documents.some((document) => !plainObject(document))) {
    throw new TypeError('Webhook configuration count changed during probe')
  }
  const secretNames = runtimeWebhookSecretNames()
  const valid = documents.filter(validRuntimeWebhookConfiguration)
  const validWithSecret = valid.filter((webhook) => secretNames.has(
    `TITRA_WEBHOOK_SECRET_${webhook.endpointId.toUpperCase()}`,
  ))
  const validInterfaceIds = validWithSecret.map((webhook) => webhook._id)
  const hasDefault = validInterfaceIds.length > 0
  return {
    secure_webhook_invalid_configurations: documents.length - valid.length,
    secure_webhook_missing_secrets: valid.length - validWithSecret.length,
    secure_webhook_candidate_over_limit: 0,
    verification_unrecoverable_locked: unrecoverableVerificationCount(
      users, validInterfaceIds, hasDefault, lockedVerificationSelector(now),
    ),
    verification_unrecoverable_pending: unrecoverableVerificationCount(
      users, validInterfaceIds, hasDefault,
    ),
    validWebhookCount: validWithSecret.length,
  }
}

function unrecoverableLockedPipeline(now, secureDefaultExists) {
  const explicitReference = {
    $expr: {
      $or: [
        {
          $and: [
            { $eq: [webhookReferenceTypeExpression(), 'string'] },
            { $ne: ['$actionVerification.webhookInterfaceId', ''] },
          ],
        },
        malformedWebhookReferenceExpression(),
      ],
    },
  }
  return [
    { $match: lockedVerificationSelector(now, secureDefaultExists ? explicitReference : {}) },
    {
      $lookup: {
        from: 'webhookverification',
        localField: 'actionVerification.webhookInterfaceId',
        foreignField: '_id',
        pipeline: [{ $match: secureWebhookSelector() }],
        as: 'recoverableWebhook',
      },
    },
    {
      $match: {
        $expr: {
          $or: [
            malformedWebhookReferenceExpression(),
            { $eq: [{ $size: '$recoverableWebhook' }, 0] },
          ],
        },
      },
    },
    { $count: 'count' },
  ]
}

function wellFormedString(value) {
  if (typeof value !== 'string') return false
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code >= 0xD800 && code <= 0xDBFF) {
      const next = value.charCodeAt(index + 1)
      if (!(next >= 0xDC00 && next <= 0xDFFF)) return false
      index += 1
    } else if (code >= 0xDC00 && code <= 0xDFFF) return false
  }
  return true
}

function timeRuleKind(source) {
  if (typeof source !== 'string' || source.length > 50000 || !wellFormedString(source)) {
    return 'unsafe'
  }
  if (LITERAL_ALLOW_RULE.test(source)) return 'allow'
  if (LITERAL_DENY_RULE.test(source)) return 'deny'
  return 'unsafe'
}

function readBoundedSettingDocuments(collection, name) {
  const documents = collection.find(
    { name },
    { _id: 0, value: 1 },
  ).sort({ _id: 1 }).limit(MAX_TIME_RULE_DOCUMENTS + 1).toArray()
  if (!Array.isArray(documents) || documents.some((document) => !plainObject(document))) {
    throw new TypeError('Unexpected setting documents')
  }
  return documents
}

function inspectTimeRule(collection) {
  const documentCount = collectionCount(collection, { name: 'timeEntryRule' })
  if (documentCount > MAX_TIME_RULE_DOCUMENTS) {
    return {
      time_rule_documents: documentCount,
      time_rule_unsafe: 0,
      time_rule_literal_deny: 0,
      time_rule_overflow: 1,
    }
  }
  const documents = readBoundedSettingDocuments(collection, 'timeEntryRule')
  if (documents.length !== documentCount) throw new TypeError('Time-rule count changed during probe')
  const kinds = documents.map((document) => timeRuleKind(document.value))
  return {
    time_rule_documents: documentCount,
    // Multiple rows make getGlobalSettingAsync selection nondeterministic even
    // if each body is individually safe.
    time_rule_unsafe: kinds.filter((kind) => kind === 'unsafe').length
      + (documentCount > 1 ? 1 : 0),
    time_rule_literal_deny: kinds.filter((kind) => kind === 'deny').length,
    time_rule_overflow: 0,
  }
}

function settingTruthy(collection, name) {
  const documents = collection.find({ name }, { _id: 0, value: 1 })
    .sort({ _id: 1 }).limit(MAX_TIME_RULE_DOCUMENTS + 1).toArray()
  if (!Array.isArray(documents) || documents.length > MAX_TIME_RULE_DOCUMENTS) {
    throw new TypeError('Unexpected global-setting cardinality')
  }
  return documents.some((document) => Boolean(document?.value))
}

function inspectCredentials(database) {
  let plaintextFields = 0
  let malformedFields = 0
  let objectFields = 0
  let oversizedPlaintextFields = 0
  let candidateDocuments = 0
  for (const store of CREDENTIAL_STORES) {
    const collection = database.getCollection(store.collection)
    const stringConditions = []
    for (const path of store.paths) {
      const plaintextSelector = mergeSelector(store.selector, exactNonemptyString(path))
      const malformedSelector = mergeSelector(store.selector, malformedConfiguredValue(path))
      const objectSelector = mergeSelector(store.selector, exactType(path, 'object'))
      const oversizedSelector = mergeSelector(
        store.selector, oversizedPlaintextCredential(path),
      )
      plaintextFields = safeAdd(plaintextFields, collectionCount(collection, plaintextSelector))
      malformedFields = safeAdd(malformedFields, collectionCount(collection, malformedSelector))
      objectFields = safeAdd(objectFields, collectionCount(collection, objectSelector))
      oversizedPlaintextFields = safeAdd(
        oversizedPlaintextFields, collectionCount(collection, oversizedSelector),
      )
      stringConditions.push(exactType(path, 'string'))
    }
    const candidateSelector = mergeSelector(store.selector, { $or: stringConditions })
    candidateDocuments = safeAdd(
      candidateDocuments,
      collectionCount(collection, candidateSelector),
    )
  }
  return {
    plaintext_credential_fields: plaintextFields,
    credential_candidate_documents: candidateDocuments,
    credential_malformed_fields: malformedFields,
    credential_object_fields: objectFields,
    credential_oversized_plaintext_fields: oversizedPlaintextFields,
    credential_candidate_over_limit:
      candidateDocuments > MAX_CREDENTIAL_CANDIDATE_DOCUMENTS ? 1 : 0,
    plaintext_credential_over_limit:
      plaintextFields > MAX_PLAINTEXT_CREDENTIAL_FIELDS ? 1 : 0,
  }
}

function inspectApiTokens(users, indexes = users.getIndexes()) {
  const activePlaintext = {
    inactive: { $ne: true },
    'profile.APItoken': { $type: 'string', $ne: '' },
  }
  const invalidPlaintext = {
    ...activePlaintext,
    $or: [
      { 'profile.APItoken': /[\s,]/ },
      {
        $expr: {
          $gt: [
            {
              $strLenCP: {
                $cond: [
                  { $eq: [{ $type: '$profile.APItoken' }, 'string'] },
                  '$profile.APItoken',
                  '',
                ],
              },
            },
            512,
          ],
        },
      },
    ],
  }
  const validHash = {
    $expr: {
      $and: [
        { $eq: ['$services.titraApiToken.version', 1] },
        exactStringExpression('services.titraApiToken.sha256'),
        {
          $regexMatch: {
            input: {
              $cond: [
                exactStringExpression('services.titraApiToken.sha256'),
                '$services.titraApiToken.sha256',
                '',
              ],
            },
            regex: /^[0-9a-f]{64}$/,
          },
        },
      ],
    },
  }
  return {
    plaintext_api_tokens: collectionCount(users, activePlaintext),
    invalid_plaintext_api_tokens: collectionCount(users, invalidPlaintext),
    duplicate_plaintext_api_token_groups: duplicateGroupCount(
      users, activePlaintext, '$profile.APItoken',
    ),
    duplicate_hashed_api_token_groups: duplicateGroupCount(
      users, validHash, '$services.titraApiToken.sha256',
    ),
    malformed_hashed_api_tokens: collectionCount(users, {
      'services.titraApiToken': { $exists: true },
      $nor: [validHash],
    }),
    api_token_key_shape_malformed: uniqueIndexKeyShapeCount(
      users,
      API_TOKEN_INDEX.partialFilterExpression,
      {
        $and: [
          { $eq: ['$services.titraApiToken.version', 1] },
          exactStringExpression('services.titraApiToken.sha256'),
        ],
      },
    ),
    api_token_index_conflicts: indexConflictCount(indexes, API_TOKEN_INDEX),
  }
}

function validRequiredString(value, maximumLength) {
  return typeof value === 'string'
    && value.trim().length > 0
    && value.trim().length <= maximumLength
    && !/[\u0000-\u001f\u007f]/u.test(value.trim())
}

function parsedHttpsUrl(value, { allowQuery = true } = {}) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) return null
  try {
    const parsed = new URL(value)
    if (parsed.protocol !== 'https:' || !parsed.hostname || parsed.username || parsed.password
      || parsed.hash || (!allowQuery && parsed.search)) return null
    return parsed
  } catch {
    return null
  }
}

function validOidcEndpoint(value, serverUrl) {
  if (typeof value !== 'string') return false
  const endpoint = value.trim()
  if (!endpoint || endpoint.length > 2048 || endpoint.startsWith('//')) return false
  let absolute = endpoint
  try {
    absolute = new URL(endpoint).toString()
  } catch {
    const server = parsedHttpsUrl(serverUrl || '', { allowQuery: false })
    if (!server) return false
    absolute = `${server.toString().replace(/\/$/u, '')}${endpoint.startsWith('/') ? '' : '/'}${endpoint}`
  }
  return Boolean(parsedHttpsUrl(absolute))
}

function validOidcScopes(value = 'openid,profile,email') {
  if (typeof value !== 'string' || value.length > 2048) return false
  const tokens = value.split(/[\s,]+/u).filter(Boolean).map((token) => {
    let normalized = token.trim()
    if (normalized.length >= 2
      && ((normalized.startsWith('"') && normalized.endsWith('"'))
        || (normalized.startsWith("'") && normalized.endsWith("'")))) {
      normalized = normalized.slice(1, -1).trim()
    }
    return normalized
  })
  const unique = [...new Set(tokens)]
  return unique.length > 0 && unique.length <= 20 && unique.includes('openid')
    && unique.every((token) => /^[A-Za-z0-9][A-Za-z0-9:._/-]{0,127}$/u.test(token))
}

function validOidcClaims(value = []) {
  if (!Array.isArray(value) || value.length > 20) return false
  const protectedClaims = new Set([
    'id', 'username', 'accessToken', 'refreshToken', 'expiresAt', 'email', 'emailVerified',
    '__proto__', 'constructor', 'prototype',
  ])
  const claims = []
  for (const item of value) {
    if (typeof item !== 'string' || item.length > 2048) return false
    for (const claim of item.split(/[\s,]+/u).filter(Boolean)) {
      if (!/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/u.test(claim)
        || protectedClaims.has(claim)) return false
      if (!claims.includes(claim)) claims.push(claim)
      if (claims.length > 20) return false
    }
  }
  return true
}

function validStoredOidcConfiguration(configuration) {
  if (!plainObject(configuration)) return false
  const allowedKeys = new Set([
    '_id', 'service', 'disableDefaultLoginForm', 'autoInitiateLogin', 'clientId', 'secret',
    'serverUrl', 'authorizationEndpoint', 'tokenEndpoint', 'userinfoEndpoint',
    'idTokenWhitelistFields', 'requestPermissions', 'loginStyle', 'insecureLoopbackAllowed',
  ])
  if (Object.keys(configuration).some((key) => !allowedKeys.has(key))) return false
  if (configuration.service !== 'oidc') return false
  for (const field of ['disableDefaultLoginForm', 'autoInitiateLogin']) {
    if (configuration[field] !== undefined && typeof configuration[field] !== 'boolean') return false
  }
  if (configuration.insecureLoopbackAllowed !== undefined
    && typeof configuration.insecureLoopbackAllowed !== 'boolean') return false
  if (!validRequiredString(configuration.clientId, 512)) return false
  if (!(validRequiredString(configuration.secret, 4096)
    || plainObject(configuration.secret))) return false
  const serverUrl = configuration.serverUrl || ''
  if (serverUrl && !parsedHttpsUrl(serverUrl, { allowQuery: false })) return false
  if (!validOidcEndpoint(configuration.authorizationEndpoint, serverUrl)
    || !validOidcEndpoint(configuration.tokenEndpoint, serverUrl)
    || !validOidcEndpoint(configuration.userinfoEndpoint, serverUrl)
    || !validOidcScopes(configuration.requestPermissions)
    || !validOidcClaims(configuration.idTokenWhitelistFields)) return false
  return configuration.loginStyle === undefined
    || configuration.loginStyle === 'popup'
    || configuration.loginStyle === 'redirect'
}

function inspectOidc(globalsettings, configurations) {
  const documentCount = collectionCount(configurations, { service: 'oidc' })
  const overflow = documentCount > MAX_OIDC_CONFIGURATION_DOCUMENTS ? 1 : 0
  const enabled = collectionCount(globalsettings, {
    name: 'enableOpenIDConnect', value: true,
  }) > 0
  if (overflow) {
    return {
      oidc_config_documents: documentCount,
      oidc_invalid_enabled: enabled ? 1 : 0,
      oidc_invalid_dormant: enabled ? 0 : 1,
      oidc_config_overflow: 1,
    }
  }
  const documents = configurations.find(
    { service: 'oidc' },
    { _id: 1, service: 1, disableDefaultLoginForm: 1, autoInitiateLogin: 1,
      clientId: 1, secret: 1, serverUrl: 1, authorizationEndpoint: 1,
      tokenEndpoint: 1, userinfoEndpoint: 1, idTokenWhitelistFields: 1,
      requestPermissions: 1, loginStyle: 1, insecureLoopbackAllowed: 1 },
  ).sort({ _id: 1 }).limit(MAX_OIDC_CONFIGURATION_DOCUMENTS + 1).toArray()
  if (!Array.isArray(documents) || documents.length !== documentCount
    || documents.some((document) => !plainObject(document))) {
    throw new TypeError('OIDC configuration count changed during probe')
  }
  const invalidDocuments = documents.filter(
    (configuration) => !validStoredOidcConfiguration(configuration),
  ).length
  const invalidConfiguration = safeAdd(
    invalidDocuments,
    documentCount === 1 ? 0 : (documentCount > 0 || enabled ? 1 : 0),
  )
  return {
    oidc_config_documents: documentCount,
    oidc_invalid_enabled: enabled ? invalidConfiguration : 0,
    oidc_invalid_dormant: enabled ? 0 : invalidConfiguration,
    oidc_config_overflow: 0,
  }
}

function validIntegrationBaseUrl(value) {
  if (typeof value !== 'string' || value !== value.trim()) return false
  return Boolean(parsedHttpsUrl(value, { allowQuery: false }))
}

function validWekanUrl(value) {
  // OAuth.sealSecret produces an object. Its plaintext cannot be inspected
  // without the production encryption key, and v7 opens it before validation.
  if (plainObject(value)) return true
  if (typeof value !== 'string' || value !== value.trim()
    || !wellFormedString(value) || value.length === 0 || value.length > 2048) return false
  const parsed = parsedHttpsUrl(value)
  if (!parsed || parsed.hash || parsed.pathname.includes('%')) return false
  const parameters = [...parsed.searchParams.keys()]
  const tokens = parsed.searchParams.getAll('authToken')
  if (parameters.length !== 1 || parameters[0] !== 'authToken' || tokens.length !== 1
    || !validRequiredString(tokens[0], 4096)) return false
  const match = parsed.pathname.match(/^(.*\/api\/boards\/([A-Za-z0-9_-]{1,128})\/)export\/?$/u)
  return Boolean(match && !match[1].includes('//'))
}

function validGitlabQuery(value) {
  if (!value) return true
  if (typeof value !== 'string' || value.length > 1024 || value !== value.trim()
    || value.startsWith('/') || value.includes('\\') || value.includes('#')) return false
  try {
    const decoded = decodeURIComponent(value)
    return !decoded.split(/[/?]/u).includes('..')
      && !/[\u0000-\u001f\u007f]/u.test(decoded)
  } catch {
    return false
  }
}

function validWekanSelectors(value) {
  if (value === undefined || value === null) return true
  const values = typeof value === 'string' ? [value] : value
  return Array.isArray(values) && values.length <= 10
    && [...new Set(values)].every(
      (entry) => typeof entry === 'string' && /^[A-Za-z0-9_-]{1,128}$/u.test(entry),
    )
}

function configuredValueExpression(path, {
  excludeEmptyArray = false,
  includeEmptyString = false,
} = {}) {
  return {
    $let: {
      vars: { value: `$${path}`, valueType: { $type: `$${path}` } },
      in: {
        $cond: [
          { $eq: ['$$valueType', 'string'] },
          includeEmptyString ? true : { $ne: ['$$value', ''] },
          {
            $cond: [
              { $eq: ['$$valueType', 'array'] },
              excludeEmptyArray ? { $gt: [{ $size: '$$value' }, 0] } : true,
              { $not: [{ $in: ['$$valueType', ['missing', 'null']] }] },
            ],
          },
        ],
      },
    },
  }
}

function inspectIntegrations(users, projects) {
  const userSelector = {
    $or: ['siwappurl', 'zammadurl', 'gitlaburl'].map((name) => ({
      $expr: configuredValueExpression(`profile.${name}`),
    })),
  }
  const projectSelector = {
    $or: [
      ...['wekanurl', 'gitlabquery'].map((name) => ({
        $expr: configuredValueExpression(name),
      })),
      ...['selectedWekanList', 'selectedWekanSwimlanes'].map((name) => ({
        $expr: configuredValueExpression(name, {
          excludeEmptyArray: true,
          includeEmptyString: true,
        }),
      })),
    ],
  }
  const userCount = collectionCount(users, userSelector)
  const projectCount = collectionCount(projects, projectSelector)
  const candidateCount = safeAdd(userCount, projectCount)
  if (candidateCount > MAX_INTEGRATION_CANDIDATE_DOCUMENTS) {
    return {
      integration_candidate_documents: candidateCount,
      integration_invalid_configurations: 0,
      integration_candidate_over_limit: 1,
      wekan_sandstorm_urls: 0,
      insecure_http_integration_urls: 0,
    }
  }
  const userDocuments = users.find(userSelector, {
    _id: 0, 'profile.siwappurl': 1, 'profile.zammadurl': 1, 'profile.gitlaburl': 1,
  }).sort({ _id: 1 }).limit(MAX_INTEGRATION_CANDIDATE_DOCUMENTS + 1).toArray()
  const projectDocuments = projects.find(projectSelector, {
    _id: 0, wekanurl: 1, gitlabquery: 1, selectedWekanList: 1,
    selectedWekanSwimlanes: 1,
  }).sort({ _id: 1 }).limit(MAX_INTEGRATION_CANDIDATE_DOCUMENTS + 1).toArray()
  if (!Array.isArray(userDocuments) || !Array.isArray(projectDocuments)
    || userDocuments.length !== userCount || projectDocuments.length !== projectCount
    || [...userDocuments, ...projectDocuments].some((document) => !plainObject(document))) {
    throw new TypeError('Integration configuration count changed during probe')
  }
  let invalid = 0
  let sandstorm = 0
  let insecureHttp = 0
  for (const user of userDocuments) {
    const profile = plainObject(user.profile) ? user.profile : {}
    const configured = ['siwappurl', 'zammadurl', 'gitlaburl']
      .filter((field) => profile[field] !== undefined && profile[field] !== null
        && profile[field] !== '')
    if (configured.some((field) => !validIntegrationBaseUrl(profile[field]))) invalid += 1
    insecureHttp += configured.filter(
      (field) => typeof profile[field] === 'string' && /^http:\/\//iu.test(profile[field]),
    ).length
  }
  for (const project of projectDocuments) {
    if ((project.wekanurl !== undefined && project.wekanurl !== null && project.wekanurl !== '')
      && !validWekanUrl(project.wekanurl)) invalid += 1
    if (!validGitlabQuery(project.gitlabquery)
      || !validWekanSelectors(project.selectedWekanList)
      || !validWekanSelectors(project.selectedWekanSwimlanes)) invalid += 1
    if (typeof project.wekanurl === 'string' && project.wekanurl.includes('#')) sandstorm += 1
    if (typeof project.wekanurl === 'string' && /^http:\/\//iu.test(project.wekanurl)) {
      insecureHttp += 1
    }
  }
  return {
    integration_candidate_documents: candidateCount,
    integration_invalid_configurations: invalid,
    integration_candidate_over_limit: 0,
    wekan_sandstorm_urls: sandstorm,
    insecure_http_integration_urls: insecureHttp,
  }
}

function countUrlMatches(collection, paths, expression) {
  return paths.reduce((total, path) => safeAdd(total, collectionCount(collection, {
    [path]: { $type: 'string', $regex: expression },
  })), 0)
}

function emptyCounts(probeErrors = 0) {
  return Object.fromEntries(COUNT_FIELDS.map((field) => [field, field === 'probe_errors'
    ? probeErrors : 0]))
}

function validateCounts(counts) {
  if (!plainObject(counts)
    || Object.keys(counts).length !== COUNT_FIELDS.length
    || COUNT_FIELDS.some((field) => !Object.prototype.hasOwnProperty.call(counts, field)
      || !count(counts[field]))) throw new TypeError('Invalid compatibility summary')
  return counts
}

function summaryStatus(counts) {
  validateCounts(counts)
  if (BLOCK_FIELDS.some((field) => counts[field] > 0)
    || counts.verification_active_admins === 0
    || counts.verification_usable_admins === 0) return 'BLOCK'
  if (WARN_FIELDS.some((field) => counts[field] > 0)) return 'WARN'
  return 'PASS'
}

function marker(status, counts) {
  if (!['PASS', 'WARN', 'BLOCK', 'ERROR'].includes(status)) {
    throw new TypeError('Invalid compatibility status')
  }
  validateCounts(counts)
  return `${MARKER} status=${status}`
    + COUNT_FIELDS.map((field) => ` ${field}=${counts[field]}`).join('')
}

function inspectDatabase(database, now = new Date()) {
  if (!database || typeof database.getCollection !== 'function') {
    throw new TypeError('A Mongo database handle is required')
  }
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new TypeError('Compatibility probe clock is invalid')
  }
  const dashboards = database.getCollection('dashboards')
  const users = database.getCollection('users')
  const globalsettings = database.getCollection('globalsettings')
  const inbound = database.getCollection('inboundinterfaces')
  const outbound = database.getCollection('outboundinterfaces')
  const webhooks = database.getCollection('webhookverification')
  const webhookReceipts = database.getCollection('webhookreceipts')
  const projects = database.getCollection('projects')
  const securityState = database.getCollection('securityState')
  const serviceConfigurations = database.getCollection(
    'meteor_accounts_loginServiceConfiguration',
  )

  const webhookRuntime = inspectSecureWebhookRuntime(webhooks, users, now)
  const secureWebhookCount = webhookRuntime.validWebhookCount
  const exactAdminExpression = strictAdminExpression()
  const activeAdmins = collectionCount(users, {
    $expr: { $and: [exactAdminExpression, activeUserExpression()] },
  })
  const lockedAdmins = collectionCount(users, lockedVerificationSelector(now, {
    $expr: exactAdminExpression,
  }))
  if (lockedAdmins > activeAdmins) throw new TypeError('Invalid administrator counts')

  const counts = {
    ...emptyCounts(),
    dashboard_all_history: collectionCount(dashboards, { timePeriod: 'all' }),
    dashboard_invalid_period: collectionCount(
      dashboards, dashboardInvalidPeriodSelector(),
    ),
    dashboard_all_projects_untrusted: collectionCount(dashboards, {
      projectId: 'all', allProjectsAuthorized: { $ne: true },
    }),
    dashboard_invalid_custom_range: oneRowCount(
      dashboards, dashboardCustomRangePipeline(now),
    ),
    dashboard_invalid_project: collectionCount(
      dashboards, dashboardInvalidProjectSelector(),
    ),
    project_legacy_markup_descriptions: oneRowCount(
      projects, projectDescriptionReviewPipeline(),
    ),
    ...inspectIndexState(database),
    verification_overdue_active: collectionCount(users, overdueVerificationSelector(now)),
    verification_malformed_pending: collectionCount(
      users, malformedPendingVerificationSelector(),
    ),
    verification_malformed_flags: oneRowCount(
      users, verificationMalformedFlagsPipeline(),
    ),
    verification_unrecoverable_locked: webhookRuntime.verification_unrecoverable_locked,
    verification_unrecoverable_pending: webhookRuntime.verification_unrecoverable_pending,
    verification_locked_admins: lockedAdmins,
    verification_active_admins: activeAdmins,
    verification_usable_admins: activeAdmins - lockedAdmins,
    verification_enabled_without_secure_default:
      settingTruthy(globalsettings, 'enableUserActionVerification') && secureWebhookCount === 0
        ? 1 : 0,
    security_toggle_malformed: collectionCount(globalsettings, {
      name: { $in: [...SECURITY_BOOLEAN_SETTINGS] },
      $expr: { $ne: [{ $type: '$value' }, 'bool'] },
    }),
    security_toggle_duplicate_groups: duplicateGroupCount(globalsettings, {
      name: { $in: [...SECURITY_BOOLEAN_SETTINGS] },
    }, '$name'),
    admin_inactive_flags_malformed: collectionCount(users, {
      $expr: {
        $and: [
          exactAdminExpression,
          { $ne: [{ $type: '$inactive' }, 'missing'] },
          { $ne: [{ $type: '$inactive' }, 'bool'] },
        ],
      },
    }),
    nonboolean_active_admin_flags: collectionCount(users, {
      $expr: {
        $and: [
          activeUserExpression(),
          { $ne: [{ $type: '$isAdmin' }, 'missing'] },
          { $ne: [{ $type: '$isAdmin' }, 'bool'] },
        ],
      },
    }),
    ...inspectAdminMutationLock(securityState, now),
    legacy_inbound_active: collectionCount(inbound, { active: true }),
    legacy_outbound_active: collectionCount(outbound, { active: true }),
    legacy_webhook_active: collectionCount(webhooks, {
      active: true,
      $nor: [secureWebhookSelector()],
    }),
    secure_webhook_duplicate_groups: duplicateGroupCount(webhooks, {
      $expr: {
        $and: [
          { $eq: ['$securityVersion', 2] },
          { $eq: ['$mappingVersion', 1] },
          exactStringExpression('endpointId'),
        ],
      },
    }, '$endpointId'),
    secure_webhook_key_shape_malformed: uniqueIndexKeyShapeCount(
      webhooks,
      WEBHOOK_INDEX.partialFilterExpression,
      {
        $and: [
          { $eq: ['$securityVersion', 2] },
          { $eq: ['$mappingVersion', 1] },
          exactStringExpression('endpointId'),
        ],
      },
    ),
    secure_webhook_index_conflicts: indexConflictCount(
      collectionIndexes(database, 'webhookverification'), WEBHOOK_INDEX,
    ),
    secure_webhook_invalid_configurations:
      webhookRuntime.secure_webhook_invalid_configurations,
    secure_webhook_missing_secrets: webhookRuntime.secure_webhook_missing_secrets,
    secure_webhook_candidate_over_limit: webhookRuntime.secure_webhook_candidate_over_limit,
    webhook_receipt_duplicate_groups: duplicateGroupCount(
      webhookReceipts, {
        $expr: {
          $and: [exactStringExpression('interfaceId'), exactStringExpression('eventId')],
        },
      }, { interfaceId: '$interfaceId', eventId: '$eventId' },
    ),
    webhook_receipt_key_shape_malformed: uniqueIndexKeyShapeCount(
      webhookReceipts, {}, {
        $and: [exactStringExpression('interfaceId'), exactStringExpression('eventId')],
      },
    ),
    webhook_receipt_index_conflicts: indexConflictCount(
      collectionIndexes(database, 'webhookreceipts'), WEBHOOK_RECEIPT_INDEX,
    ),
    stranded_project_fences: collectionCount(projects, {
      $or: [
        { lifecycleLock: { $exists: true } },
        { taskGraphLock: { $exists: true } },
        { lifecycleWriters: { $exists: true, $ne: [] } },
        { lifecycleWriterMetadata: { $exists: true, $ne: [] } },
      ],
    }),
    project_membership_malformed: oneRowCount(projects, projectMembershipPipeline()),
    resource_revisions_malformed: inspectResourceRevisions(database),
    timer_history_malformed: oneRowCount(users, timerHistoryMalformedPipeline()),
    timer_history_overflow: collectionCount(users, {
      'profile.timerStartHistory': { $type: 'array' },
      'profile.timerStartHistory.4096': { $exists: true },
    }),
    active_timer_identity_malformed: collectionCount(users, {
      'profile.timer': { $type: 'date' },
      'profile.timerId': { $exists: true, $ne: null },
      $expr: {
        $not: [{
          $regexMatch: {
            input: {
              $cond: [
                { $eq: [{ $type: '$profile.timerId' }, 'string'] },
                '$profile.timerId',
                '',
              ],
            },
            regex: /^[A-Za-z0-9._:-]{8,128}$/,
          },
        }],
      },
    }),
    ...inspectMigrationState(database),
    ...inspectTimeRule(globalsettings),
    ...inspectCredentials(database),
    ...inspectApiTokens(users, collectionIndexes(database, 'users')),
    ...inspectOidc(globalsettings, serviceConfigurations),
    ...inspectIntegrations(users, projects),
  }
  return validateCounts(counts)
}

function runMongosh(database, printLine, quitProcess) {
  let status = 'ERROR'
  let counts = emptyCounts(1)
  let exitStatus = 43
  try {
    counts = inspectDatabase(database)
    status = summaryStatus(counts)
    exitStatus = status === 'BLOCK' ? 42 : 0
  } catch {
    // Never reflect Mongo diagnostics or persisted values into console or
    // shareable deployment output.  The fixed error marker is sufficient.
  }
  printLine(marker(status, counts))
  quitProcess(exitStatus)
}

if (typeof module === 'object' && module?.exports
  && globalThis.TITRA_V7_PREFLIGHT_MODULE_ONLY === true) {
  module.exports = {
    inspectDatabase,
  }
} else if (typeof db !== 'undefined' && typeof print === 'function' && typeof quit === 'function') {
  runMongosh(db, print, quit)
} else if (typeof module === 'object' && module?.exports) {
  module.exports = {
    API_TOKEN_INDEX,
    ADMIN_MUTATION_LEASE_GRACE_MS,
    BLOCK_FIELDS,
    BOUNDED_DASHBOARD_PERIODS,
    COUNT_FIELDS,
    CREDENTIAL_STORES,
    DASHBOARD_SLUG_INDEX,
    GOOGLE_OAUTH_INDEX,
    MARKER,
    MAX_CREDENTIAL_CANDIDATE_DOCUMENTS,
    MAX_DEFAULT_PLAINTEXT_CREDENTIAL_BYTES,
    MAX_INTEGRATION_CANDIDATE_DOCUMENTS,
    MAX_OIDC_CONFIGURATION_DOCUMENTS,
    MAX_OAUTH_TOKEN_PLAINTEXT_BYTES,
    MAX_PLAINTEXT_CREDENTIAL_FIELDS,
    MAX_PUBLIC_DASHBOARD_SPAN_MS,
    MAX_TIME_RULE_DOCUMENTS,
    MAX_TIMER_START_HISTORY,
    MAX_WEBHOOK_CONFIGURATION_DOCUMENTS,
    MIGRATION_BACKUP_INDEX,
    OTHER_STARTUP_INDEXES,
    PERSONAL_TASK_INDEX,
    QUERY_TIMEOUT_MS,
    SECURITY_BOOLEAN_SETTINGS,
    USER_CREDENTIAL_PATHS,
    WARN_FIELDS,
    WEBHOOK_INDEX,
    WEBHOOK_RECEIPT_INDEX,
    collectionIndexes,
    configuredValueExpression,
    credentialPlaintextLimit,
    dashboardCustomRangePipeline,
    dashboardInvalidPeriodSelector,
    dashboardInvalidProjectSelector,
    duplicateGroupCount,
    emptyCounts,
    exactNonemptyString,
    exactType,
    indexConflictCount,
    inspectApiTokens,
    inspectCredentials,
    inspectDatabase,
    inspectIndexState,
    inspectIntegrations,
    inspectMigrationState,
    inspectOidc,
    inspectResourceRevisions,
    inspectSecureWebhookRuntime,
    inspectTimeRule,
    lockedVerificationSelector,
    malformedConfiguredValue,
    marker,
    mergeSelector,
    malformedPendingVerificationSelector,
    oneRowCount,
    oversizedPlaintextCredential,
    malformedRevisionPipeline,
    migrationLockActivePipeline,
    migrationLockMalformedPipeline,
    overdueVerificationSelector,
    parsedHttpsUrl,
    projectDescriptionReviewPipeline,
    projectMembershipPipeline,
    runMongosh,
    sameDocument,
    sameIndexKey,
    secureWebhookSelector,
    strictAdminExpression,
    summaryStatus,
    timeRuleKind,
    timerHistoryMalformedPipeline,
    unrecoverableLockedPipeline,
    uniqueIndexKeyShapeCount,
    validateCounts,
    validGitlabQuery,
    validIntegrationBaseUrl,
    validOidcClaims,
    validOidcEndpoint,
    validOidcScopes,
    validRuntimeWebhookConfiguration,
    validStoredOidcConfiguration,
    validWebhookMappingRules,
    verificationMalformedFlagsPipeline,
    validWebhookPointer,
    validWekanSelectors,
    validWekanUrl,
    wellFormedString,
  }
}
