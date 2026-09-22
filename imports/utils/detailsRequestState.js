// ReactiveVar is injected so this lifecycle can also be exercised without a
// Meteor runtime. A request owns its result, count and error state until it is
// replaced or the view is destroyed; late replies must never resurrect rows.
function createDetailsRequestState({ ReactiveVar, rows, total, dependenciesReady = () => true }) {
  const phase = new ReactiveVar('loading')
  const rendered = new ReactiveVar(false)
  const retry = new ReactiveVar(0)
  const epoch = new ReactiveVar(0)
  let generation = 0
  let disposed = false
  const current = (id) => !disposed && id === generation && phase.get() !== 'error'
  const ready = () => !disposed && phase.get() === 'ready' && dependenciesReady()
  const clear = () => {
    rows.set(undefined)
    total.set(undefined)
  }
  return {
    phase,
    rendered,
    retry,
    begin() {
      generation += 1
      epoch.set(generation)
      clear()
      rendered.set(false)
      phase.set('loading')
      return generation
    },
    current,
    // Handle objects themselves are not reactive. Observers must be able to
    // notice a replacement even when both requests are still loading.
    generation: () => epoch.get(),
    complete(id, applyResult = () => {}) {
      if (!current(id)) return false
      applyResult()
      phase.set('ready')
      return true
    },
    fail(id) {
      if (!current(id)) return false
      clear()
      rendered.set(false)
      phase.set('error')
      return true
    },
    ready,
    hasRows: () => ready() && Boolean(rows.get()?.length),
    dispose() {
      disposed = true
      generation += 1
    },
  }
}

export { createDetailsRequestState }
