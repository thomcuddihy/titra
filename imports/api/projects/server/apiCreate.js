import Projects from '../projects.js'
import {
  insertDocumentWithId,
  recoverCreatedDocument,
} from '../../apiidempotency/server/resourceCreate.js'

async function insertAPIProjectWithId(projectFields, projectId) {
  const result = await insertDocumentWithId(Projects, projectFields, projectId)
  return { projectId, created: result.created }
}

async function recoverAPIProjectWithId(projectFields, projectId) {
  const result = await recoverCreatedDocument(Projects, projectFields, projectId)
  return result ? { projectId, created: false } : null
}

export { insertAPIProjectWithId, recoverAPIProjectWithId }
