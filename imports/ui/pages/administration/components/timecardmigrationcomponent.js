/* eslint-disable no-use-before-define, no-param-reassign, no-plusplus */

import dayjs from 'dayjs'
import { EJSON } from 'meteor/ejson'
import './timecardmigrationcomponent.html'
import { showErrorToast, showToast } from '../../../../utils/frontend_helpers.js'
import { t } from '../../../../utils/i18n.js'
import {
  hasNextPage,
  hasPreviousPage,
  pageCount,
} from '../../../../utils/timecardDateMigrationPaging.js'

const METHOD_PREFIX = 'timecardDateMigration.'
const DEFAULT_PAGE_SIZE = 25
const DEFAULT_BATCH_SIZE = 100
const OPTION_PREVIEW_DELAY_MS = 300
const LATEST_FIRST_SORT_FIELDS = new Set(['date'])
const migrationAdminSummary = new ReactiveVar({
  loading: true,
  legacyDetected: false,
  legacyCount: 0,
})

const COMMON_TIME_ZONES = [
  'Africa/Johannesburg',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/New_York',
  'America/Sao_Paulo',
  'Asia/Dubai',
  'Asia/Hong_Kong',
  'Asia/Kolkata',
  'Asia/Singapore',
  'Asia/Tokyo',
  'Australia/Adelaide',
  'Australia/Brisbane',
  'Australia/Melbourne',
  'Australia/Perth',
  'Australia/Sydney',
  'Europe/Amsterdam',
  'Europe/Berlin',
  'Europe/London',
  'Europe/Paris',
  'Pacific/Auckland',
  'UTC',
]

function callMigrationMethod(name, args, callback) {
  Meteor.call(`${METHOD_PREFIX}${name}`, args, callback)
}

function getErrorMessage(error) {
  return error?.reason || error?.message || String(error)
}

function isValidTimeZone(value) {
  if (!value) {
    return false
  }
  try {
    Intl.DateTimeFormat('en-US', { timeZone: value }).format()
    return true
  } catch {
    return false
  }
}

function optionPreviewArgs(templateInstance) {
  const mode = templateInstance.mode.get()
  const timeZone = templateInstance.timeZone.get()
  if (!mode || !isValidTimeZone(timeZone)) {
    return null
  }
  return {
    mode,
    timeZone,
    startTimePolicy: mode === 'date-only'
      ? 'omit'
      : templateInstance.startTimePolicy.get(),
  }
}

function getRunId(run) {
  return run?._id || run?.runId || run?.id
}

function getRunStatus(run) {
  return String(run?.status || run?.state || '').toLowerCase()
}

function getStatusClass(run) {
  const status = getRunStatus(run)
  if (status.includes('conflict') || status === 'paused' || status === 'backup-invalid') {
    return 'text-bg-warning'
  }
  if (status.includes('failed') || status === 'cancelled') {
    return 'text-bg-danger'
  }
  if (['applied', 'verified', 'restored'].includes(status)) {
    return 'text-bg-success'
  }
  return status ? 'text-bg-primary' : 'text-bg-secondary'
}

function getRunConfig(run) {
  return run?.config || run?.options || run || {}
}

function getModeLabel(mode) {
  const translationKeys = {
    'utc-wall-clock': 'timecard_migration.mode_wall_clock',
    'instant-in-zone': 'timecard_migration.mode_instant',
    'legacy-display-in-zone': 'timecard_migration.mode_legacy_display',
    'date-only': 'timecard_migration.mode_date_only',
  }
  return translationKeys[mode] ? t(translationKeys[mode]) : mode || '—'
}

function getCount(scan, name) {
  const counts = scan?.counts || scan?.summary || {}
  const aliases = {
    canonical: ['canonical', 'canonicalCount', 'alreadyCanonical'],
    legacy: ['legacy', 'legacyCount', 'candidates', 'migratable'],
    ambiguous: ['ambiguous', 'ambiguousCount'],
    invalid: ['invalid', 'invalidCount', 'quarantined'],
    total: ['total', 'totalCount'],
  }
  const keys = aliases[name] || [name]
  const value = keys
    .map((key) => counts[key] ?? scan?.[key])
    .find((candidate) => Number.isFinite(Number(candidate)))
  return Number(value || 0)
}

function getLegacyCount(scan) {
  const directCount = getCount(scan, 'legacy')
  if (directCount) {
    return directCount
  }
  const classifications = scan?.counts?.classifications || scan?.classifications || {}
  return Object.entries(classifications)
    .filter(([key]) => key.toLowerCase().includes('legacy'))
    .reduce((sum, [, value]) => sum + Number(value || 0), 0)
}

function getCandidateCount(scan) {
  const explicitCount = Number(
    scan?.counts?.migratable ?? scan?.counts?.candidates ?? scan?.candidateCount,
  )
  if (Number.isFinite(explicitCount)) {
    return explicitCount
  }
  return getLegacyCount(scan) + getCount(scan, 'ambiguous')
}

function updateAdminSummary(scan) {
  const candidateCount = getCandidateCount(scan)
  const quarantinedCount = getCount(scan, 'invalid')
  migrationAdminSummary.set({
    loading: false,
    legacyDetected: Boolean(scan?.legacyDetected || candidateCount > 0),
    legacyCount: getLegacyCount(scan),
    candidateCount,
    attentionRequired: Boolean(scan?.attentionRequired || candidateCount + quarantinedCount > 0),
    attentionCount: candidateCount + quarantinedCount,
    activeRun: scan?.activeRun,
  })
}

function refreshTimecardMigrationSummary(callback) {
  migrationAdminSummary.set({ ...migrationAdminSummary.get(), loading: true })
  callMigrationMethod('scan', {}, (error, result) => {
    if (!error) {
      updateAdminSummary(result || {})
    } else {
      migrationAdminSummary.set({
        ...migrationAdminSummary.get(),
        loading: false,
        error: getErrorMessage(error),
      })
    }
    callback?.(error, result)
  })
}

function stepForRun(run) {
  const status = getRunStatus(run)
  if (['prepared', 'backup-verified', 'ready', 'backup-invalid'].includes(status)) {
    return 4
  }
  if (status === 'paused' && run?.pausedPhase === 'restore') {
    return 6
  }
  if (['applying', 'paused'].includes(status)) {
    return 5
  }
  const finishedStatuses = [
    'applied', 'applied-with-conflicts', 'completed', 'verifying', 'verified',
    'restore-ready', 'restoring', 'restored', 'restored-with-conflicts',
  ]
  if (finishedStatuses.includes(status)) {
    return 6
  }
  return 3
}

function setError(templateInstance, error) {
  const message = getErrorMessage(error)
  templateInstance.error.set(message)
  showErrorToast(message)
}

function requestPause(runId) {
  if (!runId) {
    return
  }
  callMigrationMethod('pause', { runId }, (error) => {
    if (error) {
      // The server lease remains the final safety net if navigation interrupts this request.
      console.error(`Unable to pause timecard migration run ${runId}`, error)
    }
  })
}

function applyRunResult(templateInstance, result) {
  const run = result?.run || result?.activeRun || result
  if (run && getRunId(run)) {
    const selectedRunId = getRunId(templateInstance.run.get())
    if (templateInstance.viewDestroyed
      || (selectedRunId && selectedRunId !== getRunId(run))) {
      return null
    }
    templateInstance.run.set(run)
  }
  if (result?.progress || run?.progress) {
    templateInstance.progress.set(result?.progress || run.progress)
  }
  return run
}

