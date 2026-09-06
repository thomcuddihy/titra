function perCallerDdpRule(type, name) {
  if (!['method', 'subscription'].includes(type) || typeof name !== 'string' || !name) {
    throw new TypeError('Invalid DDP rate-limit rule.')
  }
  return {
    type,
    name,
    userId() { return true },
    connectionId() { return true },
    clientAddress() { return true },
  }
}

export { perCallerDdpRule }
