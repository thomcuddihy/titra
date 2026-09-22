import { TimeEntryStateMutationError, validateStateMutationInput } from './stateMutation.js'

async function markAuthorizedTimeEntriesExported({ callerId, timecardIds }, dependencies) {
  const ids = validateStateMutationInput(timecardIds, 'exported')
  const entries = await dependencies.findTimeEntries({ _id: { $in: ids } }, {
    fields: { _id: 1, userId: 1, projectId: 1 },
  })
  if (!Array.isArray(entries) || entries.length !== ids.length
    || new Set(entries.map((entry) => entry._id)).size !== ids.length
    || entries.some((entry) => !ids.includes(entry._id))) throw new TimeEntryStateMutationError('not-authorized')
  const foreignProjects = [...new Set(entries.filter((entry) => entry.userId !== callerId).map((entry) => entry.projectId))]
  if (foreignProjects.some((id) => typeof id !== 'string')) throw new TimeEntryStateMutationError('not-authorized')
  const requireProjectAuthority = async () => {
    const administered = new Set(foreignProjects.length ? await dependencies.findAdministeredProjectIds({
      _id: { $in: foreignProjects }, $or: [{ userId: callerId }, { admins: callerId }],
    }, { fields: { _id: 1 } }) : [])
    if (foreignProjects.some((id) => !administered.has(id))) throw new TimeEntryStateMutationError('not-authorized')
    return administered
  }
  await requireProjectAuthority()
  await dependencies.beforeWrite()
  // Refresh project rights after the asynchronous account check. This is not a
  // cross-collection transaction; the record identity and state guards below
  // nevertheless prevent moving/reassigning a record from widening this write.
  const administered = await requireProjectAuthority()
  const authorization = [{ userId: callerId }]
  if (administered.size) authorization.push({ projectId: { $in: [...administered] } })
  const result = await dependencies.updateTimeEntries({
    _id: { $in: ids },
    $and: [
      { $or: authorization },
      { $or: [{ state: 'new' }, { state: { $exists: false } }] },
      { $or: entries.map(({ _id, userId, projectId }) => ({ _id, userId, projectId })) },
    ],
  }, { $set: { state: 'exported' } })
  if (!result || !Number.isSafeInteger(result.matchedCount) || result.matchedCount < 0
    || result.matchedCount > ids.length) throw new TimeEntryStateMutationError('timecard-write-conflict')
  return { updated: result.matchedCount, skipped: ids.length - result.matchedCount }
}

export { markAuthorizedTimeEntriesExported }
