function personalSuggestionSelector(userId, name) {
  // MongoDB's equality-to-null match deliberately includes both documents
  // where projectId is absent (the normal shape) and legacy documents where
  // it was stored explicitly as null.  Keep this identical to the partial
  // unique index so every indexed personal suggestion can also be refreshed.
  return { userId, name, projectId: null }
}

function affected(result) {
  return result === 1 || result?.matchedCount === 1 || result?.modifiedCount === 1
}

function duplicateKey(error) {
  return error?.code === 11000 || error?.code === 11001
}

async function refreshPersonalTaskSuggestion({ userId, name, lastUsed = new Date() }, {
  insertOne, updateOne,
}) {
  if (typeof userId !== 'string' || !userId || typeof name !== 'string' || !name
    || !(lastUsed instanceof Date) || Number.isNaN(lastUsed.getTime())
    || typeof insertOne !== 'function' || typeof updateOne !== 'function') {
    throw new TypeError('A personal task suggestion requires userId and name')
  }
  const selector = personalSuggestionSelector(userId, name)
  // Update-first avoids needless duplicate-key exceptions in the common path.
  // The unique partial index is the serialization point when two first uses
  // race: one insert wins and every loser retries the revisioned refresh.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const refreshed = await updateOne(selector, {
      $max: { lastUsed }, $inc: { taskSuggestionRevision: 1 },
    })
    if (affected(refreshed)) return refreshed
    try {
      return await insertOne({ userId, name, lastUsed, taskSuggestionRevision: 0 })
    } catch (error) {
      if (!duplicateKey(error)) throw error
    }
  }
  throw new Error('Personal task suggestion could not be refreshed after a concurrent insert')
}

export {
  duplicateKey,
  personalSuggestionSelector,
  refreshPersonalTaskSuggestion,
}
