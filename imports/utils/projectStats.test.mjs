import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const helperModuleUrl = `data:text/javascript;base64,${Buffer.from(
  readFileSync(new URL('./projectStats.js', import.meta.url), 'utf8'),
).toString('base64')}`
const {
  buildProjectStatsAggregation,
  createProjectStatsTracker,
  observeProjectStats,
} = await import(helperModuleUrl)

const zeroTotals = {
  totalHours: 0,
  totalRevenue: 0,
  currentMonthHours: 0,
  previousMonthHours: 0,
  beforePreviousMonthHours: 0,
}
const monthRanges = {
  currentMonthHours: {
    start: new Date('2026-09-01T00:00:00.000Z'),
    end: new Date('2026-09-30T23:59:59.999Z'),
  },
  previousMonthHours: {
    start: new Date('2026-08-01T00:00:00.000Z'),
    end: new Date('2026-08-31T23:59:59.999Z'),
  },
  beforePreviousMonthHours: {
    start: new Date('2026-07-01T00:00:00.000Z'),
    end: new Date('2026-07-31T23:59:59.999Z'),
  },
}

function tracker(overrides = {}) {
  return createProjectStatsTracker({
    project: { rate: 100, rates: { 'user-1': 80, 'user-2': 120 } },
    monthRanges,
    allowIndividualTaskRates: false,
    ...overrides,
  })
}

function record(overrides = {}) {
  return {
    date: new Date('2026-09-08T00:00:00.000Z'),
    hours: 2.5,
    userId: 'user-1',
    ...overrides,
  }
}

function publicationHarness(statsTracker, initialEvents = () => {}) {
  const initial = []
  const changes = []
  let callbacks
  let stopPublication
  let stopCount = 0
  const cursor = {
    async observeChangesAsync(observer) {
      callbacks = observer
      await initialEvents(observer)
      return { stop() { stopCount += 1 } }
    },
  }
  return {
    async start() {
      return observeProjectStats({
        cursor,
        tracker: statsTracker,
        onStop(callback) { stopPublication = callback },
        publishInitial(value) { initial.push(value) },
        publishChanged(value) { changes.push(value) },
      })
    },
    stop() { stopPublication() },
    get callbacks() { return callbacks },
    get stopCount() { return stopCount },
    initial,
    changes,
  }
}

test('empty project publishes numeric zero totals', () => {
  assert.deepEqual(tracker().snapshot(), zeroTotals)
})

test('project stats aggregation returns one scalar document with bounded-memory sums', () => {
  const pipeline = buildProjectStatsAggregation({
    project: { _id: 'project-1', rate: '100', rates: { alice: 80, ignoredZero: 0 } },
    monthRanges,
    allowIndividualTaskRates: true,
  })
  assert.deepEqual(pipeline.map((stage) => Object.keys(stage)[0]), ['$match', '$group', '$project'])
  assert.deepEqual(pipeline[0], { $match: { projectId: 'project-1' } })
  assert.equal(pipeline[1].$group.totalRevenue.$sum.$multiply.length, 2)
  const rate = pipeline[1].$group.totalRevenue.$sum.$multiply[1]
  assert.equal(rate.$cond[0], '$taskRate')
  assert.deepEqual(rate.$cond[2].$switch.branches, [
    { case: { $eq: ['$userId', 'alice'] }, then: 80 },
  ])
  assert.equal(rate.$cond[2].$switch.default, 100)
  assert.deepEqual(Object.keys(pipeline[2].$project).sort(), [
    '_id', 'beforePreviousMonthHours', 'currentMonthHours', 'previousMonthHours',
    'totalHours', 'totalRevenue',
  ])
})

test('task-only renames and identical updates do not alter totals', () => {
  const stats = tracker()
  stats.added('one', record({ task: 'Old task' }))
  const before = stats.snapshot()
  assert.equal(stats.changed('one', { task: 'New task' }), false)
  assert.equal(stats.changed('one', { hours: 2.5 }), false)
  assert.equal(stats.changed('one', {}), false)
  assert.deepEqual(stats.snapshot(), before)
  assert.deepEqual(before, {
    ...zeroTotals, totalHours: 2.5, totalRevenue: 200, currentMonthHours: 2.5,
  })
})

