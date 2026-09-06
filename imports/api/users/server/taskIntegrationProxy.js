import dns from 'node:dns/promises'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'

const MAX_ENDPOINT_LENGTH = 2048
const MAX_CREDENTIAL_LENGTH = 4096
const MAX_GITLAB_QUERY_LENGTH = 1024
const MAX_RESPONSE_BYTES = 256 * 1024
const MAX_SIWAPP_REQUEST_BYTES = 1024 * 1024
const MAX_SIWAPP_RESPONSE_BYTES = 64 * 1024
const MAX_WEKAN_RESPONSE_BYTES = 128 * 1024
const MAX_WEKAN_SELECTORS = 10
const MAX_RESULTS = 100
const REQUEST_TIMEOUT_MS = 10 * 1000

class TaskIntegrationError extends Error {
  constructor(code) {
    super(code)
    this.name = 'TaskIntegrationError'
    this.code = code
  }
}

function exactOptIn(environment, name) {
  return environment?.[name] === 'true'
}

function unbracketHostname(hostname) {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname
}

function isLoopbackHostname(hostname) {
  const value = unbracketHostname(hostname).toLowerCase().replace(/\.$/, '')
  return value === 'localhost' || value.endsWith('.localhost')
    || value === '127.0.0.1' || value.startsWith('127.') || value === '::1'
}

function privateHostnameAllowed(hostname, environment) {
  const configured = environment?.TITRA_PRIVATE_INTEGRATION_HOSTS
  if (typeof configured !== 'string' || configured.length > 8192) return false
  const requested = unbracketHostname(hostname).toLowerCase().replace(/\.$/, '')
  return configured.split(',').some((entry) => {
    const candidate = unbracketHostname(entry.trim()).toLowerCase().replace(/\.$/, '')
    return candidate.length > 0 && candidate === requested
  })
}

function hasControlCharacters(value) {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0)
    return codePoint <= 31 || codePoint === 127
  })
}

function normalizeCredential(rawCredential) {
  if (typeof rawCredential !== 'string') {
    throw new TaskIntegrationError('integration-not-configured')
  }
  const credential = rawCredential.trim()
  if (!credential || credential.length > MAX_CREDENTIAL_LENGTH
    || hasControlCharacters(credential)) {
    throw new TaskIntegrationError('integration-not-configured')
  }
  return credential
}

function assertIntegrationTransport(url, environment) {
  if (url.protocol === 'http:') {
    if (environment.NODE_ENV !== 'development'
      || !exactOptIn(environment, 'TITRA_ALLOW_LOOPBACK_HTTP_INTEGRATIONS')
      || !isLoopbackHostname(url.hostname)) {
      throw new TaskIntegrationError('integration-endpoint-insecure')
    }
  } else if (url.protocol !== 'https:') {
    throw new TaskIntegrationError('integration-endpoint-insecure')
  }
}

function isNonPublicIpv4(address) {
  const octets = address.split('.').map(Number)
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part)
    || part < 0 || part > 255)) return true
  const [a, b, c] = octets
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2))
      || (b === 88 && c === 99)))
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113)
}

function mappedIpv4Address(address) {
  const normalized = address.toLowerCase().split('%')[0]
  const dotted = normalized.match(/(?:^|:)(\d{1,3}(?:\.\d{1,3}){3})$/)?.[1]
  if (dotted && (normalized.startsWith('::ffff:') || normalized.startsWith('::'))) {
    return dotted
  }
  const mapped = normalized.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/)
  if (!mapped) return null
  const high = Number.parseInt(mapped[1], 16)
  const low = Number.parseInt(mapped[2], 16)
  return `${Math.floor(high / 256)}.${high % 256}.${Math.floor(low / 256)}.${low % 256}`
}

function isNonPublicAddress(address) {
  const family = net.isIP(address)
  if (family === 4) return isNonPublicIpv4(address)
  if (family !== 6) return true
  const normalized = address.toLowerCase().split('%')[0]
  const mapped = mappedIpv4Address(normalized)
  if (mapped) return isNonPublicIpv4(mapped)
  const [firstText, secondText = '0'] = normalized.split(':')
  const first = Number.parseInt(firstText || '0', 16)
  const second = Number.parseInt(secondText || '0', 16)
  // Only native global-unicast space is eligible. Transition mechanisms can
  // encode otherwise blocked IPv4 destinations, so 6to4 is excluded too.
  return first < 0x2000 || first > 0x3fff || first === 0x2002
    || (first === 0x2001 && (second === 0 || second === 2 || second === 0xdb8
      || (second >= 0x10 && second <= 0x2f)))
}

