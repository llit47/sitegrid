import { useEffect, useRef, useState } from 'react';
import { openProjectStorage, type ConfirmedSnapshot, type StorageScope } from '../storage/indexed-db.js';
import { readOfflineAccess, registerOfflineScope } from '../storage/offline-access.js';
import { validateSnapshot } from '../storage/snapshot.js';
import { shellIsAvailable } from '../pwa/lifecycle.js';
import { observeAccessFailure } from './account.js';
import { offlineFailureMessage } from './messages.js';

export function OfflinePreparation({ scope }: { scope: StorageScope }) {
  const [saved, setSaved] = useState<ConfirmedSnapshot | null>(null), [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false), [message, setMessage] = useState(''), [error, setError] = useState('');
  const operation = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      const access = await readOfflineAccess();
      if (!access || access.accountId !== scope.accountId || controller.signal.aborted) return;
      const handle = await openProjectStorage(scope, controller.signal);
      try {
        const existing = access.scopes.some(item => item.organizationId === scope.organizationId && item.projectId === scope.projectId) ? await handle.read(access.generation) : null;
        const shell = await shellIsAvailable();
        if (!controller.signal.aborted) { setSaved(existing); setReady(shell && !!existing); }
      } finally { handle.close(); }
    })().catch(error => { if (!controller.signal.aborted) setError(offlineFailureMessage(error)); });
    return () => { controller.abort(); operation.current?.abort(); };
  }, [scope.accountId, scope.organizationId, scope.projectId]);
  const prepare = async () => {
    if (busy) return;
    const controller = new AbortController(); operation.current = controller;
    const authorizedAt = Date.now(); setBusy(true); setError(''); setMessage('Pobieranie kompletnego projektu…');
    try {
      const access = await readOfflineAccess();
      if (!access || access.accountId !== scope.accountId) throw new Error('Potwierdź konto online przed przygotowaniem projektu.');
      if (!await shellIsAvailable()) throw new Error('Powłoka offline jest niedostępna. Zaczekaj na jej przygotowanie.');
      const path = `/api/organizations/${scope.organizationId}/projects/${scope.projectId}/snapshot`;
      const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
      const data = await response.json();
      if (!response.ok) {
        await observeAccessFailure(path, response.status);
        if ([401,403,404].includes(response.status)) { setSaved(null); setReady(false); }
        throw new Error(data.error ?? 'Nie udało się pobrać projektu.');
      }
      const snapshot = await validateSnapshot(data, scope);
      if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');
      setMessage('Weryfikacja i zapis całego projektu…');
      // Catalog admission precedes replacement. A failed download/save leaves
      // the previous confirmed record intact; empty entries never imply readiness.
      await registerOfflineScope(scope, access.generation);
      const handle = await openProjectStorage(scope, controller.signal);
      try { await handle.replace(snapshot, access.generation, authorizedAt); } finally { handle.close(); }
      const current = await readOfflineAccess();
      if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');
      if (!current || current.generation !== access.generation) throw new Error('Konto zmieniło się. Projekt nie jest gotowy offline.');
      const shell = await shellIsAvailable();
      setSaved({ format: 1, snapshot, generation: access.generation, authorizedAt }); setReady(shell);
      setMessage(shell ? 'Projekt gotowy offline — tylko odczyt.' : 'Dane zapisane, ale powłoka offline niedostępna. Projekt nie jest gotowy offline.');
    } catch (e) {
      if (controller.signal.aborted) setMessage('Przygotowanie anulowane.');
      else { setMessage(''); setError(offlineFailureMessage(e)); }
    } finally { if (operation.current === controller) { operation.current = null; setBusy(false); } }
  };
  return <section className="offline-preparation" aria-label="Przygotowanie projektu offline">
    <h4>Projekt offline</h4><p className="hint">Pobierz tylko ten projekt do odczytu przez maksymalnie 24 godziny. Dane mogą później zmienić się na serwerze.</p>
    {saved && <p>{ready ? 'Gotowy offline.' : 'Zapisany snapshot.'} {saved.snapshot.tasks.length} zadań · Ostatnie przygotowanie: {new Date(saved.snapshot.generatedAt).toLocaleString('pl-PL')}</p>}
    {saved && error && <p>Odświeżenie nie powiodło się. Poprzedni kompletny snapshot pozostaje zapisany; dostęp zależy od ważności autoryzacji i powłoki.</p>}
    {error && <p className="error" role="alert">{error}</p>}{message && <p role="status">{message}</p>}
    <div className="project-actions"><button type="button" disabled={busy} onClick={() => void prepare()}>{saved ? 'Odśwież offline' : 'Przygotuj offline'}</button>
      {busy && <button type="button" className="secondary" onClick={() => operation.current?.abort()}>Anuluj przygotowanie</button>}</div>
  </section>;
}
