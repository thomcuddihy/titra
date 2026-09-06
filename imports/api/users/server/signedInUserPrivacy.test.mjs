import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  IMPLICIT_CURRENT_USER_FIELDS,
  LEGACY_SELF_ONLY_CLIENT_CREDENTIAL_FIELDS,
  SIGNED_IN_PROFILE_FIELDS,
  SIGNED_IN_USER_FIELDS,
  configureSignedInUserPublication,
  signedInBrowserProfile,
} from './signedInUserPrivacy.js'

const EXPECTED_UI_FIELDS = [
  'emails.address',
  'emails.verified',
  'isAdmin',
  'profile.avatar',
  'profile.avatarColor',
  'profile.breakDuration',
  'profile.breakStartTime',
  'profile.customEndDate',
  'profile.customStartDate',
  'profile.dailyStartTime',
  'profile.enableWekan',
  'profile.gitlaburl',
  'profile.googleAPIexpiresAt',
  'profile.holidayCountry',
  'profile.holidayRegion',
  'profile.holidayState',
  'profile.hoursToDays',
  'profile.language',
  'profile.name',
  'profile.precision',
  'profile.regularWorkingTime',
  'profile.rounding',
  'profile.siwappurl',
  'profile.startOfWeek',
  'profile.theme',
  'profile.timeunit',
  'profile.timer',
  'profile.timerId',
  'profile.timerRevision',
  'profile.timer_custom_fields',
  'profile.timer_project',
  'profile.timer_start_time',
  'profile.timer_task',
  'profile.timetrackview',
  'profile.unit',
  'profile.zammadurl',
  'username',
]

test('signed-in browser user projection is an exact UI allowlist', () => {
  assert.deepEqual(Object.keys(SIGNED_IN_USER_FIELDS).sort(), [...EXPECTED_UI_FIELDS].sort())
  Object.values(SIGNED_IN_USER_FIELDS).forEach((value) => assert.equal(value, 1))
})

test('API, login, verification and timer receipt secrets are never published', () => {
  for (const forbidden of [
    'profile.APItoken',
    'profile.timerStartHistory',
    'profile.timerStopReceipt',
    'profile',
    'services',
    'services.resume.loginTokens',
    'services.password.bcrypt',
    'services.googleapi',
    'actionVerification',
    'actionVerification.secret',
  ]) assert.equal(SIGNED_IN_USER_FIELDS[forbidden], undefined, forbidden)
})

test('there are no browser-visible integration credential exceptions', () => {
  assert.deepEqual(LEGACY_SELF_ONLY_CLIENT_CREDENTIAL_FIELDS, {})
  assert.equal(LEGACY_SELF_ONLY_CLIENT_CREDENTIAL_FIELDS['profile.APItoken'], undefined)
})

test('stored interfaces receive only the signed-in browser profile allowlist', () => {
  assert.deepEqual(SIGNED_IN_PROFILE_FIELDS, Object.fromEntries(
    Object.keys(SIGNED_IN_USER_FIELDS)
      .filter((field) => field.startsWith('profile.'))
      .map((field) => [field, 1]),
  ))
  const profile = signedInBrowserProfile({
    profile: {
      name: 'Owner',
      theme: 'dark',
      gitlaburl: 'https://gitlab.example/',
      gitlabtoken: 'legacy-browser-token',
      APItoken: 'never-pass-to-interface',
      timerStartHistory: [{ operationId: 'never-pass-to-interface' }],
      timerStopReceipt: { tokenHash: 'never-pass-to-interface' },
      futureSecret: 'never-pass-to-interface',
    },
    services: { password: { bcrypt: 'never-pass-to-interface' } },
  })
  assert.deepEqual(profile, {
    name: 'Owner',
    theme: 'dark',
    gitlaburl: 'https://gitlab.example/',
  })
  assert.equal(Object.hasOwn(profile, 'gitlabtoken'), false)
  assert.equal(Object.hasOwn(profile, 'APItoken'), false)
  assert.equal(Object.hasOwn(profile, 'timerStartHistory'), false)
  assert.equal(Object.hasOwn(profile, 'timerStopReceipt'), false)
})

test('Accounts implicit current-user publication receives only the document id', () => {
  const calls = []
  configureSignedInUserPublication({
    setDefaultPublishFields: (options) => calls.push(options),
    config: () => { throw new Error('must not change server-side user selectors') },
  })
  assert.deepEqual(IMPLICIT_CURRENT_USER_FIELDS, { _id: 1 })
  assert.deepEqual(calls, [IMPLICIT_CURRENT_USER_FIELDS])

  for (const forbidden of [
    'username',
    'emails',
    'emails.address',
    'isAdmin',
    'profile',
    'profile.APItoken',
    'profile.siwapptoken',
    'profile.zammadtoken',
    'profile.gitlabtoken',
    'services',
  ]) assert.equal(IMPLICIT_CURRENT_USER_FIELDS[forbidden], undefined, forbidden)
})

test('implicit Accounts is minimal while explicit userRoles retains the UI allowlist', () => {
  const publications = readFileSync(new URL('./publications.js', import.meta.url), 'utf8')
  const accountsStartup = readFileSync(new URL('../../../startup/server/useraccounts-configuration.js', import.meta.url), 'utf8')
  const navbar = readFileSync(new URL('../../../ui/shared components/navbar.js', import.meta.url), 'utf8')
  assert.match(publications, /Meteor\.publish\('userRoles'[\s\S]*fields: SIGNED_IN_USER_FIELDS/)
  assert.doesNotMatch(publications, /Meteor\.publish\('userRoles'[\s\S]*fields:\s*\{\s*profile:\s*1/)
  assert.match(accountsStartup, /configureSignedInUserPublication\(Accounts\)/)
  assert.match(accountsStartup, /implicit null publication[\s\S]*ID-only/)
  assert.match(navbar, /if \(Meteor\.user\(\)\) \{\s*this\.subscribe\('userRoles'\)/)
})

test('settings renders every stored integration credential as write-only', () => {
  const settings = readFileSync(new URL('../../../ui/pages/settings.html', import.meta.url), 'utf8')
  const settingsLogic = readFileSync(new URL('../../../ui/pages/settings.js', import.meta.url), 'utf8')
  assert.match(settings, /id="titraAPItoken"[\s\S]*autocomplete="off"/)
  assert.match(settings, /settings\.api_token_write_only_help/)
  assert.match(settings, /settings\.generate_api_token/)
  assert.match(settingsLogic, /titraAPItoken:\s*\(\)\s*=>\s*''/)
  assert.doesNotMatch(settingsLogic, /getUserSetting\(['"]APItoken['"]\)/)
  for (const field of ['siwapptoken', 'zammadtoken', 'gitlabtoken']) {
    assert.match(settingsLogic, new RegExp(`${field}:\\s*\\(\\)\\s*=>\\s*''`))
    assert.doesNotMatch(settingsLogic, new RegExp(`getUserSetting\\(['"]${field}['"]\\)`))
    assert.match(settings, new RegExp(`id="${field}"[^>]*type="password"|type="password"[^>]*id="${field}"`))
  }
  assert.match(
    settingsLogic,
    /#titraAPItoken['"]\)\.val\(Random\.secret\(32\)\)\.trigger\(['"]focus['"]\)\.trigger\(['"]select['"]\)/,
  )
})
