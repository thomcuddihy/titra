import { FlowRouter } from 'meteor/ostrio:flow-router-extra'
import { LIMIT_OPTIONS, normalizeLimitParameter } from '../../../../utils/limitParameter.js'
import './limitpicker.html'

Template.limitpicker.onCreated(function createLimitPicker() {
  this.limit = new ReactiveVar(25)
  this.autorun(() => {
    this.limit.set(normalizeLimitParameter(FlowRouter.getQueryParam('limit')))
  })
})
Template.limitpicker.events({
  'change #limitpicker': (event, templateInstance) => {
    const limit = normalizeLimitParameter($(event.currentTarget).val())
    templateInstance.limit.set(limit)
    FlowRouter.setQueryParams({ limit, page: null })
  },
})
Template.limitpicker.helpers({
  limits() {
    const limit = Template.instance().limit.get()
    // Valid bookmarked custom sizes still have an honest, selected option.
    return [...new Set([...LIMIT_OPTIONS, limit])].sort((a, b) => a - b)
  },
  selected(limit) { return limit === Template.instance().limit.get() },
})
