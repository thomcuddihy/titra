const DEFAULT_ADMIN_USER_LIMIT = 25
const MAX_ADMIN_USER_LIMIT = 100
const MAX_ADMIN_USER_SEARCH_CHARS = 200

function adminUserListLimit(limit) {
  return Number.isInteger(limit)
    ? Math.min(Math.max(limit, 1), MAX_ADMIN_USER_LIMIT)
    : DEFAULT_ADMIN_USER_LIMIT
}

function literalAdminUserSearch(search) {
  if (typeof search !== 'string' || search.length === 0) return ''
  return search.slice(0, MAX_ADMIN_USER_SEARCH_CHARS)
    .replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function adminUserListSelector(search) {
  const literalSearch = literalAdminUserSearch(search)
  if (!literalSearch) return {}
  return {
    $or: [
      { 'profile.name': { $regex: literalSearch, $options: 'i' } },
      { 'emails.address': { $regex: literalSearch, $options: 'i' } },
    ],
  }
}

function copyPresentFields(source, names) {
  return names.reduce((result, name) => {
    if (Object.hasOwn(source || {}, name)) result[name] = source[name]
    return result
  }, {})
}

function adminUserListFields(user) {
  const fields = copyPresentFields(user, ['isAdmin', 'createdAt', 'inactive'])
  const profile = copyPresentFields(user?.profile, ['name', 'avatar', 'avatarColor'])
  if (Object.keys(profile).length > 0) fields.profile = profile
  if (Array.isArray(user?.emails)) {
    fields.emails = user.emails.map((email) => copyPresentFields(email, ['address']))
  }
  return fields
}

function adminUserListDocuments({ user, userId, documents }) {
  if (user?._id !== userId || user.isAdmin !== true || user.inactive === true) return new Map()
  return new Map([...documents].map(([id, document]) => [
    id, adminUserListFields(document),
  ]))
}

export {
  DEFAULT_ADMIN_USER_LIMIT,
  MAX_ADMIN_USER_LIMIT,
  MAX_ADMIN_USER_SEARCH_CHARS,
  adminUserListDocuments,
  adminUserListFields,
  adminUserListLimit,
  adminUserListSelector,
  literalAdminUserSearch,
}
