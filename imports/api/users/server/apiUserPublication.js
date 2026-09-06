// API credentials are deliberately absent from both the implicit Accounts
// publication and the explicit browser profile used by the existing UI.
const API_SAFE_USER_FIELDS = Object.freeze({
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
  'profile.siwapptoken': 1,
  'profile.holidayCountry': 1,
  'profile.holidayState': 1,
  'profile.holidayRegion': 1,
  'profile.zammadurl': 1,
  'profile.zammadtoken': 1,
  'profile.gitlaburl': 1,
  'profile.gitlabtoken': 1,
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

const IMPLICIT_CURRENT_USER_FIELDS = Object.freeze({ _id: 1 })

function configureAPIUserPublication(accounts) {
  accounts.setDefaultPublishFields(IMPLICIT_CURRENT_USER_FIELDS)
}

export {
  API_SAFE_USER_FIELDS,
  IMPLICIT_CURRENT_USER_FIELDS,
  configureAPIUserPublication,
}
