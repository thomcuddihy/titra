const XLSX_WORKER_DIRECTIVE = "worker-src 'self' blob:;"

export function withXlsxWorkerPolicy(policy) {
  if (typeof policy !== 'string' || !policy.trim()) return policy
  // An explicitly configured worker policy (including 'none') takes precedence.
  // Do not round-trip CSP through BrowserPolicy.setPolicy: its default-src merge
  // can alter unrelated restrictive directives, hashes, or configured origins.
  if (policy.split(';').some((directive) => /^\s*worker-src(?:\s|$)/i.test(directive))) {
    return policy
  }
  return `${policy}${policy.trimEnd().endsWith(';') ? ' ' : '; '}${XLSX_WORKER_DIRECTIVE}`
}

export function applyXlsxWorkerPolicy(response) {
  if (response.headersSent) return
  const name = 'Content-Security-Policy'
  const policy = response.getHeader(name)
  const updated = Array.isArray(policy)
    ? policy.map(withXlsxWorkerPolicy) : withXlsxWorkerPolicy(policy)
  if (updated !== undefined && updated !== policy) response.setHeader(name, updated)
}