function syncRestoreRun(templateInstance, run) {
  const runId = getRunId(run)
  if (!runId
    || templateInstance.viewDestroyed
    || templateInstance.restoreRunId.get() !== runId) {
    return false
  }
  templateInstance.restoreRun.set(run)
  if (getRunId(templateInstance.run.get()) === runId) {
    templateInstance.run.set(run)
  }
  return true
}

function refreshRunAfterBatchError(templateInstance, runId, error) {
  setError(templateInstance, error)
  callMigrationMethod('getRun', { runId }, (refreshError, run) => {
    if (refreshError
      || getRunId(run) !== runId
      || getRunId(templateInstance.run.get()) !== runId
      || templateInstance.viewDestroyed) {
      return
    }
    hydrateRun(templateInstance, run)
    loadHistory(templateInstance)
  })
}

function hydrateRun(templateInstance, run) {
  if (!run || !getRunId(run)) {
    return
  }
  templateInstance.runSelectionRevision += 1
  templateInstance.inspectRequestId += 1
  templateInstance.inspectLoading.set(false)
  templateInstance.previewCreationRequestId += 1
  templateInstance.previewCreationLoading.set(false)
  const previousRunId = getRunId(templateInstance.run.get())
  const nextRunId = getRunId(run)
  if (previousRunId !== nextRunId) {
    if (templateInstance.applyLoopActive || templateInstance.restoreLoopActive) {
      requestPause(previousRunId)
    }
    templateInstance.applyLoopActive = false
    templateInstance.restoreLoopActive = false
    templateInstance.batchLoading.set(false)
    templateInstance.previewLoading.set(false)
    templateInstance.backupLoading.set(false)
    templateInstance.backupExportLoading.set(false)
    templateInstance.applyConflictsLoading.set(false)
    templateInstance.verifyLoading.set(false)
    templateInstance.restoreLoading.set(false)
    templateInstance.restoreBatchLoading.set(false)
    templateInstance.applyConfirmation.set('')
    templateInstance.restoreConfirmation.set('')
  }
  templateInstance.run.set(run)
  templateInstance.step.set(stepForRun(run))
  templateInstance.progress.set({})
  templateInstance.previewRequestId += 1
  templateInstance.preview.set({ items: [] })
  templateInstance.previewPage.set(1)
  templateInstance.previewSortField.set('date')
  templateInstance.previewSortDirection.set('desc')
  templateInstance.classificationFilter.set('')
  templateInstance.warningsOnly.set(false)
  templateInstance.applyConflictsRequestId += 1
  templateInstance.applyConflicts.set({ items: [] })
  templateInstance.applyConflictPage.set(1)
  templateInstance.backupResult.set()
  templateInstance.backupExportRequestId += 1
  templateInstance.backupExport.set({ items: [] })
  templateInstance.backupExportPage.set(1)
  templateInstance.verification.set()
  templateInstance.restorePreviewRequestId += 1
  templateInstance.restoreRunId.set()
  templateInstance.restoreRun.set()
  templateInstance.restorePreview.set({ items: [] })
  templateInstance.restorePage.set(1)
  templateInstance.restoreProgress.set({})
  const config = getRunConfig(run)
  templateInstance.mode.set(config.mode || '')
  templateInstance.timeZone.set(config.timeZone || '')
  templateInstance.startTimePolicy.set(config.startTimePolicy || 'extract')
  if (run.progress || run.applyStats) {
    const progress = run.progress || run.applyStats
    templateInstance.progress.set({
      total: run.migratableCount,
      ...progress,
      remaining: Math.max(0, Number(run.migratableCount || 0) - Number(progress.processed || 0)),
    })
  }
  if (run.backupIntegrity) {
    templateInstance.backupResult.set({ run, integrity: run.backupIntegrity })
    loadBackupExportPage(templateInstance, 1)
  }
  if (run.verification) {
    templateInstance.verification.set({ report: run.verification })
  }
  const status = getRunStatus(run)
  if (Number(run.applyStats?.conflicts || 0) > 0) {
    loadApplyConflicts(templateInstance, 1)
  }
  const isRestoreRun = run.pausedPhase === 'restore'
    || ['restore-ready', 'restoring', 'restored', 'restored-with-conflicts'].includes(status)
  if (isRestoreRun) {
    templateInstance.restoreRunId.set(getRunId(run))
    templateInstance.restoreRun.set(run)
    templateInstance.restoreProgress.set({
      total: run.applyStats?.applied,
      ...run.restoreStats,
      remaining: Math.max(
        0,
        Number(run.applyStats?.applied || 0) - Number(run.restoreStats?.processed || 0),
      ),
    })
    loadRestorePreview(templateInstance, 1)
  }
}

function loadHistory(templateInstance, page = templateInstance.historyPage.get()) {
  const requestId = ++templateInstance.historyRequestId
  templateInstance.historyLoading.set(true)
  callMigrationMethod('history', { page, pageSize: 20 }, (error, result) => {
    if (requestId !== templateInstance.historyRequestId || templateInstance.viewDestroyed) {
      return
    }
    templateInstance.historyLoading.set(false)
    if (error) {
      setError(templateInstance, error)
      return
    }
    templateInstance.history.set(result || { items: [] })
    templateInstance.historyPage.set(result?.page || page)
  })
}

function inspectRun(templateInstance, runId, restore = false) {
  if (templateInstance.applyLoopActive || templateInstance.restoreLoopActive) {
    return
  }
  if (!runId) {
    setError(templateInstance, new Error(t('timecard_migration.run_unavailable')))
    return
  }
  templateInstance.runSelectionRevision += 1
  templateInstance.previewCreationRequestId += 1
  templateInstance.previewCreationLoading.set(false)
  const requestId = ++templateInstance.inspectRequestId
  templateInstance.inspectLoading.set(true)
  templateInstance.error.set()
  callMigrationMethod('getRun', { runId }, (error, run) => {
    if (requestId !== templateInstance.inspectRequestId || templateInstance.viewDestroyed) {
      return
    }
    templateInstance.inspectLoading.set(false)
    if (error) {
      setError(templateInstance, error)
      return
    }
    if (getRunId(run) !== runId) {
      setError(templateInstance, new Error(t('timecard_migration.run_unavailable')))
      return
    }
    hydrateRun(templateInstance, run)
    if (restore) {
      const restorePreviewAlreadyLoading = templateInstance.restoreRunId.get() === runId
      templateInstance.restoreRunId.set(runId)
      templateInstance.restoreRun.set(run)
      templateInstance.restorePage.set(1)
      templateInstance.restoreConfirmation.set('')
      templateInstance.step.set(6)
      if (!restorePreviewAlreadyLoading) {
        loadRestorePreview(templateInstance, 1)
      }
      return
    }
    const step = stepForRun(run)
    templateInstance.step.set(step)
    if (step === 3) {
      loadPreview(templateInstance, 1)
    }
  })
}

function loadOptionPreview(templateInstance) {
  const args = optionPreviewArgs(templateInstance)
  if (!args) {
    templateInstance.optionPreview.set({ items: [] })
    templateInstance.optionPreviewLoading.set(false)
    templateInstance.optionPreviewError.set()
    return
  }
  const requestId = ++templateInstance.optionPreviewRequestId
  templateInstance.optionPreviewLoading.set(true)
  templateInstance.optionPreviewError.set()
  callMigrationMethod('optionPreview', args, (error, result) => {
    if (requestId !== templateInstance.optionPreviewRequestId
      || templateInstance.viewDestroyed) {
      return
    }
    templateInstance.optionPreviewLoading.set(false)
    if (error) {
      templateInstance.optionPreviewError.set(getErrorMessage(error))
      return
    }
    templateInstance.optionPreview.set(result || { items: [] })
  })
}

