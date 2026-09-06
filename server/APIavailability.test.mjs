import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('./APIroutes.js', import.meta.url), 'utf8')

function routeBlock(path, nextPath) {
  const start = source.indexOf(`WebApp.handlers.use('${path}'`)
  assert.notEqual(start, -1, `${path} route is missing`)
  const end = nextPath == null
    ? source.length
    : source.indexOf(`WebApp.handlers.use('${nextPath}'`, start + 1)
  assert.notEqual(end, -1, `${nextPath} route after ${path} is missing`)
  return source.slice(start, end)
}

test('all legacy time-entry arrays use sentinel-bounded reads', () => {
  for (const [path, nextPath] of [
    ['/timeentry/list/', '/timeentry/daterange-page/'],
    ['/timeentry/daterange/', '/project/list/'],
    ['/project/timeentries/', '/project/users/'],
    ['/project/timeentriesfordaterange/', '/project/create/'],
  ]) {
    const block = routeBlock(path, nextPath)
    assert.match(block, /fetchBoundedLegacyList\(\{/)
    assert.match(block, /sort: \{ date: 1, _id: 1 \}/)
    assert.doesNotMatch(block, /const (?:payload|timecards) = await Timecards\.find\(/)
  }
})

test('owner and project range routes enforce the inclusive 366-day ceiling', () => {
  for (const [path, nextPath] of [
    ['/timeentry/daterange-page/', '/timeentry/daterange/'],
    ['/timeentry/daterange/', '/project/list/'],
    ['/project/timeentriesfordaterange-page/', '/project/timeentriesfordaterange/'],
    ['/project/timeentriesfordaterange/', '/project/create/'],
  ]) {
    const block = routeBlock(path, nextPath)
    assert.match(block, /dateRange = dateOnlyRange\(from, to\)/)
    assert.match(block, /assertDateRangeLimit\(dateRange\)/)
  }
})

test('project, project-user and task list routes have fixed result ceilings', () => {
  assert.match(routeBlock('/project/list/', '/project/timeentries/'), /fetchBoundedLegacyList\(\{/)
  const users = routeBlock('/project/users/', '/project/timeentriesfordaterange-page/')
  assert.match(users, /fetchBoundedAggregationList\(\{/)
  assert.match(users, /\{ \$group: \{ _id: '\$userId' \} \}/)
  assert.doesNotMatch(users, /\.distinct\(/)
  assert.match(users, /limit: MAX_LEGACY_RESULT_LIMIT/)
  assert.match(routeBlock('/project/tasks/', '/project/task/stats/'), /fetchBoundedLegacyList\(\{/)
})

test('task statistics delegate to one grouped bounded implementation', () => {
  const block = routeBlock('/project/task/stats/', '/user/me/')
  assert.match(block, /fetchBoundedProjectTaskStats\(\{/)
  assert.match(block, /aggregateTimecards:/)
  assert.doesNotMatch(block, /Promise\.all\(tasks\.map/)
  assert.doesNotMatch(block, /task: task\.name/)
})

test('legacy overflow is explicit rather than returning a partial array', () => {
  assert.match(source, /error\.code === 'legacy-result-too-large'/)
  assert.match(source, /sendResponse\(res, 413, oversizedMessage\)/)
  assert.doesNotMatch(source, /\.slice\(0, MAX_LEGACY_RESULT_LIMIT\)/)
})

test('HTTP project-task preview applies the live public-project disable policy', () => {
  assert.match(source, /async function previewAPIProjectTask\(options\)/)
  assert.match(source, /const publicDisabled = await currentPublicProjectsDisabled\(\)/)
  assert.match(source, /canView: \(project, userId\) => canViewProjectUnderPolicy\(/)
  const route = routeBlock('/project/task/get/', '/project/task/details/')
  assert.match(route, /previewTask: previewAPIProjectTask/)
  assert.doesNotMatch(route, /previewTask: \(options\) => getProjectTaskPreview/)
})

test('task and suggestion previews use bounded scalar reference aggregations', () => {
  const taskReferences = source.slice(
    source.indexOf('async function inspectProjectTaskReferences'),
    source.indexOf('const taskLifecycleDependencies'),
  )
  assert.match(taskReferences, /fetchBoundedAggregationList\(\{/)
  assert.match(taskReferences, /maxLimit: 1/)
  const suggestionUsage = source.slice(
    source.indexOf('async function taskSuggestionUsage'),
    source.indexOf('const suggestionLifecycleDependencies'),
  )
  assert.match(suggestionUsage, /fetchBoundedAggregationList\(\{/)
  assert.match(suggestionUsage, /projectCount: \{ \$sum: 1 \}/)
  assert.doesNotMatch(suggestionUsage, /\$addToSet/)
})
