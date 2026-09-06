import Tasks from '../tasks.js'
import {
  insertDocumentWithId,
  recoverCreatedDocument,
} from '../../apiidempotency/server/resourceCreate.js'

async function insertAPIProjectTaskWithId(taskFields, taskId) {
  const result = await insertDocumentWithId(Tasks, taskFields, taskId)
  return { taskId, created: result.created }
}

async function recoverAPIProjectTaskWithId(taskFields, taskId) {
  const result = await recoverCreatedDocument(Tasks, taskFields, taskId)
  return result ? { taskId, created: false } : null
}

export { insertAPIProjectTaskWithId, recoverAPIProjectTaskWithId }