function scheduleOptionPreview(templateInstance) {
  if (templateInstance.optionPreviewTimer) {
    Meteor.clearTimeout(templateInstance.optionPreviewTimer)
  }
  templateInstance.optionPreviewRequestId += 1
  templateInstance.optionPreviewError.set()
  if (!optionPreviewArgs(templateInstance)) {
    templateInstance.optionPreview.set({ items: [] })
    templateInstance.optionPreviewLoading.set(false)
    return
  }
  templateInstance.optionPreviewLoading.set(true)
  templateInstance.optionPreviewTimer = Meteor.setTimeout(() => {
    templateInstance.optionPreviewTimer = null
    loadOptionPreview(templateInstance)
  }, OPTION_PREVIEW_DELAY_MS)
}

function loadPreview(templateInstance, page = templateInstance.previewPage.get()) {
  const runId = getRunId(templateInstance.run.get())
  if (!runId) {
    return
  }
  const requestId = ++templateInstance.previewRequestId
  templateInstance.previewLoading.set(true)
  const args = {
    runId,
    page,
    pageSize: DEFAULT_PAGE_SIZE,
    sortField: templateInstance.previewSortField.get(),
    sortDirection: templateInstance.previewSortDirection.get(),
  }
  const classification = templateInstance.classificationFilter.get()
  if (classification) {
    args.classification = classification
  }
  if (templateInstance.warningsOnly.get()) {
    args.warningsOnly = true
  }
  callMigrationMethod('previewPage', args, (error, result) => {
    if (getRunId(templateInstance.run.get()) !== runId
      || requestId !== templateInstance.previewRequestId
      || templateInstance.viewDestroyed) {
      return
    }
    templateInstance.previewLoading.set(false)
    if (error) {
      setError(templateInstance, error)
      return
    }
    applyRunResult(templateInstance, result)
    templateInstance.preview.set(result || { items: [] })
    templateInstance.previewPage.set(result?.page || page)
  })
}

function loadApplyConflicts(
  templateInstance,
  page = templateInstance.applyConflictPage.get(),
) {
  const runId = getRunId(templateInstance.run.get())
  if (!runId) {
    return
  }
  const requestId = ++templateInstance.applyConflictsRequestId
  templateInstance.applyConflictsLoading.set(true)
  callMigrationMethod('previewPage', {
    runId,
    page,
    pageSize: DEFAULT_PAGE_SIZE,
    status: 'conflict',
  }, (error, result) => {
    if (getRunId(templateInstance.run.get()) !== runId
      || requestId !== templateInstance.applyConflictsRequestId
      || templateInstance.viewDestroyed) {
      return
    }
    templateInstance.applyConflictsLoading.set(false)
    if (error) {
      setError(templateInstance, error)
      return
    }
    templateInstance.applyConflicts.set(result || { items: [] })
    templateInstance.applyConflictPage.set(result?.page || page)
  })
}

function loadRestorePreview(templateInstance, page = templateInstance.restorePage.get()) {
  const runId = templateInstance.restoreRunId.get()
  if (!runId) {
    return
  }
  const requestId = ++templateInstance.restorePreviewRequestId
  templateInstance.restoreLoading.set(true)
  callMigrationMethod('restorePreviewPage', {
    runId,
    page,
    pageSize: DEFAULT_PAGE_SIZE,
  }, (error, result) => {
    if (templateInstance.restoreRunId.get() !== runId
      || requestId !== templateInstance.restorePreviewRequestId
      || templateInstance.viewDestroyed) {
      return
    }
    templateInstance.restoreLoading.set(false)
    if (error) {
      setError(templateInstance, error)
      return
    }
    if (result?.run) {
      syncRestoreRun(templateInstance, result.run)
    }
    templateInstance.restorePreview.set(result || { items: [] })
    if (result?.summary) {
      templateInstance.restoreProgress.set(result.summary.progress || {
        total: result.summary.total,
        processed: result.summary.processed || result.summary.restored,
        restored: result.summary.restored,
        conflicts: result.summary.conflicts || result.summary.restoreConflicts,
        failed: result.summary.failed,
        remaining: result.summary.remaining,
      })
    }
    templateInstance.restorePage.set(result?.page || page)
  })
}

function downloadBackupPage(result) {
  const runId = getRunId(result?.run) || 'unknown-run'
  const payload = {
    format: 'titra-timecard-date-migration-backup-v1',
    exportedAt: new Date(),
    run: result?.run,
    page: result?.page,
    pageSize: result?.pageSize,
    total: result?.total,
    items: result?.items || [],
  }
  const contents = EJSON.stringify(payload, { canonical: true, indent: true })
  const blobUrl = URL.createObjectURL(new Blob([contents], { type: 'application/json' }))
  const link = document.createElement('a')
  link.href = blobUrl
  link.download = `titra-timecard-date-backup-${runId}-page-${result?.page || 1}.ejson`
  document.body.appendChild(link)
  link.click()
  link.remove()
  Meteor.setTimeout(() => URL.revokeObjectURL(blobUrl), 1000)
}

function loadBackupExportPage(
  templateInstance,
  page = templateInstance.backupExportPage.get(),
  download = false,
) {
  const runId = getRunId(templateInstance.run.get())
  if (!runId) {
    return
  }
  const requestId = ++templateInstance.backupExportRequestId
  templateInstance.backupExportLoading.set(true)
  callMigrationMethod('exportBackupPage', { runId, page, pageSize: 100 }, (error, result) => {
    if (getRunId(templateInstance.run.get()) !== runId
      || requestId !== templateInstance.backupExportRequestId
      || templateInstance.viewDestroyed) {
      return
    }
    templateInstance.backupExportLoading.set(false)
    if (error) {
      setError(templateInstance, error)
      return
    }
    templateInstance.backupExport.set(result || { items: [] })
    templateInstance.backupExportPage.set(result?.page || page)
    if (download) {
      downloadBackupPage(result)
    }
  })
}

function isBatchDone(result) {
  if (typeof result?.done === 'boolean') {
    return result.done
  }
  if (Number(result?.progress?.remaining) === 0) {
    return true
  }
  return [
    'applied', 'applied-with-conflicts', 'completed', 'verified', 'restored',
    'restored-with-conflicts',
  ].includes(getRunStatus(result?.run))
}

function runApplyBatch(templateInstance, pinnedRunId = getRunId(templateInstance.run.get())) {
  if (!templateInstance.applyLoopActive
    || templateInstance.viewDestroyed
    || !pinnedRunId
    || getRunId(templateInstance.run.get()) !== pinnedRunId) {
    templateInstance.applyLoopActive = false
    templateInstance.batchLoading.set(false)
    return
  }
  templateInstance.batchLoading.set(true)
  callMigrationMethod('applyBatch', {
    runId: pinnedRunId,
    batchSize: DEFAULT_BATCH_SIZE,
  }, (error, result) => {
    if (templateInstance.viewDestroyed
      || getRunId(templateInstance.run.get()) !== pinnedRunId) {
      templateInstance.applyLoopActive = false
      templateInstance.batchLoading.set(false)
      requestPause(pinnedRunId)
      return
    }
    if (error) {
      templateInstance.applyLoopActive = false
      templateInstance.batchLoading.set(false)
      refreshRunAfterBatchError(templateInstance, pinnedRunId, error)
      return
    }
    applyRunResult(templateInstance, result)
    if (isBatchDone(result)) {
      templateInstance.applyLoopActive = false
      templateInstance.batchLoading.set(false)
      templateInstance.step.set(6)
      loadApplyConflicts(templateInstance, 1)
      refreshTimecardMigrationSummary()
      loadHistory(templateInstance)
      showToast(t('timecard_migration.apply_complete'))
      return
    }
    Meteor.setTimeout(() => runApplyBatch(templateInstance, pinnedRunId), 100)
  })
}

