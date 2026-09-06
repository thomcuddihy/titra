const publicationGuards = new WeakMap()
const MAX_DEADLINE_TIMER_DELAY_MS = 2_147_000_000
const ACTION_VERIFICATION_RECOVERY_METHODS = Object.freeze([
  'getUserVerificationStatus',
  'getUserVerificationUrl',
  'webhookverification.getdefaulttype',
])

function isPublicationContext(context) {
  return context !== null
    && typeof context === 'object'
    && typeof context.onStop === 'function'
    && typeof context.stop === 'function'
}

function isActionVerificationRecoveryMethod(methodName) {
  return typeof methodName === 'string'
    && ACTION_VERIFICATION_RECOVERY_METHODS.includes(methodName)
}

/**
 * A required verification is enforced only after its deadline. A malformed
 * deadline fails closed: otherwise corrupt data could silently disable the
 * server-side lock. Recovery methods remain available through an explicit
 * authorization option.
 */
function actionVerificationBlocksAccess(user, now = new Date()) {
  const verification = user?.actionVerification
  if (verification?.required !== true || verification.completed === true) return false
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new TypeError('Verification policy clock returned an invalid date')
  }
  if (!(verification.deadline instanceof Date)
    || Number.isNaN(verification.deadline.getTime())) return true
  return now > verification.deadline
}

function authorizedAuthenticationUser(
  user,
  userId,
  requireAdmin = false,
  { allowActionVerificationRecovery = false, now = new Date() } = {},
) {
  return user?._id === userId
    && user.inactive !== true
    && (!requireAdmin || user.isAdmin === true)
    && (allowActionVerificationRecovery || !actionVerificationBlocksAccess(user, now))
}

async function authorizeMethodAuthentication({
  context,
  users,
  requireAdmin = false,
  allowActionVerificationRecovery = false,
  now = new Date(),
}) {
  if (!context?.userId) return false
  const user = await users.findOneAsync({ _id: context.userId }, {
    fields: {
      _id: 1,
      inactive: 1,
      ...(requireAdmin ? { isAdmin: 1 } : {}),
      'actionVerification.required': 1,
      'actionVerification.completed': 1,
      'actionVerification.deadline': 1,
    },
  })
  return authorizedAuthenticationUser(user, context.userId, requireAdmin, {
    allowActionVerificationRecovery,
    now,
  })
}

function applyUserChanges(user, fields) {
  const next = { ...(user || {}) }
  Object.entries(fields || {}).forEach(([field, value]) => {
    if (value === undefined) delete next[field]
    else next[field] = value
  })
  return next
}

function stopGuardHandle(guard) {
  if (!guard.handle || guard.handleStopped) return undefined
  guard.handleStopped = true
  return guard.handle.stop()
}

function clearDeadlineTimer(guard) {
  if (!guard.deadlineTimer) return
  clearTimeout(guard.deadlineTimer)
  guard.deadlineTimer = undefined
}

function scheduleDeadlineReevaluation(guard) {
  clearDeadlineTimer(guard)
  if (guard.attaching || guard.revoked || guard.stopped) return
  const verification = guard.user?.actionVerification
  if (verification?.required !== true || verification.completed === true
    || !(verification.deadline instanceof Date)
    || Number.isNaN(verification.deadline.getTime())) return
  const remaining = verification.deadline.getTime() - Date.now()
  if (remaining < 0) return
  const delay = Math.min(remaining + 1, MAX_DEADLINE_TIMER_DELAY_MS)
  guard.deadlineTimer = setTimeout(() => {
    guard.deadlineTimer = undefined
    reevaluateGuard(guard)
  }, delay)
  guard.deadlineTimer.unref?.()
}

function revokePublication(guard) {
  if (guard.revoked || guard.stopped) return
  guard.revoked = true
  clearDeadlineTimer(guard)
  guard.context.stop()
}

function reevaluateGuard(guard) {
  const authorized = authorizedAuthenticationUser(
    guard.user, guard.userId, guard.requireAdmin,
  )
  if (!guard.attaching && !authorized) revokePublication(guard)
  else if (!guard.attaching && authorized) scheduleDeadlineReevaluation(guard)
  return authorized
}

function createPublicationGuard(context, users, requireAdmin) {
  const guard = {
    attaching: true,
    context,
    deadlineTimer: undefined,
    handle: undefined,
    handleStopped: false,
    requireAdmin,
    revoked: false,
    stopped: false,
    user: undefined,
    userId: context.userId,
  }
  publicationGuards.set(context, guard)
  context.onStop(() => {
    guard.stopped = true
    clearDeadlineTimer(guard)
    return stopGuardHandle(guard)
  })
  guard.ready = (async () => {
    let handle
    try {
      handle = await users.find({ _id: guard.userId }, {
        fields: {
          inactive: 1,
          isAdmin: 1,
          'actionVerification.required': 1,
          'actionVerification.completed': 1,
          'actionVerification.deadline': 1,
        },
      }).observeChangesAsync({
        added(id, fields) {
          guard.user = { _id: id, ...fields }
          reevaluateGuard(guard)
        },
        changed(_id, fields) {
          guard.user = applyUserChanges(guard.user, fields)
          reevaluateGuard(guard)
        },
        removed() {
          guard.user = undefined
          reevaluateGuard(guard)
        },
      })
    } catch (error) {
      guard.attaching = false
      if (!guard.stopped) revokePublication(guard)
      throw error
    }
    guard.handle = handle
    guard.attaching = false
    if (guard.stopped) await stopGuardHandle(guard)
    else reevaluateGuard(guard)
    return guard
  })()
  return guard
}

/**
 * Attach one exact-user authorization observer to a publication. Method
 * contexts return undefined and keep their existing one-shot authentication.
 */
async function guardPublicationAuthentication({
  context,
  users,
  requireAdmin = false,
}) {
  if (!isPublicationContext(context)) return undefined
  if (typeof context.userId !== 'string' || context.userId.length === 0) return false
  let guard = publicationGuards.get(context)
  if (!guard) guard = createPublicationGuard(context, users, requireAdmin)
  else if (requireAdmin && !guard.requireAdmin) {
    guard.requireAdmin = true
    reevaluateGuard(guard)
  }
  await guard.ready
  return !guard.revoked && !guard.stopped && authorizedAuthenticationUser(
    guard.user, guard.userId, guard.requireAdmin,
  )
}

export {
  ACTION_VERIFICATION_RECOVERY_METHODS,
  actionVerificationBlocksAccess,
  applyUserChanges,
  authorizeMethodAuthentication,
  authorizedAuthenticationUser,
  guardPublicationAuthentication,
  isActionVerificationRecoveryMethod,
  isPublicationContext,
}
