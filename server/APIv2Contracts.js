import { randomUUID } from 'node:crypto'

const API_V2_PROBLEMS = Object.freeze({
  BAD_REQUEST: [400, 'validation', 'The request is invalid.', 'rejected'],
  UNAUTHENTICATED: [401, 'authentication', 'Authentication is required.', 'rejected'],
  ACTION_VERIFICATION_REQUIRED: [
    403,
    'authorization',
    'Required account verification is overdue.',
    'rejected',
  ],
  FORBIDDEN: [403, 'authorization', 'Access is denied.', 'rejected'],
  NOT_FOUND: [404, 'not_found', 'The resource was not found.', 'rejected'],
  METHOD_NOT_ALLOWED: [405, 'method', 'The HTTP method is not allowed.', 'rejected'],
  CONFLICT: [409, 'conflict', 'The requested state conflicts with current state.', 'rejected'],
  PRECONDITION_FAILED: [412, 'precondition', 'A write precondition failed.', 'rejected'],
  PAYLOAD_TOO_LARGE: [413, 'validation', 'The request payload is too large.', 'rejected'],
  UNSUPPORTED_MEDIA_TYPE: [415, 'validation', 'The media type is not supported.', 'rejected'],
  RULE_REJECTED: [422, 'rule', 'A configured rule rejected the request.', 'rejected'],
  PRECONDITION_REQUIRED: [428, 'precondition', 'A required write precondition is missing.', 'rejected'],
  RATE_LIMITED: [429, 'rate_limit', 'Too many requests were received.', 'rejected'],
  MIGRATION_LOCKED: [503, 'availability', 'Writes are temporarily locked.', 'rejected'],
  WEBHOOK_AUTHENTICATION_FAILED: [401, 'authentication', 'Webhook authentication failed.', 'rejected'],
  WEBHOOK_REPLAY_CONFLICT: [409, 'conflict', 'The webhook event conflicts with an earlier event.', 'rejected'],
  WEBHOOK_PROCESSING: [
    503,
    'processing',
    'Webhook processing is already in progress; retry after the indicated delay.',
    'unknown',
  ],
  WRITE_OUTCOME_UNKNOWN: [500, 'internal', 'The write outcome could not be confirmed.', 'unknown'],
  INTERNAL_ERROR: [500, 'internal', 'The request could not be completed.', 'unknown'],
})

function requestId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{16,80}$/.test(value)
    ? value : randomUUID()
}

function apiV2Problem(code, { id, retryAfterSeconds } = {}) {
  const resolvedCode = Object.hasOwn(API_V2_PROBLEMS, code) ? code : 'INTERNAL_ERROR'
  const [status, category, message, outcome] = API_V2_PROBLEMS[resolvedCode]
  const normalizedRetry = Number.isSafeInteger(retryAfterSeconds) && retryAfterSeconds > 0
    ? retryAfterSeconds : undefined
  return {
    status,
    body: {
      error: {
        version: 1,
        code: resolvedCode,
        category,
        message,
        requestId: requestId(id),
        outcome,
        retry: {
          allowed: normalizedRetry != null,
          ...(normalizedRetry == null ? {} : { afterSeconds: normalizedRetry }),
        },
      },
    },
  }
}

