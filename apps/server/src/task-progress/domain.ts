import { createHash } from 'node:crypto';

export const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export type ProgressCommand = { operationId: string; schemaVersion: 1; action: 'start' | 'submit'; expectedVersion: number };
export type ProgressScope = { organizationId: string; projectId: string; taskId: string; actorId: string };
export type ProgressTask = { id: string; status: 'planned' | 'in_progress' | 'submitted'; version: number; updatedAt: string };
export type ProgressResult = { operationId: string; schemaVersion: 1; task: ProgressTask };
export function parseCommand(value: unknown): ProgressCommand {
  const fail = (code = 'INVALID_COMMAND') => { throw Object.assign(new Error(code), { statusCode: 400, code }); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some(key => !['operationId', 'schemaVersion', 'action', 'expectedVersion'].includes(key))) return fail();
  if (typeof body.operationId !== 'string' || !uuidPattern.test(body.operationId)
    || typeof body.expectedVersion !== 'number' || !Number.isInteger(body.expectedVersion)
    || body.expectedVersion < 1 || body.expectedVersion >= 2147483647
    || !['start', 'submit'].includes(body.action as string)) return fail();
  if (body.schemaVersion !== 1) return fail('UNSUPPORTED_COMMAND_SCHEMA');
  return { operationId: body.operationId.toLowerCase(), schemaVersion: 1,
    action: body.action as ProgressCommand['action'], expectedVersion: body.expectedVersion };
}
export function requestHash(scope: ProgressScope, command: ProgressCommand) {
  // Fixed field order and normalized path UUIDs; JSON whitespace/key order is irrelevant.
  return createHash('sha256').update(JSON.stringify([scope.organizationId.toLowerCase(), scope.projectId.toLowerCase(),
    scope.taskId.toLowerCase(), scope.actorId.toLowerCase(), command.schemaVersion, command.action, command.expectedVersion])).digest('hex');
}
export function nextStatus(status: ProgressTask['status'], action: ProgressCommand['action']) {
  if (status === 'planned' && action === 'start') return 'in_progress';
  if (status === 'in_progress' && action === 'submit') return 'submitted';
  return undefined;
}
