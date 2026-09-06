class TimeEntryRuleOutcomeError extends Error {
  constructor(code, reason) {
    super(reason)
    this.error = code
    this.reason = reason
  }
}

const rejected = () => new TimeEntryRuleOutcomeError(
  'timecard-rule-blocked',
  'The configured time entry rule rejected this operation.',
)

const internal = () => new TimeEntryRuleOutcomeError(
  'timecard-rule-internal',
  'The configured time entry rule could not be evaluated.',
)
const timeEntryRuleInternalError = internal

function infrastructureFailure(error) {
  return error instanceof SyntaxError
    || ['ERR_SCRIPT_EXECUTION_TIMEOUT', 'ERR_VM_MODULE_LINK_FAILURE']
      .includes(error?.code)
    || error?.error === 'timecard-rule-internal'
}

async function evaluateTimeEntryRule(rule, execute) {
  if (typeof rule !== 'string' || !rule.trim()) throw internal()
  try {
    if (!await execute(rule)) throw rejected()
  } catch (error) {
    if (error?.error === 'timecard-rule-blocked') throw error
    if (infrastructureFailure(error)) throw internal()
    // A configured rule's deliberate/runtime throw is a rule rejection, but
    // its private message is never copied into API/DDP errors.
    throw rejected()
  }
}

export {
  TimeEntryRuleOutcomeError,
  evaluateTimeEntryRule,
  infrastructureFailure,
  timeEntryRuleInternalError,
}
