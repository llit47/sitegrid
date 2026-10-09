import { useEffect, useState, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';

type Session = { csrfToken: string; user: { email: string; platformAdmin: boolean } | null };
type Overview = { email: string; installedAt: string; status: string };
async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, { credentials: 'same-origin', ...options });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? 'Nie udało się połączyć z serwerem.');
  return data as T;
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
        <article className="tile"><h2>Twoja platforma</h2><p>Fundament SiteGrid jest uruchomiony. Obsługa firm i zespołów będzie dostępna w kolejnych wydaniach.</p></article></div> : <p role="status">Konto nie ma dostępu do administracji platformą.</p>}
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
