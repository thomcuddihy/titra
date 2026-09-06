const GLOBAL_SECRET_NAMES = Object.freeze(['google_secret', 'openai_apikey'])
const SERVICE_NAMES = Object.freeze(['googleapi', 'oidc'])
const USER_SECRET_PATHS = Object.freeze([
  'profile.siwapptoken',
  'profile.zammadtoken',
  'profile.gitlabtoken',
  'services.googleapi.serviceData.accessToken',
  'services.googleapi.serviceData.refreshToken',
  'services.oidc.accessToken',
  'services.oidc.refreshToken',
])
const CONFIGURED_VALUE = Object.freeze({ $exists: true, $nin: ['', null] })

function valueAtPath(document, path) {
  return path.split('.').reduce((value, key) => value?.[key], document)
}

function modifiedExactlyOne(result) {
  return result?.modifiedCount === 1 || result === 1
}

async function sealLegacyField({ collection, document, path, sealSecret }) {
  const plaintext = valueAtPath(document, path)
  if (typeof plaintext !== 'string' || plaintext.length === 0) return 0
  const sealed = sealSecret(plaintext)
  const result = await collection.rawCollection().updateOne({
    _id: document._id,
    [path]: plaintext,
  }, { $set: { [path]: sealed } })
  return modifiedExactlyOne(result) ? 1 : 0
}

async function migrateLegacyCredentialEncryption({
  globalSettings,
  serviceConfigurations,
  users,
  projects,
  sealSecret,
}) {
  if (typeof sealSecret !== 'function') throw new TypeError('A credential sealer is required.')
  let migrated = 0

  const settings = await globalSettings.find({
    name: { $in: GLOBAL_SECRET_NAMES }, value: { $type: 'string' },
  }, { fields: { _id: 1, value: 1 } }).fetchAsync()
  for (const setting of settings) {
    // Compare-and-swap prevents a concurrent administrator update from being overwritten.
    // eslint-disable-next-line no-await-in-loop
    migrated += await sealLegacyField({
      collection: globalSettings, document: setting, path: 'value', sealSecret,
    })
  }

  const configurations = await serviceConfigurations.find({
    service: { $in: SERVICE_NAMES }, secret: { $type: 'string' },
  }, { fields: { _id: 1, secret: 1 } }).fetchAsync()
  for (const configuration of configurations) {
    // eslint-disable-next-line no-await-in-loop
    migrated += await sealLegacyField({
      collection: serviceConfigurations,
      document: configuration,
      path: 'secret',
      sealSecret,
    })
  }

  const projectDocuments = await projects.find(
    { wekanurl: { $type: 'string' } }, { fields: { _id: 1, wekanurl: 1 } },
  ).fetchAsync()
  for (const project of projectDocuments) {
    // eslint-disable-next-line no-await-in-loop
    migrated += await sealLegacyField({
      collection: projects, document: project, path: 'wekanurl', sealSecret,
    })
  }

  const userProjection = Object.fromEntries(USER_SECRET_PATHS.map((path) => [path, 1]))
  const legacyTokenSelectors = USER_SECRET_PATHS.map((path) => ({ [path]: { $type: 'string' } }))
  const userDocuments = await users.find(
    { $or: legacyTokenSelectors },
    { fields: { _id: 1, ...userProjection } },
  ).fetchAsync()
  for (const user of userDocuments) {
    for (const path of USER_SECRET_PATHS) {
      // Each field is independently compare-and-swapped so a concurrent token refresh cannot
      // prevent another untouched legacy credential from being protected.
      // eslint-disable-next-line no-await-in-loop
      migrated += await sealLegacyField({ collection: users, document: user, path, sealSecret })
    }
  }

  return migrated
}

async function configuredCredentialExists({
  globalSettings,
  serviceConfigurations,
  users,
  projects,
}) {
  // Fetch only identifiers: startup diagnostics must never read or print a
  // credential value merely to determine whether encryption is required.
  const projection = { fields: { _id: 1 } }
  const userSelectors = USER_SECRET_PATHS.map((path) => ({
    [path]: CONFIGURED_VALUE,
  }))
  const matches = await Promise.all([
    globalSettings.findOneAsync({
      name: { $in: GLOBAL_SECRET_NAMES }, value: CONFIGURED_VALUE,
    }, projection),
    serviceConfigurations.findOneAsync({
      service: { $in: SERVICE_NAMES }, secret: CONFIGURED_VALUE,
    }, projection),
    users.findOneAsync({ $or: userSelectors }, projection),
    projects.findOneAsync({ wekanurl: CONFIGURED_VALUE }, projection),
  ])
  return matches.some(Boolean)
}

export {
  CONFIGURED_VALUE,
  GLOBAL_SECRET_NAMES,
  SERVICE_NAMES,
  USER_SECRET_PATHS,
  configuredCredentialExists,
  migrateLegacyCredentialEncryption,
  modifiedExactlyOne,
  valueAtPath,
}