test('hours changes replace the old contribution rather than adding the whole record', () => {
  const stats = tracker()
  stats.added('one', record())
  assert.equal(stats.changed('one', { hours: 1.25 }), true)
  assert.deepEqual(stats.snapshot(), {
    ...zeroTotals, totalHours: 1.25, totalRevenue: 100, currentMonthHours: 1.25,
  })
  stats.changed('one', { hours: 3.5 })
  assert.equal(stats.snapshot().totalHours, 3.5)
  assert.equal(stats.snapshot().totalRevenue, 280)
})

test('moving a date between UTC calendar months removes its previous bucket', () => {
  const stats = tracker()
  stats.added('one', record())
  stats.changed('one', { date: new Date('2026-08-31T23:59:59.999Z') })
  assert.deepEqual(stats.snapshot(), {
    ...zeroTotals, totalHours: 2.5, totalRevenue: 200, previousMonthHours: 2.5,
  })
  stats.changed('one', { date: new Date('2026-07-01T00:00:00.000Z') })
  assert.deepEqual(stats.snapshot(), {
    ...zeroTotals, totalHours: 2.5, totalRevenue: 200, beforePreviousMonthHours: 2.5,
  })
  stats.changed('one', { date: new Date('2025-01-01T00:00:00.000Z') })
  assert.deepEqual(stats.snapshot(), { ...zeroTotals, totalHours: 2.5, totalRevenue: 200 })
})

test('records outside the three-month display still contribute to all-time totals', () => {
  const stats = tracker()
  stats.added('old', record({ date: new Date('2024-01-01T00:00:00.000Z') }))
  stats.changed('old', { hours: 4 })
  assert.deepEqual(stats.snapshot(), { ...zeroTotals, totalHours: 4, totalRevenue: 320 })
  stats.removed('old')
  assert.deepEqual(stats.snapshot(), zeroTotals)
})

test('user changes recompute the applicable user-specific or project fallback rate', () => {
  const stats = tracker()
  stats.added('one', record())
  stats.changed('one', { userId: 'user-2' })
  assert.equal(stats.snapshot().totalHours, 2.5)
  assert.equal(stats.snapshot().totalRevenue, 300)
  stats.changed('one', { userId: 'unlisted-user' })
  assert.equal(stats.snapshot().totalRevenue, 250)
})

test('individual task rates apply consistently on add, change, unset and delete', () => {
  const stats = tracker({ allowIndividualTaskRates: true })
  stats.added('one', record({ taskRate: 50 }))
  assert.equal(stats.snapshot().totalRevenue, 125)
  stats.changed('one', { taskRate: 60 })
  assert.equal(stats.snapshot().totalRevenue, 150)
  stats.changed('one', { taskRate: undefined })
  assert.equal(stats.snapshot().totalRevenue, 200)
  stats.removed('one')
  assert.deepEqual(stats.snapshot(), zeroTotals)
})

test('disabled individual task rates and zero overrides retain existing rate precedence', () => {
  const stats = tracker()
  stats.added('one', record({ taskRate: 50 }))
  assert.equal(stats.snapshot().totalRevenue, 200)
  assert.equal(stats.changed('one', { taskRate: 60 }), false)
  const zeroOverrides = tracker({
    project: { rate: 100, rates: { 'user-1': 0 } },
    allowIndividualTaskRates: true,
  })
  zeroOverrides.added('one', record({ taskRate: 0 }))
  assert.equal(zeroOverrides.snapshot().totalRevenue, 250)
})

test('moving a record between projects removes the source and uses destination rates', () => {
  const source = tracker()
  const destination = tracker({ project: { rate: 150 } })
  source.added('one', record())
  source.removed('one')
  destination.added('one', record())
  assert.deepEqual(source.snapshot(), zeroTotals)
  assert.equal(destination.snapshot().totalHours, 2.5)
  assert.equal(destination.snapshot().totalRevenue, 375)
})

test('deleted records subtract their retained contribution without a database lookup', () => {
  const stats = tracker()
  stats.added('one', record({ hours: 0.1 }))
  stats.added('two', record({ hours: 0.2 }))
  stats.removed('one')
  assert.ok(Math.abs(stats.snapshot().totalHours - 0.2) < 1e-12)
  assert.equal(stats.removed('one'), false)
  stats.removed('two')
  assert.deepEqual(stats.snapshot(), zeroTotals)
  assert.equal(stats.changed('unknown', { hours: 9 }), false)
})

