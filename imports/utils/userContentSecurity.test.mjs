import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const helperModuleUrl = `data:text/javascript;base64,${Buffer.from(
  readFileSync(new URL('./userContentSecurity.js', import.meta.url), 'utf8'),
).toString('base64')}`

const {
  avatarPresentation,
  escapeHtml,
  normalizeAvatarDataUrl,
  normalizeHexColor,
  normalizeProfileName,
  normalizeProjectPresentationFields,
  plainTextToSafeHtml,
  projectDescriptionText,
} = await import(helperModuleUrl)

test('profile and project presentation fields are bounded and normalized', () => {
  assert.equal(normalizeProfileName('  Alice Example  '), 'Alice Example')
  assert.equal(normalizeHexColor('#a1b2c3'), '#A1B2C3')
  assert.deepEqual(normalizeProjectPresentationFields({
    name: ' Project ', desc: 'line 1\r\nline 2', color: '#009688',
  }), { name: 'Project', desc: 'line 1\nline 2', color: '#009688' })
  assert.throws(() => normalizeProfileName(' '.repeat(5)), /required/u)
  assert.throws(() => normalizeProfileName('x'.repeat(201)), /Invalid profile name/u)
  assert.throws(() => normalizeProjectPresentationFields({ name: 'x', color: 'red;display:none' }), /Invalid project color/u)
  assert.throws(() => normalizeProjectPresentationFields({ name: 'x', desc: 'x'.repeat(50001) }), /Invalid project description/u)
  assert.throws(() => normalizeProjectPresentationFields({ name: 'x', desc: { ops: [] } }), /Invalid project description/u)
  assert.throws(() => normalizeProfileName(`broken\uD800`), /Invalid profile name/u)
})

test('only bounded PNG data URLs survive avatar presentation', () => {
  const png = 'data:image/png;base64,iVBORw0KGgo='
  assert.equal(normalizeAvatarDataUrl(png), png)
  assert.equal(avatarPresentation({ profile: {
    name: '<img src=x onerror=alert(1)>', avatar: png, avatarColor: '#abcdef',
  } }).url, png)
  for (const hostile of [
    'javascript:alert(1)',
    'data:image/svg+xml,<svg onload=alert(1)>',
    'https://attacker.invalid/tracker.png',
    'data:image/png;base64,not base64',
  ]) {
    assert.equal(avatarPresentation({ profile: { avatar: hostile } }).url, '')
  }
  assert.equal(avatarPresentation({ profile: { avatarColor: 'red;position:fixed' } }).color, '#455A64')
})

test('avatar names and project descriptions are returned as text, never executable markup', () => {
  const hostile = '<img src=x onerror="alert(1)">&\'"'
  assert.equal(escapeHtml(hostile), '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;&amp;&#39;&quot;')
  assert.equal(plainTextToSafeHtml(`${hostile}\nsecond`), `${escapeHtml(hostile)}<br>second`)
  assert.equal(projectDescriptionText({
    ops: [{ insert: 'first\n' }, { insert: { image: 'javascript:alert(1)' } }, { insert: '<b>second</b>' }],
  }), 'first\n<b>second</b>')
})
