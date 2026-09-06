// Retained as an exported compatibility name for downstream tests/imports.
// There are deliberately no browser-visible credential exceptions.
const LEGACY_SELF_ONLY_CLIENT_CREDENTIAL_FIELDS = Object.freeze({})

/**
 * Exact allowlist for Meteor Accounts' implicit current-user publication.
 * The navbar uses the document's presence for signed-in state; all UI fields
 * arrive through the explicitly authenticated, live-gated userRoles stream.
 */
const IMPLICIT_CURRENT_USER_FIELDS = Object.freeze({ _id: 1 })

/** Exact allowlist for the explicit, self-only userRoles publication. */
const SIGNED_IN_USER_FIELDS = Object.freeze({
  username: 1,
  'emails.address': 1,
  'emails.verified': 1,
  isAdmin: 1,
  'profile.name': 1,
  'profile.avatar': 1,
  'profile.avatarColor': 1,
  'profile.unit': 1,
  'profile.precision': 1,
  'profile.startOfWeek': 1,
  'profile.timeunit': 1,
  'profile.timetrackview': 1,
  'profile.hoursToDays': 1,
  'profile.dailyStartTime': 1,
  'profile.breakStartTime': 1,
  'profile.breakDuration': 1,
  'profile.regularWorkingTime': 1,
  'profile.enableWekan': 1,
  'profile.siwappurl': 1,
  'profile.holidayCountry': 1,
  'profile.holidayState': 1,
  'profile.holidayRegion': 1,
  'profile.zammadurl': 1,
  'profile.gitlaburl': 1,
  'profile.rounding': 1,
  'profile.theme': 1,
  'profile.language': 1,
  'profile.customStartDate': 1,
  'profile.customEndDate': 1,
  'profile.timer': 1,
  'profile.timerId': 1,
  'profile.timerRevision': 1,
  'profile.timer_project': 1,
  'profile.timer_task': 1,
  'profile.timer_custom_fields': 1,
  'profile.timer_start_time': 1,
  'profile.googleAPIexpiresAt': 1,
})

const SIGNED_IN_PROFILE_FIELDS = Object.freeze(Object.fromEntries(
  Object.keys(SIGNED_IN_USER_FIELDS)
    .filter((field) => field.startsWith('profile.'))
    .map((field) => [field, 1]),
))

/**
 * Return exactly the profile fields already available to this user in their
 * own browser session. This keeps legacy client integrations working without
 * exposing server-only profile data (notably profile.APItoken) to stored
 * interface programs.
 */
function signedInBrowserProfile(user) {
  const source = user?.profile
  if (!source || typeof source !== 'object' || Array.isArray(source)) return {}
  return Object.fromEntries(Object.keys(SIGNED_IN_PROFILE_FIELDS)
    .map((path) => path.slice('profile.'.length))
    .filter((field) => Object.hasOwn(source, field))
    .map((field) => [field, structuredClone(source[field])]))
}

function configureSignedInUserPublication(accounts) {
  // defaultFieldSelector controls server-side Meteor.userAsync()/Accounts
  // lookups and a positive selector is deliberately ignored when Accounts
  // merges its own positive publication defaults.  setDefaultPublishFields is
  // the dedicated publication API: use it so secrets in profile are not sent
  // while full server-side user lookups keep working.
  accounts.setDefaultPublishFields(IMPLICIT_CURRENT_USER_FIELDS)
}

export {
  IMPLICIT_CURRENT_USER_FIELDS,
  LEGACY_SELF_ONLY_CLIENT_CREDENTIAL_FIELDS,
  SIGNED_IN_PROFILE_FIELDS,
  SIGNED_IN_USER_FIELDS,
  configureSignedInUserPublication,
  signedInBrowserProfile,
}
