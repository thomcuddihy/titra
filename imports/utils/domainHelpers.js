export function normalizeDomain(host) {
  if (!host) return null

  let domain = String(host).trim().toLowerCase()
  domain = domain.replace(/^https?:\/\//, '')
  domain = domain.split(':')[0]
  domain = domain.split('/')[0]
  return domain
}
