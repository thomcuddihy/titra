import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createCoalescedAsyncRefresh,
  createPublicationReconciler,
  createRestartableDocumentObserver,
} from './reactivePublication.js'

test('async refreshes coalesce to one active and one latest follow-up run', async () => {
  let releaseFirst
  const firstRun = new Promise((resolve) => { releaseFirst = resolve })
  let active = 0
  let maximumActive = 0
  let runs = 0
  const refresh = createCoalescedAsyncRefresh(async () => {
    runs += 1
    active += 1
    maximumActive = Math.max(maximumActive, active)
    if (runs === 1) await firstRun
    active -= 1
  })

  const initial = refresh.request()
  refresh.request()
  refresh.request()
  releaseFirst()
  await initial

  assert.equal(runs, 2)
  assert.equal(maximumActive, 1)
})

test('stopping an async refresh drops its pending follow-up', async () => {
  let release
  const blocked = new Promise((resolve) => { release = resolve })
  let runs = 0
  const refresh = createCoalescedAsyncRefresh(async () => {
    runs += 1
    await blocked
  })
  const initial = refresh.request()
  refresh.request()
  refresh.stop()
  release()
  await initial
  assert.equal(runs, 1)
})

function publicationRecorder() {
  const events = []
  const reconciler = createPublicationReconciler({
    collectionName: 'records',
    added: (...args) => events.push(['added', ...args]),
    changed: (...args) => events.push(['changed', ...args]),
    removed: (...args) => events.push(['removed', ...args]),
  })
  return { events, reconciler }
}

test('access downgrade clears private fields and revocation removes the record', () => {
  const { events, reconciler } = publicationRecorder()
  reconciler.reconcile(new Map([['one', { name: 'visible', secret: 'member-only' }]]))
  reconciler.reconcile(new Map([['one', { name: 'visible' }]]))
  reconciler.reconcile(new Map())

  assert.deepEqual(events, [
    ['added', 'records', 'one', { name: 'visible', secret: 'member-only' }],
    ['changed', 'records', 'one', { secret: undefined }],
    ['removed', 'records', 'one'],
  ])
})

test('events observed after access loss cannot re-add an undesired record', () => {
  const { events, reconciler } = publicationRecorder()
  const source = new Map([['one', { name: 'first' }]])
  let access = true
  const reconcileAccess = () => reconciler.reconcile(access ? source : new Map())

  reconcileAccess()
  access = false
  reconcileAccess()
  source.set('two', { name: 'arrived after revocation' })
  reconcileAccess()

  assert.deepEqual(events.map(([event, , id]) => [event, id]), [
    ['added', 'one'],
    ['removed', 'one'],
  ])
})

test('access-scoped count is reset immediately and ignores later source rows', () => {
  const { events, reconciler } = publicationRecorder()
  const rows = new Map([
    ['one', { projectId: 'project' }],
    ['two', { projectId: 'project' }],
  ])
  let access = true
  const reconcileCount = () => reconciler.reconcile(new Map([['count', {
    count: [...rows.values()].filter(() => access).length,
  }]]))

  reconcileCount()
  access = false
  reconcileCount()
  rows.set('three', { projectId: 'project' })
  reconcileCount()

  assert.deepEqual(events, [
    ['added', 'records', 'count', { count: 2 }],
    ['changed', 'records', 'count', { count: 0 }],
  ])
})

test('stats downgrade clears revenue before a full revocation removes statistics', () => {
  const { events, reconciler } = publicationRecorder()
  reconciler.reconcile(new Map([['project', { totalHours: 4, totalRevenue: 800 }]]))
  reconciler.reconcile(new Map([['project', { totalHours: 4 }]]))
  reconciler.removeAll()

  assert.deepEqual(events, [
    ['added', 'records', 'project', { totalHours: 4, totalRevenue: 800 }],
    ['changed', 'records', 'project', { totalRevenue: undefined }],
    ['removed', 'records', 'project'],
  ])
})

test('replaced observer callbacks are inert after an authorization scope change', async () => {
  const observers = new Map()
  const stopped = []
  const snapshots = []
  const observer = createRestartableDocumentObserver({
    cursorForScope(scope) {
      if (!scope) return null
      return {
        async observeChangesAsync(callbacks) {
          observers.set(scope, callbacks)
          callbacks.added(`${scope}-initial`, { scope })
          return { stop: () => stopped.push(scope) }
        },
      }
    },
    documentsChanged(documents) {
      snapshots.push([...documents.keys()])
    },
  })

  await observer.restart('member')
  await observer.restart(null)
  observers.get('member').added('late-secret', { secret: true })

  assert.deepEqual(stopped, ['member'])
  assert.deepEqual(snapshots, [['member-initial'], []])
  assert.deepEqual([...observer.documents().keys()], [])
})

test('a slower obsolete observer cannot replace the newer authorized scope', async () => {
  let releaseOld
  const oldReady = new Promise((resolve) => { releaseOld = resolve })
  const callbacks = new Map()
  const stopped = []
  const observer = createRestartableDocumentObserver({
    cursorForScope: (scope) => ({
      async observeChangesAsync(nextCallbacks) {
        callbacks.set(scope, nextCallbacks)
        nextCallbacks.added(`${scope}-row`, { scope })
        if (scope === 'old') await oldReady
        return { stop: () => stopped.push(scope) }
      },
    }),
    documentsChanged() {},
  })

  const oldRestart = observer.restart('old')
  await observer.restart('new')
  releaseOld()
  await oldRestart
  callbacks.get('old').added('late-old-secret', { secret: true })

  assert.deepEqual([...observer.documents().keys()], ['new-row'])
  assert.deepEqual(stopped, ['old'])
})
