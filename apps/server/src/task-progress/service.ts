import type { PoolClient } from 'pg';
import { writeOrganizationAudit } from '../common/audit.js';
import { nextStatus, requestHash, type ProgressCommand, type ProgressScope } from './domain.js';
import { authorizedTask, isProjectActive, readReceipt, saveReceipt, updateProgress } from './persistence.js';

// Caller owns the transaction, company lock and refreshed session/tenant context.
export async function executeProgress(client: PoolClient, scope: ProgressScope, command: ProgressCommand) {
  // Authorize the requested resource BEFORE looking up operation IDs or old results.
  const current = await authorizedTask(client, scope);
  if (!current) throw Object.assign(new Error('Task unavailable'), { statusCode: 404 });
  const hash = requestHash(scope, command);
  const receipt = await readReceipt(client, scope, command.operationId);
  if (receipt) return receipt.request_hash === hash
    ? { status: 200, body: receipt.result }
    : { status: 409, body: { code: 'OPERATION_ID_REUSED', error: 'Identyfikator operacji został użyty z inną treścią.' } };
  if (current.version !== command.expectedVersion) return { status: 409,
    body: { code: 'STALE_TASK_VERSION', error: 'Zadanie zmieniło się. Wczytaj aktualne dane.', task: current } };
  const status = nextStatus(current.status, command.action);
  if (!status) return { status: 409, body: { code: 'INVALID_TASK_TRANSITION', error: 'Ta akcja jest niedostępna w obecnym stanie zadania.', task: current } };
  if (!await isProjectActive(client, scope)) return { status: 409,
    body: { code: 'PROJECT_ARCHIVED', error: 'Projekt archiwalny jest tylko do odczytu.' } };
  const task = await updateProgress(client, scope, command, status);
  const result = { operationId: command.operationId, schemaVersion: command.schemaVersion, task };
  const auditId = await writeOrganizationAudit(client, scope.organizationId, scope.actorId, scope.taskId,
    command.action === 'start' ? 'task_started' : 'task_submitted', { projectId: scope.projectId,
      operationId: command.operationId, schemaVersion: command.schemaVersion, beforeVersion: current.version,
      afterVersion: task.version, beforeStatus: current.status, afterStatus: task.status });
  await saveReceipt(client, scope, command, hash, result, auditId);
  return { status: 200, body: result };
}