function runRestoreBatch(
  templateInstance,
  pinnedRunId = templateInstance.restoreRunId.get(),
) {
  if (!templateInstance.restoreLoopActive
    || templateInstance.viewDestroyed
    || !pinnedRunId
    || templateInstance.restoreRunId.get() !== pinnedRunId) {
    templateInstance.restoreLoopActive = false
    templateInstance.restoreLoading.set(false)
    templateInstance.restoreBatchLoading.set(false)
    return
  }
  templateInstance.restoreLoading.set(true)
  templateInstance.restoreBatchLoading.set(true)
  callMigrationMethod('restoreBatch', {
    runId: pinnedRunId,
    batchSize: DEFAULT_BATCH_SIZE,
  }, (error, result) => {
    if (templateInstance.viewDestroyed
      || templateInstance.restoreRunId.get() !== pinnedRunId) {
      templateInstance.restoreLoopActive = false
      templateInstance.restoreLoading.set(false)
      templateInstance.restoreBatchLoading.set(false)
      requestPause(pinnedRunId)
      return
    }
    if (error) {
      templateInstance.restoreLoopActive = false
      templateInstance.restoreLoading.set(false)
      templateInstance.restoreBatchLoading.set(false)
      refreshRunAfterBatchError(templateInstance, pinnedRunId, error)
      return
    }
    if (result?.run) {
      syncRestoreRun(templateInstance, result.run)
    }
    templateInstance.restoreProgress.set(result?.progress || result?.run?.progress || {})
    if (isBatchDone(result)) {
      templateInstance.restoreLoopActive = false
      templateInstance.restoreLoading.set(false)
      templateInstance.restoreBatchLoading.set(false)
      templateInstance.restoreConfirmation.set('')
      loadRestorePreview(templateInstance)
      loadHistory(templateInstance)
      refreshTimecardMigrationSummary()
      showToast(t('timecard_migration.restore_complete'))
      return
    }
    Meteor.setTimeout(() => runRestoreBatch(templateInstance, pinnedRunId), 100)
  })
}

function formatProposed(value) {
  const proposed = value?.proposed || value
  if (!proposed?.dateOnly) {
    return '—'
  }
  return `${proposed.dateOnly}${proposed.startTime ? ` ${proposed.startTime}` : ''}`
}

function formatTimecardDateFields(value) {
  if (!value) {
    return '—'
  }
  const timecard = value.original || value.timecard || value
  if (timecard.dateOnly) {
    return `${timecard.dateOnly}${timecard.startTime ? ` ${timecard.startTime}` : ''}`
  }
  const rawDate = timecard.date || timecard.rawDateIso || timecard.iso
  if (!rawDate) {
    return '—'
  }
  const parsedDate = rawDate instanceof Date ? rawDate : new Date(rawDate)
  return Number.isNaN(parsedDate.getTime()) ? String(rawDate) : parsedDate.toISOString()
}

function formatCodes(codes) {
  if (!codes) {
    return '—'
  }
  const list = Array.isArray(codes) ? codes : [codes]
  return list.length
    ? list.map((code) => String(code).replaceAll('-', ' ').replaceAll('_', ' ')).join(', ')
    : '—'
}

function getProgress(templateInstance, restore = false) {
  const direct = restore ? templateInstance.restoreProgress.get() : templateInstance.progress.get()
  const run = restore ? templateInstance.restoreRun.get() : templateInstance.run.get()
  return direct || run?.progress || {}
}

function getProgressPercentage(progress) {
  const total = Number(progress?.total || 0)
  const processed = Number(progress?.processed || progress?.restored || 0)
  return total ? Math.min(100, Math.round((processed / total) * 100)) : 0
}

Template.timecardmigrationcomponent.onCreated(function timecardmigrationcomponentCreated() {
  this.step = new ReactiveVar(1)
  this.loading = new ReactiveVar(true)
  this.error = new ReactiveVar()
  this.scan = new ReactiveVar()
  this.scanRequestId = 0
  this.runSelectionRevision = 0
  this.run = new ReactiveVar()
  this.mode = new ReactiveVar('')
  this.timeZone = new ReactiveVar('')
  this.startTimePolicy = new ReactiveVar('extract')
  this.optionPreview = new ReactiveVar({ items: [] })
  this.optionPreviewLoading = new ReactiveVar(false)
  this.optionPreviewError = new ReactiveVar()
  this.optionPreviewRequestId = 0
  this.optionPreviewTimer = null
  this.preview = new ReactiveVar({ items: [] })
  this.previewCreationLoading = new ReactiveVar(false)
  this.previewCreationRequestId = 0
  this.previewPage = new ReactiveVar(1)
  this.previewLoading = new ReactiveVar(false)
  this.previewSortField = new ReactiveVar('date')
  this.previewSortDirection = new ReactiveVar('desc')
  this.previewRequestId = 0
  this.applyConflicts = new ReactiveVar({ items: [] })
  this.applyConflictPage = new ReactiveVar(1)
  this.applyConflictsLoading = new ReactiveVar(false)
  this.applyConflictsRequestId = 0
  this.classificationFilter = new ReactiveVar('')
  this.warningsOnly = new ReactiveVar(false)
  this.backupResult = new ReactiveVar()
  this.backupLoading = new ReactiveVar(false)
  this.backupExport = new ReactiveVar({ items: [] })
  this.backupExportPage = new ReactiveVar(1)
  this.backupExportLoading = new ReactiveVar(false)
  this.backupExportRequestId = 0
  this.applyConfirmation = new ReactiveVar('')
  this.progress = new ReactiveVar({})
  this.batchLoading = new ReactiveVar(false)
  this.verification = new ReactiveVar()
  this.verifyLoading = new ReactiveVar(false)
  this.history = new ReactiveVar({ items: [] })
  this.historyPage = new ReactiveVar(1)
  this.historyLoading = new ReactiveVar(false)
  this.historyRequestId = 0
  this.inspectLoading = new ReactiveVar(false)
  this.inspectRequestId = 0
  this.restoreRunId = new ReactiveVar()
  this.restoreRun = new ReactiveVar()
  this.restorePreview = new ReactiveVar({ items: [] })
  this.restorePage = new ReactiveVar(1)
  this.restoreLoading = new ReactiveVar(false)
  this.restorePreviewRequestId = 0
  this.restoreBatchLoading = new ReactiveVar(false)
  this.restoreConfirmation = new ReactiveVar('')
  this.restoreProgress = new ReactiveVar({})
  this.applyLoopActive = false
  this.restoreLoopActive = false
  this.viewDestroyed = false

  const scanRequestId = ++this.scanRequestId
  const { runSelectionRevision } = this
  refreshTimecardMigrationSummary((error, result) => {
    if (scanRequestId !== this.scanRequestId || this.viewDestroyed) {
      return
    }
    this.loading.set(false)
    if (error) {
      setError(this, error)
      return
    }
    this.scan.set(result || {})
    if (runSelectionRevision === this.runSelectionRevision) {
      hydrateRun(this, result?.activeRun)
      if (result?.activeRun && stepForRun(result.activeRun) >= 3) {
        loadPreview(this)
      }
    }
  })
  loadHistory(this)
})

