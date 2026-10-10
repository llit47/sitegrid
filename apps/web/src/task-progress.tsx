import { useEffect, useRef, useState } from 'react';

export type ProgressTask = { id: string; status: string; version: number; canProgress?: boolean };
type Command = { operationId: string; schemaVersion: 1; action: 'start' | 'submit'; expectedVersion: number };
export const taskStateName = (status: string) => ({ planned: 'Zaplanowane', in_progress: 'W toku', submitted: 'Zgłoszone do odbioru' })[status] ?? status;

export function TaskProgress({ task, path, csrfToken, writable, disabled, onConfirmed, onAccessChanged, onGone }: {
  task: ProgressTask; path: string; csrfToken: string; writable: boolean; disabled: boolean;
  onConfirmed: (task: ProgressTask) => void; onAccessChanged: (status: number) => void; onGone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(false);
  const [conflict, setConflict] = useState(false);
  const command = useRef<Command | null>(null);
  const sending = useRef(false);
  const lifetime = useRef<AbortController | null>(null);
  useEffect(() => { const controller = new AbortController(); lifetime.current = controller; return () => controller.abort(); }, []);
  const action = task.status === 'planned' ? 'start' : task.status === 'in_progress' ? 'submit' : null;
  const send = async () => {
    if (sending.current || disabled || conflict) return;
    if (!command.current) {
      if (!action) return;
      command.current = { operationId: crypto.randomUUID(), schemaVersion: 1, action, expectedVersion: task.version };
    }
    sending.current = true; setBusy(true); setError(''); setFeedback(''); setRetry(false);
    const signal = lifetime.current!.signal;
    try {
      const response = await fetch(`${path}/commands`, { method: 'POST', credentials: 'same-origin', signal,
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken }, body: JSON.stringify(command.current) });
      const data = await response.json();
      if (signal.aborted) return;
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) { onAccessChanged(response.status); return; }
        if (response.status === 404) { onGone(); return; }
        if (response.status === 409) {
          command.current = null; setConflict(true);
          setError(`${data.error} Użyj „Wczytaj aktualne dane” przed kolejną akcją.`); return;
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
  return <div className="task-progress">
    <small>{taskStateName(task.status)} · Wersja {task.version}</small>
    {writable && task.canProgress && (action || retry) && <button disabled={busy || disabled || conflict} onClick={() => void send()}>
      {busy ? 'Oczekiwanie na serwer…' : retry ? 'Ponów operację' : action === 'start' ? 'Rozpocznij zadanie' : 'Zgłoś do odbioru'}
    </button>}
    {feedback && <p role="status">{feedback}</p>}
    {error && <p className="error" role="alert">{error}</p>}
  </div>;
}
