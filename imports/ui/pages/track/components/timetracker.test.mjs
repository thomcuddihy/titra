import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('./timetracker.js', import.meta.url), 'utf8')

function eventBlock(start, end) {
  const from = source.indexOf(start)
  const to = end == null ? source.length : source.indexOf(end, from + start.length)
  assert.notEqual(from, -1)
  if (end != null) assert.notEqual(to, -1)
  return source.slice(from, to)
}

test('timer start supplies a unique operation ID and updates local state only after success', () => {
  const block = eventBlock("'click .js-start'")
  assert.match(block, /operationId: `ddp:\$\{Random\.id\(\)\}`/u)
  const call = block.indexOf("Meteor.call('setTimer'")
  const callback = block.indexOf('} else {', call)
  assert.ok(call >= 0 && callback > call)
  for (const update of [
    'templateInstance.timer?.set',
    'templateInstance.project?.set',
    'templateInstance.task?.set',
    'templateInstance.customFields?.set',
  ]) assert.ok(block.indexOf(update, callback) > callback, update)
})

test('timer stop sends the observed ID/revision and clears local state only after success', () => {
  const block = eventBlock("'click .js-stop'", "'click .js-start'")
  assert.match(block, /timerId: Object\.prototype\.hasOwnProperty/u)
  assert.match(block, /expectedRevision: Object\.prototype\.hasOwnProperty/u)
  const call = block.indexOf("Meteor.call('setTimer'")
  const callback = block.indexOf('} else {', call)
  assert.ok(call >= 0 && callback > call)
  assert.ok(block.indexOf('templateInstance.timer.set(null)', callback) > callback)
  assert.ok(block.indexOf('Meteor.clearTimeout', callback) > callback)
})
