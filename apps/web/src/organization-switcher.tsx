import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { CompanyWorkspace } from './workspace/company-workspace.js';
import { WorkspaceLayout, type Section } from './workspace/layout.js';
import { guardWorkspaceChange, useUnloadGuard } from './workspace/navigation-safety.js';
import { AccentSwatch, brandingRequest, CompanyLogo, type Branding } from './company-branding.js';
import { observeAccessFailure } from './offline/account.js';
import { readOfflineAccess, invalidateOfflineProjects } from './storage/offline-access.js';

type Organization = { id: string; name: string; roles: string[] };
const roleNames: Record<string, string> = {
  organization_admin: 'Administrator firmy', manager: 'Kierownik', foreman: 'Brygadzista', worker: 'Pracownik',
};
async function read<T>(path: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(path, { credentials: 'same-origin', signal });
  const data = await response.json();
  if (!response.ok) { await observeAccessFailure(path, response.status); throw new Error(data.error ?? 'Nie udało się połączyć z serwerem.'); }
  return data;
}

export function OrganizationSwitcher({ csrfToken, accountId, email, platformAdmin, busy, onLogout, platform }: {
  csrfToken: string; accountId: string; email: string; platformAdmin: boolean; busy: boolean; onLogout: () => void; platform: ReactNode;
}) {
  useUnloadGuard();
  const [active, setActive] = useState<Section>(platformAdmin ? 'platform' : 'dashboard');
  const [visited, setVisited] = useState(new Set<Section>(platformAdmin ? ['platform'] : []));
  const navigate = (section: Section) => { setActive(section); setVisited(current => new Set([...current, section])); };
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
        const access = await readOfflineAccess().catch(() => null);
        if (access?.accountId === accountId) for (const id of new Set(access.scopes.map(scope => scope.organizationId))) {
          if (!data.organizations.some(organization => organization.id === id)) await invalidateOfflineProjects(id);
        }
        if (controller.signal.aborted) return;
        setOrganizations(data.organizations);
        if (data.organizations.length === 1) setSelectedId(data.organizations[0].id);
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
    setActive(platformAdmin ? 'platform' : 'dashboard'); setVisited(new Set());
    setSelectedId(''); setContext(null); setBranding(null); setBrands({}); setContextError(''); setListError(''); setOrganizations(null);
    setRevision(current => current + 1);
  }, [platformAdmin]);
  const select = (id: string) => { if (id !== selectedId && guardWorkspaceChange()) { setActive('dashboard'); setVisited(new Set()); setContext(null); setBranding(null); setContextError(''); setSelectedId(id); } };
  const saved = (updated: Branding) => {
    // An unmounted settings request must never overwrite a different company's header.
    if (updated.organizationId !== selectedId) return;
    setBranding(updated); setContext(current => current?.id === updated.organizationId ? { ...current, name: updated.name } : current);
    setBrands(current => ({ ...current, [updated.organizationId]: updated }));
    setOrganizations(current => current?.map(organization => organization.id === updated.organizationId ? { ...organization, name: updated.name } : organization) ?? null);
  };
  const admin = context?.roles.includes('organization_admin') ?? false;
  const sections: Section[] = context ? ['dashboard', 'projects', ...(admin ? ['contractors', 'members', 'invitations', 'settings'] as Section[] : [])] : ['dashboard'];
  if (platformAdmin) sections.push('platform');
  const company = <>
    <label htmlFor="active-organization">Firma</label>
    {organizations?.length ? <select id="active-organization" value={selectedId} onChange={event => select(event.target.value)}>
      <option value="">Wybierz firmę…</option>{organizations.map(organization => <option key={organization.id} value={organization.id}>{brands[organization.id]?.name ?? organization.name}</option>)}
    </select> : <p>{listError || (organizations ? 'Brak członkostwa w firmie.' : 'Ładowanie firm…')}</p>}
    <button className="secondary company-refresh" onClick={() => { if (guardWorkspaceChange()) refresh(); }}>Odśwież dostępne firmy</button>
  </>;
  const identity = active === 'platform' ? <strong>Administracja platformy</strong> : context && branding ? <div className="company-header"><AccentSwatch color={branding.accentColor} /><CompanyLogo key={`${branding.organizationId}-${branding.logo?.version ?? 0}`} branding={branding} /><div><h3>{branding.name}</h3><small>{context.roles.map(role => roleNames[role] ?? role).join(', ') || 'Brak przypisanych ról'}</small></div></div> : <strong>Wybierz firmę</strong>;
  return <WorkspaceLayout active={active} navigate={navigate} sections={sections} company={company} identity={identity} email={email} busy={busy} onLogout={onLogout}>
    {listError && <p className="error" role="alert">{listError}</p>}
    {contextError && <p className="error" role="alert">{contextError} <button className="secondary" onClick={refresh}>Ponów połączenie</button></p>}
    {active !== 'platform' && selectedId && !context && !contextError && <p role="status">Ładowanie kontekstu firmy…</p>}
    {active !== 'platform' && !selectedId && <article className="workspace-empty"><h2>{organizations?.length ? 'Wybierz swoje miejsce pracy' : 'Dostęp do firmy'}</h2><p>{organizations?.length ? 'Wybierz firmę w nawigacji, aby otworzyć jej projekty i narzędzia.' : platformAdmin ? 'Firmy i ich pierwszych administratorów przygotujesz w administracji platformy. Projekty wymagają osobnego członkostwa.' : 'Poproś administratora firmy o zaproszenie. Sam profil pracownika nie daje konta logowania ani dostępu do projektów.'}</p></article>}
    {context?.id === selectedId && branding?.organizationId === selectedId && <CompanyWorkspace key={context.id} active={active} visited={visited} navigate={navigate} accountId={accountId} organizationId={context.id} admin={admin} branding={branding} csrfToken={csrfToken} onSaved={saved} onAccessChanged={refresh} />}
    {platformAdmin && (active === 'platform' || visited.has('platform')) && <div hidden={active !== 'platform'}>{platform}</div>}
  </WorkspaceLayout>;
}
