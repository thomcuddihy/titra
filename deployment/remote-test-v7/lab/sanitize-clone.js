const labDatabase = 'titra_v7_lab';
const labDb = db.getSiblingDB(labDatabase);

const disabledSettings = [
  'enableOpenIDConnect',
  'enableLDAP',
  'enableWekan',
  'enableZammad',
  'enableGitlab',
  'enableSiwapp',
  'enableUserActionVerification',
  'enableAnonymousLogins',
];
const forcedTrueSettings = [
  'disableUserRegistration',
  'disablePublicProjects',
];
const clearedSettings = [
  'google_clientid',
  'google_secret',
  'openai_apikey',
];
const clearedBrowserSettings = [
  'customHTML',
  'customCSS',
  'customPlaceholderContent',
  'customLogo',
];

function summarize(result) {
  return {
    matched: result.matchedCount || 0,
    modified: result.modifiedCount || 0,
    upserted: result.upsertedCount || 0,
    deleted: result.deletedCount || 0,
  };
}

try {
  const passwordVerifiersBefore = labDb.users.countDocuments({
    'services.password.bcrypt': { $type: 'string', $ne: '' },
  });
  const timecardsBefore = labDb.timecards.countDocuments({});
  const serviceResult = labDb.users.updateMany(
    {},
    [{
      $set: {
        services: {
          $cond: [
            {
              $and: [
                { $eq: [{ $type: '$services.password.bcrypt' }, 'string'] },
                { $ne: ['$services.password.bcrypt', ''] },
              ],
            },
            { password: { bcrypt: '$services.password.bcrypt' } },
            '$$REMOVE',
          ],
        },
      },
    }],
  );
  const profileCredentialResult = labDb.users.updateMany(
    {
      $or: [
        { 'profile.APItoken': { $exists: true } },
        { 'profile.siwapptoken': { $exists: true } },
        { 'profile.siwappurl': { $exists: true } },
        { 'profile.zammadtoken': { $exists: true } },
        { 'profile.zammadurl': { $exists: true } },
        { 'profile.gitlabtoken': { $exists: true } },
        { 'profile.gitlaburl': { $exists: true } },
        { 'profile.enableWekan': { $exists: true } },
        { 'profile.googleAPIexpiresAt': { $exists: true } },
        { 'profile.avatar': { $exists: true } },
        { 'profile.avatarColor': { $exists: true } },
        { actionVerification: { $exists: true } },
      ],
    },
    {
      $unset: {
        'profile.APItoken': '',
        'profile.siwapptoken': '',
        'profile.siwappurl': '',
        'profile.zammadtoken': '',
        'profile.zammadurl': '',
        'profile.gitlabtoken': '',
        'profile.gitlaburl': '',
        'profile.enableWekan': '',
        'profile.googleAPIexpiresAt': '',
        'profile.avatar': '',
        'profile.avatarColor': '',
        actionVerification: '',
      },
    },
  );
  const projectWekanResult = labDb.projects.updateMany(
    {
      $or: [
        { wekanurl: { $exists: true } },
        { selectedWekanList: { $exists: true } },
        { selectedWekanSwimlanes: { $exists: true } },
        { desc: { $exists: true } },
      ],
    },
    {
      $unset: {
        wekanurl: '',
        selectedWekanList: '',
        selectedWekanSwimlanes: '',
        desc: '',
      },
    },
  );
  const loginConfigurationResult = labDb
    .getCollection('meteor_accounts_loginServiceConfiguration')
    .deleteMany({});
  const inboundResult = labDb.inboundinterfaces.deleteMany({});
  const outboundResult = labDb.outboundinterfaces.deleteMany({});
  const webhookVerificationResult = labDb.webhookverification.deleteMany({});

  const disabledResult = labDb.globalsettings.bulkWrite(
    disabledSettings.map((name) => ({
      updateOne: {
        filter: { name },
        update: { $set: { value: false } },
        upsert: true,
      },
    })),
    { ordered: true },
  );
  const forcedTrueResult = labDb.globalsettings.bulkWrite(
    forcedTrueSettings.map((name) => ({
      updateOne: {
        filter: { name },
        update: { $set: { value: true } },
        upsert: true,
      },
    })),
    { ordered: true },
  );
  const clearedResult = labDb.globalsettings.bulkWrite(
    clearedSettings.map((name) => ({
      updateOne: {
        filter: { name },
        update: { $set: { value: '' } },
        upsert: true,
      },
    })),
    { ordered: true },
  );
  const clearedBrowserResult = labDb.globalsettings.bulkWrite(
    clearedBrowserSettings.map((name) => ({
      updateOne: {
        filter: { name },
        update: { $set: { value: '' } },
        upsert: true,
      },
    })),
    { ordered: true },
  );

  const verification = {
    usersWithUnsafeServiceData: labDb.users.aggregate([
      {
        $project: {
          unsafeKeys: {
            $setDifference: [
              {
                $map: {
                  input: { $objectToArray: { $ifNull: ['$services', {}] } },
                  as: 'service',
                  in: '$$service.k',
                },
              },
              ['password'],
            ],
          },
        },
      },
      { $match: { 'unsafeKeys.0': { $exists: true } } },
      { $count: 'count' },
    ]).toArray()[0]?.count || 0,
    usersWithUnsafePasswordData: labDb.users.aggregate([
      {
        $project: {
          unsafeKeys: {
            $setDifference: [
              {
                $map: {
                  input: { $objectToArray: { $ifNull: ['$services.password', {}] } },
                  as: 'passwordField',
                  in: '$$passwordField.k',
                },
              },
              ['bcrypt'],
            ],
          },
        },
      },
      { $match: { 'unsafeKeys.0': { $exists: true } } },
      { $count: 'count' },
    ]).toArray()[0]?.count || 0,
    usersWithInvalidPasswordVerifier: labDb.users.countDocuments({
      $expr: {
        $and: [
          { $ne: [{ $type: '$services.password' }, 'missing'] },
          {
            $or: [
              { $ne: [{ $type: '$services.password.bcrypt' }, 'string'] },
              { $eq: ['$services.password.bcrypt', ''] },
            ],
          },
        ],
      },
    }),
    usersWithProfileCredentials: labDb.users.countDocuments({
      $or: [
        { 'profile.APItoken': { $exists: true } },
        { 'profile.siwapptoken': { $exists: true } },
        { 'profile.siwappurl': { $exists: true } },
        { 'profile.zammadtoken': { $exists: true } },
        { 'profile.zammadurl': { $exists: true } },
        { 'profile.gitlabtoken': { $exists: true } },
        { 'profile.gitlaburl': { $exists: true } },
        { 'profile.enableWekan': { $exists: true } },
        { 'profile.googleAPIexpiresAt': { $exists: true } },
        { 'profile.avatar': { $exists: true } },
        { 'profile.avatarColor': { $exists: true } },
        { actionVerification: { $exists: true } },
      ],
    }),
    projectsWithUnsafeData: labDb.projects.countDocuments({
      $or: [
        { wekanurl: { $exists: true } },
        { selectedWekanList: { $exists: true } },
        { selectedWekanSwimlanes: { $exists: true } },
        { desc: { $exists: true } },
      ],
    }),
    passwordVerifiersBefore,
    passwordVerifiersAfter: labDb.users.countDocuments({
      'services.password.bcrypt': { $type: 'string', $ne: '' },
    }),
    usablePasswordLogins: labDb.users.countDocuments({
      'services.password.bcrypt': { $type: 'string', $ne: '' },
      inactive: { $ne: true },
    }),
    usableAdminPasswordLogins: labDb.users.countDocuments({
      'services.password.bcrypt': { $type: 'string', $ne: '' },
      isAdmin: true,
      inactive: { $ne: true },
    }),
    timecardsBefore,
    timecardsAfter: labDb.timecards.countDocuments({}),
    loginServiceConfigurations: labDb
      .getCollection('meteor_accounts_loginServiceConfiguration')
      .countDocuments({}),
    inboundInterfaces: labDb.inboundinterfaces.countDocuments({}),
    outboundInterfaces: labDb.outboundinterfaces.countDocuments({}),
    webhookVerificationInterfaces: labDb.webhookverification.countDocuments({}),
    unsafeDisabledSettings: labDb.globalsettings.countDocuments({
      name: { $in: disabledSettings },
      value: { $ne: false },
    }),
    unsafeForcedTrueSettings: labDb.globalsettings.countDocuments({
      name: { $in: forcedTrueSettings },
      value: { $ne: true },
    }),
    unsafeRestrictedSettings: labDb.globalsettings.countDocuments({
      name: { $in: clearedSettings },
      value: { $ne: '' },
    }),
    unsafeBrowserSettings: labDb.globalsettings.countDocuments({
      name: { $in: clearedBrowserSettings },
      value: { $ne: '' },
    }),
    disabledSettingsPresent: labDb.globalsettings.countDocuments({
      name: { $in: disabledSettings },
      value: false,
    }),
    forcedTrueSettingsPresent: labDb.globalsettings.countDocuments({
      name: { $in: forcedTrueSettings },
      value: true,
    }),
    clearedSettingsPresent: labDb.globalsettings.countDocuments({
      name: { $in: clearedSettings },
      value: '',
    }),
    clearedBrowserSettingsPresent: labDb.globalsettings.countDocuments({
      name: { $in: clearedBrowserSettings },
      value: '',
    }),
  };

  const safe = verification.usersWithUnsafeServiceData === 0
    && verification.usersWithUnsafePasswordData === 0
    && verification.usersWithInvalidPasswordVerifier === 0
    && verification.usersWithProfileCredentials === 0
    && verification.projectsWithUnsafeData === 0
    && verification.passwordVerifiersAfter === verification.passwordVerifiersBefore
    && verification.timecardsAfter === verification.timecardsBefore
    && verification.loginServiceConfigurations === 0
    && verification.inboundInterfaces === 0
    && verification.outboundInterfaces === 0
    && verification.webhookVerificationInterfaces === 0
    && verification.unsafeDisabledSettings === 0
    && verification.unsafeForcedTrueSettings === 0
    && verification.unsafeRestrictedSettings === 0
    && verification.unsafeBrowserSettings === 0
    && verification.disabledSettingsPresent === disabledSettings.length
    && verification.forcedTrueSettingsPresent === forcedTrueSettings.length
    && verification.clearedSettingsPresent === clearedSettings.length
    && verification.clearedBrowserSettingsPresent === clearedBrowserSettings.length;

  if (!safe) {
    throw new Error(`Post-sanitization verification failed: ${JSON.stringify(verification)}`);
  }

  print(`TITRA_LAB_SANITIZE=${JSON.stringify({
    userServices: summarize(serviceResult),
    userProfileCredentials: summarize(profileCredentialResult),
    projectWekanData: summarize(projectWekanResult),
    loginServiceConfigurations: summarize(loginConfigurationResult),
    inboundInterfaces: summarize(inboundResult),
    outboundInterfaces: summarize(outboundResult),
    webhookVerificationInterfaces: summarize(webhookVerificationResult),
    disabledSettings: summarize(disabledResult),
    forcedTrueSettings: summarize(forcedTrueResult),
    clearedSettings: summarize(clearedResult),
    clearedBrowserSettings: summarize(clearedBrowserResult),
    verification,
  })}`);
  print(`TITRA_LAB_PASSWORD_LOGINS=${verification.usablePasswordLogins}`);
  print(`TITRA_LAB_ADMIN_PASSWORD_LOGINS=${verification.usableAdminPasswordLogins}`);
} catch (error) {
  print(`TITRA_LAB_SANITIZE_ERROR=${error.message}`);
  quit(2);
}
