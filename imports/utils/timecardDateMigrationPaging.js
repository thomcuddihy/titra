const PREVIEW_SORT_FIELDS = Object.freeze({
  date: ['original.date'],
  context: ['original.userId', 'original.projectId', 'original.task'],
  classification: ['classification', 'original.date'],
  'day-shift': ['preview.dayShift', 'original.date'],
})

function buildPreviewSort(sortField = 'date', sortDirection = 'desc') {
  if (!Object.hasOwn(PREVIEW_SORT_FIELDS, sortField)) {
    throw new RangeError('Choose a supported preview sort column')
  }
  const fields = PREVIEW_SORT_FIELDS[sortField]
  if (!['asc', 'desc'].includes(sortDirection)) {
    throw new RangeError('Choose ascending or descending preview order')
  }
  const direction = sortDirection === 'asc' ? 1 : -1
  return {
    field: sortField,
    direction: sortDirection,
    mongo: Object.fromEntries([
      ...fields.map((field) => [field, direction]),
      ['timecardId', 1],
    ]),
  }
}

function hasPreviousPage(page, loading = false) {
  return !loading && Number(page) > 1
}

function hasNextPage({
  page = 1, pageSize, total, loading = false,
}) {
  if (loading || !Number.isFinite(Number(pageSize)) || Number(pageSize) < 1) {
    return false
  }
  return Number(page) * Number(pageSize) < Number(total || 0)
}

function pageCount(total, pageSize) {
  if (!Number.isFinite(Number(pageSize)) || Number(pageSize) < 1) {
    return 1
  }
  return Math.max(1, Math.ceil(Number(total || 0) / Number(pageSize)))
}

export {
  buildPreviewSort,
  hasNextPage,
  hasPreviousPage,
  pageCount,
}
