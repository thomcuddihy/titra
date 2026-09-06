import { check, Match } from 'meteor/check'
import Transactions from '../transactions.js'
import { checkAdminAuthentication } from '../../../utils/server_method_helpers.js'
import { publishAdminCollection } from '../../../utils/adminCollectionPublication.js'
import { transactionPublicationFields } from '../../../utils/transactionLogSecurity.js'

const TRANSACTION_ADMIN_FIELDS = Object.freeze({
  user: 1,
  method: 1,
  args: 1,
  timestamp: 1,
})
const MAX_TRANSACTION_FILTER_CHARS = 200

function literalTransactionFilter(filter) {
  if (!filter) return ''
  return filter
    .slice(0, MAX_TRANSACTION_FILTER_CHARS)
    .replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Publishes all transactions.
 * @param {Number} limit - The number of transactions to return.
 * @param {String} filter - The string to filter transactions by.
 * @returns {Array} - The list of transactions that match the filter.
 */
Meteor.publish('allTransactions', async function allTransactions({ limit, filter } = {}) {
  check(limit, Match.Maybe(Number))
  check(filter, Match.Maybe(String))
  await checkAdminAuthentication(this)
  const selector = {}
  if (filter) {
    const literalFilter = literalTransactionFilter(filter)
    selector.$or = [
      { user: { $regex: literalFilter, $options: 'i' } },
      { method: { $regex: literalFilter, $options: 'i' } },
      { args: { $regex: literalFilter, $options: 'i' } },
    ]
  }
  const publicationLimit = Number.isInteger(limit)
    ? Math.min(Math.max(limit, 1), 100)
    : 25
  return publishAdminCollection(this, {
    users: Meteor.users,
    collection: Transactions,
    collectionName: 'transactions',
    fields: TRANSACTION_ADMIN_FIELDS,
    selector,
    cursorOptions: { limit: publicationLimit, sort: { timestamp: -1 } },
    transformDocument: transactionPublicationFields,
  })
})

export {
  MAX_TRANSACTION_FILTER_CHARS,
  TRANSACTION_ADMIN_FIELDS,
  literalTransactionFilter,
}
