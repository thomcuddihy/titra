import './tableRequestFeedback.html'

Template.tableRequestFeedback.helpers({
  loading() {
    const { request } = Template.currentData()
    return request.phase.get() !== 'error' && (!request.ready() || !request.rendered.get())
  },
  failed: () => Template.currentData().request.phase.get() === 'error',
})
Template.tableRequestFeedback.events({
  'click .js-retry-details': (event, templateInstance) => {
    event.preventDefault()
    const { request } = templateInstance.data
    if (request.phase.get() === 'error') request.retry.set(request.retry.get() + 1)
  },
})
