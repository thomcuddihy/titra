const taskForbiddenCustomfieldKeys = new Set([
  '_id', 'projectId', 'name', 'start', 'end', 'estimatedHours', 'dependencies',
  'isDefaultTask', 'userId', 'createdAt', 'updatedAt', 'projectTaskRevision',
])

const timeEntryForbiddenCustomfieldKeys = new Set([
  '_id', 'userId', 'projectId', 'date', 'dateOnly', 'startTime', 'dateRevision',
  'hours', 'task', 'taskRate', 'state', 'lastUsed', 'name', 'createdAt', 'updatedAt',
])

// Upstream's presentation allowlist is retained for compatibility, but must not
// replace the DDP/API ownership checks, revision guards, or Wekan normalization.
// In particular, team and admins are only writable through authorized routes.
const projectAllowedFields = new Set([
  'name', 'desc', 'color', 'customer', 'rate', 'budget', 'public', 'notbillable',
  'startDate', 'endDate', 'target', 'selectedWekanList', 'selectedWekanSwimlanes',
  'team', 'admins', 'defaultTask', 'status', 'order', 'wipLimit',
])

export {
  taskForbiddenCustomfieldKeys,
  timeEntryForbiddenCustomfieldKeys,
  projectAllowedFields,
}