function apiV2Capabilities({
  projectFenceRecoveryEnabled = false,
  webhookActionVerificationEnabled = false,
} = {}) {
  return {
    apiVersion: 2,
    capabilitiesVersion: 2,
    features: {
      identity: { read: 1 },
      projects: {
        list: 1,
        create: 1,
        read: 1,
        detailsEdit: 1,
        archive: 1,
        emptyDelete: 1,
        fenceRecovery: 1,
        timeEntries: 1,
        users: 2,
        tasks: 2,
        taskStats: 1,
      },
      timeEntries: {
        create: 1,
        get: 1,
        delete: 1,
        listByDay: 1,
        listByRange: 1,
        taskEdit: 1,
        detailsEdit: 1,
      },
      taskSuggestions: { list: 1, read: 1, delete: 1 },
      timers: { start: 1, get: 1, stop: 1, atomicTransitions: 2 },
      webhooks: { actionVerificationReceiver: 3 },
      pagination: { stableCursor: 1 },
      idempotency: { create: 1 },
    },
    contracts: {
      errors: {
        version: 1,
        mediaType: 'application/problem+json',
        routes: [
          { path: '/capabilities/v2', methods: ['GET'] },
          { path: '/user/action-verification/webhook/:endpointId', methods: ['POST'] },
        ],
        otherAdvertisedRoutes: 'legacy-v1-envelope',
      },
      dateOnly: 1,
      timecardRevisionETag: 1,
      resourceRevisionETag: 1,
      projectUserPrivacy: 1,
      projectFenceRecovery: 1,
      webhookHmacSha256: 1,
      webhookRetry: {
        version: 1,
        authenticationTimestamp: 'fresh',
        actionTimestamp: 'original',
        configurationBinding: 'revision',
        retentionSeconds: 7 * 24 * 60 * 60,
        clientSafetyMarginSeconds: 10 * 60,
      },
      timerStartReplay: {
        version: 1,
        scope: 'user',
        activeReplay: 'returnExisting',
        consumedReplay: 'conflict',
        consumedErrorCode: 'timer-operation-consumed',
        retentionSeconds: 7 * 24 * 60 * 60,
        clientSafetyMarginSeconds: 10 * 60,
      },
      expectedUserId: {
        version: 1,
        header: 'X-Titra-Expected-User-Id',
        appliesTo: 'authenticatedRequests',
        required: false,
        mismatchStatus: 412,
      },
    },
    mutationPreconditions: {
      version: 2,
      operations: [
        {
          id: 'timeEntry.create', method: 'POST', path: '/timeentry/create',
          headers: ['Content-Type: application/json'], optionalHeaders: ['Idempotency-Key'],
          guards: ['projectAccess', 'timeEntryRule', 'migrationLease'],
        },
        {
          id: 'timeEntry.delete', method: 'DELETE', path: '/timeentry/delete/:timecardId',
          headers: ['If-Match'],
          guards: ['owner', 'dateRevision', 'timeEntryRule', 'migrationLease'],
        },
        {
          id: 'timeEntry.taskEdit', method: 'PATCH', path: '/timeentry/task/:timecardId',
          headers: ['Content-Type: application/json', 'If-Match'],
          bodyPreconditions: ['expectedTask'],
          guards: ['owner', 'projectAccess', 'timeEntryRule', 'migrationLease'],
        },
        {
          id: 'timeEntry.detailsEdit', method: 'PATCH', path: '/timeentry/details/:timecardId',
          headers: ['Content-Type: application/json', 'If-Match'],
          bodyPreconditions: ['expected mirrors changes', 'acceptLegacyConversion when required'],
          guards: ['owner', 'projectAccess', 'timeEntryRule', 'migrationLease'],
        },
        {
          id: 'project.create', method: 'POST', path: '/project/create',
          headers: ['Content-Type: application/json'], optionalHeaders: ['Idempotency-Key'],
          guards: ['authenticatedUser'],
        },
        {
          id: 'project.detailsEdit', method: 'PATCH', path: '/project/details/:projectId',
          headers: ['Content-Type: application/json', 'If-Match'],
          bodyPreconditions: ['expected mirrors changes'], guards: ['projectAdministrator'],
        },
        {
          id: 'project.archive', method: 'PATCH', path: '/project/archive/:projectId',
          headers: ['Content-Type: application/json', 'If-Match'],
          bodyPreconditions: ['expectedArchived'], guards: ['projectAdministrator'],
        },
        {
          id: 'project.emptyDelete', method: 'DELETE', path: '/project/delete/:projectId',
          headers: ['Content-Type: application/json', 'If-Match'],
          bodyPreconditions: ['expectedName'], guards: ['projectOwner', 'emptyProject'],
        },
        {
          id: 'project.fenceRecovery', method: 'POST', path: '/project/recovery/:projectId',
          headers: ['Content-Type: application/json', 'If-Match'],
          bodyPreconditions: ['type', 'recoveryId', 'acknowledgeStaleFence=true'],
          guards: [
            'projectAdministrator', 'oldProcessBoot', 'minimumFenceAge',
            'trackedFence', 'verifiedResourceOutcome', 'exactCompareAndSwap',
          ],
        },
        {
          id: 'projectTask.create', method: 'POST', path: '/project/task/create',
          headers: ['Content-Type: application/json'], optionalHeaders: ['Idempotency-Key'],
          bodyPreconditions: ['start/end canonical UTC RFC3339 milliseconds'],
          guards: ['projectAdministrator', 'sameProjectDependencies'],
        },
        {
          id: 'projectTask.detailsEdit', method: 'PATCH', path: '/project/task/details/:taskId',
          headers: ['Content-Type: application/json', 'If-Match'],
          bodyPreconditions: ['expected mirrors changes'],
          guards: ['projectAdministrator', 'sameProjectDependencies', 'notDefaultWhenRenaming'],
        },
        {
          id: 'projectTask.delete', method: 'DELETE', path: '/project/task/delete/:taskId',
          headers: ['Content-Type: application/json', 'If-Match'],
          bodyPreconditions: ['expectedName', 'acknowledgeRecordedEntries when required'],
          guards: ['projectAdministrator', 'notDefault', 'noDependants'],
        },
        {
          id: 'taskSuggestion.delete', method: 'DELETE',
          path: '/task-suggestions/delete/:suggestionId',
          headers: ['Content-Type: application/json', 'If-Match'],
          bodyPreconditions: ['expectedName', 'acknowledgeReferencedRecords when required'],
          guards: ['owner'],
        },
        {
          id: 'timer.start', method: 'POST', path: '/timer/start',
          headers: ['Content-Type: application/json for a nonempty body'],
          bodyPreconditions: ['operationId for client-attributed replay'],
          guards: ['noDifferentActiveTimer', 'unconsumedOperationId'],
        },
        {
          id: 'timer.stop', method: 'POST', path: '/timer/stop',
          headers: ['Content-Type: application/json', 'If-Match'],
          bodyPreconditions: ['timerId'], guards: ['exactActiveTimer'],
        },
        {
          id: 'webhook.actionVerification', method: 'POST',
          path: '/user/action-verification/webhook/:endpointId',
          headers: [
            'Content-Type: application/json', 'X-Titra-Webhook-Timestamp',
            'X-Titra-Webhook-Event-Id', 'X-Titra-Webhook-Signature',
          ],
          guards: ['enabledSecureInterface', 'hmacSha256', 'replayReceipt', 'eventOrdering'],
        },
      ],
    },
    idempotency: {
      version: 1,
      header: 'Idempotency-Key',
      minKeyLength: 16,
      maxKeyLength: 128,
      retentionSeconds: 7 * 24 * 60 * 60,
      operations: ['timeentry.create', 'project.create', 'project-task.create'],
    },
    timeEntryPagination: {
      version: 1,
      defaultLimit: 200,
      maxLimit: 500,
      consistency: 'live-keyset',
      ownerPath: 'timeentry/daterange-page',
      projectPath: 'project/timeentriesfordaterange-page',
    },
    deployment: {
      projectFenceRecoveryEnabled: projectFenceRecoveryEnabled === true,
      webhookActionVerificationEnabled: webhookActionVerificationEnabled === true,
    },
    limits: {
      taskCodePoints: 1000,
      taskEditBodyBytes: 64 * 1024,
      webhookBodyBytes: 64 * 1024,
      webhookTimestampSkewSeconds: 5 * 60,
      webhookProcessingLeaseSeconds: 60,
      webhookReplayRetentionSeconds: 7 * 24 * 60 * 60,
      timerStartRetainedOperations: 4096,
      projectFenceRecoveryMinimumAgeSeconds: 15 * 60,
    },
  }
}

