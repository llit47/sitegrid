// Shared wire contract: no database, browser or authentication dependencies.
export const SNAPSHOT_FORMAT = 1;
export const MAX_SNAPSHOT_TASKS = 500;
export const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;
export const OFFLINE_ACCESS_MS = 24 * 60 * 60 * 1000;
export type SnapshotScope = { accountId: string; organizationId: string; projectId: string };
type TimedRecord = { id: string; version: number; createdAt: string; updatedAt: string };
export type ProjectSnapshotBody = {
  format: 1; complete: true; scope: SnapshotScope; generatedAt: string; expiresAt: string;
  taskAccess: 'none' | 'own' | 'project';
  project: TimedRecord & { name: string; description: string; status: 'active' | 'archived'; contractor: { id: string; name: string; status: 'active' | 'inactive' } | null };
  tasks: (TimedRecord & { title: string; description: string; status: 'planned' | 'in_progress' | 'submitted'; assigneeName: string | null })[];
};
export type ProjectSnapshot = ProjectSnapshotBody & { integrity: { algorithm: 'SHA-256'; digest: string; records: number; bytes: number } };
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
export function snapshotBody(snapshot: ProjectSnapshot): ProjectSnapshotBody {
  const { integrity: _integrity, ...body } = snapshot;
  return body;
}
export function snapshotRecords(body: ProjectSnapshotBody) { return 1 + (body.project.contractor ? 1 : 0) + body.tasks.length; }
