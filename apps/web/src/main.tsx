import { useEffect, useRef, useState, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';
import { PwaShell } from './pwa/shell.js';
import { announceAccountChange } from './pwa/lifecycle.js';
import { Organizations } from './platform-administration.js';
import { guardWorkspaceChange } from './workspace/navigation-safety.js';
import { OrganizationSwitcher } from './organization-switcher.js';
import { InvitationAcceptance } from './invitations.js';
import { captureInvitationToken } from './invitation-bootstrap.js';
import { beginAccountVerification, finishAccountVerification, beforeAccountChange } from './offline/account.js';

// Bootstrap also runs offline; App remounts keep this page-lifetime token.
const invitationToken = captureInvitationToken(window);

type Session = { csrfToken: string; user: { id: string; email: string; platformAdmin: boolean } | null };
type Overview = { email: string; installedAt: string; status: string };
async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, { credentials: 'same-origin', ...options });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? 'Nie udało się połączyć z serwerem.');
  return data as T;
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
    const warning = await finishAccountVerification(next.user === null ? null : next.user?.id, generation);
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
    if (!session || busy || !guardWorkspaceChange()) return;
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
    {session?.user ? <OrganizationSwitcher key={`${session.user.id}:${workspaceRevision}`} accountId={session.user.id} csrfToken={session.csrfToken}
      email={session.user.email} platformAdmin={session.user.platformAdmin} busy={busy} onLogout={() => void logout()}
      platform={<>{overview && <article className="tile"><p className="eyebrow">INSTALACJA SITEGRID</p><h2>Administracja platformy</h2><p>Twórz firmy i zapraszaj ich pierwszych administratorów. Dostęp do pracy firmy wymaga aktywnego członkostwa w firmie i odpowiedniej roli.</p><p className="hint">Instalacja utworzona {new Date(overview.installedAt).toLocaleDateString('pl-PL')}</p></article>}<Organizations csrfToken={session.csrfToken} /></>} /> : <section className="card"><p className="eyebrow">TWOJE MIEJSCE PRACY</p><h1>Zaloguj się.</h1><p>Otwórz panel swojej instalacji SiteGrid.</p>
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
