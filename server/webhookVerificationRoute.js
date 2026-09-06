import { createHash } from 'node:crypto'
import { TextDecoder } from 'node:util'
import { Meteor } from 'meteor/meteor'
import { getBuffer } from './bodyparser.js'
import WebhookVerification from '../imports/api/webhookverification/webhookverification.js'
import { mapWebhookPayload } from '../imports/api/webhookverification/webhookMapping.js'
import {
  ENDPOINT_ID_PATTERN,
  EVENT_ID_PATTERN,
  MAX_WEBHOOK_BODY_BYTES,
  resolveWebhookSecret,
  verifyWebhookAuthentication,
} from '../imports/api/webhookverification/webhookSecurity.js'
import { createWebhookReceiptStore } from '../imports/api/webhookreceipts/server/store.js'
import { getGlobalSettingAsync } from '../imports/utils/server_method_helpers.js'
import { sendAPIv2, sendAPIv2Problem } from './APIv2Contracts.js'
import {
  TokenBucketLimiter,
  boundedRate,
  requestPeerAddress,
} from './apiRateLimit.js'

const WEBHOOK_PATH = '/user/action-verification/webhook'
const DEFAULT_WEBHOOK_REQUESTS_PER_MINUTE = 120
const WEBHOOK_EVENT_INTERFACE_FIELD = 'actionVerification.webhookEventInterfaceId'
const WEBHOOK_EVENT_TIMESTAMP_FIELD = 'actionVerification.webhookEventTimestamp'
const WEBHOOK_EVENT_ID_FIELD = 'actionVerification.webhookEventId'

function endpointFromPath(pathname) {
  const match = String(pathname || '').match(
    /^\/user\/action-verification\/webhook\/([0-9a-f]{32})\/?$/,
  )
  return match?.[1]
}

function parseJSONBody(rawBody) {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(rawBody)
  const payload = JSON.parse(text)
  if (!payload || Object.getPrototypeOf(payload) !== Object.prototype) {
    throw new TypeError('Expected a JSON object')
  }
  return payload
}

function secureInterfaceSelector(endpointId) {
  return {
    endpointId,
    securityVersion: 2,
    mappingVersion: 1,
    active: true,
    removedAt: { $exists: false },
  }
}

function webhookConfigurationRevision(webhookInterface) {
  if (!Object.hasOwn(webhookInterface || {}, 'configurationRevision')) return 0
  const value = webhookInterface.configurationRevision
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError('Invalid webhook interface configuration revision')
  }
  return value
}

function webhookEventOrderSelector(interfaceId, eventTimestamp, eventId) {
  if (typeof interfaceId !== 'string' || !interfaceId
    || !(eventTimestamp instanceof Date) || Number.isNaN(eventTimestamp.getTime())
    || !EVENT_ID_PATTERN.test(eventId || '')) {
    throw new TypeError('Invalid authenticated webhook event ordering data')
  }
  return {
    $or: [
      { [WEBHOOK_EVENT_INTERFACE_FIELD]: { $exists: false } },
      { [WEBHOOK_EVENT_INTERFACE_FIELD]: { $ne: interfaceId } },
      { [WEBHOOK_EVENT_TIMESTAMP_FIELD]: { $exists: false } },
      { [WEBHOOK_EVENT_TIMESTAMP_FIELD]: { $lt: eventTimestamp } },
      {
        $and: [
          { [WEBHOOK_EVENT_TIMESTAMP_FIELD]: eventTimestamp },
          {
            $or: [
              { [WEBHOOK_EVENT_ID_FIELD]: { $exists: false } },
              // Equality makes recovery of the same leased event an
              // idempotent matched write; lower IDs still cannot overwrite a
              // deterministic same-second winner.
              { [WEBHOOK_EVENT_ID_FIELD]: { $lte: eventId } },
            ],
          },
        ],
      },
    ],
  }
}

function webhookEventMetadata(interfaceId, eventTimestamp, eventId) {
  return {
    [WEBHOOK_EVENT_INTERFACE_FIELD]: interfaceId,
    [WEBHOOK_EVENT_TIMESTAMP_FIELD]: eventTimestamp,
    [WEBHOOK_EVENT_ID_FIELD]: eventId,
  }
}

