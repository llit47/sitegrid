import { useEffect, useState } from 'react';
import { readOfflineAccess, offlineAccessDenied } from '../storage/offline-access.js';
import { openProjectStorage, type ConfirmedSnapshot } from '../storage/indexed-db.js';
import { shellIsAvailable } from '../pwa/lifecycle.js';
import { offlineFailureMessage } from './messages.js';

const taskStatus = { planned: 'Zaplanowane', in_progress: 'W toku', submitted: 'Zgłoszone do odbioru' };
export function OfflineViewer({ localOnly = false }: { localOnly?: boolean }) {
  const [organization, setOrganization] = useState(''), [organizations, setOrganizations] = useState<string[]>([]);
  const [snapshots, setSnapshots] = useState<ConfirmedSnapshot[]>([]), [error, setError] = useState(''), [loading, setLoading] = useState(true);
  useEffect(() => {
    let disposed = false, checking = false;
    const controller = new AbortController();
    const check = async () => {
      if (checking) return; checking = true;
      try {
        if (document.visibilityState === 'hidden' || offlineAccessDenied()) { setSnapshots([]); setOrganizations([]); setError('Dostęp lokalny zablokowany. Połącz się i zaloguj online.'); return; }
        const access = await readOfflineAccess();
        if (!access) throw new Error('Brak potwierdzonego dostępu lokalnego. Połącz się i zaloguj online.');
        if (!await shellIsAvailable()) throw new Error('Powłoka offline niedostępna. Połącz się, aby przygotować aplikację ponownie.');
        const ids = [...new Set(access.scopes.map(scope => scope.organizationId))];
        const selected = organization || ids[0] || '';
        const prepared: ConfirmedSnapshot[] = [];
        let invalid = false;
        for (const scope of access.scopes.filter(item => item.organizationId === selected)) {
          if (controller.signal.aborted) return;
          const handle = await openProjectStorage(scope, controller.signal);
          try { const snapshot = await handle.read(access.generation); if (snapshot) prepared.push(snapshot); }
          catch { invalid = true; } finally { handle.close(); }
        }
        const current = await readOfflineAccess();
        if (!current || current.generation !== access.generation || controller.signal.aborted) throw new Error('Dostęp lokalny został unieważniony. Wymagane logowanie online.');
        if (!disposed) {
          setOrganizations(ids); setSnapshots(prepared); setError(invalid ? 'Część danych wygasła lub jest uszkodzona. Wymagane ponowne przygotowanie online.' : '');
        }
      } catch (e) { if (!disposed) { setSnapshots([]); setOrganizations([]); setError(offlineFailureMessage(e)); } }
      finally { checking = false; if (!disposed) setLoading(false); }
    };
    const refreshed = () => { setSnapshots([]); void check(); };
    void check(); const timer = setInterval(() => void check(), 1000);
    document.addEventListener('visibilitychange', refreshed); window.addEventListener('sitegrid-offline-access', refreshed);
    return () => { disposed = true; controller.abort(); clearInterval(timer); document.removeEventListener('visibilitychange', refreshed); window.removeEventListener('sitegrid-offline-access', refreshed); };
  }, [organization]);
  return <section className="card offline-viewer"><h1>{localOnly ? 'Odczyt lokalny SiteGrid' : 'SiteGrid bez połączenia'}</h1>
    <p>Przygotowane dane służą wyłącznie do odczytu. Mogły zmienić się na serwerze. Nie zapisujemy ani nie synchronizujemy zmian offline.</p>
    <p>Po odzyskaniu sieci aplikacja ponownie sprawdzi sesję.</p>
    {loading && <p role="status">Sprawdzanie lokalnego dostępu…</p>}{error && <p role="alert" className="error">{error}</p>}
    {organizations.length > 1 && <label>Przygotowana firma<select aria-label="Przygotowana firma" value={organization || organizations[0]} onChange={event => { setSnapshots([]); setOrganization(event.target.value); }}>
      {organizations.map(id => <option key={id} value={id}>{id}</option>)}</select></label>}
    {!loading && !snapshots.length && <p>Brak pobranych projektów z ważnym dostępem offline. Połącz się z serwerem, aby przygotować wybrany projekt.</p>}
    {snapshots.map(({ snapshot }) => <article className="offline-project" key={snapshot.scope.projectId}>
      <h2>{snapshot.project.name}</h2><p>{snapshot.project.description || 'Brak opisu projektu.'}</p>
      <p>{snapshot.project.status === 'archived' ? 'Projekt archiwalny' : 'Projekt aktywny'} · Wersja {snapshot.project.version}</p>
      {snapshot.project.contractor && <p>Kontrahent: {snapshot.project.contractor.name}{snapshot.project.contractor.status === 'inactive' ? ' (nieaktywny)' : ''}</p>}
      <p>Ostatnie przygotowanie: {new Date(snapshot.generatedAt).toLocaleString('pl-PL')} · {snapshot.tasks.length} zadań</p>
      {snapshot.taskAccess === 'none' && <p>Przygotowano wyłącznie metadane projektu. Brak dostępu do zadań.</p>}
      {snapshot.tasks.map(task => <article className="task-row" key={task.id}><div><strong>{task.title}</strong><p>{task.description || 'Brak opisu zadania.'}</p>
        {task.assigneeName && <small>Wykonawca: {task.assigneeName}</small>}<p>{taskStatus[task.status]} · Wersja {task.version}</p></div></article>)}
    </article>)}
  </section>;
}
