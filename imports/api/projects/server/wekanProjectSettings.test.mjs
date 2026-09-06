import assert from 'node:assert/strict'
import test from 'node:test'

import normalizeWekanProjectFields from './wekanProjectSettings.js'

const production = { NODE_ENV: 'production' }

test('blank write-only Wekan input preserves the stored secret by omitting it', () => {
  const update = {
    name: 'Existing project',
    wekanurl: '   ',
    selectedWekanList: ['list-one'],
  }
  const normalized = normalizeWekanProjectFields(update, { environment: production })
  assert.equal(Object.prototype.hasOwnProperty.call(normalized, 'wekanurl'), false)
  assert.deepEqual(normalized.selectedWekanList, ['list-one'])
  assert.equal(update.wekanurl, '   ')
})

test('replacement Wekan input is validated and stored canonically', () => {
  const update = {
    wekanurl: 'https://wekan.example.test/root/api/boards/board_1/export?authToken=a%20token',
    selectedWekanList: 'list-one',
    selectedWekanSwimlanes: [],
  }
  const normalized = normalizeWekanProjectFields(update, { environment: production })
  assert.equal(
    normalized.wekanurl,
    'https://wekan.example.test/root/api/boards/board_1/export?authToken=a+token',
  )
  assert.deepEqual(normalized.selectedWekanList, ['list-one'])
  assert.deepEqual(normalized.selectedWekanSwimlanes, [])
})

test('hostile Wekan settings fail before storage', () => {
  for (const wekanurl of [
    'http://wekan.example.test/api/boards/board/export?authToken=token',
    'https://user:password@wekan.example.test/api/boards/board/export?authToken=token',
    'https://wekan.example.test/api/boards/board/export?authToken=token#capability',
    'https://wekan.example.test/api/boards/board/export?authToken=token&next=/admin',
  ]) {
    assert.throws(() => normalizeWekanProjectFields({ wekanurl }, {
      environment: production,
    }))
  }
  assert.throws(() => normalizeWekanProjectFields({
    selectedWekanList: ['safe', '../unsafe'],
  }, { environment: production }))
})
