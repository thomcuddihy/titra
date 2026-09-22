import assert from 'node:assert/strict'
import test from 'node:test'
import { createDetailsRequestState } from './detailsRequestState.js'

class ReactiveVar {
  constructor(value) { this.value = value }
  get() { return this.value }
  set(value) { this.value = value }
}

test('request lifecycle clears rows/count/visibility and rejects obsolete success or failure', () => {
  const rows = new ReactiveVar(['old']); const total = new ReactiveVar(1)
  const request = createDetailsRequestState({ ReactiveVar, rows, total })
  const first = request.begin()
  assert.equal(rows.get(), undefined)
  assert.equal(total.get(), undefined)
  assert.equal(request.ready(), false)
  const second = request.begin()
  assert.equal(request.complete(first, () => assert.fail('obsolete callback')), false)
  assert.equal(request.fail(first), false)
  request.complete(second, () => { rows.set(['new']); total.set(1) })
  assert.equal(request.hasRows(), true)
  request.rendered.set(true)
  const third = request.begin()
  assert.equal(request.rendered.get(), false)
  request.fail(third)
  assert.equal(request.phase.get(), 'error')
  assert.equal(request.hasRows(), false)
  assert.equal(request.complete(third, () => assert.fail('failed callback')), false)
  const fourth = request.begin()
  request.dispose()
  assert.equal(request.complete(fourth, () => assert.fail('destroyed callback')), false)
  assert.equal(request.fail(fourth), false)
})

test('empty results are ready without export rows, and metadata dependencies gate export readiness', () => {
  let metadataReady = false
  const rows = new ReactiveVar(); const total = new ReactiveVar()
  const request = createDetailsRequestState({ ReactiveVar, rows, total, dependenciesReady: () => metadataReady })
  const sequence = request.begin()
  request.complete(sequence, () => { rows.set([{}]); total.set(1) })
  assert.equal(request.ready(), false)
  assert.equal(request.hasRows(), false)
  metadataReady = true
  assert.equal(request.ready(), true)
  assert.equal(request.hasRows(), true)
  rows.set([])
  assert.equal(request.hasRows(), false)
})