function createWebhookPeerLimiter(environment = globalThis.process?.env, now) {
  const limiter = new TokenBucketLimiter({
    ratePerMinute: boundedRate(
      environment?.TITRA_WEBHOOK_RATE_PER_MINUTE,
      DEFAULT_WEBHOOK_REQUESTS_PER_MINUTE,
    ),
    now,
  })
  return (req) => limiter.consume(requestPeerAddress(req))
}

const consumeDefaultWebhookPeer = createWebhookPeerLimiter()

function createDefaultWebhookDependencies() {
  const receipts = createWebhookReceiptStore()
  return {
    readRawBody: (req, options) => getBuffer(req, { ...options, encoding: null }),
    consumePeer: consumeDefaultWebhookPeer,
    featureEnabled: () => getGlobalSettingAsync('enableUserActionVerification'),
    findInterface: (endpointId) => WebhookVerification.findOneAsync(
      secureInterfaceSelector(endpointId),
    ),
    resolveSecret: (endpointId) => resolveWebhookSecret(endpointId),
    claimReceipt: (args) => receipts.claim(args),
    completeReceipt: (args) => receipts.complete(args),
    failReceipt: (args) => receipts.fail(args),
    applyResult: async (webhookInterface, result, eventTimestamp, eventId) => {
      const selector = {
        _id: result.userId,
        'actionVerification.required': true,
        'actionVerification.webhookInterfaceId': webhookInterface._id,
        ...webhookEventOrderSelector(webhookInterface._id, eventTimestamp, eventId),
      }
      const eventMetadata = webhookEventMetadata(
        webhookInterface._id, eventTimestamp, eventId,
      )
      if (result.action === 'complete') {
        return Meteor.users.updateAsync(selector, {
          $set: {
            'actionVerification.completed': true,
            'actionVerification.completedAt': eventTimestamp,
            ...eventMetadata,
          },
        })
      }
      const deadline = new Date(
        eventTimestamp.getTime() + webhookInterface.verificationPeriod * 24 * 60 * 60 * 1000,
      )
      return Meteor.users.updateAsync(selector, {
        $set: {
          'actionVerification.completed': false,
          'actionVerification.deadline': deadline,
          ...eventMetadata,
        },
        $unset: { 'actionVerification.completedAt': '' },
      })
    },
  }
}

function updateAffected(result) {
  if (typeof result === 'number') return result === 1
  return result?.matchedCount === 1 || result?.modifiedCount === 1
}

