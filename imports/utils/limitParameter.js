import { MAX_DETAILED_LIMIT } from './detailedTimeQuery.js'
import { MAX_WORKING_TIME_ROWS } from './resourceLimits.js'

const DEFAULT_LIMIT_PARAMETER = 25
const MAX_LIMIT_PARAMETER = Math.min(MAX_DETAILED_LIMIT, MAX_WORKING_TIME_ROWS)
const LIMIT_OPTIONS = [10, 25, 50, 100, 200, MAX_LIMIT_PARAMETER]

// Old bookmarks used -1 for an unbounded query. Preserve their intent as far as
// the server's safety ceiling permits; never send the obsolete sentinel to DDP.
function normalizeLimitParameter(value) {
  if (value === -1 || value === '-1') return MAX_LIMIT_PARAMETER
  if (typeof value === 'string') {
    if (!/^[1-9]\d{0,2}$/.test(value)) return DEFAULT_LIMIT_PARAMETER
    value = Number(value)
  }
  return Number.isSafeInteger(value) && value >= 1 && value <= MAX_LIMIT_PARAMETER
    ? value : DEFAULT_LIMIT_PARAMETER
}

function limitParameterCorrection(value) {
  const limit = normalizeLimitParameter(value)
  if (value == null || String(value) === String(limit)) return undefined
  return { limit, page: null }
}

export {
  DEFAULT_LIMIT_PARAMETER, LIMIT_OPTIONS, MAX_LIMIT_PARAMETER,
  limitParameterCorrection, normalizeLimitParameter,
}
