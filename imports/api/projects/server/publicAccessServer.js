import { Globalsettings } from '../../globalsettings/globalsettings.js'
import {
  projectAudienceClauses,
  publicProjectsDisabled,
} from './publicAccessPolicy.js'

async function currentPublicProjectsDisabled() {
  const setting = await Globalsettings.findOneAsync({ name: 'disablePublicProjects' }, {
    fields: { value: 1 },
  })
  return publicProjectsDisabled(setting?.value)
}

async function currentProjectAudienceClauses(userId) {
  return projectAudienceClauses(userId, await currentPublicProjectsDisabled())
}

/** Revoke fixed-cursor publications when public access is switched off. */
async function stopPublicationOnPublicAccessDisable(context, initiallyDisabled) {
  if (initiallyDisabled) return undefined
  let handle
  context.onStop(() => handle?.stop())
  handle = await Globalsettings.find({ name: 'disablePublicProjects' }, {
    fields: { value: 1 },
  }).observeChangesAsync({
    added(_id, fields) {
      if (publicProjectsDisabled(fields.value)) context.stop()
    },
    changed(_id, fields) {
      if (publicProjectsDisabled(fields.value)) context.stop()
    },
  })
  return handle
}

export {
  currentProjectAudienceClauses,
  currentPublicProjectsDisabled,
  stopPublicationOnPublicAccessDisable,
}