Template.timecardmigrationcomponent.onDestroyed(function timecardmigrationcomponentDestroyed() {
  if (this.applyLoopActive) {
    requestPause(getRunId(this.run.get()))
  }
  if (this.restoreLoopActive) {
    requestPause(this.restoreRunId.get())
  }
  this.viewDestroyed = true
  if (this.optionPreviewTimer) {
    Meteor.clearTimeout(this.optionPreviewTimer)
  }
  this.optionPreviewRequestId += 1
  this.scanRequestId += 1
  this.runSelectionRevision += 1
  this.previewCreationRequestId += 1
  this.previewRequestId += 1
  this.backupExportRequestId += 1
  this.historyRequestId += 1
  this.inspectRequestId += 1
  this.applyConflictsRequestId += 1
  this.restorePreviewRequestId += 1
  this.applyLoopActive = false
  this.restoreLoopActive = false
})

Template.timecardmigrationcomponent.helpers({
  isStep: (step) => Template.instance().step.get() === Number(step),
  stepClass(step) {
    const currentStep = Template.instance().step.get()
    if (Number(step) < currentStep) {
      return 'text-bg-success'
    }
    return Number(step) === currentStep ? 'text-bg-primary' : 'text-bg-secondary'
  },
  loading: () => Template.instance().loading.get(),
  error: () => Template.instance().error.get(),
  scan: () => Template.instance().scan.get(),
  scanCount: (name) => getCount(Template.instance().scan.get(), name),
  legacyCount: () => getLegacyCount(Template.instance().scan.get()),
  candidateCount: () => getCandidateCount(Template.instance().scan.get()),
  legacyDetected() {
    const scan = Template.instance().scan.get()
    return Boolean(scan?.legacyDetected || getCandidateCount(scan) > 0)
  },
  quarantinedDetected: () => getCount(Template.instance().scan.get(), 'invalid') > 0,
  modeIs: (mode) => Template.instance().mode.get() === mode,
  modeCheckedAttributes(mode) {
    return Template.instance().mode.get() === mode ? { checked: true } : {}
  },
  selectedModeClass(mode) {
    return Template.instance().mode.get() === mode ? 'table-primary' : ''
  },
  previewOptionsReady() {
    const templateInstance = Template.instance()
    return Boolean(templateInstance.mode.get() && isValidTimeZone(templateInstance.timeZone.get()))
  },
  previewCreationLoading: () => Template.instance().previewCreationLoading.get(),
  startTimePolicyDisabled() {
    const templateInstance = Template.instance()
    return templateInstance.mode.get() === 'date-only'
      || templateInstance.previewCreationLoading.get()
  },
  optionPreviewItems: () => Template.instance().optionPreview.get()?.items || [],
  optionPreviewLoading: () => Template.instance().optionPreviewLoading.get(),
  optionPreviewError: () => Template.instance().optionPreviewError.get(),
  selectedMode: () => getModeLabel(Template.instance().mode.get()),
  timeZone: () => Template.instance().timeZone.get(),
  startTimePolicyIs: (policy) => Template.instance().startTimePolicy.get() === policy,
  startTimePolicySelectedAttributes(policy) {
    return Template.instance().startTimePolicy.get() === policy ? { selected: true } : {}
  },
  checkedIf: (condition) => (condition ? { checked: true } : {}),
  disabledIf: (condition) => (condition ? { disabled: true } : {}),
  disabledUnless: (condition) => (condition ? {} : { disabled: true }),
  commonTimeZones() {
    try {
      const supportedTimeZones = Intl.supportedValuesOf?.('timeZone') || []
      return [...new Set([...COMMON_TIME_ZONES, ...supportedTimeZones])].sort()
    } catch {
      return COMMON_TIME_ZONES
    }
  },
  runId: () => getRunId(Template.instance().run.get()),
  runStatus: () => getRunStatus(Template.instance().run.get()) || '—',
  runStatusClass: () => getStatusClass(Template.instance().run.get()),
  runCanPrepare() {
    return ['preview', 'ready', 'backup-invalid'].includes(
      getRunStatus(Template.instance().run.get()),
    )
  },
  previewItems: () => Template.instance().preview.get()?.items || [],
  previewLoading: () => Template.instance().previewLoading.get(),
  previewPage: () => Template.instance().previewPage.get(),
  previewTotal: () => Template.instance().preview.get()?.total || 0,
  previewHasPrevious() {
    const templateInstance = Template.instance()
    return hasPreviousPage(
      templateInstance.previewPage.get(),
      templateInstance.previewLoading.get(),
    )
  },
  previewHasNext() {
    const templateInstance = Template.instance()
    const preview = templateInstance.preview.get() || {}
    return hasNextPage({
      page: preview.page,
      pageSize: preview.pageSize || DEFAULT_PAGE_SIZE,
      total: preview.total,
      loading: templateInstance.previewLoading.get(),
    })
  },
  previewSortIndicator(field) {
    const templateInstance = Template.instance()
    if (templateInstance.previewSortField.get() !== field) {
      return '↕'
    }
    return templateInstance.previewSortDirection.get() === 'asc' ? '▲' : '▼'
  },
  previewAriaSort(field) {
    const templateInstance = Template.instance()
    if (templateInstance.previewSortField.get() !== field) {
      return 'none'
    }
    return templateInstance.previewSortDirection.get() === 'asc'
      ? 'ascending'
      : 'descending'
  },
  hasApplyConflicts() {
    const templateInstance = Template.instance()
    return Number(getProgress(templateInstance)?.conflicts || 0) > 0
      || Number(templateInstance.applyConflicts.get()?.total || 0) > 0
  },
  applyConflictItems: () => Template.instance().applyConflicts.get()?.items || [],
  applyConflictsLoading: () => Template.instance().applyConflictsLoading.get(),
  applyConflictPage: () => Template.instance().applyConflictPage.get(),
  applyConflictTotal: () => Template.instance().applyConflicts.get()?.total || 0,
  applyConflictHasPrevious: () => Template.instance().applyConflictPage.get() > 1,
  applyConflictHasNext() {
    const conflicts = Template.instance().applyConflicts.get() || {}
    return (conflicts.page || 1) * (conflicts.pageSize || DEFAULT_PAGE_SIZE)
      < (conflicts.total || 0)
  },
  applyConflictError: (item) => item?.applyError || t('timecard_migration.conflict'),
  warningsOnly: () => Template.instance().warningsOnly.get(),
  classificationFilter: () => Template.instance().classificationFilter.get(),
  classificationFilterSelectedAttributes(classification) {
    return Template.instance().classificationFilter.get() === classification
      ? { selected: true }
      : {}
  },
  rawDate(item) {
    return item?.rawDateIso || item?.source?.iso || item?.source?.date || '—'
  },
  currentDisplay(item) {
    if (item?.currentDisplay) {
      return item.currentDisplay
    }
    const rawDate = item?.rawDateIso || item?.source?.iso
    if (!rawDate) {
      return '—'
    }
    const utcDateOnly = item?.source?.utcDateOnly || new Date(rawDate).toISOString().slice(0, 10)
    return `${utcDateOnly} ${dayjs(rawDate).format('HH:mm')}`
  },
  legacyDisplayInZone(item) {
    return formatProposed(item?.alternatives?.legacyDisplayInZone)
  },
  utcWallClock(item) {
    return formatProposed(item?.alternatives?.utcWallClock)
  },
  instantInZone(item) {
    return formatProposed(item?.alternatives?.instantInZone)
  },
  dateOnlyAlternative(item) {
    return formatProposed(item?.alternatives?.dateOnly)
  },
  selectedProposal: (item) => formatProposed(item?.proposed),
  itemWarnings(item) {
    const warnings = [...(item?.warnings || []), ...(item?.reasons || [])]
    if (item?.changedSinceSnapshot) {
      warnings.push(t('timecard_migration.changed_since_snapshot'))
    }
    return formatCodes(warnings)
  },
  itemClassification: (item) => item?.classification || '—',
  itemDayShift(item) {
    const shift = item?.dayShift
    return Number.isFinite(Number(shift)) ? `${Number(shift) > 0 ? '+' : ''}${shift}` : '—'
  },
  hasItemWarnings: (item) => Boolean(
    item?.warnings?.length
      || item?.reasons?.length
      || item?.conflict
      || item?.changedSinceSnapshot,
  ),
  itemWarningClass(item) {
    return item?.warnings?.length
      || item?.reasons?.length
      || item?.conflict
      || item?.changedSinceSnapshot
      ? 'table-warning'
      : ''
  },
  backupResult: () => Template.instance().backupResult.get(),
  backupLoading: () => Template.instance().backupLoading.get(),
  backupReady() {
    const result = Template.instance().backupResult.get()
    return Boolean(result && (result.integrity?.ok === true || result.integrity?.valid === true))
  },
  backupExportLoading: () => Template.instance().backupExportLoading.get(),
  backupExportItems: () => Template.instance().backupExport.get()?.items || [],
  backupExportPage: () => Template.instance().backupExportPage.get(),
  backupExportTotal: () => Template.instance().backupExport.get()?.total || 0,
  backupExportTotalPages() {
    const total = Number(Template.instance().backupExport.get()?.total || 0)
    return pageCount(total, 100)
  },
  backupExportHasPrevious() {
    const templateInstance = Template.instance()
    return hasPreviousPage(
      templateInstance.backupExportPage.get(),
      templateInstance.backupExportLoading.get(),
    )
  },
  backupExportHasNext() {
    const templateInstance = Template.instance()
    const backup = templateInstance.backupExport.get() || {}
    return hasNextPage({
      page: backup.page,
      pageSize: backup.pageSize || 100,
      total: backup.total,
      loading: templateInstance.backupExportLoading.get(),
    })
  },
  backupOriginal: (item) => formatTimecardDateFields(item?.original),
  backupFrozenAt(item) {
    return item?.frozenAt ? dayjs(item.frozenAt).format('YYYY-MM-DD HH:mm:ss') : '—'
  },
  backupCount() {
    const result = Template.instance().backupResult.get() || {}
    return result.integrity?.backupCount
      || result.integrity?.count
      || result.run?.backupCount
      || '—'
  },
  backupChecksum() {
    const result = Template.instance().backupResult.get() || {}
    return result.run?.snapshotDigest
      || result.integrity?.snapshotDigest
      || result.integrity?.checksum
      || '—'
  },
  backupIntegrity() {
    const result = Template.instance().backupResult.get() || {}
    const integrity = result.integrity || result
    return integrity.ok === false || integrity.valid === false
      ? t('timecard_migration.failed')
      : t('timecard_migration.passed')
  },
  applyConfirmation: () => Template.instance().applyConfirmation.get(),
  applyConfirmationMatches: () => Template.instance().applyConfirmation.get() === 'MIGRATE',
  batchLoading: () => Template.instance().batchLoading.get(),
  batchProgressClass() {
    return Template.instance().batchLoading.get() ? 'progress-bar-animated' : ''
  },
  isPaused: () => getRunStatus(Template.instance().run.get()) === 'paused',
  canCancelPausedApply() {
    const templateInstance = Template.instance()
    const run = templateInstance.run.get()
    return getRunStatus(run) === 'paused'
      && run?.pausedPhase !== 'restore'
      && Number(getProgress(templateInstance)?.applied || 0) === 0
  },
  applyComplete() {
    const status = getRunStatus(Template.instance().run.get())
    return ['applied', 'applied-with-conflicts', 'completed', 'verified'].includes(status)
  },
  canRunVerification() {
    const status = getRunStatus(Template.instance().run.get())
    return [
      'applied', 'applied-with-conflicts', 'completed', 'verified',
      'restored', 'restored-with-conflicts',
    ].includes(status)
  },
  progress: () => getProgress(Template.instance()),
  progressPercentage: () => getProgressPercentage(getProgress(Template.instance())),
  verifyLoading: () => Template.instance().verifyLoading.get(),
  verification: () => Template.instance().verification.get(),
  verificationReport() {
    const result = Template.instance().verification.get()
    return result ? JSON.stringify(result.report || result, null, 2) : ''
  },
  verificationPassed() {
    const result = Template.instance().verification.get()
    return Boolean((result?.report || result)?.ok)
  },
  historyItems: () => Template.instance().history.get()?.items || [],
  historyLoading: () => Template.instance().historyLoading.get(),
  historyPage: () => Template.instance().historyPage.get(),
  historyHasPrevious: () => Template.instance().historyPage.get() > 1,
  historyHasNext() {
    const history = Template.instance().history.get() || {}
    return (history.page || 1) * (history.pageSize || 20) < (history.total || 0)
  },
  historyRunId: (run) => getRunId(run),
  historyStatus: (run) => getRunStatus(run) || '—',
  historyStatusClass: (run) => getStatusClass(run),
  historyMode: (run) => getModeLabel(getRunConfig(run).mode),
  historyTimeZone: (run) => getRunConfig(run).timeZone || '—',
  historyDate(run) {
    const date = run?.createdAt || run?.startedAt || run?.updatedAt
    return date ? dayjs(date).format('YYYY-MM-DD HH:mm') : '—'
  },
  inspectLoading: () => Template.instance().inspectLoading.get(),
  historyActionsDisabled() {
    const templateInstance = Template.instance()
    return templateInstance.inspectLoading.get()
      || templateInstance.previewCreationLoading.get()
      || templateInstance.batchLoading.get()
      || templateInstance.restoreBatchLoading.get()
  },
  canRestore(run) {
    const status = getRunStatus(run)
    return ['applied', 'applied-with-conflicts', 'completed', 'verified'].includes(status)
  },
  restoreRunId: () => Template.instance().restoreRunId.get(),
  isRestorePaused: () => getRunStatus(Template.instance().restoreRun.get()) === 'paused',
  restoreItems: () => Template.instance().restorePreview.get()?.items || [],
  restoreSummary() {
    const result = Template.instance().restorePreview.get()
    return result?.summary ? JSON.stringify(result.summary, null, 2) : ''
  },
  restoreLoading: () => Template.instance().restoreLoading.get(),
  restoreBatchLoading: () => Template.instance().restoreBatchLoading.get(),
  restorePage: () => Template.instance().restorePage.get(),
  restoreHasPrevious() {
    const templateInstance = Template.instance()
    return hasPreviousPage(
      templateInstance.restorePage.get(),
      templateInstance.restoreLoading.get(),
    )
  },
  restoreHasNext() {
    const templateInstance = Template.instance()
    const preview = templateInstance.restorePreview.get() || {}
    return hasNextPage({
      page: preview.page,
      pageSize: preview.pageSize || DEFAULT_PAGE_SIZE,
      total: preview.total,
      loading: templateInstance.restoreLoading.get(),
    })
  },
  restoreConfirmation: () => Template.instance().restoreConfirmation.get(),
  restoreTerminal() {
    return ['restored', 'restored-with-conflicts'].includes(
      getRunStatus(Template.instance().restoreRun.get()),
    )
  },
  restoreRunStatus: () => getRunStatus(Template.instance().restoreRun.get()) || '—',
  restoreCanStart() {
    const templateInstance = Template.instance()
    const status = getRunStatus(templateInstance.restoreRun.get())
    return templateInstance.restoreConfirmation.get() === 'RESTORE'
      && !templateInstance.restoreLoading.get()
      && !templateInstance.restoreBatchLoading.get()
      && !['restored', 'restored-with-conflicts'].includes(status)
  },
  restoreOriginal(item) {
    return formatTimecardDateFields(item?.original || item?.backup || item?.before)
  },
  restoreMigrated(item) {
    return formatTimecardDateFields(item?.migrated || item?.afterMigration || item?.proposed)
  },
  restoreCurrent(item) {
    return formatTimecardDateFields(item?.current || item?.currentTimecard)
  },
  restoreConflict(item) {
    if (item?.conflict || item?.status === 'conflict') {
      return item?.conflict?.reason || item?.conflictReason || t('timecard_migration.conflict')
    }
    return '—'
  },
  restoreProgress: () => getProgress(Template.instance(), true),
  restoreProgressPercentage: () => getProgressPercentage(getProgress(Template.instance(), true)),
})

