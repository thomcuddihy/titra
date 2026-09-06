import {
  MAX_PROJECT_SCOPE_IDS,
  RESOURCE_QUERY_MAX_TIME_MS,
  assertResultWithinLimit,
} from '../../../utils/resourceLimits.js'

const MAX_CUSTOMER_PROJECTS = MAX_PROJECT_SCOPE_IDS
const MAX_CUSTOMER_RESULTS = MAX_PROJECT_SCOPE_IDS
const MAX_CUSTOMER_NAME_LENGTH = 500

const customerProjectFields = Object.freeze({
  userId: 1,
  admins: 1,
  team: 1,
  customer: 1,
})

function customerAccessSelector(userId) {
  if (typeof userId !== 'string' || !userId || userId.length > 128) {
    throw new TypeError('A valid customer caller is required.')
  }
  return {
    $or: [
      { userId },
      { admins: userId },
      { team: userId },
    ],
  }
}

function isBoundedCustomerName(value) {
  return typeof value === 'string' && value.length > 0
    && value.length <= MAX_CUSTOMER_NAME_LENGTH * 2
    && value.isWellFormed() && [...value].length <= MAX_CUSTOMER_NAME_LENGTH
}

async function aggregateBoundedCustomers({
  aggregate,
  userId,
  maxResults = MAX_CUSTOMER_RESULTS,
}) {
  if (typeof aggregate !== 'function') {
    throw new TypeError('A customer aggregation callback is required.')
  }
  if (!Number.isSafeInteger(maxResults) || maxResults < 1) {
    throw new TypeError('A positive customer result limit is required.')
  }
  const rows = await aggregate([
    {
      $match: {
        ...customerAccessSelector(userId),
        customer: { $type: 'string', $ne: '' },
      },
    },
    {
      $match: {
        $expr: { $lte: [{ $strLenCP: '$customer' }, MAX_CUSTOMER_NAME_LENGTH] },
      },
    },
    { $group: { _id: '$customer' } },
    { $sort: { _id: 1 } },
    { $limit: maxResults + 1 },
  ], {
    allowDiskUse: false,
    maxTimeMS: RESOURCE_QUERY_MAX_TIME_MS,
  })
  return assertResultWithinLimit(rows, maxResults, 'Customer result')
}

export {
  MAX_CUSTOMER_PROJECTS,
  MAX_CUSTOMER_RESULTS,
  MAX_CUSTOMER_NAME_LENGTH,
  aggregateBoundedCustomers,
  customerAccessSelector,
  customerProjectFields,
  isBoundedCustomerName,
}
