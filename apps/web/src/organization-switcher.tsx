import { useEffect, useState } from 'react';

type Organization = { id: string; name: string; roles: string[] };
const roleNames: Record<string, string> = {
  organization_admin: 'Administrator firmy', manager: 'Kierownik', foreman: 'Brygadzista', worker: 'Pracownik',
};
async function read<T>(path: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(path, { credentials: 'same-origin', signal });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? 'Nie udało się połączyć z serwerem.');
  return data;
}

export function OrganizationSwitcher() {
  const [organizations, setOrganizations] = useState<Organization[] | null>(null);
  // Selection lives only in this mounted tab; it is never stored in the session or browser storage.
  const [selectedId, setSelectedId] = useState('');
  const [context, setContext] = useState<Organization | null>(null);
  const [listError, setListError] = useState('');
  const [contextError, setContextError] = useState('');
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void read<{ organizations: Organization[] }>('/api/me/organizations', controller.signal)
      .then(data => { if (!controller.signal.aborted) setOrganizations(data.organizations); })
      .catch(e => { if (!controller.signal.aborted) setListError(e.message); });
    return () => controller.abort();
  }, [revision]);
  useEffect(() => {
    if (!selectedId) return;
    const controller = new AbortController();
    void read<{ organization: Organization }>(`/api/organizations/${encodeURIComponent(selectedId)}/context`, controller.signal)
      .then(data => { if (!controller.signal.aborted) setContext(data.organization); })
      .catch(e => { if (!controller.signal.aborted) setContextError(e.message); });
    return () => controller.abort();
  }, [selectedId]);
  const refresh = () => {
    setSelectedId(''); setContext(null); setContextError(''); setListError(''); setOrganizations(null);
    setRevision(current => current + 1);
  };
  return <section className="tile organizations" aria-labelledby="workspace-title">
    <h2 id="workspace-title">Twoje firmy</h2>
    {listError && <p className="error" role="alert">{listError}</p>}
    {!organizations && !listError && <p role="status">Ładowanie dostępnych firm…</p>}
    {organizations && (organizations.length === 0 ? <p role="status">Nie masz aktywnego członkostwa w żadnej aktywnej firmie.</p> : <>
      <label htmlFor="active-organization">Wybierz firmę</label>
      <select id="active-organization" value={selectedId} onChange={event => {
        setContext(null); setContextError(''); setSelectedId(event.target.value);
      }}>
        <option value="">Wybierz firmę…</option>
        {organizations.map(organization => <option key={organization.id} value={organization.id}>{organization.name}</option>)}
      </select>
      {selectedId && !context && !contextError && <p role="status">Ładowanie kontekstu firmy…</p>}
      {context?.id === selectedId && <div aria-live="polite"><h3>{context.name}</h3>
        <p>Twoje role: {context.roles.length ? context.roles.map(role => roleNames[role] ?? role).join(', ') : 'Brak przypisanych ról'}</p></div>}
      {contextError && <p className="error" role="alert">{contextError}</p>}
    </>)}
    <button className="secondary" onClick={refresh}>Odśwież dostępne firmy</button>
  </section>;
}