function normalizeIntegrationBaseUrl(rawUrl, environment = process.env) {
  if (typeof rawUrl !== 'string' || rawUrl.length === 0
    || rawUrl.length > MAX_ENDPOINT_LENGTH || rawUrl !== rawUrl.trim()) {
    throw new TaskIntegrationError('integration-endpoint-invalid')
  }
  let url
  try {
    url = new URL(rawUrl)
  } catch {
    throw new TaskIntegrationError('integration-endpoint-invalid')
  }
  if (url.username || url.password || url.hash || url.search || !url.hostname) {
    throw new TaskIntegrationError('integration-endpoint-invalid')
  }
  assertIntegrationTransport(url, environment)
  if (!url.pathname.endsWith('/')) url.pathname += '/'
  return url
}

function parseWekanConfiguration(rawUrl, environment = process.env) {
  if (typeof rawUrl !== 'string' || rawUrl.length === 0
    || rawUrl.length > MAX_ENDPOINT_LENGTH || rawUrl !== rawUrl.trim()
    || hasControlCharacters(rawUrl)) {
    throw new TaskIntegrationError('integration-endpoint-invalid')
  }
  let url
  try {
    url = new URL(rawUrl)
  } catch {
    throw new TaskIntegrationError('integration-endpoint-invalid')
  }
  if (url.hash) throw new TaskIntegrationError('wekan-sandstorm-unsupported')
  if (url.username || url.password || !url.hostname) {
    throw new TaskIntegrationError('integration-endpoint-invalid')
  }
  assertIntegrationTransport(url, environment)
  const parameters = [...url.searchParams.keys()]
  const tokens = url.searchParams.getAll('authToken')
  if (parameters.length !== 1 || parameters[0] !== 'authToken' || tokens.length !== 1) {
    throw new TaskIntegrationError('integration-endpoint-invalid')
  }
  const credential = normalizeCredential(tokens[0])
  if (url.pathname.includes('%')) {
    throw new TaskIntegrationError('integration-endpoint-invalid')
  }
  const match = url.pathname.match(/^(.*\/api\/boards\/([A-Za-z0-9_-]{1,128})\/)export\/?$/u)
  if (!match || match[1].includes('//')) {
    throw new TaskIntegrationError('integration-endpoint-invalid')
  }
  const [, boardPath, boardId] = match
  const baseUrl = new URL(url.origin)
  baseUrl.pathname = boardPath
  const exportUrl = new URL('export', baseUrl)
  exportUrl.searchParams.set('authToken', credential)
  return {
    baseUrl,
    boardId,
    credential,
    storedUrl: exportUrl.href,
  }
}

function normalizeWekanStoredUrl(rawUrl, environment = process.env) {
  return parseWekanConfiguration(rawUrl, environment).storedUrl
}

function normalizeWekanSelectors(value) {
  const input = typeof value === 'string' ? [value] : value
  if (input === undefined || input === null) return []
  if (!Array.isArray(input) || input.length > MAX_WEKAN_SELECTORS) {
    throw new TaskIntegrationError('integration-query-invalid')
  }
  const selectors = [...new Set(input)]
  if (selectors.some((entry) => typeof entry !== 'string'
    || !/^[A-Za-z0-9_-]{1,128}$/u.test(entry))) {
    throw new TaskIntegrationError('integration-query-invalid')
  }
  return selectors
}

function normalizeGitlabQuery(rawQuery) {
  const query = rawQuery || 'issues'
  if (typeof query !== 'string' || query.length === 0
    || query.length > MAX_GITLAB_QUERY_LENGTH || query !== query.trim()
    || query.startsWith('/') || query.includes('\\') || query.includes('#')) {
    throw new TaskIntegrationError('integration-query-invalid')
  }
  let decoded
  try {
    decoded = decodeURIComponent(query)
  } catch {
    throw new TaskIntegrationError('integration-query-invalid')
  }
  if (decoded.split(/[/?]/).includes('..') || hasControlCharacters(decoded)) {
    throw new TaskIntegrationError('integration-query-invalid')
  }
  return query
}

