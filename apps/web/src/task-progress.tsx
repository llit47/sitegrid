import { QueueFeedback, useQueuedCommand } from './progress/queue-ui.js';
import { StatusBadge } from './tasks/status.js';
import { usePendingOperation } from './workspace/navigation-safety.js';
import { useEffect, useRef, useState } from 'react';

export type ProgressTask = { id: string; status: string; version: number; canProgress?: boolean; assigneeMembershipId?: string | null };
type Command = { operationId: string; schemaVersion: 1; action: 'start' | 'submit'; expectedVersion: number };
export const taskStateName = (status: string) => ({ planned: 'Zaplanowane', in_progress: 'W toku', submitted: 'Zgłoszone do odbioru' })[status] ?? status;

export function TaskProgress({ task, path, csrfToken, writable, disabled, onConfirmed, onAccessChanged, onGone, onPendingChange }: {
  task: ProgressTask; path: string; csrfToken: string; writable: boolean; disabled: boolean;
  onConfirmed: (task: ProgressTask) => void; onAccessChanged: (status: number) => void; onGone: () => void;
  onPendingChange?: (taskId: string, pending: boolean) => void;
}) {
  const queued = useQueuedCommand(path);
  const queueBlocked = queued.checking || (!!queued.row && (queued.row.state !== 'confirmed' || queued.row.confirmed!.version > task.version));
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(false);
  const [conflict, setConflict] = useState(false);
  usePendingOperation(busy || retry);
  useEffect(() => {
    onPendingChange?.(task.id, busy || retry);
    return () => onPendingChange?.(task.id, false);
  }, [task.id, busy, retry, onPendingChange]);
  const command = useRef<Command | null>(null);
  const sending = useRef(false);
  const lifetime = useRef<AbortController | null>(null);
  useEffect(() => { const controller = new AbortController(); lifetime.current = controller; return () => controller.abort(); }, []);
  useEffect(() => { if (!command.current) setConflict(false); }, [task.version]);
  const action = task.status === 'planned' ? 'start' : task.status === 'in_progress' ? 'submit' : null;
  const send = async () => {
    if (sending.current || disabled || conflict || (queueBlocked && !command.current)) return;
    sending.current = true; setBusy(true); setError(''); setFeedback(''); setRetry(false);
    const signal = lifetime.current!.signal;
    try {
      if (!command.current) {
        if (!action) return;
        if (queued.failed) {
          // Storage cannot prove the queue is empty. Check authorized server data
          // and keep the original version; M08 fences any hidden concurrent write.
          const current = await fetch(path, { credentials: 'same-origin', cache: 'no-store', signal });
          const data = await current.json();
          if (signal.aborted) return;
          if (!current.ok) {
            if ([401,403].includes(current.status)) { onAccessChanged(current.status); return; }
            if (current.status === 404) { onGone(); return; }
            throw new Error(data.error ?? 'Nie udało się sprawdzić zadania na serwerze.');
          }
          if (data.task.version !== task.version || data.task.status !== task.status) {
            setConflict(true); setError('Zadanie zmieniło się na serwerze. Sprawdź aktualny stan przed kolejną akcją.'); return;
          }
        }
        command.current = { operationId: crypto.randomUUID(), schemaVersion: 1, action, expectedVersion: task.version };
      }
      const response = await fetch(`${path}/commands`, { method: 'POST', credentials: 'same-origin', signal,
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken }, body: JSON.stringify(command.current) });
      const data = await response.json();
      if (signal.aborted) return;
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) { onAccessChanged(response.status); return; }
        if (response.status === 404) { onGone(); return; }
        if (response.status === 409) {
          command.current = null; setConflict(true);
          setError(`${data.error} Poczekaj na aktualizację danych przed kolejną akcją.`); return;
        }
        if (response.status < 500 && response.status !== 429) { command.current = null; setConflict(true); }
        throw new Error(data.error ?? 'Nie udało się zapisać postępu.');
      }
      command.current = null; onConfirmed(data.task);
      setFeedback(data.task.status === 'in_progress' ? 'Serwer potwierdził rozpoczęcie zadania.' : 'Serwer potwierdził zgłoszenie do odbioru.');
    } catch (e) {
      if (!signal.aborted) {
        setRetry(command.current !== null);
        setError(command.current ? 'Brak potwierdzenia serwera. Ponów tę samą operację, aby sprawdzić wynik.' : (e as Error).message);
      }
    } finally { if (!signal.aborted) { sending.current = false; setBusy(false); } }
  };
  useEffect(() => {
    if (queued.row?.state === 'confirmed' && queued.row.confirmed!.version > task.version) onConfirmed({ ...task, ...queued.row.confirmed! });
  }, [queued.row, task, onConfirmed]);
  return <div className="task-progress">
    <StatusBadge task={task} />
    {writable && task.canProgress && (action || retry) && <button disabled={busy || disabled || conflict || (queueBlocked && !retry)} onClick={() => void send()}>
      {busy ? 'Oczekiwanie na serwer…' : retry ? 'Ponów operację' : action === 'start' ? 'Rozpocznij zadanie' : 'Zgłoś do odbioru'}
    </button>}
    {queued.row && (queued.row.state !== 'confirmed' || (!busy && !retry && queued.row.confirmed!.version === task.version)) && <QueueFeedback row={queued.row} />}
    {queued.failed && <p role="alert" className="error">Wymaga uwagi. Nie można sprawdzić wcześniejszych operacji na urządzeniu. Zapis online potwierdza tylko serwer. Przywróć pamięć urządzenia i sprawdź kolejkę; zachowane operacje mogą wymagać uwagi.</p>}
    {feedback && <p role="status">{feedback}</p>}
    {error && <p className="error" role="alert">{error}</p>}
  </div>;
}
