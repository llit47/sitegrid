import { readOfflineAccess, offlineAccessDenied, denyOfflineAccess } from '../storage/offline-access.js';
import { queuedScopes, queueRows, claimProgress, settleProgress, flagProgress, commandPath, type QueuedProgress } from '../storage/progress-queue.js';
import { observeAccessFailure } from '../offline/account.js';

export const progressEvent = 'sitegrid-progress-queue';
let channel: BroadcastChannel | null = null;
try {
  if (typeof BroadcastChannel !== 'undefined') channel = new BroadcastChannel(progressEvent);
  channel?.addEventListener('message', () => window.dispatchEvent(new Event(progressEvent)));
} catch { channel = null; } // Storage/privacy policies can deny this optional channel.
export function notifyProgress() {
  window.dispatchEvent(new Event(progressEvent));
  try { channel?.postMessage('changed'); } catch { /* Other tabs still poll durable state. */ }
}
export async function accountQueue(accountId: string) {
  const rows: QueuedProgress[] = [];
  for (const scope of await queuedScopes(accountId)) rows.push(...await queueRows(scope));
  return rows;
}
export function startProgressSync(accountId: string, onWarning: (message: string) => void) {
  const owner = crypto.randomUUID(), lifetime = new AbortController();
  let running = false;
  const active = () => !lifetime.signal.aborted && navigator.onLine && document.visibilityState === 'visible' && !offlineAccessDenied();
  const run = async () => {
    if (running || !active()) return; running = true;
    try {
      let access = await readOfflineAccess();
      if (!access || access.accountId !== accountId || !active()) return;
      const rows = (await accountQueue(accountId)).filter(row => row.state === 'pending');
      if (!rows.length) return;
      const stopForSession = async () => {
        try { for (const row of rows) await flagProgress(row, 'session'); notifyProgress(); }
        finally {
          if (active()) {
            onWarning('Wymaga uwagi. Operacje pozostają na urządzeniu. Zaloguj się online.');
            await observeAccessFailure('/api/auth/session', 401);
          }
        }
      };
      // Cookies can change in another tab. Never use a cached session/CSRF token
      // to replay an account's commands after reconnect or reopening.
      const response = await fetch('/api/auth/session', { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(15_000)]) });
      if (!active()) return;
      if (!response.ok) {
        if ([401,403].includes(response.status)) await stopForSession();
        return;
      }
      const session = await response.json();
      if (!active()) return;
      if (!session.user) { await stopForSession(); return; }
      if (session.user?.id !== accountId) return;
      for (const row of rows) {
        access = await readOfflineAccess();
        if (!active() || !access || access.accountId !== accountId) return;
        const prepared = access.scopes.some(scope => scope.organizationId === row.scope.organizationId && scope.projectId === row.scope.projectId);
        if (row.generation !== access.generation || Date.now() >= row.expiresAt || (!prepared && row.reason !== 'retry')) {
          await flagProgress(row, 'access'); notifyProgress(); continue;
        }
        const claimed = await claimProgress(row, owner);
        if (!claimed) continue;
        notifyProgress();
        const path = commandPath(row.scope, row.taskId);
        let permanentFailure = false;
        try {
          if (!active()) continue; // The durable lease expires after a suspended tab.
          const reply = await fetch(`${path}/commands`, { method: 'POST', credentials: 'same-origin',
            signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(15_000)]),
            headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken }, body: JSON.stringify(claimed.command) });
          permanentFailure = !reply.ok && reply.status < 500 && reply.status !== 429;
          const current = await readOfflineAccess();
          if (!active() || !current || current.accountId !== accountId || current.generation !== access.generation) continue;
          if ([401,403,404,409].includes(reply.status) || (!reply.ok && reply.status < 500 && reply.status !== 429)) {
            await settleProgress(claimed, owner, 'attention', reply.status === 409 ? 'conflict' : reply.status === 401 ? 'session' : 'permission');
            notifyProgress();
            if ([401,403,404].includes(reply.status) && active()) {
              onWarning('Wymaga uwagi. Operacja pozostaje na urządzeniu. Zaloguj się i sprawdź dostęp do projektu.');
              await observeAccessFailure(path, reply.status);
            }
            continue;
          }
          if (!reply.ok) throw new Error('Unconfirmed');
          const data = await reply.json();
          if (data.operationId !== claimed.command.operationId || data.schemaVersion !== 1 || data.task?.id !== claimed.taskId ||
            data.task.version !== claimed.command.expectedVersion + 1 || data.task.status !== (claimed.command.action === 'start' ? 'in_progress' : 'submitted')) throw new Error('Unconfirmed');
          // A failed local acknowledgement leaves the original operation pending;
          // its next send retrieves the M08 receipt, never creates a new ID.
          await settleProgress(claimed, owner, 'confirmed', '', data.task);
        } catch {
          if (!lifetime.signal.aborted) {
            if (permanentFailure) {
              // If the stop marker cannot commit, the existing durable denial
              // fence prevents a restart from automatically replaying the error.
              onWarning('Wymaga uwagi. Nie udało się zapisać blokady kolejki. Operacja pozostaje na urządzeniu; zaloguj się ponownie online.');
              denyOfflineAccess();
            } else await settleProgress(claimed, owner, 'pending');
          }
        } finally { notifyProgress(); }
      }
    } catch {
      if (!lifetime.signal.aborted) onWarning('Wymaga uwagi. Nie udało się odczytać lub zapisać kolejki. Spróbuj ponownie po otwarciu aplikacji.');
    } finally { running = false; }
  };
  const wake = () => { void run(); };
  const revoke = () => { if (offlineAccessDenied()) lifetime.abort(); else wake(); };
  const timer = window.setInterval(wake, 15_000);
  window.addEventListener('online', wake); window.addEventListener(progressEvent, wake);
  window.addEventListener('sitegrid-offline-access', revoke); document.addEventListener('visibilitychange', wake);
  wake();
  return () => {
    lifetime.abort(); clearInterval(timer);
    window.removeEventListener('online', wake); window.removeEventListener(progressEvent, wake);
    window.removeEventListener('sitegrid-offline-access', revoke); document.removeEventListener('visibilitychange', wake);
  };
}
