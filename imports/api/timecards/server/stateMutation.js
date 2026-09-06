const ALLOWED_TIME_ENTRY_STATES = Object.freeze([
  'new',
  'exported',
  'billed',
  'notBillable',
])
const MAX_STATE_MUTATION_ENTRIES = 1000
const SAFE_DOCUMENT_ID = /^[A-Za-z0-9_-]{1,128}$/

class TimeEntryStateMutationError extends Error {
  constructor(code) {
    super(code)
    this.error = code
  }
}

function validateStateMutationInput(timeEntries, state) {
  if (!Array.isArray(timeEntries) || timeEntries.length < 1
    || timeEntries.length > MAX_STATE_MUTATION_ENTRIES
    || !ALLOWED_TIME_ENTRY_STATES.includes(state)) {
    throw new TimeEntryStateMutationError('timecard-state-invalid')
  }
  const unique = new Set(timeEntries)
  if (unique.size !== timeEntries.length
    || timeEntries.some((id) => typeof id !== 'string' || !SAFE_DOCUMENT_ID.test(id))) {
    throw new TimeEntryStateMutationError('timecard-state-invalid')
  }
  return [...unique]
}

async function setAuthorizedTimeEntryStates({ callerId, timeEntries, state }, dependencies) {
  const ids = validateStateMutationInput(timeEntries, state)
  const entries = await dependencies.findTimeEntries({
    _id: { $in: ids },
  }, {
    fields: { _id: 1, userId: 1, projectId: 1 },
  })
  if (!Array.isArray(entries) || entries.length !== ids.length) {
    throw new TimeEntryStateMutationError('not-authorized')
  }

  const foreignProjectIds = [...new Set(entries
    .filter((entry) => entry?.userId !== callerId)
    .map((entry) => entry?.projectId))]
  if (foreignProjectIds.some((id) => typeof id !== 'string')) {
    throw new TimeEntryStateMutationError('not-authorized')
  }
  const administeredProjectIds = foreignProjectIds.length
    ? await dependencies.findAdministeredProjectIds({
      _id: { $in: foreignProjectIds },
      $or: [{ userId: callerId }, { admins: callerId }],
    }, { fields: { _id: 1 } })
    : []
  const administered = new Set(administeredProjectIds)
  if (foreignProjectIds.some((projectId) => !administered.has(projectId))) {
    throw new TimeEntryStateMutationError('not-authorized')
  }

  const authorization = [{ userId: callerId }]
  if (administered.size) authorization.push({ projectId: { $in: [...administered] } })
  const result = await dependencies.updateTimeEntries({
    _id: { $in: ids },
    $or: authorization,
  }, { $set: { state } })
  if (!result || result.matchedCount !== ids.length) {
    throw new TimeEntryStateMutationError('timecard-write-conflict')
  }
  return { updated: ids.length, state }
}

export {
  ALLOWED_TIME_ENTRY_STATES,
  MAX_STATE_MUTATION_ENTRIES,
  TimeEntryStateMutationError,
  setAuthorizedTimeEntryStates,
  validateStateMutationInput,
}