test('duplicate adds replace snapshots and caller mutations cannot corrupt old contributions', () => {
  const stats = tracker()
  const fields = record()
  stats.added('one', fields)
  fields.date.setUTCMonth(0)
  fields.hours = 99
  stats.changed('one', { task: 'Renamed' })
  assert.equal(stats.snapshot().currentMonthHours, 2.5)
  assert.equal(stats.snapshot().totalHours, 2.5)
  stats.added('one', record({ hours: 1 }))
  assert.equal(stats.snapshot().totalHours, 1)
  const snapshot = stats.snapshot()
  snapshot.totalHours = 1000
  assert.equal(stats.snapshot().totalHours, 1)
})

test('missing rates and invalid numeric fields do not poison all totals with NaN', () => {
  const stats = tracker({ project: {} })
  stats.added('one', record())
  assert.equal(stats.snapshot().totalRevenue, 0)
  stats.added('bad', record({ hours: 'not a number' }))
  assert.equal(stats.snapshot().totalHours, 2.5)
  assert.equal(stats.snapshot().totalRevenue, 0)
})

test('observer initialization publishes one consistent initial snapshot, then actual deltas', async () => {
  const stats = tracker()
  const publication = publicationHarness(stats, (observer) => {
    observer.added('one', record())
    observer.changed('one', { hours: 3 })
    observer.added('deleted-during-startup', record({ hours: 1 }))
    observer.removed('deleted-during-startup')
  })
  assert.equal(await publication.start(), true)
  assert.equal(publication.initial.length, 1)
  assert.equal(publication.initial[0].totalHours, 3)
  assert.deepEqual(publication.changes, [])
  publication.callbacks.changed('one', { task: 'Renamed' })
  assert.deepEqual(publication.changes, [])
  publication.callbacks.changed('one', { hours: 4 })
  assert.equal(publication.changes.length, 1)
  assert.equal(publication.changes[0].totalHours, 4)
  publication.callbacks.removed('one')
  assert.deepEqual(publication.changes.at(-1), zeroTotals)
})

test('normal unsubscribe stops the observer, releases snapshots and ignores late callbacks', async () => {
  const stats = tracker()
  const publication = publicationHarness(stats, (observer) => observer.added('one', record()))
  await publication.start()
  publication.stop()
  publication.stop()
  assert.equal(publication.stopCount, 1)
  assert.deepEqual(stats.snapshot(), zeroTotals)
  publication.callbacks.added('late', record())
  publication.callbacks.changed('one', { hours: 5 })
  publication.callbacks.removed('one')
  assert.deepEqual(publication.changes, [])
  assert.deepEqual(stats.snapshot(), zeroTotals)
})

test('unsubscribe while observer startup awaits its handle does not leak or publish', async () => {
  let finishStartup
  const startup = new Promise((resolve) => { finishStartup = resolve })
  const stats = tracker()
  const publication = publicationHarness(stats, async (observer) => {
    observer.added('one', record())
    await startup
  })
  const running = publication.start()
  publication.stop()
  finishStartup()
  assert.equal(await running, false)
  assert.equal(publication.stopCount, 1)
  assert.deepEqual(publication.initial, [])
  assert.deepEqual(publication.changes, [])
  assert.deepEqual(stats.snapshot(), zeroTotals)
})

test('failed observer startup clears retained data and does not publish partial results', async () => {
  const stats = tracker()
  const publication = publicationHarness(stats, (observer) => {
    observer.added('one', record())
    throw new Error('observer startup failed')
  })
  await assert.rejects(publication.start(), /observer startup failed/)
  assert.deepEqual(publication.initial, [])
  assert.deepEqual(publication.changes, [])
  assert.deepEqual(stats.snapshot(), zeroTotals)
})

test('failed initial publication stops the acquired observer and clears retained data', async () => {
  const stats = tracker()
  let stopCount = 0
  await assert.rejects(observeProjectStats({
    cursor: {
      async observeChangesAsync(observer) {
        observer.added('one', record())
        return { stop() { stopCount += 1 } }
      },
    },
    tracker: stats,
    onStop() {},
    publishInitial() { throw new Error('publication failed') },
    publishChanged() { assert.fail('unexpected update') },
  }), /publication failed/)
  assert.equal(stopCount, 1)
  assert.deepEqual(stats.snapshot(), zeroTotals)
})
