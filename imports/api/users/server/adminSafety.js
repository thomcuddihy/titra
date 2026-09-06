class AdminSafetyError extends Error {
  constructor(code) {
    super(code)
    this.name = 'AdminSafetyError'
    this.code = code
  }
}

function affectedExactlyOne(result) {
  return result?.modifiedCount === 1 || result?.upsertedCount === 1
}

async function reserveInitialAdministrator({ userId }, {
  countUsers,
  findActiveAdministrator,
  claimBootstrap,
}) {
  if (typeof userId !== 'string' || !userId) return false
  if (await countUsers() !== 0 || await findActiveAdministrator()) return false
  try {
    return affectedExactlyOne(await claimBootstrap(userId))
  } catch (error) {
    if (error?.code === 11000) return false
    throw error
  }
}

async function assertAdministrativeContinuity({ targetUserId, removesAccess }, {
  findUser,
  countActiveAdministrators,
}) {
  const target = await findUser(targetUserId)
  if (!target) throw new AdminSafetyError('user-not-found')
  if (removesAccess && target.isAdmin === true && target.inactive !== true
      && await countActiveAdministrators() <= 1) {
    throw new AdminSafetyError('last-active-administrator')
  }
  return target
}

export {
  AdminSafetyError,
  affectedExactlyOne,
  assertAdministrativeContinuity,
  reserveInitialAdministrator,
}
