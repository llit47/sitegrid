import { guardWorkspaceChange, usePendingOperation } from './workspace/navigation-safety.js';
import { useEffect, useState, type FormEvent } from 'react';
import { InvitationDelivery, InvitationManager, type InvitationDeliveryResult } from './invitations.js';
type Organization = { id: string; name: string; status: 'active' | 'inactive'; createdAt: string };
async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, { credentials: 'same-origin', ...options });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? 'Nie udało się połączyć z serwerem.');
  return data as T;
}
export function Organizations({ csrfToken }: { csrfToken: string }) {
  const [organizations, setOrganizations] = useState<Organization[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  usePendingOperation(busy);
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
      <tbody>{organizations.map(organization => <tr key={organization.id}><td>{organization.name}</td><td>{organization.status === 'active' ? 'Aktywna' : 'Nieaktywna'}</td><td>{new Date(organization.createdAt).toLocaleDateString('pl-PL')}</td><td>{organization.status === 'active' && <button className="secondary" onClick={() => { if (guardWorkspaceChange()) { setDelivery(null); setInvitationCompany(organization.id); } }}>Pierwszy administrator</button>}</td></tr>)}</tbody>
    </table></div>)}
    <form className="organization-form" onSubmit={event => void create(event)}><h3>Dodaj firmę</h3>
      <label htmlFor="organization-name">Nazwa firmy</label><input id="organization-name" name="name" type="text" maxLength={200} required disabled={busy || !organizations} />
      <label htmlFor="administrator-email">Email pierwszego administratora</label><input id="administrator-email" name="administratorEmail" type="email" maxLength={254} required disabled={busy || !organizations} />
      <button type="submit" disabled={busy || !organizations}>{busy && organizations ? 'Zapisywanie…' : 'Dodaj firmę'}</button>
    </form>
    <InvitationDelivery result={delivery} />
    {invitationCompany && <><h3>{organizations?.find(organization => organization.id === invitationCompany)?.name}</h3>
      <InvitationManager key={invitationCompany} organizationId={invitationCompany} csrfToken={csrfToken} platform />
      <button className="secondary" onClick={() => { if (guardWorkspaceChange()) setInvitationCompany(''); }}>Zamknij zaproszenia</button></>}
  </section>;
}
