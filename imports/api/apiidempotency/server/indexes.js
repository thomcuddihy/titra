import ApiIdempotency from '../apiidempotency.js'
import Timecards from '../../timecards/timecards.js'
import Tasks from '../../tasks/tasks.js'

async function ensureApiV6Indexes() {
  await Promise.all([
    ApiIdempotency.rawCollection().createIndex(
      { expiresAt: 1 },
      { name: 'api_idempotency_expiry', expireAfterSeconds: 0 },
    ),
    ApiIdempotency.rawCollection().createIndex(
      { status: 1, updatedAt: 1 },
      { name: 'api_idempotency_status_updated' },
    ),
    ApiIdempotency.rawCollection().createIndex(
      { userId: 1, operation: 1, createdAt: -1 },
      { name: 'api_idempotency_owner_operation_created' },
    ),
    Timecards.rawCollection().createIndex(
      { userId: 1, date: 1, _id: 1 },
      { name: 'api_timecards_owner_date_id' },
    ),
    Timecards.rawCollection().createIndex(
      { projectId: 1, date: 1, _id: 1 },
      { name: 'api_timecards_project_date_id' },
    ),
    Timecards.rawCollection().createIndex(
      { projectId: 1, userId: 1 },
      { name: 'api_timecards_project_user' },
    ),
    Timecards.rawCollection().createIndex(
      { projectId: 1, task: 1 },
      { name: 'api_timecards_project_task' },
    ),
    Tasks.rawCollection().createIndex(
      { projectId: 1, _id: 1 },
      { name: 'api_tasks_project_id' },
    ),
  ])
}

export { ensureApiV6Indexes }
