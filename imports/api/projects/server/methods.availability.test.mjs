import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('./methods.js', import.meta.url), 'utf8')

function methodBlock(name, nextName = null) {
  const start = source.indexOf(`const ${name} = new ValidatedMethod({`)
  assert.notEqual(start, -1, `${name} is missing`)
  if (nextName == null) return source.slice(start)
  const end = source.indexOf(`const ${nextName} = new ValidatedMethod({`, start + 1)
  assert.notEqual(end, -1, `${nextName} after ${name} is missing`)
  return source.slice(start, end)
}

test('all-project statistics use projected project IDs and scalar/grouped aggregates', () => {
  const block = methodBlock('getAllProjectStats', 'getProjectUsers')
  assert.match(block, /boundedVisibleProjectIds\(\{ \$and: andCondition \}\)/)
  assert.match(block, /aggregateProjectMethodScalar\(\{/)
  assert.match(block, /aggregateProjectMonthTotals\(\{/)
  assert.doesNotMatch(block, /Timecards\.find\(/)
  assert.doesNotMatch(block, /for \(const timecard/)
})

test('project-user identities are projected and sentinel bounded', () => {
  const block = methodBlock('getProjectUsers', 'updateProject')
  assert.match(block, /fetchBoundedProjectMethodRows\(\{/)
  assert.match(block, /fields: \{ 'profile\.name': 1 \}/)
  assert.match(block, /label: 'Project users'/)
  assert.doesNotMatch(block, /Meteor\.users\.find\(selector, \{/)
})

test('top-task and distribution methods use bounded timed aggregations', () => {
  const topTasks = methodBlock('getTopTasks', 'getProjectDistribution')
  assert.match(topTasks, /boundedVisibleProjectIds\(\{ \$and: andCondition \}\)/)
  assert.match(topTasks, /aggregateBoundedProjectMethodRows\(\{/)
  assert.match(topTasks, /\{ \$limit: TOP_TASK_RESULT_LIMIT \}/)
  assert.doesNotMatch(topTasks, /rawCollection\.aggregate/)

  const distribution = methodBlock('getProjectDistribution', 'addTeamMember')
  assert.match(distribution, /boundedVisibleProjectIds\(\{ \$and: andCondition \}\)/)
  assert.match(distribution, /aggregateBoundedProjectMethodRows\(\{/)
  assert.match(distribution, /maxResults = MAX_PROJECT_SCOPE_IDS/)
  assert.match(distribution, /boundedPeriodRange\(/)
  assert.doesNotMatch(distribution, /rawCollection\.aggregate/)
})

test('project search is text-limited and scores only bounded projected rows', () => {
  const block = methodBlock('searchForProject')
  assert.match(block, /MAX_RESOURCE_SCOPE_TEXT/)
  assert.match(block, /fetchBoundedProjectMethodRows\(\{/)
  assert.match(block, /fields: \{ _id: 1, name: 1 \}/)
  assert.match(block, /bestProjectMatch\(projects, query, calculateSimilarity\)/)
  assert.doesNotMatch(block, /const projects = await Projects\.find\(/)
})

test('shared storage wrappers enforce the database aggregation policy', () => {
  assert.match(source, /function aggregateTimecards\(pipeline, options\)/)
  assert.match(source, /aggregate\(pipeline, options\)\.toArray\(\)/)
  assert.match(source, /fields: \{ _id: 1 \}/)
  assert.match(source, /label: 'Visible projects'/)
})
