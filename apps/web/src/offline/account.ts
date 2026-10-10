import { confirmOfflineAccount, denyOfflineAccess, invalidateOfflineAccount, invalidateOfflineProjects, offlineAccountGeneration, readOfflineAccess } from '../storage/offline-access.js';
import { openProjectStorage, LocalStorageError } from '../storage/indexed-db.js';
import { announceAccountChange } from '../pwa/lifecycle.js';

export const localAccessWarning = 'Dostęp offline zablokowany: nie udało się potwierdzić lub wyczyścić pamięci lokalnej. Funkcje online pozostają dostępne.';
export async function beginAccountVerification() { return offlineAccountGeneration().catch(() => undefined); }
export async function finishAccountVerification(accountId: string | null | undefined, generation: string | null | undefined) {
  try {
    if (accountId === undefined) { denyOfflineAccess(); return localAccessWarning; }
    const repaired = generation === undefined;
    if (repaired) { await invalidateOfflineAccount(); generation = await offlineAccountGeneration(); }
    await confirmOfflineAccount(accountId, generation!);
    return repaired ? 'Przywrócono lokalny kontekst konta. Wcześniejsze projekty wymagają ponownego przygotowania offline.' : '';
  } catch { denyOfflineAccess(); return localAccessWarning; }
}
export async function beforeAccountChange() {
  // Set the durable denial before any server mutation. Failure to set it blocks
  // the account change; failed IDB cleanup leaves it set across page restarts.
  denyOfflineAccess(); announceAccountChange();
  try { await invalidateOfflineAccount(); return ''; } catch { return localAccessWarning; }
}
export async function observeAccessFailure(path: string, status: number) {
  try {
    if (status === 401) { await invalidateOfflineAccount(); return; }
    const match = path.match(/^\/api\/organizations\/([a-f0-9-]+)(?:\/projects\/([a-f0-9-]+))?/);
    if (match && (status === 403 || (status === 404 && match[2]))) await invalidateOfflineProjects(match[1], match[2] ? [match[2]] : undefined);
  } catch { denyOfflineAccess(); }
}
export async function reconcilePreparedProjects(organizationId: string, projectIds: string[]) {
  try { await invalidateOfflineProjects(organizationId, projectIds, true); } catch { denyOfflineAccess(); }
}
export async function reconcilePreparedTasks(organizationId: string, projectId: string, taskIds: string[]) {
  try {
    const access = await readOfflineAccess();
    const scope = access?.scopes.find(item => item.organizationId === organizationId && item.projectId === projectId);
    if (!scope || !access) return;
    const handle = await openProjectStorage(scope);
    try {
      const saved = await handle.read(access.generation).catch(error => {
        if (error instanceof LocalStorageError && error.code === 'expired') return null;
        throw error;
      });
      if (saved?.snapshot.tasks.some(task => !taskIds.includes(task.id))) await invalidateOfflineProjects(organizationId, [projectId]);
    } finally { handle.close(); }
  } catch { denyOfflineAccess(); }
}
