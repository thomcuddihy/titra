import { isDateOnly } from './timecardDate.js'

// All metadata, labels and conversion rules are snapshots taken before the
// first asynchronous fetch, so every page in one file has the same meaning.
function buildDetailsExportRows(view, entries, context) {
  validateDetailsExportEntries(view, entries)
  const { labels, options, projects, resources } = context
  const project = (id) => projects.get(id) || {}
  const resource = (id) => resources.get(id)?.name || ''
  const header = []
  if (view === 'working') {
    header.push(labels.date, labels.resource, labels.startTime, labels.breakStartTime,
      labels.breakEndTime, labels.endTime, labels.totalTime,
      labels.regularWorkingTime, labels.regularWorkingTimeDifference)
    return [header, ...entries.map((entry) => [
      context.formatDate(entry.date), entry.resource, entry.startTime,
      entry.breakStartTime, entry.breakEndTime, entry.endTime, entry.totalTime,
      entry.regularWorkingTime, entry.regularWorkingTimeDifference,
    ])]
  }
  if (view === 'daily') header.push(labels.date)
  header.push(labels.project)
  if (view === 'detailed') header.push(labels.date, labels.task)
  if (options.showResource) header.push(labels.resource)
  if (view === 'detailed') {
    header.push(...context.timeFields, ...context.projectFields)
    if (options.showCustomer) header.push(labels.customer)
    if (options.useState) header.push(labels.state)
    if (options.useStartTime) header.push(labels.startTime, labels.endTime)
  }
  header.push(labels.unit)
  if (view === 'detailed' && options.showRate) header.push(labels.rate)
  const rows = entries.map((entry) => {
    if (view === 'daily' || view === 'total') {
      const row = view === 'daily' ? [context.formatDate(entry._id.date)] : []
      row.push(project(entry._id.projectId).name || '')
      if (options.showResource) row.push(resource(entry._id.userId))
      row.push(context.convertHours(entry.totalHours, false))
      return row
    }
    const metadata = project(entry.projectId)
    const row = [metadata.name || '', context.formatTimecardDate(entry), entry.task || '']
    if (options.showResource) row.push(resource(entry.userId))
    row.push(...context.timeFields.map((name) => entry[name] ?? null))
    row.push(...context.projectFields.map((name) => metadata[name] ?? null))
    if (options.showCustomer) row.push(metadata.customer || '')
    if (options.useState) row.push(context.states[entry.state || 'new'] || entry.state || '')
    if (options.useStartTime) row.push(context.startTime(entry), context.endTime(entry))
    row.push(context.convertHours(entry.hours, true))
    if (options.showRate) row.push(entry.taskRate || metadata.rates?.[entry.userId] || metadata.rate || 0)
    return row
  })
  return [header, ...rows]
}

function exportedTimecardIds(entries) {
  return [...new Set(entries.filter((entry) => entry.state === undefined || entry.state === 'new')
    .map((entry) => entry._id))]
}

export { buildDetailsExportRows, exportedTimecardIds, validateDetailsExportEntries }

function invalidRow() {
  throw Object.assign(new Error('An export row is incomplete or invalid.'), { code: 'export-incomplete' })
}

function identifier(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 1024 && value.isWellFormed()
}

function validExportDate(value) {
  return (value instanceof Date && Number.isFinite(value.getTime())) || isDateOnly(value)
}

function validateDetailsExportEntries(view, entries) {
  if (!['detailed', 'daily', 'total', 'working'].includes(view) || !Array.isArray(entries)) invalidRow()
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) invalidRow()
    if (view === 'detailed') {
      if (!identifier(entry._id) || !identifier(entry.projectId) || !identifier(entry.userId)
        || typeof entry.task !== 'string' || !Number.isFinite(entry.hours)
        || (entry.dateOnly != null ? !isDateOnly(entry.dateOnly) : !validExportDate(entry.date))) invalidRow()
    } else if (view === 'daily' || view === 'total') {
      if (!entry._id || typeof entry._id !== 'object' || Array.isArray(entry._id)
        || !identifier(entry._id.projectId) || !identifier(entry._id.userId)
        || !Number.isFinite(entry.totalHours)
        || (view === 'daily' && !validExportDate(entry._id.date))) invalidRow()
    } else {
      if (!validExportDate(entry.date)
        || !['totalTime', 'regularWorkingTime', 'regularWorkingTimeDifference'].every((field) => Number.isFinite(entry[field]))) invalidRow()
      // Names can legitimately be withheld; schedule fields may be absent in
      // legacy data. They must not become objects or fabricated numeric times.
      if (['resource', 'startTime', 'breakStartTime', 'breakEndTime', 'endTime']
        .some((field) => entry[field] != null && typeof entry[field] !== 'string')) invalidRow()
    }
  }
}
