import {
  normalizeDetailedFilters,
  normalizeDetailedPeriod,
  normalizeDetailedScope,
  normalizeDetailedSearch,
  normalizeDetailedSort,
} from '../../../utils/detailedTimeQuery.js'
import { normalizeResourceScope } from '../../../utils/resourceLimits.js'
import { canViewProjectUnderPolicy } from '../../projects/server/publicAccessPolicy.js'
import { projectMemberIds, projectRole } from '../../users/server/projectUserPrivacy.js'
import { isProjectMember, timecardFields } from './publicationPrivacy.js'

const EXPORT_PAGE_SIZE = 500
const MAX_EXPORT_ROWS = 100000
const MAX_EXPORT_PAGE = MAX_EXPORT_ROWS / EXPORT_PAGE_SIZE
const MAX_EXPORT_RESPONSE_BYTES = 2 * 1024 * 1024
const EXPORT_VIEWS = new Set(['detailed', 'daily', 'total', 'working'])
const QUERY_FIELDS = new Set(['projectId', 'userId', 'customer', 'period', 'dates', 'search', 'sort', 'filters'])

class TimecardExportError extends Error {
  constructor(code, message) {
    super(message)
    this.error = code
  }
}

function invalid(message = 'Invalid time-entry export request.') {
  throw new TimecardExportError('export-invalid-input', message)
}

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value))
}

function normalizeExportPageInput(input) {
  if (!plainObject(input) || Object.keys(input).some((key) => !['view', 'query', 'page', 'limit'].includes(key))
    || !EXPORT_VIEWS.has(input.view) || !plainObject(input.query)
    || Object.keys(input.query).some((key) => !QUERY_FIELDS.has(key))) invalid()
  const page = input.page
  const limit = input.limit ?? EXPORT_PAGE_SIZE
  if (!Number.isSafeInteger(page) || page < 1 || page > MAX_EXPORT_PAGE
    || limit !== EXPORT_PAGE_SIZE) invalid('Exports require 500-row pages numbered 1 through 200.')
  const query = input.query
  try {
    const { period, dates } = normalizeDetailedPeriod(query.period, query.dates)
    const detailed = input.view === 'detailed'
    const scope = (value, label) => detailed
      ? normalizeDetailedScope(value, label) : normalizeResourceScope(value, label).value
    const normalized = {
      projectId: scope(query.projectId, 'project'),
      userId: scope(query.userId, 'user'),
      period,
      ...(dates ? { dates } : {}),
    }
    if (!detailed && typeof normalized.userId !== 'string') invalid('This view requires one resource or all resources.')
    if (input.view !== 'working') normalized.customer = scope(query.customer, 'customer')
    else if (query.customer !== undefined && query.customer !== 'all') {
      invalid('Working-time exports do not support a customer filter.')
    }
    if (detailed) {
      if (plainObject(query.filters)
        && Object.keys(query.filters).some((key) => ['__proto__', 'constructor', 'prototype'].includes(key))) invalid()
      normalized.search = normalizeDetailedSearch(query.search)
      normalized.sort = normalizeDetailedSort(query.sort)
      normalized.filters = normalizeDetailedFilters(query.filters)
    } else if ((query.search !== undefined && query.search !== '')
      || query.sort !== undefined
      || (query.filters !== undefined && (!plainObject(query.filters) || Object.keys(query.filters).length))) {
      invalid('Search, sorting and column filters are only supported for detailed exports.')
    }
    return { view: input.view, query: normalized, page, limit }
  } catch (error) {
    if (error instanceof TimecardExportError) throw error
    invalid(error instanceof TypeError ? error.message : undefined)
  }
  return undefined
}

function assertExportCount(count) {
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new TimecardExportError('export-invalid-result', 'The export query returned an invalid count.')
  }
  if (count > MAX_EXPORT_ROWS) {
    throw new TimecardExportError('export-too-large', 'This export exceeds 100,000 rows. Narrow the filters and try again.')
  }
  return count
}

function exportRowKey(view, row) {
  if (view === 'detailed') {
    if (typeof row?._id !== 'string' || !row._id) invalid('An export row has no identifier.')
    return row._id
  }
  const userId = row?._id?.userId
  const projectId = row?._id?.projectId
  if (typeof userId !== 'string' || !userId
    || (view !== 'working' && (typeof projectId !== 'string' || !projectId))) invalid('An export group has no identifier.')
  if (view === 'total') return JSON.stringify([userId, projectId])
  const date = row?._id?.date
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) invalid('An export group has an invalid calendar date.')
  return JSON.stringify(view === 'daily' ? [date.toISOString(), userId, projectId] : [date.toISOString(), userId])
}