function integrationRequest({ provider, profile, project }, environment = process.env) {
  if (!['zammad', 'gitlab'].includes(provider)) {
    throw new TaskIntegrationError('integration-provider-invalid')
  }
  const baseUrl = normalizeIntegrationBaseUrl(profile?.[`${provider}url`], environment)
  const credential = normalizeCredential(profile?.[`${provider}token`])
  if (provider === 'zammad') {
    return {
      url: new URL('api/v1/tickets', baseUrl),
      headers: { Authorization: `Token token=${credential}` },
    }
  }
  const query = normalizeGitlabQuery(project?.gitlabquery)
  return {
    url: new URL(`api/v4/${query}`, baseUrl),
    headers: { 'PRIVATE-TOKEN': credential },
  }
}

async function resolvePinnedTarget(url, {
  environment = process.env,
  lookup = (hostname) => dns.lookup(hostname, { all: true, verbatim: true }),
} = {}) {
  let addresses
  const hostname = unbracketHostname(url.hostname)
  const literalFamily = net.isIP(hostname)
  if (literalFamily) {
    addresses = [{ address: hostname, family: literalFamily }]
  } else {
    try {
      addresses = await lookup(hostname)
    } catch {
      throw new TaskIntegrationError('integration-unavailable')
    }
  }
  if (!Array.isArray(addresses) || addresses.length === 0
    || addresses.some(({ address }) => !net.isIP(address))) {
    throw new TaskIntegrationError('integration-unavailable')
  }
  addresses = addresses.map(({ address }) => ({ address, family: net.isIP(address) }))
  const containsNonPublicAddress = addresses.some(({ address }) => isNonPublicAddress(address))
  const developmentLoopback = url.protocol === 'http:' && environment.NODE_ENV === 'development'
    && exactOptIn(environment, 'TITRA_ALLOW_LOOPBACK_HTTP_INTEGRATIONS')
    && isLoopbackHostname(url.hostname)
  if (containsNonPublicAddress && !developmentLoopback
    && !privateHostnameAllowed(url.hostname, environment)) {
    throw new TaskIntegrationError('integration-endpoint-private')
  }
  return addresses[0]
}

function defaultPinnedRequest(url, {
  headers, target, maxBytes, timeoutMs,
}) {
  return new Promise((resolve, reject) => {
    const client = url.protocol === 'https:' ? https : http
    let timeout
    const resolveOnce = (value) => {
      clearTimeout(timeout)
      resolve(value)
    }
    const rejectOnce = (error) => {
      clearTimeout(timeout)
      reject(error)
    }
    const request = client.request(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'User-Agent': 'titra-integration-proxy/1',
        ...headers,
      },
      agent: false,
      lookup(hostname, options, callback) {
        if (options?.all) callback(null, [target])
        else callback(null, target.address, target.family)
      },
    }, (response) => {
      const status = response.statusCode || 0
      const contentType = String(response.headers['content-type'] || '')
      const declaredLength = Number.parseInt(response.headers['content-length'] || '0', 10)
      if (status < 200 || status >= 300 || !/^application\/(?:[\w.+-]+\+)?json(?:;|$)/i.test(contentType)
        || (Number.isFinite(declaredLength) && declaredLength > maxBytes)) {
        response.resume()
        rejectOnce(new TaskIntegrationError('integration-unavailable'))
        return
      }
      const chunks = []
      let bytes = 0
      response.on('data', (chunk) => {
        bytes += chunk.length
        if (bytes > maxBytes) {
          response.destroy(new TaskIntegrationError('integration-response-too-large'))
          return
        }
        chunks.push(chunk)
      })
      response.on('end', () => {
        try {
          resolveOnce(JSON.parse(Buffer.concat(chunks).toString('utf8')))
        } catch {
          rejectOnce(new TaskIntegrationError('integration-response-invalid'))
        }
      })
      response.on('aborted', () => rejectOnce(new TaskIntegrationError('integration-unavailable')))
      response.on('error', rejectOnce)
    })
    timeout = setTimeout(() => {
      request.destroy(new TaskIntegrationError('integration-timeout'))
    }, timeoutMs)
    request.on('error', rejectOnce)
    request.end()
  })
}

