import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'
import { MAX_PAGE_PARAMETER, normalizePageParameter } from '../../../../utils/pageParameter.js'

const source = (await readFile(new URL('./pagination.js', import.meta.url), 'utf8'))
  .replace(/^import .*\r?\n/gm, '')

function createPagination({ page, total, limit = 10 } = {}) {
  let onCreated
  let helpers
  let events
  let routePage = page
  const routeWrites = []
  const computations = []
  class ReactiveVar {
    constructor(value) { this.value = value }
    get() { return this.value }
    set(value) { this.value = value }
  }
  const instance = {
    data: { totalEntries: new ReactiveVar(total), limit: new ReactiveVar(limit) },
    autorun(callback) {
      computations.push(callback)
      callback()
    },
  }
  vm.runInNewContext(source, {
    MAX_PAGE_PARAMETER,
    normalizePageParameter,
    ReactiveVar,
    FlowRouter: {
      getQueryParam(name) {
        assert.equal(name, 'page')
        return routePage
      },
      setQueryParams(parameters) {
        routeWrites.push(parameters.page)
        routePage = parameters.page ?? undefined
      },
    },
    Template: {
      instance: () => instance,
      pagination: {
        onCreated(callback) { onCreated = callback },
        helpers(callbacks) { helpers = callbacks },
        events(callbacks) { events = callbacks },
      },
    },
    $: (element) => ({ text: () => element.textContent }),
  }, { filename: 'pagination.js' })
  onCreated.call(instance)
  return {
    instance,
    routeWrites,
    helper(name, ...args) { return helpers[name](...args) },
    update(values) {
      if (Object.hasOwn(values, 'page')) routePage = values.page
      if (Object.hasOwn(values, 'total')) instance.data.totalEntries.set(values.total)
      if (Object.hasOwn(values, 'limit')) instance.data.limit.set(values.limit)
      computations.forEach((callback) => callback())
    },
    click(selector, textContent = '') {
      let prevented = false
      events[`click ${selector}`]({
        preventDefault() { prevented = true },
        currentTarget: { textContent },
      })
      assert.equal(prevented, true)
    },
  }
}

test('missing page loads page one, with numeric pagination state', () => {
  const pagination = createPagination({ total: 30 })
  assert.equal(pagination.instance.currentPage.get(), 1)
  assert.equal(pagination.instance.numPages.get(), 3)
  assert.equal(pagination.helper('activeClass', 1), 'active')
  assert.equal(pagination.helper('disabledClass', 'previous'), 'disabled')
  assert.equal(pagination.helper('disabledClass', 'next'), '')
  assert.deepEqual(Array.from(pagination.helper('getPages')), [1, 2, 3])
  assert.deepEqual(pagination.routeWrites, [])
})

test('direct page links survive unknown counts until results arrive', () => {
  const pagination = createPagination({ page: '3' })
  assert.equal(pagination.instance.currentPage.get(), 3)
  assert.equal(pagination.instance.numPages.get(), undefined)
  assert.equal(pagination.helper('showPagination'), false)
  assert.equal(pagination.helper('disabledClass', 'next'), 'disabled')
  pagination.click('.js-next')
  pagination.click('.js-previous')
  assert.deepEqual(pagination.routeWrites, [])
  pagination.update({ total: 100 })
  assert.equal(pagination.instance.currentPage.get(), 3)
  assert.equal(pagination.helper('showPagination'), true)
  assert.deepEqual(pagination.routeWrites, [])
  pagination.update({ total: undefined, limit: 25 })
  assert.equal(pagination.instance.currentPage.get(), 3)
  assert.deepEqual(pagination.routeWrites, [])
  pagination.update({ total: 25 })
  assert.equal(pagination.instance.currentPage.get(), 1)
  assert.deepEqual(pagination.routeWrites, [null])
})

test('removing the page query resets currentPage instead of retaining stale state', () => {
  const pagination = createPagination({ page: '3', total: 40 })
  pagination.update({ page: undefined })
  assert.equal(pagination.instance.currentPage.get(), 1)
  pagination.click('.js-previous')
  assert.deepEqual(pagination.routeWrites, [])
})

test('malformed route pages cannot produce invalid requests or pagination state', () => {
  for (const page of ['', 'abc', '-1', '0', '1.5', 'NaN', 'Infinity', '10001', ['2']]) {
    const pagination = createPagination({ page, total: 40 })
    assert.equal(pagination.instance.currentPage.get(), 1, String(page))
    assert.deepEqual(pagination.routeWrites, [null], String(page))
    pagination.click('.js-previous')
    assert.deepEqual(pagination.routeWrites, [null], String(page))
  }
})

test('known empty results and pages beyond the last page reset to page one', () => {
  for (const total of [0, 10]) {
    const pagination = createPagination({ page: '3' })
    pagination.update({ total })
    assert.equal(pagination.instance.currentPage.get(), 1)
    assert.equal(pagination.instance.numPages.get(), 1)
    assert.deepEqual(pagination.routeWrites, [null])
    assert.equal(pagination.helper('disabledClass', 'previous'), 'disabled')
    assert.equal(pagination.helper('disabledClass', 'next'), 'disabled')
  }
})

test('previous/next enforce boundaries even if their disabled links receive clicks', () => {
  const pagination = createPagination({ total: 30 })
  pagination.click('.js-previous')
  assert.deepEqual(pagination.routeWrites, [])
  pagination.click('.js-next')
  assert.equal(pagination.instance.currentPage.get(), 2)
  pagination.click('.js-next')
  assert.equal(pagination.instance.currentPage.get(), 3)
  pagination.click('.js-next')
  assert.deepEqual(pagination.routeWrites, [2, 3])
  pagination.click('.js-previous')
  pagination.click('.js-previous')
  pagination.click('.js-previous')
  assert.equal(pagination.instance.currentPage.get(), 1)
  assert.deepEqual(pagination.routeWrites, [2, 3, 2, null])
})

test('numbered links accept only existing canonical pages', () => {
  const pagination = createPagination({ total: 30 })
  for (const page of ['4', '0', '-1', '1.5', 'abc']) pagination.click('.js-page-number', page)
  assert.deepEqual(pagination.routeWrites, [])
  pagination.click('.js-page-number', '3')
  assert.equal(pagination.instance.currentPage.get(), 3)
  assert.deepEqual(pagination.routeWrites, [3])
})

test('page list and navigation honor the server page ceiling', () => {
  const pagination = createPagination({ page: String(MAX_PAGE_PARAMETER), total: 1000000, limit: 1 })
  assert.equal(pagination.instance.numPages.get(), MAX_PAGE_PARAMETER)
  assert.equal(pagination.helper('getPages').length, MAX_PAGE_PARAMETER)
  pagination.click('.js-next')
  assert.deepEqual(pagination.routeWrites, [])
})

test('unknown/invalid totals or limits never claim an empty result', () => {
  for (const values of [
    { total: undefined }, { total: null }, { total: NaN }, { total: -1 },
    { total: 30, limit: undefined }, { total: 30, limit: 0 }, { total: 30, limit: -1 },
  ]) {
    const pagination = createPagination({ page: '2' })
    pagination.update(values)
    assert.equal(pagination.instance.currentPage.get(), 2)
    assert.equal(pagination.instance.numPages.get(), undefined)
    assert.deepEqual(pagination.routeWrites, [])
  }
})
