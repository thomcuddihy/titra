import { createHmac, timingSafeEqual } from 'node:crypto'

const ENDPOINT_ID_PATTERN = /^[0-9a-f]{32}$/
const BASE64URL_SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/
const SIGNATURE_PATTERN = /^v1=([0-9a-fA-F]{64})$/
const EVENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/
const MAX_WEBHOOK_BODY_BYTES = 64 * 1024
const MAX_TIMESTAMP_SKEW_SECONDS = 5 * 60

function webhookSecretEnvironmentVariable(endpointId) {
  if (!ENDPOINT_ID_PATTERN.test(endpointId)) {
    throw new TypeError('Invalid webhook endpoint ID')
  }
  return `TITRA_WEBHOOK_SECRET_${endpointId.toUpperCase()}`
}

function decodeWebhookSecret(value) {
  if (typeof value !== 'string' || !BASE64URL_SECRET_PATTERN.test(value)) return undefined
  const decoded = Buffer.from(value, 'base64url')
  return decoded.length === 32 && decoded.toString('base64url') === value ? decoded : undefined
}

function resolveWebhookSecret(endpointId, environment = process.env) {
  return decodeWebhookSecret(environment[webhookSecretEnvironmentVariable(endpointId)])
}

function headerValue(headers, name) {
  const value = headers?.[name]
  return typeof value === 'string' ? value : undefined
}

function verifyWebhookAuthentication({ headers, rawBody, secret, now = new Date() }) {
  if (!Buffer.isBuffer(rawBody) || rawBody.length > MAX_WEBHOOK_BODY_BYTES
    || !Buffer.isBuffer(secret) || secret.length !== 32) return undefined
  const timestampText = headerValue(headers, 'x-titra-webhook-timestamp')
  const eventId = headerValue(headers, 'x-titra-webhook-event-id')
  const signatureText = headerValue(headers, 'x-titra-webhook-signature')
  if (!/^[1-9][0-9]{9,12}$/.test(timestampText || '')
    || !EVENT_ID_PATTERN.test(eventId || '')) return undefined
  const timestamp = Number(timestampText)
  const nowSeconds = Math.floor(now.getTime() / 1000)
  if (!Number.isSafeInteger(timestamp) || !Number.isSafeInteger(nowSeconds)
    || Math.abs(nowSeconds - timestamp) > MAX_TIMESTAMP_SKEW_SECONDS) return undefined
  const signatureMatch = signatureText?.match(SIGNATURE_PATTERN)
  if (!signatureMatch) return undefined
  const supplied = Buffer.from(signatureMatch[1], 'hex')
  const expected = createHmac('sha256', secret)
    .update(Buffer.from(`${timestampText}.`, 'utf8'))
    .update(rawBody)
    .digest()
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return undefined
  return {
    eventId,
    eventTimestamp: new Date(timestamp * 1000),
  }
}

export {
  ENDPOINT_ID_PATTERN,
  EVENT_ID_PATTERN,
  MAX_TIMESTAMP_SKEW_SECONDS,
  MAX_WEBHOOK_BODY_BYTES,
  decodeWebhookSecret,
  resolveWebhookSecret,
  verifyWebhookAuthentication,
  webhookSecretEnvironmentVariable,
}
