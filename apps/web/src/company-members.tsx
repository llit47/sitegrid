import { useEffect, useState, type FormEvent } from 'react';

type Employee = { id: string; membershipId: string | null; displayName: string; position: string; phone: string; status: string };
type Member = { id: string; email: string; status: string; roles: string[]; employee: Employee | null };
const roles: Record<string, string> = { organization_admin: 'Administrator firmy', manager: 'Kierownik', foreman: 'Brygadzista', worker: 'Pracownik' };
const states: Record<string, string> = { active: 'Aktywny', inactive: 'Nieaktywny', pending: 'Oczekujący' };
async function request<T>(path: string, csrfToken: string, payload?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, { credentials: 'same-origin', signal, ...(payload === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken }, body: JSON.stringify(payload),
  }) });
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(data.error ?? 'Błąd połączenia.'), { status: response.status });
  return data;
}
export function CompanyMembers({ organizationId, csrfToken, onAccessChanged }: {
  organizationId: string; csrfToken: string; onAccessChanged: () => void;
}) {
  const [members, setMembers] = useState<Member[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [revision, setRevision] = useState(0);
  const [filter, setFilter] = useState('all');
  const [editing, setEditing] = useState<Employee | null>(null);
  const path = `/api/organizations/${encodeURIComponent(organizationId)}`;
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setMembers([]); setEmployees([]);
    void Promise.all([
      request<{ members: Member[] }>(`${path}/members`, csrfToken, undefined, controller.signal),
      request<{ employees: Employee[] }>(`${path}/employees`, csrfToken, undefined, controller.signal),
    ]).then(([m, e]) => {
      if (!controller.signal.aborted) { setMembers(m.members); setEmployees(e.employees); setLoading(false); }
    }).catch(e => {
      if (!controller.signal.aborted) {
        setLoading(false); setError(e.message);
        if (e.status === 401 || e.status === 403) onAccessChanged();
      }
    });
    return () => controller.abort();
  }, [path, csrfToken, revision, onAccessChanged]);
  const mutate = async (suffix: string, payload: unknown) => {
    if (busy) return false;
    setBusy(true); setError(''); setNotice('');
    try {
      await request(`${path}/${suffix}`, csrfToken, payload);
      setNotice('Zapisano zmianę.'); setRevision(current => current + 1);
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Błąd połączenia.');
      if ((e as { status?: number }).status === 401 || (e as { status?: number }).status === 403) onAccessChanged();
      return false;
    } finally { setBusy(false); }
  };
  const saveEmployee = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget, data = new FormData(form);
    const payload = { displayName: data.get('displayName'), position: data.get('position'), phone: data.get('phone'),
      ...(!editing ? { membershipId: data.get('membershipId') || null } : {}) };
    if (await mutate(editing ? `employees/${editing.id}/update` : 'employees', payload)) {
      setEditing(null); form.reset();
    }
  };
  const visible = <T extends { status: string }>(items: T[]) => items.filter(item => filter === 'all' || item.status === filter);
  const statusAction = (kind: 'members' | 'employees', item: { id: string; status: string }) => item.status !== 'pending' &&
    <button className="secondary" disabled={busy || loading} onClick={() => void mutate(`${kind}/${item.id}/${item.status === 'active' ? 'deactivate' : 'reactivate'}`, {})}>
      {item.status === 'active' ? 'Dezaktywuj' : 'Reaktywuj'}
    </button>;
  return <section className="company-members" aria-labelledby={`members-${organizationId}`}>
    <h3 id={`members-${organizationId}`}>Członkowie i pracownicy</h3>
    <p className="hint">Zmiany dotyczą wybranej firmy. Dezaktywacja zachowuje historię i role. Przed odebraniem dostępu ostatniemu administratorowi nadaj tę rolę innemu aktywnemu członkowi.</p>
    {error && <p className="error" role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    <div className="member-toolbar"><label>Pokaż<select aria-label="Pokaż" value={filter} onChange={event => setFilter(event.target.value)}>
      <option value="all">Wszystkich</option><option value="active">Aktywnych</option><option value="inactive">Nieaktywnych</option><option value="pending">Oczekujących</option>
    </select></label><button className="secondary" disabled={busy || loading} onClick={() => { setError(''); setRevision(current => current + 1); }}>Odśwież listę</button></div>
    {loading ? <p role="status">Ładowanie członków i pracowników…</p> : <>
      <h4>Członkostwa z kontem</h4>
      <div className="member-list">{visible(members).map(member => <article className="member-row" key={member.id}>
        <div><strong>{member.employee?.displayName || member.email}</strong>
          {member.employee && <p>{member.email}<br />{[member.employee.position, member.employee.phone].filter(Boolean).join(' · ')}</p>}
          <p>{states[member.status]} · {member.roles.map(role => roles[role]).join(', ') || 'Brak ról'}</p>
          {!member.employee && <p className="hint">Brak profilu pracownika</p>}
        </div>
        <div><fieldset disabled={busy}><legend>Role w firmie</legend>{Object.entries(roles).map(([role, name]) => <label className="role-choice" key={role}>
          <input type="checkbox" checked={member.roles.includes(role)} onChange={event => void mutate(`members/${member.id}/roles/${event.target.checked ? 'assign' : 'remove'}`, { role })} />{name}
        </label>)}</fieldset>
          {statusAction('members', member)}
          {member.employee && <button className="secondary" disabled={busy} onClick={() => setEditing(member.employee)}>Edytuj profil</button>}
        </div>
      </article>)}</div>
      {!visible(members).length && <p>Brak członkostw w wybranym filtrze.</p>}
      <h4>Pracownicy bez konta</h4>
      <div className="member-list">{visible(employees.filter(employee => !employee.membershipId)).map(employee => <article className="member-row" key={employee.id}>
        <div><strong>{employee.displayName}</strong><p>{[employee.position, employee.phone].filter(Boolean).join(' · ')}</p><p>{states[employee.status]} · Bez konta logowania</p></div>
        <div><button className="secondary" disabled={busy} onClick={() => setEditing(employee)}>Edytuj profil</button>{statusAction('employees', employee)}</div>
      </article>)}</div>
      {!visible(employees.filter(employee => !employee.membershipId)).length && <p>Brak pracowników bez konta w wybranym filtrze.</p>}
    </>}
    <form className="employee-form" key={editing?.id ?? 'new'} onSubmit={event => void saveEmployee(event)}>
      <h4>{editing ? `Edycja: ${editing.displayName}` : 'Dodaj profil pracownika'}</h4>
      <label>Imię i nazwisko<input name="displayName" maxLength={120} defaultValue={editing?.displayName} required disabled={busy} /></label>
      <label>Stanowisko (opcjonalnie)<input name="position" maxLength={120} defaultValue={editing?.position} disabled={busy} /></label>
      <label>Telefon (opcjonalnie)<input name="phone" type="tel" maxLength={40} defaultValue={editing?.phone} disabled={busy} /></label>
      {!editing && <label>Powiązanie z członkostwem<select name="membershipId" disabled={busy || loading} defaultValue="">
        <option value="">Pracownik bez konta</option>{members.filter(member => !member.employee && member.status !== 'pending').map(member => <option key={member.id} value={member.id}>{member.email} ({states[member.status]})</option>)}
      </select></label>}
      <p className="hint">Profil jest lokalny dla firmy. Powiązany profil ma status członkostwa. Konta z dostępem dodawaj przez zaproszenie.</p>
      <div><button disabled={busy || loading}>{busy ? 'Zapisywanie…' : editing ? 'Zapisz profil' : 'Dodaj pracownika'}</button>
        {editing && <button type="button" className="secondary" disabled={busy} onClick={() => setEditing(null)}>Anuluj edycję</button>}</div>
    </form>
  </section>;
}
