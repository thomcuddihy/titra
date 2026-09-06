import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CONFIGURED_VALUE,
  configuredCredentialExists,
  migrateLegacyCredentialEncryption,
  modifiedExactlyOne,
  valueAtPath,
} from './credentialEncryptionMigration.js'

function get(document, path) {
  return path.split('.').reduce((value, key) => value?.[key], document)
}

function set(document, path, value) {
  const parts = path.split('.')
  let target = document
  for (const part of parts.slice(0, -1)) {
    target[part] ??= {}
    target = target[part]
  }
  target[parts.at(-1)] = value
}

class FakeCollection {
  constructor(documents) {
    this.documents = documents.map((document) => structuredClone(document))
    this.selectors = []
  }

  find() {
    return { fetchAsync: async () => this.documents.map((document) => structuredClone(document)) }
  }

  rawCollection() {
    return {
      updateOne: async (selector, modifier) => {
        this.selectors.push(structuredClone(selector))
        const [path, expected] = Object.entries(selector).find(([key]) => key !== '_id')
        const document = this.documents.find((item) => (
          item._id === selector._id && get(item, path) === expected
        ))
        if (!document) return { modifiedCount: 0 }
        const [updatedPath, value] = Object.entries(modifier.$set)[0]
        set(document, updatedPath, value)
        return { modifiedCount: 1 }
      },
    }
  }
}

test('configured startup migration seals legacy settings, service secrets and user tokens', async () => {
  const settings = new FakeCollection([
    { _id: 'gs1', name: 'google_secret', value: 'google-secret' },
    { _id: 'gs2', name: 'openai_apikey', value: { algorithm: 'aes-128-gcm' } },
  ])
  const configurations = new FakeCollection([
    { _id: 'sc1', service: 'oidc', secret: 'oidc-secret' },
  ])
  const projects = new FakeCollection([
    { _id: 'p1', wekanurl: 'https://wekan.example.test/api/boards/b/export?authToken=secret' },
  ])
  const users = new FakeCollection([{
    _id: 'u1', profile: { zammadtoken: 'zammad-secret' }, services: {
      googleapi: { serviceData: { accessToken: 'google-access', refreshToken: '' } },
      oidc: { accessToken: { algorithm: 'aes-128-gcm' }, refreshToken: 'oidc-refresh' },
    },
  }])
  const migrated = await migrateLegacyCredentialEncryption({
    globalSettings: settings,
    serviceConfigurations: configurations,
    users,
    projects,
    sealSecret: (value) => ({ algorithm: 'aes-128-gcm', protected: value }),
  })

  assert.equal(migrated, 6)
  assert.deepEqual(settings.documents[0].value, {
    algorithm: 'aes-128-gcm', protected: 'google-secret',
  })
  assert.deepEqual(configurations.documents[0].secret, {
    algorithm: 'aes-128-gcm', protected: 'oidc-secret',
  })
  assert.deepEqual(projects.documents[0].wekanurl, {
    algorithm: 'aes-128-gcm',
    protected: 'https://wekan.example.test/api/boards/b/export?authToken=secret',
  })
  assert.deepEqual(get(users.documents[0], 'services.googleapi.serviceData.accessToken'), {
    algorithm: 'aes-128-gcm', protected: 'google-access',
  })
  assert.equal(get(users.documents[0], 'services.googleapi.serviceData.refreshToken'), '')
  assert.deepEqual(get(users.documents[0], 'services.oidc.refreshToken'), {
    algorithm: 'aes-128-gcm', protected: 'oidc-refresh',
  })
  assert.deepEqual(get(users.documents[0], 'profile.zammadtoken'), {
    algorithm: 'aes-128-gcm', protected: 'zammad-secret',
  })
  assert.equal(settings.selectors[0].value, 'google-secret')
  assert.equal(users.selectors[0]['profile.zammadtoken'], 'zammad-secret')
  assert.equal(
    users.selectors[1]['services.googleapi.serviceData.accessToken'], 'google-access',
  )
})

test('migration validates its sealer and compare-and-swap result shapes', async () => {
  await assert.rejects(() => migrateLegacyCredentialEncryption({
    globalSettings: new FakeCollection([]),
    serviceConfigurations: new FakeCollection([]),
    users: new FakeCollection([]),
    projects: new FakeCollection([]),
  }), TypeError)
  assert.equal(modifiedExactlyOne({ modifiedCount: 1 }), true)
  assert.equal(modifiedExactlyOne({ modifiedCount: 0 }), false)
  assert.equal(modifiedExactlyOne(1), true)
  assert.equal(valueAtPath({ a: { b: 'value' } }, 'a.b'), 'value')
})

test('keyless-start check detects every credential store without reading values', async () => {
  function existenceCollection(result) {
    return {
      calls: [],
      async findOneAsync(selector, options) {
        this.calls.push({ selector, options })
        return result ? { _id: 'credential-owner' } : undefined
      },
    }
  }

  for (const presentAt of ['globalSettings', 'serviceConfigurations', 'users', 'projects']) {
    const stores = Object.fromEntries([
      'globalSettings', 'serviceConfigurations', 'users', 'projects',
    ].map((name) => [name, existenceCollection(name === presentAt)]))
    assert.equal(await configuredCredentialExists(stores), true, presentAt)
    for (const collection of Object.values(stores)) {
      assert.deepEqual(collection.calls[0].options, { fields: { _id: 1 } })
    }
  }

  const emptyStores = Object.fromEntries([
    'globalSettings', 'serviceConfigurations', 'users', 'projects',
  ].map((name) => [name, existenceCollection(false)]))
  assert.equal(await configuredCredentialExists(emptyStores), false)
  assert.deepEqual(CONFIGURED_VALUE, { $exists: true, $nin: ['', null] })
})
