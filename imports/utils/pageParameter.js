import { MAX_DETAILED_PAGE } from './detailedTimeQuery.js'
import { MAX_RESOURCE_PAGE } from './resourceLimits.js'

// Route parameters are untrusted strings (or absent), unlike the numeric DDP
// contract. Normalize here, without relaxing either server-side validator.
const MAX_PAGE_PARAMETER = Math.min(MAX_DETAILED_PAGE, MAX_RESOURCE_PAGE)

function normalizePageParameter(value) {
  if (typeof value === 'string') {
    if (!/^[1-9]\d{0,4}$/.test(value)) return 1
    value = Number(value)
  }
  return Number.isSafeInteger(value) && value >= 1 && value <= MAX_PAGE_PARAMETER
    ? value : 1
}

export { MAX_PAGE_PARAMETER, normalizePageParameter }
