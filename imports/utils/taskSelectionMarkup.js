function escapeTaskSelectionText(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character])
}

/**
 * Frappe DataTable formatters return HTML. Encode the task separately from the
 * fixed markup so upstream task providers cannot create elements or attributes.
 * HTML parsing restores the original value in data-task for the click handler.
 */
function taskSelectionCell(value) {
  const safeValue = escapeTaskSelectionText(value)
  return `<button type="button" class="btn text-primary py-0 js-select-task" data-task="${safeValue}"><i class="fa fa-plus"></i></button><span>${safeValue}</span>`
}

export { escapeTaskSelectionText, taskSelectionCell }
