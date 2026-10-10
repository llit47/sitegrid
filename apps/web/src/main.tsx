import { useEffect, useRef, useState, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';
import { PwaShell } from './pwa/shell.js';
import { announceAccountChange } from './pwa/lifecycle.js';
import { OrganizationSwitcher } from './organization-switcher.js';
import { InvitationAcceptance, InvitationDelivery, InvitationManager, type InvitationDeliveryResult } from './invitations.js';
import { captureInvitationToken } from './invitation-bootstrap.js';
import { beginAccountVerification, finishAccountVerification, beforeAccountChange } from './offline/account.js';

// Bootstrap also runs offline; App remounts keep this page-lifetime token.
const invitationToken = captureInvitationToken(window);

type Session = { csrfToken: string; user: { id: string; email: string; platformAdmin: boolean } | null };
type Overview = { email: string; installedAt: string; status: string };
type Organization = { id: string; name: string; status: 'active' | 'inactive'; createdAt: string };
async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, { credentials: 'same-origin', ...options });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? 'Nie udało się połączyć z serwerem.');
  return data as T;
}
function Organizations({ csrfToken }: { csrfToken: string }) {
  const [organizations, setOrganizations] = useState<Organization[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [invitationCompany, setInvitationCompany] = useState('');
  const [delivery, setDelivery] = useState<InvitationDeliveryResult | null>(null);
  const load = async () => {
    setError(''); setBusy(true);
    try { setOrganizations((await api<{ organizations: Organization[] }>('/api/admin/organizations')).organizations); }
    catch (e) { setError(e instanceof Error ? e.message : 'Błąd połączenia.'); }
    finally { setBusy(false); }
  };
  useEffect(() => { void load(); }, []);
  const create = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || !organizations) return;
    const form = event.currentTarget;
    const name = new FormData(form).get('name');
    const administratorEmail = new FormData(form).get('administratorEmail');
    setBusy(true); setError(''); setDelivery(null);
    try {
      const created = await api<{ organization: Organization } & InvitationDeliveryResult>('/api/admin/organizations', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken }, body: JSON.stringify({ name, administratorEmail }),
      });
      setOrganizations(current => [created.organization, ...(current ?? [])]);
      setDelivery(created);
      form.reset();
    } catch (e) { setError(e instanceof Error ? e.message : 'Błąd połączenia.'); }
    finally { setBusy(false); }
  };
  return <section className="tile organizations" aria-labelledby="organizations-title"><h2 id="organizations-title">Firmy</h2>
    {error && <div className="error" role="alert">{error} {!organizations && <button className="secondary" onClick={() => void load()} disabled={busy}>Ponów połączenie</button>}</div>}
    {!organizations && !error && <p role="status">Ładowanie firm…</p>}
    {organizations && (organizations.length === 0 ? <p role="status">Nie dodano jeszcze żadnej firmy.</p> : <div className="table-scroll"><table>
      <thead><tr><th scope="col">Nazwa</th><th scope="col">Status</th><th scope="col">Utworzona</th><th scope="col">Aktywacja</th></tr></thead>
      <tbody>{organizations.map(organization => <tr key={organization.id}><td>{organization.name}</td><td>{organization.status === 'active' ? 'Aktywna' : 'Nieaktywna'}</td><td>{new Date(organization.createdAt).toLocaleDateString('pl-PL')}</td><td>{organization.status === 'active' && <button className="secondary" onClick={() => { setDelivery(null); setInvitationCompany(organization.id); }}>Pierwszy administrator</button>}</td></tr>)}</tbody>
    </table></div>)}
    <form className="organization-form" onSubmit={event => void create(event)}><h3>Dodaj firmę</h3>
      <label htmlFor="organization-name">Nazwa firmy</label><input id="organization-name" name="name" type="text" maxLength={200} required disabled={busy || !organizations} />
      <label htmlFor="administrator-email">Email pierwszego administratora</label><input id="administrator-email" name="administratorEmail" type="email" maxLength={254} required disabled={busy || !organizations} />
      <button type="submit" disabled={busy || !organizations}>{busy && organizations ? 'Zapisywanie…' : 'Dodaj firmę'}</button>
    </form>
    <InvitationDelivery result={delivery} />
    {invitationCompany && <><h3>{organizations?.find(organization => organization.id === invitationCompany)?.name}</h3>
      <InvitationManager key={invitationCompany} organizationId={invitationCompany} csrfToken={csrfToken} platform />
      <button className="secondary" onClick={() => setInvitationCompany('')}>Zamknij zaproszenia</button></>}
  </section>;
}
function App({ invitationToken }: { invitationToken: string }) {
  const [session, setSession] = useState<Session | null>(null);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [workspaceRevision, setWorkspaceRevision] = useState(0);
  const [localWarning, setLocalWarning] = useState('');
  const sessionRequest = useRef<AbortController | null>(null);
  const load = async () => {
    sessionRequest.current?.abort(); const controller = new AbortController(); sessionRequest.current = controller;
    const generation = await beginAccountVerification();
    const next = await api<Session>('/api/auth/session', { signal: controller.signal });
    if (controller.signal.aborted) return;
    const warning = await finishAccountVerification(next.user === null ? null : next.user.id, generation);
    if (controller.signal.aborted) return;
    setLocalWarning(warning);
    setSession(next);
    setOverview(next.user?.platformAdmin ? await api<Overview>('/api/admin/overview') : null);
  };
  useEffect(() => { void load().catch(e => { if (!sessionRequest.current?.signal.aborted) setError(e.message); }); return () => sessionRequest.current?.abort(); }, []);
  const login = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!session || busy) return;
    const form = event.currentTarget;
    const fields = new FormData(form);
    setBusy(true); setError('');
    try {
      setLocalWarning(await beforeAccountChange());
      await api('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken },
        body: JSON.stringify({ email: fields.get('email'), password: fields.get('password') }) });
      form.reset();
      try { await load(); } finally { announceAccountChange(); }
    } catch (e) { setError(e instanceof Error ? e.message : 'Błąd połączenia.'); }
    finally { setBusy(false); }
  };
  const logout = async () => {
    if (!session || busy) return;
    setBusy(true); setError('');
    try {
      setLocalWarning(await beforeAccountChange());
      await api('/api/auth/logout', { method: 'POST', headers: { 'X-CSRF-Token': session.csrfToken } });
      setSession(null); setOverview(null);
      // Establish the anonymous cookie before other tabs re-read their session.
      try { await load(); } finally { announceAccountChange(); }
    } catch (e) { setError(e instanceof Error ? e.message : 'Błąd połączenia.'); }
    finally { setBusy(false); }
  };
  return <>
    {session && window.location.pathname === '/invitations/accept' && <InvitationAcceptance token={invitationToken} csrfToken={session.csrfToken} user={session.user}
      onAccepted={async () => { await load(); setWorkspaceRevision(current => current + 1); }} />}
    {session?.user ? <section className="dashboard">
      <div className="dashboard-heading"><div><p className="eyebrow">{session.user.platformAdmin ? 'ADMINISTRACJA PLATFORMY' : 'TWOJE MIEJSCE PRACY'}</p><h1>Witaj w SiteGrid.</h1><p className="account">{session.user.email}</p></div><button className="secondary" onClick={() => void logout()} disabled={busy}>Wyloguj się</button></div>
      {overview ? <div className="tiles"><article className="tile"><span className="indicator" /> <h2>Instalacja jest gotowa</h2><p>Masz dostęp do panelu administratora platformy.</p><dl><dt>Utworzona</dt><dd>{new Date(overview.installedAt).toLocaleDateString('pl-PL')}</dd><dt>Konto</dt><dd>Administrator platformy</dd></dl></article>
        <article className="tile"><h2>Twoja platforma</h2><p>Zarządzaj firmami w sekcji poniżej.</p></article></div> : null}
      {session.user.platformAdmin && <Organizations csrfToken={session.csrfToken} />}
      <OrganizationSwitcher key={`${session.user.id ?? session.user.email}:${workspaceRevision}`} accountId={session.user.id} csrfToken={session.csrfToken} />
    </section> : <section className="card"><p className="eyebrow">TWOJE MIEJSCE PRACY</p><h1>Zaloguj się.</h1><p>Otwórz panel swojej instalacji SiteGrid.</p>
      <form onSubmit={event => void login(event)}><label htmlFor="email">Email</label><input id="email" name="email" type="email" autoComplete="username" maxLength={254} required disabled={busy} />
        <label htmlFor="password">Hasło</label><input id="password" name="password" type="password" autoComplete="current-password" maxLength={128} required disabled={busy} />
        <button type="submit" disabled={!session || busy}>{busy ? 'Logowanie…' : 'Zaloguj się'}</button></form>
      <p className="hint">Dostęp przyznaje administrator Twojej instalacji.</p>
    </section>}
    {error && <div className="error" role="alert">{error} {!session && <button className="secondary" onClick={() => void load().then(() => setError('')).catch(e => setError(e.message))}>Ponów połączenie</button>}</div>}
    {localWarning && <p className="error" role="alert">{localWarning}</p>}
    {!session && !error && <p role="status">Łączenie z SiteGrid…</p>}
  </>;
}
createRoot(document.getElementById('root')!).render(<PwaShell><App invitationToken={invitationToken} /></PwaShell>);
