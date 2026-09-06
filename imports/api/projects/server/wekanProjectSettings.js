import {
  normalizeWekanSelectors,
  normalizeWekanStoredUrl,
} from '../../users/server/taskIntegrationProxy.js'

/**
 * Normalize the Wekan fields accepted by createProject/updateProject.
 * A blank write-only secret is removed from the update document so an existing
 * stored credential is preserved instead of being overwritten by the form.
 */
function normalizeWekanProjectFields(project, { environment = process.env } = {}) {
  const normalized = { ...project }
  if (Object.prototype.hasOwnProperty.call(normalized, 'wekanurl')) {
    const value = normalized.wekanurl
    if (typeof value === 'string' && value.trim().length === 0) {
      delete normalized.wekanurl
    } else {
      normalized.wekanurl = normalizeWekanStoredUrl(value, environment)
    }
  }
  if (Object.prototype.hasOwnProperty.call(normalized, 'selectedWekanList')) {
    normalized.selectedWekanList = normalizeWekanSelectors(normalized.selectedWekanList)
  }
  if (Object.prototype.hasOwnProperty.call(normalized, 'selectedWekanSwimlanes')) {
    normalized.selectedWekanSwimlanes = normalizeWekanSelectors(
      normalized.selectedWekanSwimlanes,
    )
  }
  return normalized
}

export default normalizeWekanProjectFields
