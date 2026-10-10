import type { PoolClient } from 'pg';
import type { ProgressCommand, ProgressResult, ProgressScope, ProgressTask } from './domain.js';
const columns = 'id, status, version, updated_at AS "updatedAt"';
export async function authorizedTask(client: PoolClient, scope: ProgressScope) {
  const { rows } = await client.query<ProgressTask>(`SELECT ${columns} FROM tasks
    WHERE (organization_id, project_id, id) = ($1, $2, $3)
      AND can_progress_assignment(organization_id, project_id, assignee_membership_id)`,
  [scope.organizationId, scope.projectId, scope.taskId]);
  return rows[0];
}
export async function readReceipt(client: PoolClient, scope: ProgressScope, operationId: string) {
  const { rows } = await client.query<{ request_hash: string; result: ProgressResult }>(`SELECT request_hash, result
    FROM task_progress_receipts WHERE (organization_id, actor_id, operation_id) = ($1, $2, $3)`,
  [scope.organizationId, scope.actorId, operationId]);
  return rows[0];
}
export async function updateProgress(client: PoolClient, scope: ProgressScope, command: ProgressCommand, status: string) {
  await client.query("SELECT set_config('sitegrid.task_progress_action', $1, true)", [command.action]);
  const { rows } = await client.query<ProgressTask>(`UPDATE tasks SET status = $4, version = version + 1
    WHERE (organization_id, project_id, id) = ($1, $2, $3) AND version = $5 RETURNING ${columns}`,
  [scope.organizationId, scope.projectId, scope.taskId, status, command.expectedVersion]);
  const task = rows[0];
  if (!task) throw Object.assign(new Error('Concurrent task update'), { statusCode: 409 });
  // Persist exactly the wire representation, including PostgreSQL's UTC timestamp.
  return { ...task, updatedAt: new Date(task.updatedAt).toISOString() };
}
export async function saveReceipt(client: PoolClient, scope: ProgressScope, command: ProgressCommand,
  hash: string, result: ProgressResult, auditId: string) {
  await client.query(`INSERT INTO task_progress_receipts
    (organization_id, actor_id, operation_id, project_id, task_id, schema_version, request_hash, result, audit_id)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`, [scope.organizationId, scope.actorId, command.operationId,
    scope.projectId, scope.taskId, command.schemaVersion, hash, result, auditId]);
}

export async function isProjectActive(client: PoolClient, scope: ProgressScope) {
  const { rows } = await client.query("SELECT status FROM projects WHERE organization_id = $1 AND id = $2", [scope.organizationId, scope.projectId]);
  return rows[0]?.status === 'active';
}
