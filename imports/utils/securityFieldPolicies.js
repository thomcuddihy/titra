const taskForbiddenCustomfieldKeys = new Set([
  '_id', 'projectId', 'name', 'start', 'end', 'estimatedHours', 'dependencies', 'isDefaultTask', 'userId', 'createdAt', 'updatedAt',
])

const timeEntryForbiddenCustomfieldKeys = new Set([
  '_id', 'userId', 'projectId', 'date', 'hours', 'task', 'taskRate', 'state', 'lastUsed', 'name', 'createdAt', 'updatedAt',
])

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