function createWebhookVerificationHandler(dependencies) {
  const {
    readRawBody, consumePeer, featureEnabled, findInterface, resolveSecret,
    claimReceipt, completeReceipt, failReceipt, applyResult,
    now = () => new Date(),
  } = dependencies
  if (typeof consumePeer !== 'function') throw new TypeError('A webhook peer limiter is required.')
  return async (req, res) => {
    const suppliedRequestId = req.headers?.['x-request-id']
    const endpointId = endpointFromPath(req._parsedUrl?.pathname)
    if (!endpointId || !ENDPOINT_ID_PATTERN.test(endpointId)) {
      sendAPIv2Problem(res, 'NOT_FOUND', { id: suppliedRequestId })
      return
    }
    if (req.method === 'OPTIONS') {
      res.setHeader('Allow', 'POST, OPTIONS')
      sendAPIv2(res, 204, undefined, { id: suppliedRequestId })
      return
    }
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST, OPTIONS')
      sendAPIv2Problem(res, 'METHOD_NOT_ALLOWED', { id: suppliedRequestId })
      return
    }
    const peerLimit = consumePeer(req)
    if (!peerLimit?.allowed) {
      sendAPIv2Problem(res, 'RATE_LIMITED', {
        id: suppliedRequestId,
        retryAfterSeconds: peerLimit?.retryAfterSeconds,
      })
      return
    }
    if (!/^application\/json(?:\s*;\s*charset=utf-8)?\s*$/i.test(
      req.headers?.['content-type'] || '',
    )) {
      sendAPIv2Problem(res, 'UNSUPPORTED_MEDIA_TYPE', { id: suppliedRequestId })
      return
    }
    const contentLength = Number(req.headers?.['content-length'])
    if (Number.isFinite(contentLength) && contentLength > MAX_WEBHOOK_BODY_BYTES) {
      sendAPIv2Problem(res, 'PAYLOAD_TOO_LARGE', { id: suppliedRequestId })
      return
    }
    let rawBody
    try {
      rawBody = await readRawBody(req, { limit: `${MAX_WEBHOOK_BODY_BYTES}b` })
    } catch (error) {
      const code = error?.type === 'entity.too.large'
        || /too large|limit/i.test(error?.message || '')
        ? 'PAYLOAD_TOO_LARGE' : 'BAD_REQUEST'
      sendAPIv2Problem(res, code, { id: suppliedRequestId })
      return
    }
    if (!Buffer.isBuffer(rawBody) || rawBody.length > MAX_WEBHOOK_BODY_BYTES) {
      sendAPIv2Problem(res, 'PAYLOAD_TOO_LARGE', { id: suppliedRequestId })
      return
    }
    let webhookInterface
    let authentication
    try {
      if (!await featureEnabled()) throw new Error('disabled')
      webhookInterface = await findInterface(endpointId)
      const secret = webhookInterface ? await resolveSecret(endpointId) : undefined
      authentication = webhookInterface && verifyWebhookAuthentication({
        headers: req.headers, rawBody, secret, now: now(),
      })
    } catch (error) {
      authentication = undefined
    }
    if (!authentication) {
      sendAPIv2Problem(res, 'WEBHOOK_AUTHENTICATION_FAILED', { id: suppliedRequestId })
      return
    }
    let payload
    try {
      payload = parseJSONBody(rawBody)
    } catch (error) {
      sendAPIv2Problem(res, 'BAD_REQUEST', { id: suppliedRequestId })
      return
    }
    const payloadDigest = createHash('sha256').update(rawBody).digest('hex')
    let claim
    try {
      claim = await claimReceipt({
        interfaceId: webhookInterface._id,
        eventId: authentication.eventId,
        eventTimestamp: authentication.eventTimestamp,
        payloadDigest,
        configurationRevision: webhookConfigurationRevision(webhookInterface),
      })
    } catch (error) {
      sendAPIv2Problem(res, 'INTERNAL_ERROR', { id: suppliedRequestId })
      return
    }
    if (claim.status === 'processed') {
      sendAPIv2(res, 202, { accepted: true }, { id: suppliedRequestId })
      return
    }
    if (claim.status === 'event_conflict') {
      sendAPIv2Problem(res, 'WEBHOOK_REPLAY_CONFLICT', { id: suppliedRequestId })
      return
    }
    if (claim.status !== 'claimed') {
      sendAPIv2Problem(res, 'WEBHOOK_PROCESSING', {
        id: suppliedRequestId, retryAfterSeconds: 5,
      })
      return
    }
    if (!(claim.eventTimestamp instanceof Date)
      || Number.isNaN(claim.eventTimestamp.getTime())) {
      sendAPIv2Problem(res, 'INTERNAL_ERROR', { id: suppliedRequestId })
      return
    }
    const receipt = {
      interfaceId: webhookInterface._id,
      eventId: authentication.eventId,
      leaseToken: claim.leaseToken,
    }
    try {
      const mapped = mapWebhookPayload(payload, webhookInterface.mappingRules)
      const applied = mapped
        ? updateAffected(await applyResult(
          webhookInterface, mapped, claim.eventTimestamp, authentication.eventId,
        )) : false
      await completeReceipt({ ...receipt, outcome: applied ? 'applied' : 'ignored' })
    } catch (error) {
      try { await failReceipt({ ...receipt, errorCode: 'WEBHOOK_PROCESSING_FAILED' }) } catch { /* best effort */ }
      sendAPIv2Problem(res, 'WRITE_OUTCOME_UNKNOWN', { id: suppliedRequestId })
      return
    }
    sendAPIv2(res, 202, { accepted: true }, { id: suppliedRequestId })
  }
}

const webhookVerificationHandler = createWebhookVerificationHandler(
  createDefaultWebhookDependencies(),
)

export {
  DEFAULT_WEBHOOK_REQUESTS_PER_MINUTE,
  WEBHOOK_PATH,
  createDefaultWebhookDependencies,
  createWebhookPeerLimiter,
  createWebhookVerificationHandler,
  endpointFromPath,
  parseJSONBody,
  secureInterfaceSelector,
  updateAffected,
  webhookConfigurationRevision,
  webhookEventMetadata,
  webhookEventOrderSelector,
  webhookVerificationHandler,
}
