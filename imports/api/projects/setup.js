import Projects from './projects.js'
import { currentPublicProjectsDisabled } from './server/publicAccessServer.js'
import { projectDescriptionText } from '../../utils/userContentSecurity.js'

export default async function initNewUser(userId, info) {
  if (info.profile) {
    const description = projectDescriptionText(info.profile.currentLanguageProjectDesc)
    if (Meteor.settings.public.sandstorm && !await currentPublicProjectsDisabled()) {
      if (!await Projects.findOneAsync({ public: true })) {
        await Projects.insertAsync({
          _id: 'sandstorm',
          userId,
          name: `👋 ${info.profile?.name}'s ${info.profile?.currentLanguageProject}`,
          desc: description,
          public: true,
        })
      }
    } else {
      await Projects.insertAsync({
        userId,
        name: `👋 ${info.profile?.name}'s ${info.profile?.currentLanguageProject}`,
        desc: description,
      })
    }
  }
}