function defaultPinnedStatusRequest(url, {
  body, headers, target, maxResponseBytes, timeoutMs,
}) {
  return new Promise((resolve, reject) => {
    const client = url.protocol === 'https:' ? https : http
    let timeout
    const resolveOnce = (value) => {
      clearTimeout(timeout)
      resolve(value)
    }
    const rejectOnce = (error) => {
      clearTimeout(timeout)
      reject(error)
    }
    const request = client.request(url, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'Content-Type': 'application/json',
        'User-Agent': 'titra-integration-proxy/1',
        ...headers,
      },
      agent: false,
      lookup(hostname, options, callback) {
        if (options?.all) callback(null, [target])
        else callback(null, target.address, target.family)
      },
    }, (response) => {
      let bytes = 0
      response.on('data', (chunk) => {
        bytes += chunk.length
        if (bytes > maxResponseBytes) {
          response.destroy(new TaskIntegrationError('integration-response-too-large'))
        }
      })
      response.on('end', () => resolveOnce({ status: response.statusCode || 0 }))
      response.on('aborted', () => rejectOnce(new TaskIntegrationError('integration-unavailable')))
      response.on('error', rejectOnce)
    })
    timeout = setTimeout(() => {
      request.destroy(new TaskIntegrationError('integration-timeout'))
    }, timeoutMs)
    request.on('error', rejectOnce)
    request.end(body)
  })
}

function boundedText(value, maxLength) {
  if (typeof value !== 'string') return ''
  return [...value].filter((character) => {
    const codePoint = character.codePointAt(0)
    return codePoint === 9 || codePoint === 10 || codePoint === 13
      || (codePoint > 31 && codePoint !== 127)
  }).join('').slice(0, maxLength)
}

function sanitizeSuggestions(provider, response) {
  if (!Array.isArray(response)) throw new TaskIntegrationError('integration-response-invalid')
  return response.slice(0, MAX_RESULTS).map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null
    const title = boundedText(entry.title, 512).trim()
    if (!title) return null
    const description = provider === 'zammad' ? entry.note : entry.description
    return {
      title,
      description: boundedText(description, 4096),
    }
  }).filter(Boolean)
}

function sanitizeWekanOptions(response) {
  if (!Array.isArray(response)) throw new TaskIntegrationError('integration-response-invalid')
  return response.slice(0, MAX_RESULTS).map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)
      || !/^[A-Za-z0-9_-]{1,128}$/u.test(entry._id)) return null
    const title = boundedText(entry.title, 512).trim()
    return title ? { _id: entry._id, title } : null
  }).filter(Boolean)
}

async function requestWekanJson(path, configuration, target, {
  request, environment,
}) {
  const url = new URL(path, configuration.baseUrl)
  // The path is built only from validated identifiers, but keep it tied to the
  // validated origin and board prefix as a defence against future refactors.
  if (url.origin !== configuration.baseUrl.origin
    || !url.pathname.startsWith(configuration.baseUrl.pathname)) {
    throw new TaskIntegrationError('integration-query-invalid')
  }
  try {
    return await request(url, {
      headers: { Authorization: `Bearer ${configuration.credential}` },
      target,
      maxBytes: MAX_WEKAN_RESPONSE_BYTES,
      timeoutMs: REQUEST_TIMEOUT_MS,
      environment,
    })
  } catch (error) {
    if (error instanceof TaskIntegrationError) throw error
    throw new TaskIntegrationError('integration-unavailable')
  }
}

async function inspectWekanConfiguration(rawUrl, {
  environment = process.env,
  lookup,
  request = defaultPinnedRequest,
} = {}) {
  const configuration = parseWekanConfiguration(rawUrl, environment)
  const target = await resolvePinnedTarget(configuration.baseUrl, { environment, lookup })
  const listResponse = await requestWekanJson('lists', configuration, target, {
    request, environment,
  })
  const swimlaneResponse = await requestWekanJson('swimlanes', configuration, target, {
    request, environment,
  })
  const lists = sanitizeWekanOptions(listResponse)
  const swimlanes = sanitizeWekanOptions(swimlaneResponse)
  return { lists, swimlanes }
}

