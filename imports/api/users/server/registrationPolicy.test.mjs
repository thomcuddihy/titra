import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  anonymousRegistrationAllowed,
  firstUserAdministratorAllowed,
  RegistrationInputError,
  normalizeSelfRegistration,
  selfRegistrationAllowed,
} from './registrationPolicy.js'

const valid = {
  email: ' Person@Example.COM ',
  password: 'correct horse battery staple',
  name: ' Person ',
  currentLanguageProject: ' Project ',
  currentLanguageProjectDesc: ' First project ',
}

test('self-registration normalizes identity labels without changing the password', () => {
  assert.deepEqual(normalizeSelfRegistration(valid), {
    email: 'person@example.com',
    password: valid.password,
    profile: {
      name: 'Person',
      currentLanguageProject: 'Project',
      currentLanguageProjectDesc: 'First project',
    },
  })
})

test('self-registration rejects malformed and oversized untrusted fields', () => {
  for (const replacement of [
    { email: 'not-an-email' },
    { password: 'short' },
    { password: 'x'.repeat(129) },
    { name: '' },
    { currentLanguageProject: '' },
    { currentLanguageProjectDesc: 'x'.repeat(4001) },
    { email: `bad\ud800@example.com` },
  ]) {
    assert.throws(
      () => normalizeSelfRegistration({ ...valid, ...replacement }),
      RegistrationInputError,
    )
  }
})

test('registration setting is fail-explicit and only boolean true disables signup', () => {
  assert.equal(selfRegistrationAllowed(false), true)
  assert.equal(selfRegistrationAllowed(undefined), true)
  assert.equal(selfRegistrationAllowed(true), false)

  const registrationMethod = readFileSync(new URL('./registration.js', import.meta.url), 'utf8')
  assert.match(registrationMethod, /connectionId\(connectionId\)/u)
  assert.match(registrationMethod, /clientAddress\(clientAddress\)/u)
})

test('anonymous registration is closed unless explicitly enabled', () => {
  assert.equal(anonymousRegistrationAllowed(true), true)
  for (const value of [false, undefined, null, 1, 'true', 'false']) {
    assert.equal(anonymousRegistrationAllowed(value), false, String(value))
  }

  const accountsStartup = readFileSync(
    new URL('../../../startup/server/useraccounts-configuration.js', import.meta.url),
    'utf8',
  )
  const anonymousGate = accountsStartup.indexOf('if (options.anonymous &&')
  const newUserInitialization = accountsStartup.indexOf('await initNewUser')
  assert.ok(anonymousGate >= 0)
  assert.ok(newUserInitialization > anonymousGate)
  assert.match(accountsStartup, /getGlobalSettingAsync\('enableAnonymousLogins'\)/u)
  assert.match(accountsStartup, /anonymousRegistrationAllowed/u)
})

test('automatic first-user administrator elevation requires exact operator opt-in', () => {
  assert.equal(firstUserAdministratorAllowed('true'), true)
  for (const value of [undefined, null, '', false, true, 1, 'TRUE', ' true ', 'false']) {
    assert.equal(firstUserAdministratorAllowed(value), false, String(value))
  }

  const accountsStartup = readFileSync(
    new URL('../../../startup/server/useraccounts-configuration.js', import.meta.url),
    'utf8',
  )
  assert.match(
    accountsStartup,
    /if \(!options\.anonymous\s+&& firstUserAdministratorAllowed\(process\.env\.TITRA_ENABLE_FIRST_USER_ADMIN\)/u,
  )
})
