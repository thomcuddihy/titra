function escapeDataTableText(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character])
}

/**
 * Frappe DataTable 1.x treats both column names and formatter output as HTML.
 * Encode every heading and give otherwise-unformatted cells a plain-text
 * formatter. Callers that deliberately return fixed markup retain their
 * explicit formatter and remain responsible for encoding interpolated data.
 */
function secureDataTableColumns(columns) {
  if (!Array.isArray(columns)) return []
  return columns.map((column) => {
    if (typeof column === 'string') {
      return {
        name: escapeDataTableText(column),
        format: escapeDataTableText,
      }
    }
    const securedColumn = {
      ...column,
      name: escapeDataTableText(column?.name),
    }
    if (typeof securedColumn.format !== 'function') {
      securedColumn.format = escapeDataTableText
    }
    return securedColumn
  })
}

export { escapeDataTableText, secureDataTableColumns }
