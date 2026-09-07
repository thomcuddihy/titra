import Projects from '../projects.js'
import {
  invalidateProjectStats as invalidateProjectStatsWithDependencies,
  runWithProjectStatsInvalidation as runWithProjectStatsInvalidationWithDependencies,
} from './projectStatsRevision.js'

function invalidateProjectStats(projectIds) {
  return invalidateProjectStatsWithDependencies(projectIds, {
    updateMany: (selector, modifier) => Projects.rawCollection().updateMany(selector, modifier),
  })
}

function runWithProjectStatsInvalidation(projectIds, operation) {
  return runWithProjectStatsInvalidationWithDependencies(projectIds, operation, {
    invalidate: invalidateProjectStats,
  })
}

export { invalidateProjectStats, runWithProjectStatsInvalidation }
