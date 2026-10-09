import { useEffect, useState, type FormEvent } from 'react';

type Invitation = { id: string; email: string; role: string; status: string; expiresAt: string };
export type InvitationDeliveryResult = { delivery: 'sent' | 'failed' | 'manual'; acceptanceLink?: string };
const states: Record<string, string> = { pending: 'Oczekujące', accepted: 'Zaakceptowane', expired: 'Wygasłe', revoked: 'Anulowane', unavailable: 'Niedostępne' };
const roles: Record<string, string> = { organization_admin: 'Administrator firmy', manager: 'Kierownik', foreman: 'Brygadzista', worker: 'Pracownik' };
async function request<T>(path: string, csrfToken: string, payload?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, { credentials: 'same-origin', signal, ...(payload === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken }, body: JSON.stringify(payload),
  }) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? 'Błąd połączenia.');
  return data;
}
export function InvitationDelivery({ result }: { result: InvitationDeliveryResult | null }) {
  if (!result) return null;
  return <div role="status">
    <p>{result.delivery === 'sent' ? 'Wysłano zaproszenie. Link jest ważny przez 24 godziny.' : result.delivery === 'failed'
      ? 'Nie udało się wysłać emaila. Zaproszenie zapisano. Sprawdź SMTP i wyślij nowe zaproszenie, aby zastąpić ten link.'
      : 'Link developerski jest ważny przez 24 godziny. Skopiuj go teraz i przekaż odbiorcy.'}</p>
    {result.acceptanceLink && <label>Link zaproszenia<input aria-label="Link zaproszenia" readOnly value={result.acceptanceLink} onFocus={event => event.target.select()} /></label>}
  </div>;
}
export function InvitationManager({ organizationId, csrfToken, platform = false }: { organizationId: string; csrfToken: string; platform?: boolean }) {
  const [invitations, setInvitations] = useState<Invitation[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const [delivery, setDelivery] = useState<InvitationDeliveryResult | null>(null);
  const path = `/api/${platform ? 'admin/' : ''}organizations/${encodeURIComponent(organizationId)}/invitations`;
  useEffect(() => {
    const controller = new AbortController();
    void request<{ invitations: Invitation[] }>(path, csrfToken, undefined, controller.signal)
      .then(data => { if (!controller.signal.aborted) setInvitations(data.invitations); })
      .catch(e => { if (!controller.signal.aborted) setError(e.message); });
    return () => controller.abort();
  }, [path, csrfToken, revision]);
  const create = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    const form = event.currentTarget;
    const fields = new FormData(form);
    setBusy(true); setError(''); setDelivery(null);
    try {
      const result = await request<InvitationDeliveryResult>(path, csrfToken, { email: fields.get('email'), ...(platform ? {} : { role: fields.get('role') }) });
      setDelivery(result); form.reset(); setRevision(current => current + 1);
    } catch (e) { setError(e instanceof Error ? e.message : 'Błąd połączenia.'); }
    finally { setBusy(false); }
  };
  const revoke = async (id: string) => {
    setBusy(true); setError(''); setDelivery(null);
    try { await request(`${path}/${encodeURIComponent(id)}/revoke`, csrfToken, {}); setRevision(current => current + 1); }
    catch (e) { setError(e instanceof Error ? e.message : 'Błąd połączenia.'); }
    finally { setBusy(false); }
  };
  return <section className="organization-form"><h3>{platform ? 'Zaproszenie pierwszego administratora' : 'Zaproszenia do firmy'}</h3>
    {error && <p className="error" role="alert">{error}</p>}
    {!invitations && !error && <p role="status">Ładowanie zaproszeń…</p>}
    {invitations && <div className="table-scroll"><table><thead><tr><th>Email</th><th>Rola</th><th>Status</th><th>Ważne do</th><th>Akcja</th></tr></thead>
      <tbody>{invitations.map(invitation => <tr key={invitation.id}><td>{invitation.email}</td><td>{roles[invitation.role]}</td><td>{states[invitation.status]}</td>
        <td>{new Date(invitation.expiresAt).toLocaleString('pl-PL')}</td><td>{invitation.status === 'pending' && <button className="secondary" disabled={busy} onClick={() => void revoke(invitation.id)}>Anuluj</button>}</td></tr>)}</tbody></table>
      {!invitations.length && <p>Brak zaproszeń.</p>}</div>}
    <button className="secondary" disabled={busy} onClick={() => { setError(''); setRevision(current => current + 1); }}>Odśwież zaproszenia</button>
    <form onSubmit={event => void create(event)}><label>Email odbiorcy<input name="email" type="email" maxLength={254} required disabled={busy} /></label>
      {!platform && <label>Rola<select name="role" aria-label="Rola" defaultValue="worker" disabled={busy}>{Object.entries(roles).map(([role, name]) => <option key={role} value={role}>{name}</option>)}</select></label>}
      <p className="hint">Nowe zaproszenie zastępuje poprzedni oczekujący link do tego adresu{platform ? ' lub pierwszego administratora' : ''}.</p>
      <button disabled={busy}>{busy ? 'Zapisywanie…' : 'Wyślij zaproszenie'}</button>
    </form><InvitationDelivery result={delivery} />
  </section>;
}
export function InvitationAcceptance({ token, csrfToken, user, onAccepted }: { token: string; csrfToken: string; user: { email: string } | null; onAccepted: () => Promise<void> }) {
  const [state, setState] = useState<{ status: string; organizationName?: string } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void request<{ status: string; organizationName?: string }>('/api/invitations/inspect', csrfToken, { token }, controller.signal)
      .then(result => { if (!controller.signal.aborted) setState(result); })
      .catch(e => { if (!controller.signal.aborted) setError(e.message); });
    return () => controller.abort();
  }, [token, csrfToken, revision]);
  const accept = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    const fields = new FormData(event.currentTarget);
    if (!user && fields.get('password') !== fields.get('confirmation')) { setError('Hasła muszą być identyczne.'); return; }
    setBusy(true); setError('');
    try {
      await request('/api/invitations/accept', csrfToken, { token, ...(!user ? { email: fields.get('email'), password: fields.get('password') } : {}) });
      setState({ status: 'accepted' }); await onAccepted();
    } catch (e) {
      setError(`${e instanceof Error ? e.message : 'Błąd połączenia.'} Jeśli masz konto, zaloguj się na zaproszony adres email.`);
      setRevision(current => current + 1);
    } finally { setBusy(false); }
  };
  return <section className="tile organizations"><h2>Aktywacja zaproszenia</h2>
    {!state && !error && <p role="status">Sprawdzanie zaproszenia…</p>}
    {state && <p role="status">{states[state.status]}{state.organizationName ? ` — ${state.organizationName}` : ''}</p>}
    {state?.status === 'accepted' && <p>Zaproszenie zostało przyjęte. {user ? 'Odśwież dostępne firmy i wybierz firmę.' : 'Zaloguj się, aby otworzyć swoje firmy.'}</p>}
    {state?.status === 'pending' && <form onSubmit={event => void accept(event)}>
      {user ? <p>Akceptujesz jako {user.email}. Konto musi mieć zaproszony adres email.</p> : <>
        <p>Masz już konto? Zaloguj się poniżej i zaakceptuj zaproszenie. Nowe konto aktywujesz tutaj:</p>
        <label>Email z zaproszenia<input name="email" type="email" autoComplete="username" maxLength={254} required disabled={busy} /></label>
        <label>Nowe hasło<input name="password" type="password" autoComplete="new-password" minLength={12} maxLength={128} required disabled={busy} /></label>
        <label>Powtórz hasło<input name="confirmation" type="password" autoComplete="new-password" minLength={12} maxLength={128} required disabled={busy} /></label>
      </>}
      <button disabled={busy}>{busy ? 'Aktywacja…' : user ? 'Akceptuj zaproszenie' : 'Utwórz konto i zaakceptuj'}</button>
    </form>}
    {error && <p className="error" role="alert">{error}</p>}
  </section>;
}
