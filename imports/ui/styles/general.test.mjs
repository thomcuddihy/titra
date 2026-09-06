import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const styles = readFileSync(new URL('./general.scss', import.meta.url), 'utf8')
const migrationTemplate = readFileSync(new URL(
  '../pages/administration/components/timecardmigrationcomponent.html',
  import.meta.url,
), 'utf8')

function nestedBlock(source, selector) {
  const selectorIndex = source.indexOf(selector)
  assert.notEqual(selectorIndex, -1, `missing ${selector}`)
  const openingBrace = source.indexOf('{', selectorIndex + selector.length)
  assert.notEqual(openingBrace, -1, `missing block for ${selector}`)
  let depth = 1
  for (let index = openingBrace + 1; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1
    if (source[index] === '}') depth -= 1
    if (depth === 0) return source.slice(openingBrace + 1, index)
  }
  assert.fail(`unterminated block for ${selector}`)
  return undefined
}

test('dark theme keeps migration reports and semantic helper text legible', () => {
  assert.match(migrationTemplate, /class="[^"]*text-body-secondary[^"]*"/)
  assert.match(migrationTemplate, /class="[^"]*migration-machine-report[^"]*"/)
  assert.match(migrationTemplate, /progress-bar bg-warning text-dark/)

  const darkMigration = nestedBlock(nestedBlock(styles, 'body.is-dark'), '.timecard-migration')
  assert.match(
    darkMigration,
    /\.text-body-secondary\s*\{\s*color:\s*rgba\(240,\s*240,\s*240,\s*0\.75\)\s*!important;/,
  )
  assert.match(darkMigration, /code\s*\{\s*color:\s*#ffb3d7;/)
  assert.match(
    darkMigration,
    /\.table-primary code,[\s\S]*?\.table-warning code\s*\{\s*color:\s*#212529\s*!important;/,
  )
  assert.match(darkMigration, /\.text-warning-emphasis\s*\{\s*color:\s*#ffe69c\s*!important;/)

  const migrationStyles = nestedBlock(styles, '.timecard-migration')
  assert.match(
    migrationStyles,
    /\.migration-machine-report\s*\{[\s\S]*?color:\s*var\(--bs-body-color\)\s*!important;[\s\S]*?background-color:/,
  )
})

test('migration disabled and destructive controls remain visibly distinct', () => {
  const migrationStyles = nestedBlock(styles, '.timecard-migration')
  assert.match(migrationStyles, /\.btn-outline-primary:not\(:disabled\)/)
  assert.match(migrationStyles, /\.btn-outline-secondary:not\(:disabled\)/)
  assert.match(migrationStyles, /\.btn-outline-primary:disabled,[\s\S]*?opacity:\s*1;/)
  assert.match(
    migrationStyles,
    /\.btn-outline-danger:not\(:disabled\)[\s\S]*?background-color:\s*#a4133c/,
  )
})
