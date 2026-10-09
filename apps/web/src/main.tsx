import { useEffect, useState, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';

type Session = { csrfToken: string; user: { email: string; platformAdmin: boolean } | null };
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
    setBusy(true); setError('');
    try {
      const created = await api<{ organization: Organization }>('/api/admin/organizations', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken }, body: JSON.stringify({ name }),
      });
      setOrganizations(current => [created.organization, ...(current ?? [])]);
      form.reset();
    } catch (e) { setError(e instanceof Error ? e.message : 'Błąd połączenia.'); }
    finally { setBusy(false); }
  };
  return <section className="tile organizations" aria-labelledby="organizations-title"><h2 id="organizations-title">Firmy</h2>
    {error && <div className="error" role="alert">{error} {!organizations && <button className="secondary" onClick={() => void load()} disabled={busy}>Ponów połączenie</button>}</div>}
    {!organizations && !error && <p role="status">Ładowanie firm…</p>}
    {organizations && (organizations.length === 0 ? <p role="status">Nie dodano jeszcze żadnej firmy.</p> : <div className="table-scroll"><table>
      <thead><tr><th scope="col">Nazwa</th><th scope="col">Status</th><th scope="col">Utworzona</th></tr></thead>
      <tbody>{organizations.map(organization => <tr key={organization.id}><td>{organization.name}</td><td>{organization.status === 'active' ? 'Aktywna' : 'Nieaktywna'}</td><td>{new Date(organization.createdAt).toLocaleDateString('pl-PL')}</td></tr>)}</tbody>
    </table></div>)}
    <form className="organization-form" onSubmit={event => void create(event)}><h3>Dodaj firmę</h3>
      <label htmlFor="organization-name">Nazwa firmy</label><input id="organization-name" name="name" type="text" maxLength={200} required disabled={busy || !organizations} />
      <button type="submit" disabled={busy || !organizations}>{busy && organizations ? 'Zapisywanie…' : 'Dodaj firmę'}</button>
    </form>
  </section>;
}
function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const load = async () => {
    const next = await api<Session>('/api/auth/session');
    setSession(next);
    setOverview(next.user?.platformAdmin ? await api<Overview>('/api/admin/overview') : null);
  };
  useEffect(() => { void load().catch(e => setError(e.message)); }, []);
  const login = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!session || busy) return;
    const form = event.currentTarget;
    const fields = new FormData(form);
    setBusy(true); setError('');
    try {
      await api('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken },
        body: JSON.stringify({ email: fields.get('email'), password: fields.get('password') }) });
      form.reset();
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : 'Błąd połączenia.'); }
    finally { setBusy(false); }
  };
  const logout = async () => {
    if (!session || busy) return;
    setBusy(true); setError('');
    try {
      await api('/api/auth/logout', { method: 'POST', headers: { 'X-CSRF-Token': session.csrfToken } });
      setSession(null); setOverview(null);
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : 'Błąd połączenia.'); }
    finally { setBusy(false); }
  };
  return <main className="shell"><header className="brand"><span className="brand-mark" aria-hidden="true">S</span> SiteGrid</header>
    {session?.user ? <section className="dashboard">
      <div className="dashboard-heading"><div><p className="eyebrow">ADMINISTRACJA PLATFORMY</p><h1>Witaj w SiteGrid.</h1><p className="account">{session.user.email}</p></div><button className="secondary" onClick={() => void logout()} disabled={busy}>Wyloguj się</button></div>
      {overview ? <div className="tiles"><article className="tile"><span className="indicator" /> <h2>Instalacja jest gotowa</h2><p>Masz dostęp do panelu administratora platformy.</p><dl><dt>Utworzona</dt><dd>{new Date(overview.installedAt).toLocaleDateString('pl-PL')}</dd><dt>Konto</dt><dd>Administrator platformy</dd></dl></article>
        <article className="tile"><h2>Twoja platforma</h2><p>Zarządzaj firmami w sekcji poniżej.</p></article></div> : !session.user.platformAdmin && <p role="status">Konto nie ma dostępu do administracji platformą.</p>}
      {session.user.platformAdmin && <Organizations csrfToken={session.csrfToken} />}
    </section> : <section className="card"><p className="eyebrow">TWOJE MIEJSCE PRACY</p><h1>Zaloguj się.</h1><p>Otwórz panel swojej instalacji SiteGrid.</p>
      <form onSubmit={event => void login(event)}><label htmlFor="email">Email</label><input id="email" name="email" type="email" autoComplete="username" maxLength={254} required disabled={busy} />
        <label htmlFor="password">Hasło</label><input id="password" name="password" type="password" autoComplete="current-password" maxLength={128} required disabled={busy} />
        <button type="submit" disabled={!session || busy}>{busy ? 'Logowanie…' : 'Zaloguj się'}</button></form>
      <p className="hint">Dostęp przyznaje administrator Twojej instalacji.</p>
    </section>}
    {error && <div className="error" role="alert">{error} {!session && <button className="secondary" onClick={() => void load().then(() => setError('')).catch(e => setError(e.message))}>Ponów połączenie</button>}</div>}
    {!session && !error && <p role="status">Łączenie z SiteGrid…</p>}
    <footer>SiteGrid · samodzielna instalacja</footer></main>;
}
createRoot(document.getElementById('root')!).render(<App />);
