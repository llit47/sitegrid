import { useCallback, useEffect, useState } from 'react';
import { InvitationManager } from './invitations.js';
import { CompanyMembers } from './company-members.js';
import { AccentSwatch, brandingRequest, CompanyBranding, CompanyLogo, type Branding } from './company-branding.js';

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

export function OrganizationSwitcher({ csrfToken }: { csrfToken: string }) {
  const [organizations, setOrganizations] = useState<Organization[] | null>(null);
  // Selection lives only in this mounted tab; it is never stored in the session or browser storage.
  const [selectedId, setSelectedId] = useState('');
  const [context, setContext] = useState<Organization | null>(null);
  const [branding, setBranding] = useState<Branding | null>(null);
  const [brands, setBrands] = useState<Record<string, Branding>>({});
  const [listError, setListError] = useState('');
  const [contextError, setContextError] = useState('');
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void read<{ organizations: Organization[] }>('/api/me/organizations', controller.signal)
      .then(async data => {
        if (controller.signal.aborted) return;
        setOrganizations(data.organizations);
        const results = await Promise.allSettled(data.organizations.map(async organization =>
          (await brandingRequest<{ branding: Branding }>(`/api/organizations/${encodeURIComponent(organization.id)}/branding`, controller.signal)).branding));
        if (!controller.signal.aborted) setBrands(current => {
          const next = { ...current };
          for (const result of results) {
            if (result.status !== 'fulfilled') continue;
            const incoming = result.value;
            if (!next[incoming.organizationId] || incoming.version > next[incoming.organizationId].version) {
              next[incoming.organizationId] = incoming;
            }
          }
          return next;
        });
      })
      .catch(e => { if (!controller.signal.aborted) setListError(e.message); });
    return () => controller.abort();
  }, [revision]);
  useEffect(() => {
    if (!selectedId) return;
    const controller = new AbortController();
    void Promise.all([
      read<{ organization: Organization }>(`/api/organizations/${encodeURIComponent(selectedId)}/context`, controller.signal),
      brandingRequest<{ branding: Branding }>(`/api/organizations/${encodeURIComponent(selectedId)}/branding`, controller.signal),
    ]).then(([data, brand]) => { if (!controller.signal.aborted) {
      setContext({ ...data.organization, name: brand.branding.name }); setBranding(brand.branding);
    } })
      .catch(e => { if (!controller.signal.aborted) setContextError(e.message); });
    return () => controller.abort();
  }, [selectedId]);
  const refresh = useCallback(() => {
    setSelectedId(''); setContext(null); setBranding(null); setBrands({}); setContextError(''); setListError(''); setOrganizations(null);
    setRevision(current => current + 1);
  }, []);
  const select = (id: string) => { if (id !== selectedId) { setContext(null); setBranding(null); setContextError(''); setSelectedId(id); } };
  const saved = (updated: Branding) => {
    // An unmounted settings request must never overwrite a different company's header.
    if (updated.organizationId !== selectedId) return;
    setBranding(updated); setContext(current => current?.id === updated.organizationId ? { ...current, name: updated.name } : current);
    setBrands(current => ({ ...current, [updated.organizationId]: updated }));
    setOrganizations(current => current?.map(organization => organization.id === updated.organizationId ? { ...organization, name: updated.name } : organization) ?? null);
  };
  return <section className="tile organizations" aria-labelledby="workspace-title">
    <h2 id="workspace-title">Twoje firmy</h2>
    {listError && <p className="error" role="alert">{listError}</p>}
    {!organizations && !listError && <p role="status">Ładowanie dostępnych firm…</p>}
    {organizations && (organizations.length === 0 ? <p role="status">Nie masz aktywnego członkostwa w żadnej aktywnej firmie.</p> : <>
      <label htmlFor="active-organization">Wybierz firmę</label>
      <select id="active-organization" value={selectedId} onChange={event => select(event.target.value)}>
        <option value="">Wybierz firmę…</option>
        {organizations.map(organization => <option key={organization.id} value={organization.id}>{organization.name}</option>)}
      </select>
      <div className="company-choices">{organizations.map(organization => <button key={organization.id} type="button" className="secondary company-choice"
        aria-pressed={selectedId === organization.id} onClick={() => select(organization.id)}>
        {brands[organization.id] ? <CompanyLogo key={`${organization.id}-${brands[organization.id].logo?.version ?? 0}`} branding={brands[organization.id]} /> : <span className="company-logo" aria-hidden="true">{organization.name.slice(0, 1)}</span>}
        <span>{brands[organization.id]?.name ?? organization.name}</span>
      </button>)}</div>
      {selectedId && !context && !contextError && <p role="status">Ładowanie kontekstu firmy…</p>}
      {context?.id === selectedId && branding?.organizationId === selectedId && <div aria-live="polite">
        <div className="company-header"><AccentSwatch color={branding.accentColor} />
          <CompanyLogo key={`${branding.organizationId}-${branding.logo?.version ?? 0}`} branding={branding} /><h3>{branding.name}</h3></div>
        <p>Twoje role: {context.roles.length ? context.roles.map(role => roleNames[role] ?? role).join(', ') : 'Brak przypisanych ról'}</p>
        {context.roles.includes('organization_admin') && <>
          <CompanyBranding key={`branding-${context.id}`} branding={branding} csrfToken={csrfToken} onSaved={saved} onAccessChanged={refresh} />
          <CompanyMembers key={`members-${context.id}`} organizationId={context.id} csrfToken={csrfToken} onAccessChanged={refresh} />
          <InvitationManager key={context.id} organizationId={context.id} csrfToken={csrfToken} />
        </>}</div>}
      {contextError && <p className="error" role="alert">{contextError}</p>}
    </>)}
    <button className="secondary" onClick={refresh}>Odśwież dostępne firmy</button>
  </section>;
}
