import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const methods = readFileSync(new URL('./taskIntegrationMethods.js', import.meta.url), 'utf8')
const taskSearch = readFileSync(new URL('../../../ui/pages/track/components/tasksearch.js', import.meta.url), 'utf8')
const popup = readFileSync(new URL('../../../ui/pages/track/components/taskSelectPopup.js', import.meta.url), 'utf8')
const timecardMethods = readFileSync(new URL('../../timecards/server/methods.js', import.meta.url), 'utf8')
const detailTable = readFileSync(new URL('../../../ui/pages/details/components/detailtimetable.js', import.meta.url), 'utf8')
const wekanEditor = readFileSync(new URL('../../../ui/pages/overview/editproject/components/wekanInterfaceSettings.js', import.meta.url), 'utf8')
const wekanEditorHtml = readFileSync(new URL('../../../ui/pages/overview/editproject/components/wekanInterfaceSettings.html', import.meta.url), 'utf8')
const projectPrivacy = readFileSync(new URL('../../projects/server/publicationPrivacy.js', import.meta.url), 'utf8')
const projectMethods = readFileSync(new URL('../../projects/server/methods.js', import.meta.url), 'utf8')

test('proxy method requires authentication and non-public project membership', () => {
  assert.match(methods, /mixins:\s*\[authenticationMixin\]/)
  assert.match(methods, /\$or:\s*\[\{ userId: this\.userId \}, \{ admins: this\.userId \}, \{ team: this\.userId \}\]/)
  assert.doesNotMatch(methods, /\{ public: true \}/)
  assert.match(methods, /inactive:\s*\{ \$ne: true \}/)
  assert.match(methods, /Object\.hasOwn\(PROVIDER_SETTING, provider\)/)
  assert.match(methods, /A-Za-z0-9_-/)
})

test('proxy exposes only one generic error and has a strict cumulative DDP limit', () => {
  assert.match(methods, /catch \{[\s\S]*new Meteor\.Error\([\s\S]*'integration-unavailable'/)
  assert.match(methods, /DDPRateLimiter\.addRule\([\s\S]*20, 60 \* 1000\)/)
  assert.match(methods, /userId\(userId\)/)
  assert.doesNotMatch(methods, /connectionId\(/)
  assert.doesNotMatch(methods, /console\.(?:log|error)/)
})

test('task-selection clients do not fetch Zammad or GitLab credentials or endpoints', () => {
  assert.match(methods, /OAuth\.openSecret\(user\.profile\?\.\[\x60\$\{provider\}token\x60\]\)/)
  for (const source of [taskSearch, popup]) {
    assert.match(source, /taskIntegrations\.listSuggestions/)
    assert.doesNotMatch(source, /getUserSetting\(['"](?:zammad|gitlab)(?:token|url)['"]\)/)
    assert.doesNotMatch(source, /PRIVATE-TOKEN|Token token=/)
    assert.doesNotMatch(source, /api\/v[14]\/(?:tickets|\$\{query\})/)
  }
})

test('Siwapp uses the same server-only transport and the client never reads its token', () => {
  assert.match(timecardMethods, /siwapptoken: OAuth\.openSecret\(meteorUser\.profile\.siwapptoken\)/)
  assert.match(timecardMethods, /sendSiwappInvoice\(\{[\s\S]*invoice: invoiceJSON/)
  assert.doesNotMatch(timecardMethods, /fetch\(`\$\{meteorUser\.profile\.siwappurl\}/)
  assert.match(timecardMethods, /DDPRateLimiter\.addRule\([\s\S]*name: 'sendToSiwapp'[\s\S]*5, 60 \* 1000/)
  assert.doesNotMatch(detailTable, /getUserSetting\(['"]siwapptoken['"]\)/)
})

test('Wekan list, swimlane and card traffic uses authenticated server methods only', () => {
  assert.match(methods, /wekan:\s*'enableWekan'/)
  assert.match(methods, /wekanurl: OAuth\.openSecret\(project\.wekanurl\)/)
  assert.match(methods, /requestWekanTaskSuggestions\(\{/)
  assert.match(methods, /taskIntegrations\.inspectWekan/)
  assert.match(methods, /inspectWekanConfiguration\(requestedUrl\)/)
  assert.match(methods, /\{ userId: this\.userId \}, \{ admins: this\.userId \}/)
  assert.match(methods, /INSPECT_WEKAN_METHOD_NAME[\s\S]*5, 60 \* 1000/)

  for (const source of [taskSearch, popup, wekanEditor]) {
    assert.doesNotMatch(source, /window\.fetch/)
    assert.doesNotMatch(source, /authToken/)
    assert.doesNotMatch(source, /DDP\.connect|sandstorm-token|new Mongo\.Collection/)
  }
  assert.match(taskSearch, /loadIntegrationSuggestions\([\s\S]*'wekan'/)
  assert.match(popup, /loadPopupIntegration\([\s\S]*templateInstance,[\s\S]*'wekan'/)
  assert.match(wekanEditor, /taskIntegrations\.inspectWekan/)
})

test('Wekan project credentials are unpublished and edited as a write-only password', () => {
  assert.doesNotMatch(projectPrivacy, /^\s*wekanurl:\s*1,/m)
  assert.match(wekanEditor, /wekanurl:\s*\(\) => ''/)
  assert.match(wekanEditorHtml, /name="wekanurl"[\s\S]*type="password"[\s\S]*autocomplete="new-password"/)
  assert.match(projectMethods, /normalizeWekanProjectFields\(updateJSON\)/)
  assert.match(projectMethods, /OAuth\.sealSecret\(project\.wekanurl\)/)
})

test('Sandstorm Wekan browser integration is explicitly disabled with a clear UI error', () => {
  for (const source of [taskSearch, popup, wekanEditor]) {
    assert.match(source, /Meteor\.settings\?\.public\?\.sandstorm/)
    assert.match(source, /notifications\.wekan_sandstorm_unsupported/)
  }
})
