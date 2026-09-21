import { FlowRouter } from 'meteor/ostrio:flow-router-extra'
import { MAX_PAGE_PARAMETER, normalizePageParameter } from '../../../../utils/pageParameter.js'
import './pagination.html'

function pageCount(totalEntries, limit) {
  // An unavailable count is not an empty result: preserve direct page links
  // until the subscription or method has returned its first count.
  if (!Number.isSafeInteger(totalEntries) || totalEntries < 0
    || !Number.isSafeInteger(limit) || limit < 1) return undefined
  return Math.min(MAX_PAGE_PARAMETER, Math.max(1, Math.ceil(totalEntries / limit)))
}

function navigateToPage(templateInstance, page) {
  const numPages = templateInstance.numPages.get()
  if (numPages === undefined || !Number.isSafeInteger(page)
    || page < 1 || page > numPages || page === templateInstance.currentPage.get()) return
  templateInstance.currentPage.set(page)
  FlowRouter.setQueryParams({ page: page === 1 ? null : page })
}

Template.pagination.onCreated(function paginationCreated() {
  this.currentPage = new ReactiveVar(1)
  this.numPages = new ReactiveVar()
  this.autorun(() => {
    const numPages = pageCount(this.data?.totalEntries?.get(), this.data?.limit?.get())
    const requestedPage = FlowRouter.getQueryParam('page')
    let page = normalizePageParameter(requestedPage)
    if (numPages !== undefined && page > numPages) page = 1
    this.numPages.set(numPages)
    this.currentPage.set(page)
    if (requestedPage != null && String(requestedPage) !== String(page)) {
      FlowRouter.setQueryParams({ page: null })
    }
  })
})
Template.pagination.helpers({
  showPagination() {
    return Template.instance().numPages.get() > 1
  },
  getPages() {
    const numPages = Template.instance().numPages.get()
    return Array.from({ length: numPages ?? 0 }, (_, index) => index + 1)
  },
  activeClass(page) {
    return page === Template.instance().currentPage.get() ? 'active' : ''
  },
  disabledClass(type) {
    const templateInstance = Template.instance()
    const numPages = templateInstance.numPages.get()
    const currentPage = templateInstance.currentPage.get()
    if (numPages === undefined
      || (type === 'previous' && currentPage <= 1)
      || (type === 'next' && currentPage >= numPages)) return 'disabled'
    return ''
  },
})
Template.pagination.events({
  'click .js-previous': (event) => {
    event.preventDefault()
    const templateInstance = Template.instance()
    navigateToPage(templateInstance, templateInstance.currentPage.get() - 1)
  },
  'click .js-next': (event) => {
    event.preventDefault()
    const templateInstance = Template.instance()
    navigateToPage(templateInstance, templateInstance.currentPage.get() + 1)
  },
  'click .js-page-number': (event) => {
    event.preventDefault()
    const pageText = $(event.currentTarget).text().trim()
    const page = normalizePageParameter(pageText)
    if (String(page) !== pageText) return
    navigateToPage(Template.instance(), page)
  },
})
