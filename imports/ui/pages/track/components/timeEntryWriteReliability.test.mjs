import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const magicPopup = await readFile(
  new URL('./magicPopup.js', import.meta.url),
  'utf8',
)
const weektable = await readFile(
  new URL('./weektable.js', import.meta.url),
  'utf8',
)

test('magic import uses the Meteor error-first callback contract', () => {
  assert.match(magicPopup, /Meteor\.call\('upsertWeek', selectedEntries, \(error\) =>/)
  assert.doesNotMatch(magicPopup, /\(result, error\) =>/)
})

test('magic import prevents duplicate writes and restores the save control', () => {
  assert.match(magicPopup, /saveInFlight = new ReactiveVar\(false\)/)
  assert.match(magicPopup, /if \(templateInstance\.saveInFlight\.get\(\)\)/)
  assert.match(magicPopup, /\.js-save'\)\.prop\('disabled', true\)/)
  assert.match(magicPopup, /\.js-save'\)\.prop\('disabled', false\)/)
})

test('an earlier magic import cannot close a newly opened modal', () => {
  assert.match(magicPopup, /popupGeneration \+= 1/)
  assert.match(magicPopup, /popupGeneration === popupGeneration/)
})

test('week entry writes include only fields changed by the user', () => {
  assert.match(weektable, /'input \.js-hours'/)
  assert.match(weektable, /attr\('data-dirty', 'true'\)/)
  assert.match(weektable, /attr\('data-dirty'\) !== 'true'/)
})

test('week entry writes prevent duplicate submissions while in flight', () => {
  assert.match(weektable, /weekSaveInFlight = new ReactiveVar\(false\)/)
  assert.match(weektable, /if \(templateInstance\.weekSaveInFlight\.get\(\)\)/)
  assert.match(weektable, /\.js-save'\)\.prop\('disabled', true\)/)
  assert.match(weektable, /\.js-save'\)\.prop\('disabled', false\)/)
})

test('failed week writes remain dirty and later edits survive success', () => {
  assert.match(weektable, /attr\('data-dirty', 'saving'\)/)
  assert.match(weektable, /attr\('data-dirty'\) === 'saving'[\s\S]*attr\('data-dirty', 'true'\)/)
  assert.match(weektable, /\.js-hours\[data-dirty="true"\]/)
  assert.match(weektable, /if \(!hasPendingEdits\)/)
})