function exportAccessFingerprint(projects, callerId, publicDisabled, customFieldNames = []) {
  if (!Array.isArray(projects) || projects.some((project) => !project?._id
    || !canViewProjectUnderPolicy(project, callerId, publicDisabled))) {
    throw new TimecardExportError('export-access-changed', 'Project access changed while preparing the export. Try again.')
  }
  return JSON.stringify({
    publicDisabled,
    customFields: [...customFieldNames].sort(),
    projects: projects.map((project) => ({
      id: project._id,
      owner: project.userId,
      admins: [...(project.admins || [])].sort(),
      team: [...(project.team || [])].sort(),
      public: project.public === true,
      archived: project.archived === true,
    })).sort((left, right) => left.id.localeCompare(right.id)),
  })
}

// Filtering a redacted field still reveals its value through row existence and
// counts. Require every selected project to permit the field before querying.
function assertExportFilterVisibility(query, projects, callerId, customFieldNames = []) {
  const member = projects.every((project) => isProjectMember(project, callerId))
  const fields = timecardFields({ member, customFieldNames })
  if (member) fields.customer = 1
  if (Object.keys(query.filters || {}).some((name) => !Object.hasOwn(fields, name))
    || (!member && query.customer !== undefined && query.customer !== 'all')) {
    throw new TimecardExportError('export-filter-not-visible', 'One or more export filters require project membership. Remove those filters or select projects you belong to.')
  }
}

// Evaluate name visibility on contributing records before working-time grouping
// discards projectId. Public viewers may only learn their own resource name;
// members may learn fellow project members; project admins may learn contributors.
function workingExportNameVisibility(projects, callerId) {
  const administered = projects.filter((project) => ['owner', 'admin'].includes(projectRole(project, callerId)))
    .map((project) => project._id)
  const clauses = [{ $eq: ['$userId', callerId] }]
  if (administered.length) clauses.push({ $in: ['$projectId', administered] })
  for (const project of projects) {
    if (projectRole(project, callerId) === 'member') {
      clauses.push({ $and: [
        { $eq: ['$projectId', project._id] },
        { $in: ['$userId', projectMemberIds(project)] },
      ] })
    }
  }
  return { $max: { $cond: [{ $or: clauses }, 1, 0] } }
}

function assertExportResponse(response, measureBytes) {
  assertExportCount(response.totalEntries)
  if (!Array.isArray(response.rows) || response.rows.length > EXPORT_PAGE_SIZE
    || !Array.isArray(response.keys) || response.rows.length !== response.keys.length
    || response.keys.some((key) => typeof key !== 'string' || !key)
    || new Set(response.keys).size !== response.keys.length) {
    throw new TimecardExportError('export-invalid-result', 'The export query returned an invalid page.')
  }
  if (measureBytes(response) > MAX_EXPORT_RESPONSE_BYTES) {
    throw new TimecardExportError('export-page-too-large', 'An export page exceeds the 2 MiB safety limit. Narrow the filters and try again.')
  }
  return response
}

async function readAuthorizedExportPage(context, input, dependencies) {
  const request = normalizeExportPageInput(input)
  const release = dependencies.acquire({ userId: context.userId, peerAddress: context.connection?.clientAddress })
  if (!release) throw new TimecardExportError('export-busy', 'Another export request is already running. Please try again shortly.')
  try {
    const plan = await dependencies.buildPlan(request, context.userId)
    const before = await dependencies.accessSnapshot(plan, context.userId)
    const result = await dependencies.readPage(plan, before)
    await dependencies.authenticate(context)
    const after = await dependencies.accessSnapshot(plan, context.userId)
    if (before.fingerprint !== after.fingerprint) {
      throw new TimecardExportError('export-access-changed', 'Project access changed while preparing the export. Try again.')
    }
    return assertExportResponse({ rows: result.rows, keys: result.keys, totalEntries: result.totalEntries, page: request.page }, dependencies.measureBytes)
  } finally {
    release()
  }
}

export {
  EXPORT_PAGE_SIZE,
  MAX_EXPORT_PAGE,
  MAX_EXPORT_RESPONSE_BYTES,
  MAX_EXPORT_ROWS,
  TimecardExportError,
  assertExportCount,
  assertExportFilterVisibility,
  assertExportResponse,
  exportAccessFingerprint,
  exportRowKey,
  normalizeExportPageInput,
  readAuthorizedExportPage,
  workingExportNameVisibility,
}
