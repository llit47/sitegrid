import { useEffect, useState, useSyncExternalStore } from 'react';
import { readOfflineAccess } from '../storage/offline-access.js';
import { queueProgress, retryProgress, commandPath, type QueuedProgress } from '../storage/progress-queue.js';
import type { ConfirmedSnapshot } from '../storage/indexed-db.js';
import { notifyProgress, startProgressSync } from './sync.js';
import { queueState } from './queue-state.js';
import { offlineFailureMessage } from '../offline/messages.js';

export function queueLabel(row: QueuedProgress) {
  return row.state === 'confirmed' ? 'Zapisano na serwerze' : row.state === 'attention' ? 'Wymaga uwagi' :
    row.lease && row.lease.until > Date.now() && navigator.onLine ? 'Synchronizowanie' : 'Oczekuje na synchronizację';
}
export function QueueFeedback({ row }: { row: QueuedProgress }) {
  return <div><p role="status">{queueLabel(row)}</p>
    {row.state === 'attention' && <p role="alert" className="error">{row.reason === 'conflict' ?
      'Zadanie zmieniło się na serwerze. Sprawdź aktualny stan online. Operacja pozostaje na urządzeniu. Skontaktuj się z kierownikiem przed kolejnym postępem.' :
      'Zaloguj się online, sprawdź dostęp do projektu i ponów tę samą operację w kolejce. Operacja pozostaje na urządzeniu.'}</p>}
    {row.state !== 'confirmed' && <p className="hint">Kolejny postęp tego zadania jest zablokowany do potwierdzenia serwera.</p>}
  </div>;
}
export function useQueuedCommand(path: string) {
  const state = useSyncExternalStore(queueState.subscribe, queueState.getSnapshot);
  const match = path.match(/^\/api\/organizations\/([a-f0-9-]+)\/projects\/([a-f0-9-]+)\/tasks\/([a-f0-9-]+)$/);
  const row = match ? state.rows.find(row => row.scope.accountId === state.accountId && row.scope.organizationId === match[1] && row.scope.projectId === match[2] && row.taskId === match[3]) ?? null : null;
  const failed = state.failed || !!match && state.failures.some(scope => scope.organizationId === match[1] && scope.projectId === match[2]);
  return { row, checking: state.checking, failed };
}
export function OfflineProgress({ saved, task }: { saved: ConfirmedSnapshot; task: ConfirmedSnapshot['snapshot']['tasks'][number] }) {
  const scope = saved.snapshot.scope, { row, checking, failed } = useQueuedCommand(commandPath(scope, task.id));
  const [saving, setSaving] = useState(false), [message, setMessage] = useState(''), [error, setError] = useState('');
  const blocked = !!row && (row.state !== 'confirmed' || row.confirmed!.version > task.version);
  const action = task.status === 'planned' ? 'start' : task.status === 'in_progress' ? 'submit' : null;
  const save = async () => {
    if (saving || checking || failed || blocked || !action) return;
    setSaving(true); setMessage(''); setError('');
    try {
      await queueProgress(scope, task.id, { operationId: crypto.randomUUID(), schemaVersion: 1, action, expectedVersion: task.version });
      setMessage('Zapisano na urządzeniu'); notifyProgress();
    } catch (error) { setError(`Nie zapisano postępu. ${offlineFailureMessage(error)}`); }
    finally { setSaving(false); }
  };
  return <div className="task-progress">
    {task.canProgress && saved.snapshot.project.status === 'active' && action && <button disabled={saving || checking || failed || blocked} onClick={() => void save()}>{action === 'start' ? 'Rozpocznij zadanie' : 'Zgłoś do odbioru'}</button>}
    {message && <p role="status">{message}</p>}{row && <QueueFeedback row={row} />}
    {row?.state === 'confirmed' && blocked && <p className="hint">Odśwież projekt online przed kolejnym postępem.</p>}
    {(error || failed) && <p role="alert" className="error">{error || 'Pamięć lokalna niedostępna. Nie można zapisać postępu.'}</p>}
  </div>;
}
export function ProgressQueue({ accountId }: { accountId: string }) {
  const state = useSyncExternalStore(queueState.subscribe, queueState.getSnapshot);
  const [warning, setWarning] = useState('');
  const rows = state.accountId === accountId ? state.rows.map(row => ({ ...row, title:
    state.access && row.generation === state.access.generation && Date.now() < row.expiresAt && state.access.scopes.some(scope => scope.organizationId === row.scope.organizationId && scope.projectId === row.scope.projectId) ? row.title : 'Operacja postępu zadania' })) : [];
  useEffect(() => {
    const unbind = queueState.bindAccount(accountId);
    const stop = startProgressSync(accountId, setWarning);
    return () => { stop(); unbind(); };
  }, [accountId]);
  const retry = async (row: QueuedProgress) => {
    try {
      const access = await readOfflineAccess();
      if (!navigator.onLine || access?.accountId !== accountId) return;
      await retryProgress(row, access.generation); notifyProgress();
    } catch { setWarning('Wymaga uwagi. Nie udało się zapisać ponowienia. Operacja pozostaje w kolejce.'); }
  };
  const pending = rows.filter(row => row.state !== 'confirmed');
  return <>{pending.length > 0 && <section className="offline-preparation" aria-label="Kolejka postępu"><h2>Kolejka postępu</h2>
    {pending.map(row => <article key={row.command.operationId}><strong>{row.title}</strong><QueueFeedback row={row} />
      {row.state === 'attention' && row.reason !== 'conflict' && <button onClick={() => void retry(row)}>Ponów tę samą operację</button>}
    </article>)}
  </section>}{rows.length > 0 && pending.length === 0 && <p role="status">Zapisano na serwerze</p>}{(warning || state.failed || state.failures.length > 0) && <p role="alert" className="error">{warning ||
    'Wymaga uwagi. Nie można odczytać części kolejek urządzenia. Dane zachowano; przywróć pamięć urządzenia i otwórz aplikację ponownie. Zdrowe projekty synchronizują się dalej.'}</p>}</>;
}
