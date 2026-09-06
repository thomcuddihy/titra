import {
  MAX_PROJECT_SCOPE_IDS,
  normalizeResourceScope,
} from '../../../utils/resourceLimits.js'
import { isBoundedCustomerName } from './customerReadLimits.js'

function isActiveUser(user, userId) {
  return user?._id === userId && user.inactive !== true
}

function canViewProject(project, userId) {
  return project?.userId === userId
    || project?.admins?.includes(userId)
    || project?.team?.includes(userId)
}

function customerPublicationDocuments({ projects, user, userId }) {
  if (!isActiveUser(user, userId)) return new Map()
  const customers = new Set([...projects.values()]
    .filter((project) => canViewProject(project, userId))
    .map((project) => project.customer)
    .filter(isBoundedCustomerName))
  return new Map([...customers].sort().map((customer) => [
    customer, { name: customer },
  ]))
}

function normalizeRequestedProjectIds(projectId) {
  try {
    // This legacy publication has always used the scalar string as its only
    // all-project sentinel. Keep an array exact: every element must be an ID.
    if (Array.isArray(projectId) && projectId.includes('all')) return undefined
    const scope = normalizeResourceScope(projectId, 'Project', {
      maxItems: MAX_PROJECT_SCOPE_IDS,
    })
    return scope.all ? null : scope.values
  } catch {
    return undefined
  }
}

function normalizeProjectCustomerOptions(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(options))
    || Object.keys(options).length !== 1
    || !Object.prototype.hasOwnProperty.call(options, 'projectId')) return undefined
  return normalizeRequestedProjectIds(options.projectId)
}

export {
  canViewProject,
  customerPublicationDocuments,
  isActiveUser,
  normalizeProjectCustomerOptions,
  normalizeRequestedProjectIds,
}