function responseHeaders(contentType, requestIdentifier) {
  return {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
    Pragma: 'no-cache',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': [
      'Content-Type', 'Authorization', 'If-Match', 'X-Requested-With',
      'X-Titra-Webhook-Timestamp', 'X-Titra-Webhook-Event-Id',
      'X-Titra-Webhook-Signature', 'X-Request-ID', 'Idempotency-Key',
      'X-Titra-Expected-User-Id',
    ].join(', '),
    'Access-Control-Expose-Headers': [
      'ETag', 'X-Request-ID', 'Retry-After', 'Idempotency-Replayed',
      'Idempotency-Expires-At',
    ].join(', '),
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), geolocation=(), microphone=(), payment=(), usb=()',
    'X-Request-ID': requestIdentifier,
  }
}

function sendAPIv2(res, status, payload, { id } = {}) {
  const identifier = requestId(id)
  res.writeHead(status, responseHeaders('application/vnd.titra.v2+json', identifier))
  res.end(status === 204 ? undefined : JSON.stringify({ apiVersion: 2, payload }))
  return identifier
}

function sendAPIv2Problem(res, code, options = {}) {
  const problem = apiV2Problem(code, options)
  const identifier = problem.body.error.requestId
  const headers = responseHeaders('application/problem+json', identifier)
  if (problem.body.error.retry.afterSeconds != null) {
    headers['Retry-After'] = String(problem.body.error.retry.afterSeconds)
  }
  res.writeHead(problem.status, headers)
  res.end(JSON.stringify(problem.body))
  return identifier
}

export {
  API_V2_PROBLEMS,
  apiV2Capabilities,
  apiV2Problem,
  sendAPIv2,
  sendAPIv2Problem,
}
