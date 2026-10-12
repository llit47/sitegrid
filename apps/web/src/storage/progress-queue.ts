import type { ProgressCommand, ProgressTask } from '../../../server/src/task-progress/domain.js';
import { openProjectStorage, openProgressStorage, openLocalDatabase, plainStore, localTransaction, LocalStorageError, storageFailure, type StorageScope, type ConfirmedSnapshot } from './indexed-db.js';
import { readOfflineAccess } from './offline-access.js';
import { validUuid, OFFLINE_ACCESS_MS } from './snapshot.js';

export type QueuedProgress = {
  format: 1; scope: StorageScope; taskId: string; title: string; generation: string; expiresAt: number;
  command: ProgressCommand; state: 'pending' | 'attention' | 'confirmed'; reason: string;
  attempts: number; nextAttempt: number; lease: { owner: string; until: number } | null; confirmed: ProgressTask | null;
};
export const commandPath = (scope: StorageScope, taskId: string) => `/api/organizations/${scope.organizationId}/projects/${scope.projectId}/tasks/${taskId}`;
export function validCommand(value: unknown): value is ProgressCommand {
  const c = value as ProgressCommand;
  return !!c && Object.keys(c).sort().join() === 'action,expectedVersion,operationId,schemaVersion' && validUuid(c.operationId) &&
    c.schemaVersion === 1 && ['start','submit'].includes(c.action) && Number.isInteger(c.expectedVersion) && c.expectedVersion > 0 && c.expectedVersion < 2147483647;
}
function validate(value: unknown, scope: StorageScope): QueuedProgress {
  const row = value as QueuedProgress;
  if (!row || row.format !== 1 || !row.scope || !Object.entries(scope).every(([key, id]) => row.scope[key as keyof StorageScope] === id) ||
    !validUuid(row.taskId) || !validUuid(row.generation) || !validCommand(row.command) || typeof row.title !== 'string' || row.title.length > 400 ||
    !Number.isFinite(row.expiresAt) || !['pending','attention','confirmed'].includes(row.state) || typeof row.reason !== 'string' ||
    !Number.isSafeInteger(row.attempts) || row.attempts < 0 || !Number.isFinite(row.nextAttempt) ||
    (row.lease !== null && (!validUuid(row.lease?.owner) || !Number.isFinite(row.lease.until))) ||
    (row.state === 'confirmed' && (!row.confirmed || row.confirmed.id !== row.taskId || row.confirmed.version !== row.command.expectedVersion + 1 ||
      row.confirmed.status !== (row.command.action === 'start' ? 'in_progress' : 'submitted')))) throw new LocalStorageError('invalid');
  return row;
}
// Account-specific catalog admits a scope before any queue write. Empty entries are
// harmless; logout/revocation never deletes unresolved commands or their catalog.
async function catalog(accountId: string, scope?: StorageScope): Promise<StorageScope[]> {
  if (!validUuid(accountId)) throw new LocalStorageError('invalid');
  const db = await openLocalDatabase(`sitegrid-progress-catalog-${accountId}`, 1, database => { database.createObjectStore('scopes'); });
  try {
    if (!plainStore(db, 'scopes') || db.objectStoreNames.length !== 1) throw new LocalStorageError('invalid');
    return await localTransaction<StorageScope[]>(db, ['scopes'], scope ? 'readwrite' : 'readonly', (tx, result, invalid) => {
      const store = tx.objectStore('scopes');
      if (scope) store.put(scope, `${scope.organizationId}/${scope.projectId}`);
      const request = store.getAll(); request.onsuccess = () => {
        if (request.result.some(item => item.accountId !== accountId || !validUuid(item.organizationId) || !validUuid(item.projectId))) invalid();
        else result(request.result);
      };
    });
  } finally { db.close(); }
}
export const queuedScopes = (accountId: string) => catalog(accountId);
export async function queueRows(scope: StorageScope): Promise<QueuedProgress[]> {
  const handle = await openProgressStorage(scope);
  try { return await handle.progressTransaction((tx, result, invalid) => {
    const request = tx.objectStore('progress').getAll(); request.onsuccess = () => {
      try { result(request.result.map(row => validate(row, scope))); } catch (error) { invalid(storageFailure(error)); }
    };
  }, 'readonly', false); } finally { handle.close(); }
}
export async function queueProgress(scope: StorageScope, taskId: string, command: ProgressCommand): Promise<QueuedProgress> {
  if (!validUuid(taskId) || !validCommand(command)) throw new LocalStorageError('invalid');
  const access = await readOfflineAccess();
  if (!access || access.accountId !== scope.accountId || !access.scopes.some(item => item.organizationId === scope.organizationId && item.projectId === scope.projectId)) throw new LocalStorageError('expired');
  await catalog(scope.accountId, scope);
  const handle = await openProjectStorage(scope);
  try {
    // Validate integrity outside the transaction, then compare inside it to fence
    // concurrent replacement/revocation. One task key gives atomic tab exclusion.
    const saved = await handle.read(access.generation);
    if (!saved) throw new LocalStorageError('expired');
    const current = await readOfflineAccess();
    if (!current || current.generation !== access.generation || !current.scopes.some(item => item.organizationId === scope.organizationId && item.projectId === scope.projectId)) throw new LocalStorageError('expired');
    return await handle.progressTransaction<QueuedProgress>((tx, result, invalid) => {
      const store = tx.objectStore('progress'), snapshot = tx.objectStore('confirmed').get('snapshot');
      snapshot.onsuccess = () => {
        const record = snapshot.result as ConfirmedSnapshot;
        const task = record?.snapshot.tasks.find(item => item.id === taskId);
        const expiresAt = Math.min(Date.parse(saved.snapshot.expiresAt), saved.authorizedAt + OFFLINE_ACCESS_MS);
        if (JSON.stringify(record) !== JSON.stringify(saved) || Date.now() < saved.authorizedAt || Date.now() >= expiresAt ||
          !task?.canProgress || record.snapshot.project.status !== 'active' || task.version !== command.expectedVersion ||
          task.status !== (command.action === 'start' ? 'planned' : 'in_progress')) { invalid(new LocalStorageError('expired')); return; }
        const request = store.get(taskId); request.onsuccess = () => {
          try {
            const previous = request.result === undefined ? null : validate(request.result, scope);
            if (previous && (previous.state !== 'confirmed' || previous.confirmed!.version > task.version)) { invalid(new LocalStorageError('stale')); return; }
            const row: QueuedProgress = { format: 1, scope, taskId, title: task.title, generation: access.generation, expiresAt,
              command, state: 'pending', reason: '', attempts: 0, nextAttempt: 0, lease: null, confirmed: null };
            store.put(row, taskId); result(row);
          } catch (error) { invalid(storageFailure(error)); }
        };
      };
    });
  } finally { handle.close(); }
}
async function update(scope: StorageScope, taskId: string, operationId: string, change: (row: QueuedProgress) => QueuedProgress | null) {
  const handle = await openProgressStorage(scope);
  try { return await handle.progressTransaction<QueuedProgress | null>((tx, result, invalid) => {
    const store = tx.objectStore('progress'), request = store.get(taskId);
    request.onsuccess = () => {
      try {
        if (request.result === undefined) { result(null); return; }
        const row = validate(request.result, scope);
        if (row.command.operationId !== operationId) { result(null); return; }
        const next = change(row); if (next) store.put(validate(next, scope), taskId); result(next);
      } catch (error) { invalid(storageFailure(error)); }
    };
  }, 'readwrite', false); } finally { handle.close(); }
}
export function claimProgress(row: QueuedProgress, owner: string, now = Date.now()) {
  return update(row.scope, row.taskId, row.command.operationId, current => current.state !== 'pending' || current.nextAttempt > now || (current.lease && current.lease.until > now) ? null :
    { ...current, attempts: current.attempts + 1, lease: { owner, until: now + 60_000 } });
}
export function settleProgress(row: QueuedProgress, owner: string, state: QueuedProgress['state'], reason = '', confirmed: ProgressTask | null = null) {
  return update(row.scope, row.taskId, row.command.operationId, current => current.state !== 'pending' || current.lease?.owner !== owner ? null :
    { ...current, state, reason: state === 'pending' ? current.reason : reason, confirmed, lease: null, nextAttempt: state === 'pending' ? Date.now() + Math.min(60_000, 1000 * 2 ** Math.min(current.attempts, 6)) : 0 });
}
export function flagProgress(row: QueuedProgress, reason: string) {
  return update(row.scope, row.taskId, row.command.operationId, current => current.state === 'confirmed' ? null : { ...current, state: 'attention', reason, lease: null });
}
export function retryProgress(row: QueuedProgress, generation: string) {
  return update(row.scope, row.taskId, row.command.operationId, current => current.state !== 'attention' || current.reason === 'conflict' ? null :
    { ...current, state: 'pending', reason: 'retry', generation, expiresAt: Date.now() + OFFLINE_ACCESS_MS, nextAttempt: 0, lease: null });
}