Template.timecardmigrationcomponent.events({
  'click .js-rescan': (event, templateInstance) => {
    event.preventDefault()
    templateInstance.inspectRequestId += 1
    templateInstance.inspectLoading.set(false)
    templateInstance.previewCreationRequestId += 1
    templateInstance.previewCreationLoading.set(false)
    templateInstance.runSelectionRevision += 1
    const scanRequestId = ++templateInstance.scanRequestId
    const { runSelectionRevision } = templateInstance
    templateInstance.loading.set(true)
    templateInstance.error.set()
    refreshTimecardMigrationSummary((error, result) => {
      if (scanRequestId !== templateInstance.scanRequestId
        || templateInstance.viewDestroyed) {
        return
      }
      templateInstance.loading.set(false)
      if (error) {
        setError(templateInstance, error)
        return
      }
      templateInstance.scan.set(result || {})
      if (runSelectionRevision === templateInstance.runSelectionRevision) {
        hydrateRun(templateInstance, result?.activeRun)
      }
    })
  },
  'click .js-go-to-options': (event, templateInstance) => {
    event.preventDefault()
    templateInstance.step.set(2)
    scheduleOptionPreview(templateInstance)
  },
  'click .js-back-to-scan': (event, templateInstance) => {
    event.preventDefault()
    templateInstance.step.set(1)
  },
  'change input[name="migrationMode"]': (event, templateInstance) => {
    if (templateInstance.previewCreationLoading.get()) {
      return
    }
    templateInstance.mode.set(event.currentTarget.value)
    if (event.currentTarget.value === 'date-only') {
      templateInstance.startTimePolicy.set('omit')
    }
    scheduleOptionPreview(templateInstance)
  },
  'input .js-time-zone': (event, templateInstance) => {
    if (templateInstance.previewCreationLoading.get()) {
      return
    }
    templateInstance.timeZone.set(event.currentTarget.value.trim())
    scheduleOptionPreview(templateInstance)
  },
  'change .js-start-time-policy': (event, templateInstance) => {
    if (templateInstance.previewCreationLoading.get()) {
      return
    }
    templateInstance.startTimePolicy.set(event.currentTarget.value)
    scheduleOptionPreview(templateInstance)
  },
  'click .js-create-preview': (event, templateInstance) => {
    event.preventDefault()
    if (templateInstance.previewCreationLoading.get()) {
      return
    }
    const mode = templateInstance.mode.get()
    const timeZone = templateInstance.timeZone.get()
    if (!mode) {
      setError(templateInstance, new Error(t('timecard_migration.choose_method_required')))
      return
    }
    if (!timeZone) {
      setError(templateInstance, new Error(t('timecard_migration.time_zone_required')))
      return
    }
    templateInstance.error.set()
    templateInstance.runSelectionRevision += 1
    templateInstance.inspectRequestId += 1
    templateInstance.inspectLoading.set(false)
    const requestId = ++templateInstance.previewCreationRequestId
    templateInstance.previewCreationLoading.set(true)
    const selectedRunId = getRunId(templateInstance.run.get())
    callMigrationMethod('createPreviewRun', {
      mode,
      ...(timeZone ? { timeZone } : {}),
      startTimePolicy: mode === 'date-only' ? 'omit' : templateInstance.startTimePolicy.get(),
    }, (error, result) => {
      if (requestId !== templateInstance.previewCreationRequestId
        || templateInstance.viewDestroyed) {
        return
      }
      templateInstance.previewCreationLoading.set(false)
      if (getRunId(templateInstance.run.get()) !== selectedRunId) {
        return
      }
      if (error) {
        setError(templateInstance, error)
        return
      }
      hydrateRun(templateInstance, result)
      templateInstance.step.set(3)
      templateInstance.previewPage.set(1)
      loadPreview(templateInstance, 1)
      loadHistory(templateInstance)
    })
  },
  'click .js-preview-sort': (event, templateInstance) => {
    event.preventDefault()
    if (templateInstance.previewLoading.get()) {
      return
    }
    const field = event.currentTarget.dataset.sortField
    if (!field) {
      return
    }
    const currentField = templateInstance.previewSortField.get()
    const currentDirection = templateInstance.previewSortDirection.get()
    let nextDirection = LATEST_FIRST_SORT_FIELDS.has(field) ? 'desc' : 'asc'
    if (currentField === field) {
      nextDirection = currentDirection === 'asc' ? 'desc' : 'asc'
    }
    templateInstance.previewSortField.set(field)
    templateInstance.previewSortDirection.set(nextDirection)
    templateInstance.previewPage.set(1)
    loadPreview(templateInstance, 1)
  },
  'click .js-preview-previous': (event, templateInstance) => {
    event.preventDefault()
    loadPreview(templateInstance, Math.max(1, templateInstance.previewPage.get() - 1))
  },
  'click .js-preview-next': (event, templateInstance) => {
    event.preventDefault()
    loadPreview(templateInstance, templateInstance.previewPage.get() + 1)
  },
  'change .js-warning-filter': (event, templateInstance) => {
    templateInstance.warningsOnly.set(event.currentTarget.checked)
    loadPreview(templateInstance, 1)
  },
  'change .js-classification-filter': (event, templateInstance) => {
    templateInstance.classificationFilter.set(event.currentTarget.value)
    loadPreview(templateInstance, 1)
  },
  'click .js-go-to-backup': (event, templateInstance) => {
    event.preventDefault()
    templateInstance.step.set(4)
  },
  'click .js-go-to-preview': (event, templateInstance) => {
    event.preventDefault()
    templateInstance.step.set(3)
    loadPreview(templateInstance)
  },
  'click .js-cancel-preview': (event, templateInstance) => {
    event.preventDefault()
    // eslint-disable-next-line no-alert
    if (!window.confirm(t('timecard_migration.cancel_run_confirmation'))) {
      return
    }
    const runId = getRunId(templateInstance.run.get())
    callMigrationMethod('cancel', { runId }, (error) => {
      if (getRunId(templateInstance.run.get()) !== runId || templateInstance.viewDestroyed) {
        return
      }
      if (error) {
        setError(templateInstance, error)
        return
      }
      templateInstance.run.set()
      templateInstance.preview.set({ items: [] })
      templateInstance.backupResult.set()
      templateInstance.backupExport.set({ items: [] })
      templateInstance.progress.set({})
      templateInstance.applyConflicts.set({ items: [] })
      templateInstance.applyConfirmation.set('')
      templateInstance.step.set(2)
      scheduleOptionPreview(templateInstance)
      loadHistory(templateInstance)
    })
  },
  'click .js-prepare-backup': (event, templateInstance) => {
    event.preventDefault()
    const runId = getRunId(templateInstance.run.get())
    templateInstance.backupLoading.set(true)
    templateInstance.error.set()
    callMigrationMethod('prepareBackup', { runId }, (prepareError, prepareResult) => {
      if (getRunId(templateInstance.run.get()) !== runId || templateInstance.viewDestroyed) {
        return
      }
      if (prepareError) {
        templateInstance.backupLoading.set(false)
        setError(templateInstance, prepareError)
        return
      }
      applyRunResult(templateInstance, prepareResult)
      callMigrationMethod('verifyBackup', { runId }, (verifyError, integrity) => {
        if (getRunId(templateInstance.run.get()) !== runId || templateInstance.viewDestroyed) {
          return
        }
        templateInstance.backupLoading.set(false)
        if (verifyError) {
          setError(templateInstance, verifyError)
          return
        }
        templateInstance.backupResult.set({
          ...prepareResult,
          integrity: integrity?.integrity || integrity,
        })
        loadBackupExportPage(templateInstance, 1)
        if (integrity?.ok === true || integrity?.valid === true) {
          showToast(t('timecard_migration.backup_verified'))
        } else {
          setError(templateInstance, new Error(t('timecard_migration.backup_failed')))
        }
      })
    })
  },
  'click .js-backup-export-previous': (event, templateInstance) => {
    event.preventDefault()
    loadBackupExportPage(templateInstance, Math.max(1, templateInstance.backupExportPage.get() - 1))
  },
  'click .js-backup-export-next': (event, templateInstance) => {
    event.preventDefault()
    loadBackupExportPage(templateInstance, templateInstance.backupExportPage.get() + 1)
  },
  'click .js-download-backup-page': (event, templateInstance) => {
    event.preventDefault()
    loadBackupExportPage(templateInstance, templateInstance.backupExportPage.get(), true)
  },
  'click .js-go-to-apply': (event, templateInstance) => {
    event.preventDefault()
    templateInstance.step.set(5)
  },
  'input .js-apply-confirmation': (event, templateInstance) => {
    templateInstance.applyConfirmation.set(event.currentTarget.value)
  },
  'click .js-start-apply': (event, templateInstance) => {
    event.preventDefault()
    if (templateInstance.applyConfirmation.get() !== 'MIGRATE') {
      return
    }
    templateInstance.error.set()
    templateInstance.applyLoopActive = true
    runApplyBatch(templateInstance, getRunId(templateInstance.run.get()))
  },
  'click .js-pause-apply': (event, templateInstance) => {
    event.preventDefault()
    templateInstance.applyLoopActive = false
    const runId = getRunId(templateInstance.run.get())
    callMigrationMethod('pause', { runId }, (error, result) => {
      if (getRunId(templateInstance.run.get()) !== runId || templateInstance.viewDestroyed) {
        return
      }
      templateInstance.batchLoading.set(false)
      if (error) {
        setError(templateInstance, error)
        return
      }
      applyRunResult(templateInstance, result)
    })
  },
  'click .js-resume-apply': (event, templateInstance) => {
    event.preventDefault()
    const runId = getRunId(templateInstance.run.get())
    callMigrationMethod('resume', { runId }, (error, result) => {
      if (getRunId(templateInstance.run.get()) !== runId || templateInstance.viewDestroyed) {
        return
      }
      if (error) {
        setError(templateInstance, error)
        return
      }
      applyRunResult(templateInstance, result)
      templateInstance.applyLoopActive = true
      runApplyBatch(templateInstance, runId)
    })
  },
  'click .js-go-to-verify': (event, templateInstance) => {
    event.preventDefault()
    templateInstance.step.set(6)
  },
  'click .js-verify': (event, templateInstance) => {
    event.preventDefault()
    templateInstance.verifyLoading.set(true)
    const runId = getRunId(templateInstance.run.get())
    callMigrationMethod('verify', { runId }, (error, result) => {
      if (getRunId(templateInstance.run.get()) !== runId || templateInstance.viewDestroyed) {
        return
      }
      templateInstance.verifyLoading.set(false)
      if (error) {
        setError(templateInstance, error)
        return
      }
      const run = applyRunResult(templateInstance, result)
      templateInstance.verification.set(result)
      templateInstance.step.set(Math.max(6, stepForRun(run)))
      loadApplyConflicts(templateInstance, 1)
      loadHistory(templateInstance)
      refreshTimecardMigrationSummary()
    })
  },
  'click .js-history-previous': (event, templateInstance) => {
    event.preventDefault()
    loadHistory(templateInstance, Math.max(1, templateInstance.historyPage.get() - 1))
  },
  'click .js-history-next': (event, templateInstance) => {
    event.preventDefault()
    loadHistory(templateInstance, templateInstance.historyPage.get() + 1)
  },
  'click .js-inspect-run': (event, templateInstance) => {
    event.preventDefault()
    inspectRun(templateInstance, event.currentTarget.dataset.runId)
  },
  'click .js-preview-restore': (event, templateInstance) => {
    event.preventDefault()
    inspectRun(templateInstance, event.currentTarget.dataset.runId, true)
  },
  'click .js-restore-previous': (event, templateInstance) => {
    event.preventDefault()
    loadRestorePreview(templateInstance, Math.max(1, templateInstance.restorePage.get() - 1))
  },
  'click .js-apply-conflicts-previous': (event, templateInstance) => {
    event.preventDefault()
    loadApplyConflicts(
      templateInstance,
      Math.max(1, templateInstance.applyConflictPage.get() - 1),
    )
  },
  'click .js-apply-conflicts-next': (event, templateInstance) => {
    event.preventDefault()
    loadApplyConflicts(templateInstance, templateInstance.applyConflictPage.get() + 1)
  },
  'click .js-restore-next': (event, templateInstance) => {
    event.preventDefault()
    loadRestorePreview(templateInstance, templateInstance.restorePage.get() + 1)
  },
  'input .js-restore-confirmation': (event, templateInstance) => {
    templateInstance.restoreConfirmation.set(event.currentTarget.value)
  },
  'click .js-start-restore': (event, templateInstance) => {
    event.preventDefault()
    const status = getRunStatus(templateInstance.restoreRun.get())
    if (templateInstance.restoreConfirmation.get() !== 'RESTORE'
      || templateInstance.restoreLoading.get()
      || ['restored', 'restored-with-conflicts'].includes(status)) {
      return
    }
    const runId = templateInstance.restoreRunId.get()
    templateInstance.restorePreviewRequestId += 1
    templateInstance.restoreLoopActive = true
    runRestoreBatch(templateInstance, runId)
  },
  'click .js-pause-restore': (event, templateInstance) => {
    event.preventDefault()
    templateInstance.restoreLoopActive = false
    const runId = templateInstance.restoreRunId.get()
    callMigrationMethod('pause', { runId }, (error, result) => {
      if (templateInstance.restoreRunId.get() !== runId || templateInstance.viewDestroyed) {
        return
      }
      templateInstance.restoreLoading.set(false)
      templateInstance.restoreBatchLoading.set(false)
      if (error) {
        setError(templateInstance, error)
        return
      }
      syncRestoreRun(templateInstance, result)
    })
  },
  'click .js-resume-restore': (event, templateInstance) => {
    event.preventDefault()
    const runId = templateInstance.restoreRunId.get()
    callMigrationMethod('resume', { runId }, (error, result) => {
      if (templateInstance.restoreRunId.get() !== runId || templateInstance.viewDestroyed) {
        return
      }
      if (error) {
        setError(templateInstance, error)
        return
      }
      syncRestoreRun(templateInstance, result)
      templateInstance.restoreLoopActive = true
      runRestoreBatch(templateInstance, runId)
    })
  },
})

export { migrationAdminSummary, refreshTimecardMigrationSummary }
