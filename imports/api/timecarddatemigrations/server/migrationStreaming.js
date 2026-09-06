const MAX_MIGRATION_STREAM_BATCH_SIZE = 500

function keysetSelector(selector, field, afterValue) {
  if (!selector || typeof selector !== 'object' || Array.isArray(selector)
    || typeof field !== 'string' || !field) {
    throw new TypeError('Invalid migration keyset selector')
  }
  if (afterValue === undefined) return { ...selector }
  return { $and: [{ ...selector }, { [field]: { $gt: afterValue } }] }
}

function cursorFingerprint(value) {
  if (value instanceof Date) return `date:${value.toISOString()}`
  return `${typeof value}:${String(value)}`
}

/**
 * Visit a collection through monotonically increasing keyset pages. No more
 * than 500 records are retained by this helper at any point. The optional
 * renewal callback runs before and after each non-empty page so a caller can
 * fence a long-running maintenance operation with a short database lease.
 */
async function forEachKeysetBatch({
  fetchBatch,
  onBatch,
  cursorValue = (document) => document?._id,
  renew = async () => {},
  batchSize = MAX_MIGRATION_STREAM_BATCH_SIZE,
}) {
  if (typeof fetchBatch !== 'function' || typeof onBatch !== 'function'
    || typeof cursorValue !== 'function' || typeof renew !== 'function'
    || !Number.isSafeInteger(batchSize) || batchSize < 1
    || batchSize > MAX_MIGRATION_STREAM_BATCH_SIZE) {
    throw new TypeError('Invalid migration streaming configuration')
  }

  let afterValue
  let previousFingerprint
  let batches = 0
  let documents = 0
  while (true) {
    // eslint-disable-next-line no-await-in-loop
    await renew()
    // eslint-disable-next-line no-await-in-loop
    const batch = await fetchBatch({ afterValue, limit: batchSize })
    if (!Array.isArray(batch) || batch.length > batchSize) {
      throw new TypeError('Migration keyset source exceeded its requested batch size')
    }
    if (!batch.length) break

    const nextValue = cursorValue(batch[batch.length - 1])
    if (nextValue === undefined || nextValue === null) {
      throw new TypeError('Migration keyset source returned a document without a cursor')
    }
    const nextFingerprint = cursorFingerprint(nextValue)
    if (nextFingerprint === previousFingerprint) {
      throw new TypeError('Migration keyset source did not advance')
    }

    // eslint-disable-next-line no-await-in-loop
    await onBatch(batch)
    batches += 1
    documents += batch.length
    afterValue = nextValue
    previousFingerprint = nextFingerprint
    // eslint-disable-next-line no-await-in-loop
    await renew()
    if (batch.length < batchSize) break
  }
  return { batches, documents, lastValue: afterValue }
}

export {
  MAX_MIGRATION_STREAM_BATCH_SIZE,
  forEachKeysetBatch,
  keysetSelector,
}