async function requestWekanTaskSuggestions(project, {
  environment = process.env,
  lookup,
  request = defaultPinnedRequest,
} = {}) {
  const configuration = parseWekanConfiguration(project?.wekanurl, environment)
  const swimlanes = normalizeWekanSelectors(project?.selectedWekanSwimlanes)
  const lists = swimlanes.length > 0
    ? [] : normalizeWekanSelectors(project?.selectedWekanList)
  const selectors = swimlanes.length > 0 ? swimlanes : lists
  const kind = swimlanes.length > 0 ? 'swimlanes' : 'lists'
  if (selectors.length === 0) return []
  const target = await resolvePinnedTarget(configuration.baseUrl, { environment, lookup })
  const output = []
  const seen = new Set()
  const requests = selectors.map((selector) => {
    const path = `${kind}/${selector}/cards`
    return requestWekanJson(path, configuration, target, { request, environment })
  })
  const responses = await Promise.all(requests)
  for (const response of responses) {
    if (!Array.isArray(response)) throw new TaskIntegrationError('integration-response-invalid')
    for (const card of response) {
      if (card?.archived !== true) {
        const suggestion = sanitizeSuggestions('wekan', [card])[0]
        if (suggestion) {
          const key = `${suggestion.title}\0${suggestion.description}`
          if (!seen.has(key)) {
            seen.add(key)
            output.push(suggestion)
          }
        }
      }
      if (output.length >= MAX_RESULTS) return output
    }
  }
  return output
}

async function requestTaskIntegrationSuggestions({
  provider, profile, project,
}, {
  environment = process.env,
  lookup,
  request = defaultPinnedRequest,
} = {}) {
  const requestOptions = integrationRequest({ provider, profile, project }, environment)
  const target = await resolvePinnedTarget(requestOptions.url, { environment, lookup })
  let response
  try {
    response = await request(requestOptions.url, {
      headers: requestOptions.headers,
      target,
      maxBytes: MAX_RESPONSE_BYTES,
      timeoutMs: REQUEST_TIMEOUT_MS,
    })
  } catch (error) {
    if (error instanceof TaskIntegrationError) throw error
    throw new TaskIntegrationError('integration-unavailable')
  }
  return sanitizeSuggestions(provider, response)
}

async function sendSiwappInvoice({ profile, invoice }, {
  environment = process.env,
  lookup,
  request = defaultPinnedStatusRequest,
} = {}) {
  const baseUrl = normalizeIntegrationBaseUrl(profile?.siwappurl, environment)
  const credential = normalizeCredential(profile?.siwapptoken)
  const url = new URL('api/v1/invoices', baseUrl)
  const target = await resolvePinnedTarget(url, { environment, lookup })
  let body
  try {
    body = JSON.stringify(invoice)
  } catch {
    throw new TaskIntegrationError('integration-request-invalid')
  }
  if (typeof body !== 'string' || Buffer.byteLength(body) > MAX_SIWAPP_REQUEST_BYTES) {
    throw new TaskIntegrationError('integration-request-too-large')
  }
  let response
  try {
    response = await request(url, {
      body,
      headers: { Authorization: `Token token=${credential}` },
      target,
      maxResponseBytes: MAX_SIWAPP_RESPONSE_BYTES,
      timeoutMs: REQUEST_TIMEOUT_MS,
    })
  } catch (error) {
    if (error instanceof TaskIntegrationError) throw error
    throw new TaskIntegrationError('integration-unavailable')
  }
  if (response?.status !== 201) throw new TaskIntegrationError('integration-unavailable')
  return true
}

export {
  integrationRequest,
  isNonPublicAddress,
  MAX_RESPONSE_BYTES,
  MAX_RESULTS,
  MAX_SIWAPP_REQUEST_BYTES,
  MAX_SIWAPP_RESPONSE_BYTES,
  MAX_WEKAN_RESPONSE_BYTES,
  MAX_WEKAN_SELECTORS,
  inspectWekanConfiguration,
  normalizeGitlabQuery,
  normalizeIntegrationBaseUrl,
  normalizeWekanSelectors,
  normalizeWekanStoredUrl,
  parseWekanConfiguration,
  privateHostnameAllowed,
  REQUEST_TIMEOUT_MS,
  requestTaskIntegrationSuggestions,
  requestWekanTaskSuggestions,
  resolvePinnedTarget,
  sanitizeSuggestions,
  sendSiwappInvoice,
  TaskIntegrationError,
}
