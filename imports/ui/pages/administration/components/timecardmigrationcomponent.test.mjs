import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const script = readFileSync(
  new URL('./timecardmigrationcomponent.js', import.meta.url),
  'utf8',
)
const template = readFileSync(
  new URL('./timecardmigrationcomponent.html', import.meta.url),
  'utf8',
)
const styles = readFileSync(
  new URL('../../../styles/general.scss', import.meta.url),
  'utf8',
)

function eventHandler(eventName) {
  const start = script.indexOf(`'${eventName}':`)
  assert.notEqual(start, -1, `missing ${eventName} event handler`)
  const next = script.indexOf("\n  '", start + eventName.length + 4)
  return script.slice(start, next === -1 ? undefined : next)
}

test('method choices refresh a bounded real-data preview immediately', () => {
  for (const eventName of [
    'change input[name="migrationMode"]',
    'input .js-time-zone',
    'change .js-start-time-policy',
  ]) {
    assert.match(eventHandler(eventName), /scheduleOptionPreview\(templateInstance\)/)
  }
  assert.match(script, /callMigrationMethod\('optionPreview', args,/)
  assert.match(script, /const OPTION_PREVIEW_DELAY_MS = 300/)
})

test('preview is latest-first, sortable, and wired to functional pagination', () => {
  assert.match(script, /previewSortField = new ReactiveVar\('date'\)/)
  assert.match(script, /previewSortDirection = new ReactiveVar\('desc'\)/)
  assert.match(eventHandler('click .js-preview-sort'), /loadPreview\(templateInstance, 1\)/)
  assert.match(eventHandler('click .js-preview-previous'), /loadPreview\(/)
  assert.match(eventHandler('click .js-preview-next'), /loadPreview\(/)
  assert.match(template, /class="[^"]*js-preview-sort[^"]*" data-sort-field="date"/)
  assert.match(template, /js-preview-previous" \{\{disabledUnless previewHasPrevious\}\}/)
  assert.match(template, /js-preview-next" \{\{disabledUnless previewHasNext\}\}/)
})

test('backup browsing and download remain separate, bounded actions', () => {
  assert.match(template, /\{\{#each item in backupExportItems\}\}/)
  assert.match(template, /js-backup-export-previous/)
  assert.match(template, /js-backup-export-next/)
  assert.match(template, /js-download-backup-page/)
  assert.match(script, /callMigrationMethod\('exportBackupPage', \{ runId, page, pageSize: 100 \}/)
  assert.match(eventHandler('click .js-download-backup-page'), /loadBackupExportPage\([^]*true\)/)
  assert.match(script, /document\.body\.appendChild\(link\)[^]*link\.click\(\)[^]*link\.remove\(\)/)
  assert.doesNotMatch(eventHandler('click .js-backup-export-next'), /downloadBackupPage/)
})

test('verification and history stay readable and navigable', () => {
  assert.match(template, /js-go-to-verify/)
  assert.match(template, /migration-machine-report[^>]*>\{\{verificationReport\}\}<\/pre>/)
  assert.match(eventHandler('click .js-verify'), /verification\.set\(result\)/)
  assert.match(eventHandler('click .js-verify'), /loadHistory\(templateInstance\)/)
  assert.match(script, /templateInstance\.history\.set\(result \|\| \{ items: \[\] \}\)/)
  assert.match(eventHandler('click .js-inspect-run'), /inspectRun\(templateInstance, event\.currentTarget\.dataset\.runId\)/)
  assert.match(script, /callMigrationMethod\('getRun', \{ runId \}[^]*hydrateRun\(templateInstance, run\)/)
  assert.match(styles, /\.migration-machine-report\s*\{[^}]*color: var\(--bs-body-color\) !important;[^}]*background-color:/s)
})

test('enabled migration controls receive explicit, unfaded theme styles', () => {
  const migrationStyles = styles.slice(
    styles.indexOf('.timecard-migration {'),
    styles.indexOf('.form-label {'),
  )
  assert.match(migrationStyles, /\.btn-outline-secondary:not\(:disabled\)/)
  assert.match(migrationStyles, /\.btn-outline-primary:not\(:disabled\)/)
  assert.match(migrationStyles, /\.btn-outline-danger:not\(:disabled\)/)
  assert.match(migrationStyles, /opacity: 1/)
})
