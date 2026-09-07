import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

function source(relativePath) {
  return readFileSync(new URL(`../../${relativePath}`, import.meta.url), 'utf8')
}

test('audited user-content templates have no raw Spacebars HTML sinks', () => {
  for (const relativePath of [
    'imports/ui/pages/profile.html',
    'imports/ui/shared components/navbar.html',
    'imports/ui/pages/administration/components/userscomponent.html',
    'imports/ui/pages/overview/components/projectchart.html',
    'imports/ui/pages/track/components/projectInfoPopup.html',
    'imports/ui/pages/track/components/magicPopup.html',
  ]) assert.doesNotMatch(source(relativePath), /\{\{\{/u, relativePath)
})

test('magic popup project choices use the escaped Spacebars option contract', () => {
  const controller = source('imports/ui/pages/track/components/magicPopup.js')
  const template = source('imports/ui/pages/track/components/magicPopup.html')

  assert.match(controller, /projectOptions:\s*\(projectId\)\s*=>\s*Projects\.find\(/u)
  assert.match(controller, /name:\s*project\.name/u)
  assert.match(controller, /selected:\s*project\._id\s*===\s*projectId/u)
  assert.doesNotMatch(controller, /renderProjectSelect|<option|<select/u)
  assert.match(template, /\{\{#each project in projectOptions entry\.projectID\}\}/u)
  assert.match(template, /\{\{project\.name\}\}/u)
})

test('remote changelog and legacy descriptions are converted to text', () => {
  const about = source('imports/ui/pages/about.js')
  assert.doesNotMatch(about, /\.html\s*\(/u)
  assert.match(about, /textContent/u)
  assert.match(about, /replaceChildren/u)

  for (const relativePath of [
    'imports/ui/pages/overview/components/projectchart.js',
    'imports/ui/pages/track/components/projectInfoPopup.js',
    'imports/ui/pages/overview/editproject/editproject.js',
  ]) {
    const file = source(relativePath)
    assert.match(file, /projectDescriptionText/u, relativePath)
    assert.doesNotMatch(file, /quill-delta-to-html/u, relativePath)
  }
})

test('all four audited CSV exports use the centralized safe encoder', () => {
  for (const relativePath of [
    'imports/ui/pages/details/components/detailtimetable.js',
    'imports/ui/pages/details/components/dailytimetable.js',
    'imports/ui/pages/details/components/periodtimetable.js',
    'imports/ui/pages/details/components/workingtimetable.js',
  ]) {
    const file = source(relativePath)
    assert.match(file, /import \{ encodeCsv \}/u, relativePath)
    assert.match(file, /new Blob\(\[encodeCsv\(csvRows\)\]/u, relativePath)
  }
})

test('DDP profile and project presentation writes invoke shared validators', () => {
  const users = source('imports/api/users/server/methods.js')
  assert.match(users, /normalizeProfileName\(name\)/u)
  assert.match(users, /normalizeAvatarDataUrl\(avatar\)/u)
  assert.match(users, /normalizeHexColor\(avatarColor/u)

  const projects = source('imports/api/projects/server/methods.js')
  assert.equal(
    [...projects.matchAll(/normalizeProjectPresentationFields\(updateJSON\)/gu)].length,
    4,
  )
})
