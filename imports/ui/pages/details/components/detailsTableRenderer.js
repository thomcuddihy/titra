// The module load, render and animation-frame callbacks all belong to one
// request. Old callbacks must not fill a newer view or a replacement tab.
function createDetailsTableRenderer({
  request, container, getTable, setTable,
  load = async () => {
    await import('frappe-datatable/dist/frappe-datatable.css')
    return (await import('frappe-datatable')).default
  },
  schedule = (callback) => window.requestAnimationFrame(callback),
  onError = (error) => console.error(error),
}) {
  let revision = 0
  let pendingLoad
  let destroyed = false
  const current = (sequence, render) => !destroyed
    && render === revision && request.current(sequence) && request.ready()
  return {
    async render(config) {
      const sequence = request.generation()
      const render = ++revision
      try {
        let table = getTable()
        if (!table) {
          pendingLoad ??= load().catch((error) => { pendingLoad = undefined; throw error })
          const DataTable = await pendingLoad
          if (!current(sequence, render)) return
          table = getTable()
          if (!table) {
            table = new DataTable(container(), config)
            setTable(table)
          } else table.refresh(config.data, config.columns)
        } else {
          if (!current(sequence, render)) return
          table.refresh(config.data, config.columns)
        }
        if (!current(sequence, render)) return
        request.rendered.set(true)
        schedule(() => {
          if (!current(sequence, render)) return
          try {
            // Loading uses visibility:hidden (not display:none), preserving
            // measurable ratio-layout widths before and after Blaze reveals it.
            table.setDimensions()
            const element = container()
            const scrollable = element?.querySelector('.dt-scrollable')
            const lastRow = element?.querySelector('.dt-row.vrow:last-of-type')
            if (scrollable) {
              const top = Number.parseInt(lastRow?.style.top, 10)
              scrollable.style.height = config.data.length && Number.isFinite(top) ? `${top + 40}px` : 'auto'
              scrollable.style.overflow = 'hidden'
            }
          } catch (error) {
            if (request.fail(sequence)) onError(error)
          }
        })
      } catch (error) {
        if (current(sequence, render) && request.fail(sequence)) onError(error)
      }
    },
    destroy() {
      destroyed = true
      revision += 1
      try { getTable()?.destroy() } catch (error) { onError(error) }
      setTable(undefined)
    },
  }
}

function tableRendererForTemplate(templateInstance) {
  return createDetailsTableRenderer({
    request: templateInstance.request,
    container: () => templateInstance.find('#datatable-container'),
    getTable: () => templateInstance.datatable,
    setTable: (table) => { templateInstance.datatable = table },
  })
}

export { createDetailsTableRenderer, tableRendererForTemplate }
