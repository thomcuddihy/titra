import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

function dataModule(source) {
  return `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
}

const source = fs.readFileSync(new URL('./googleOAuthState.js', import.meta.url), 'utf8')
const {
  GOOGLE_OAUTH_STATE_LIFETIME_MS,
  GoogleOAuthStateError,
  consumeGoogleOAuthState,
  credentialTokenDigest,
  issueGoogleOAuthState,
} = await import(dataModule(source))

const NOW = new Date('2026-09-03T00:00:00.000Z')
const TOKEN_A = 'A'.repeat(43)

function memoryDependencies({ activeUsers = ['user-a'], token = TOKEN_A } = {}) {
  const bindings = new Map()
  return {
    bindings,
    dependencies: {
      now: () => new Date(NOW),
      generateCredentialToken: () => token,
      findActiveUser: async (userId) => (activeUsers.includes(userId) ? { _id: userId } : null),
      replaceBinding: async (binding) => {
        bindings.set(binding.userId, { _id: binding.userId, ...binding })
        return { matchedCount: 0, upsertedCount: 1 }
      },
      findBinding: async ({ tokenHash, consumedAt }) => [...bindings.values()].find(
        (binding) => binding.tokenHash === tokenHash && binding.expiresAt > consumedAt,
      ),
      removeBinding: async ({ bindingId, tokenHash, consumedAt }) => {
        const binding = bindings.get(bindingId)
        if (!binding || binding.tokenHash !== tokenHash || binding.expiresAt <= consumedAt) {
          return { deletedCount: 0 }
        }
        bindings.delete(bindingId)
        return { deletedCount: 1 }
      },
    },
  }
}

async function rejectsWithCode(operation, code) {
  await assert.rejects(operation, (error) => (
    error instanceof GoogleOAuthStateError && error.code === code
  ))
}

test('issue binds an opaque token to the authenticated active user without storing it', async () => {
  const { bindings, dependencies } = memoryDependencies()
  const credentialToken = await issueGoogleOAuthState({ userId: 'user-a' }, dependencies)

  assert.equal(credentialToken, TOKEN_A)
  assert.deepEqual([...bindings.keys()], ['user-a'])
  const binding = bindings.get('user-a')
  assert.equal(binding.userId, 'user-a')
  assert.equal(binding.tokenHash, credentialTokenDigest(TOKEN_A))
  assert.equal(JSON.stringify(binding).includes(TOKEN_A), false)
  assert.equal(
    binding.expiresAt.getTime() - binding.createdAt.getTime(),
    GOOGLE_OAUTH_STATE_LIFETIME_MS,
  )
})

test('issue rejects missing, malformed, and inactive initiating identities', async () => {
  for (const userId of [undefined, '', { $ne: null }, '../user']) {
    const { dependencies } = memoryDependencies()
    await rejectsWithCode(
      () => issueGoogleOAuthState({ userId }, dependencies),
      'google-oauth-authentication-required',
    )
  }
  const { dependencies } = memoryDependencies({ activeUsers: [] })
  await rejectsWithCode(
    () => issueGoogleOAuthState({ userId: 'user-a' }, dependencies),
    'google-oauth-authentication-required',
  )
})

test('consume resolves only the server-bound user and deletes the binding once', async () => {
  const { bindings, dependencies } = memoryDependencies()
  await issueGoogleOAuthState({ userId: 'user-a' }, dependencies)

  assert.equal(
    await consumeGoogleOAuthState({ credentialToken: TOKEN_A }, dependencies),
    'user-a',
  )
  assert.equal(bindings.size, 0)
  await rejectsWithCode(
    () => consumeGoogleOAuthState({ credentialToken: TOKEN_A }, dependencies),
    'google-oauth-state-invalid',
  )
})

test('a valid state can select only its authenticated initiating user', async () => {
  const tokenB = 'B'.repeat(43)
  const { dependencies } = memoryDependencies({ activeUsers: ['user-a', 'user-b'] })
  await issueGoogleOAuthState({ userId: 'user-a' }, dependencies)
  dependencies.generateCredentialToken = () => tokenB
  await issueGoogleOAuthState({ userId: 'user-b' }, dependencies)

  assert.equal(
    await consumeGoogleOAuthState({ credentialToken: TOKEN_A }, dependencies),
    'user-a',
  )
  assert.equal(
    await consumeGoogleOAuthState({ credentialToken: tokenB }, dependencies),
    'user-b',
  )
})

test('tampered, malformed, and expired credential state cannot select a user', async () => {
  const { bindings, dependencies } = memoryDependencies()
  await issueGoogleOAuthState({ userId: 'user-a' }, dependencies)

  for (const credentialToken of ['B'.repeat(43), 'short', { $ne: null }]) {
    await rejectsWithCode(
      () => consumeGoogleOAuthState({ credentialToken }, dependencies),
      'google-oauth-state-invalid',
    )
  }
  assert.equal(bindings.size, 1)
  dependencies.now = () => new Date(NOW.getTime() + GOOGLE_OAUTH_STATE_LIFETIME_MS + 1)
  await rejectsWithCode(
    () => consumeGoogleOAuthState({ credentialToken: TOKEN_A }, dependencies),
    'google-oauth-state-invalid',
  )
})

test('a user deactivated before callback cannot receive tokens and state stays consumed', async () => {
  const activeUsers = ['user-a']
  const { bindings, dependencies } = memoryDependencies({ activeUsers })
  await issueGoogleOAuthState({ userId: 'user-a' }, dependencies)
  activeUsers.length = 0

  await rejectsWithCode(
    () => consumeGoogleOAuthState({ credentialToken: TOKEN_A }, dependencies),
    'google-oauth-authentication-required',
  )
  assert.equal(bindings.size, 0)
})

test('concurrent replay claims have exactly one winner', async () => {
  const { dependencies } = memoryDependencies()
  await issueGoogleOAuthState({ userId: 'user-a' }, dependencies)

  const outcomes = await Promise.allSettled([
    consumeGoogleOAuthState({ credentialToken: TOKEN_A }, dependencies),
    consumeGoogleOAuthState({ credentialToken: TOKEN_A }, dependencies),
  ])
  assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1)
  assert.equal(outcomes.filter((outcome) => outcome.status === 'rejected').length, 1)
})

test('client and callback use the opaque Meteor credential token rather than state userId', () => {
  const client = fs.readFileSync(new URL('./google_client.js', import.meta.url), 'utf8')
  const server = fs.readFileSync(new URL('./google_server.js', import.meta.url), 'utf8')

  assert.match(client, /Meteor\.callAsync\('googleapi\.beginAuthorization'\)/)
  assert.match(client, /OAuth\._stateParam\(loginStyle, credentialToken/)
  assert.doesNotMatch(client, /userId\s*:\s*Meteor\.userId\(\)/)
  assert.match(server, /OAuth\._credentialTokenFromQuery\(query\)/)
  assert.match(server, /consumeGoogleOAuthState/)
  assert.doesNotMatch(server, /JSON\.parse\(Buffer\.from\(query\.state/)
  assert.match(server, /inactive:\s*\{\s*\$ne:\s*true\s*\}/)
  assert.doesNotMatch(server, /\$\{response\.error\}/)
  assert.doesNotMatch(
    server,
    /console\.(?:log|error)\(\s*(?:error|query|tokens|credentialToken|tokenHash|userId)\b/,
  )
})
