const BASE_HTTP_SECURITY_HEADERS = Object.freeze({
  'Cross-Origin-Opener-Policy': 'same-origin-allow-popups',
  'Permissions-Policy': 'camera=(), geolocation=(), microphone=(), payment=(), usb=()',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-DNS-Prefetch-Control': 'off',
})

function httpSecurityHeaders(environment = {}) {
  return {
    ...BASE_HTTP_SECURITY_HEADERS,
    ...(environment.TITRA_ENABLE_HSTS === 'true'
      ? { 'Strict-Transport-Security': 'max-age=31536000' } : {}),
  }
}

function applyHttpSecurityHeaders(response, environment = {}) {
  for (const [name, value] of Object.entries(httpSecurityHeaders(environment))) {
    if (!response.headersSent) response.setHeader(name, value)
  }
}

export {
  BASE_HTTP_SECURITY_HEADERS,
  applyHttpSecurityHeaders,
  httpSecurityHeaders,
}
