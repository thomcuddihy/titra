import { Meteor } from 'meteor/meteor'

import { canonicalJSONString, isDuplicateKeyError } from '../../../../server/apiIdempotency.js'

function expectedResourceDocument(document, resourceId) {
  if (typeof resourceId !== 'string' || !resourceId || resourceId.length > 128) {
    throw new TypeError('Resource ID must contain 1 to 128 characters.')
  }
  return { ...document, _id: resourceId }
}

function assertMatchingResource(existing, expected) {
  if (!existing || canonicalJSONString(existing) !== canonicalJSONString(expected)) {
    throw new Meteor.Error(
      'api-idempotency-resource-conflict',
      'The reserved resource ID exists with different data.',
    )
  }
  return existing
}

async function recoverCreatedDocument(collection, document, resourceId) {
  const expected = expectedResourceDocument(document, resourceId)
  const existing = await collection.findOneAsync({ _id: resourceId })
  if (!existing) return null
  assertMatchingResource(existing, expected)
  return { resourceId, document: existing, created: false }
}

async function insertDocumentWithId(collection, document, resourceId) {
  const expected = expectedResourceDocument(document, resourceId)
  try {
    await collection.insertAsync(expected)
    return { resourceId, document: expected, created: true }
  } catch (error) {
    if (!isDuplicateKeyError(error)) throw error
    const recovered = await recoverCreatedDocument(collection, document, resourceId)
    if (!recovered) throw error
    return recovered
  }
}

export {
  assertMatchingResource,
  expectedResourceDocument,
  insertDocumentWithId,
  recoverCreatedDocument,
}
