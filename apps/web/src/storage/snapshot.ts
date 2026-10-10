import { canonicalJson, snapshotBody, snapshotRecords, MAX_SNAPSHOT_BYTES, MAX_SNAPSHOT_TASKS, OFFLINE_ACCESS_MS,
  type ProjectSnapshot, type SnapshotScope } from '../../../server/src/project-snapshots/contract.js';
export type { ProjectSnapshot };
export { OFFLINE_ACCESS_MS };
export function validUuid(value: unknown): value is string { return typeof value === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value); }
function keys(value: unknown, expected: string): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join() === expected.split(',').sort().join();
}
function text(value: unknown, max: number, required = false) { return typeof value === 'string' && [...value].length <= max && !/\p{Cc}/u.test(value) && (!required || !!value.trim()); }
function date(value: unknown): value is string { return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value; }
function timed(value: Record<string, unknown>) {
  return validUuid(value.id) && Number.isInteger(value.version) && Number(value.version) > 0 && Number(value.version) <= 2147483647 && date(value.createdAt) && date(value.updatedAt) && value.createdAt <= value.updatedAt;
}
export async function validateSnapshot(value: unknown, scope: SnapshotScope): Promise<ProjectSnapshot> {
  const invalid = () => { throw new Error('Niepełny, uszkodzony lub nieobsługiwany snapshot.'); };
  if (!keys(value, 'format,complete,scope,generatedAt,expiresAt,taskAccess,project,tasks,integrity') || value.format !== 1 || value.complete !== true ||
    !keys(value.scope, 'accountId,organizationId,projectId') || !Object.entries(scope).every(([key, id]) => validUuid(id) && (value.scope as Record<string, unknown>)[key] === id) ||
    !date(value.generatedAt) || !date(value.expiresAt) || Date.parse(value.expiresAt) - Date.parse(value.generatedAt) !== OFFLINE_ACCESS_MS ||
    !['none','own','project'].includes(value.taskAccess as string)) return invalid();
  const project = value.project;
  if (!keys(project, 'id,name,description,status,version,createdAt,updatedAt,contractor') || !timed(project) || project.id !== scope.projectId ||
    !text(project.name, 200, true) || !text(project.description, 4000) || !['active','archived'].includes(project.status as string)) return invalid();
  if (project.contractor !== null && (!keys(project.contractor, 'id,name,status') || !validUuid(project.contractor.id) ||
    !text(project.contractor.name, 200, true) || !['active','inactive'].includes(project.contractor.status as string))) return invalid();
  if (!Array.isArray(value.tasks) || value.tasks.length > MAX_SNAPSHOT_TASKS || (value.taskAccess === 'none' && value.tasks.length)) return invalid();
  const ids = new Set<string>();
  for (const task of value.tasks) {
    if (!keys(task, 'id,title,description,status,version,createdAt,updatedAt,assigneeName') || !timed(task) ||
      !text(task.title, 200, true) || !text(task.description, 4000) || !['planned','in_progress','submitted'].includes(task.status as string) ||
      (task.assigneeName !== null && !text(task.assigneeName, 254, true)) || ids.has(task.id as string)) return invalid();
    ids.add(task.id as string);
  }
  if (!keys(value.integrity, 'algorithm,digest,records,bytes') || value.integrity.algorithm !== 'SHA-256' ||
    typeof value.integrity.digest !== 'string' || !/^[a-f0-9]{64}$/.test(value.integrity.digest)) return invalid();
  const snapshot = value as unknown as ProjectSnapshot;
  const body = snapshotBody(snapshot), encoded = new TextEncoder().encode(canonicalJson(body));
  if (value.integrity.records !== snapshotRecords(body) || value.integrity.bytes !== encoded.length || new TextEncoder().encode(JSON.stringify(snapshot)).length > MAX_SNAPSHOT_BYTES) return invalid();
  const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', encoded))].map(byte => byte.toString(16).padStart(2, '0')).join('');
  if (digest !== value.integrity.digest) return invalid();
  return snapshot;
}
