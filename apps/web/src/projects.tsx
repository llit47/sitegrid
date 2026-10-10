import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';

type Project = { id: string; name: string; description: string; status: string; version: number; createdAt: string; updatedAt: string };
type Task = { id: string; title: string; description: string; assigneeMembershipId: string; assigneeName?: string; status: string; version: number };
type Member = { membershipId: string; displayName: string; companyStatus: string; accountActive: boolean; status: string | null; version: number };
type Details = { project: Project; permissions: { administer: boolean; readTasks: boolean; manageTasks: boolean } };
async function request<T>(path: string, signal: AbortSignal, csrfToken?: string, payload?: unknown): Promise<T> {
  const response = await fetch(path, { credentials: 'same-origin', signal, ...(payload === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken! }, body: JSON.stringify(payload),
  }) });
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(data.error ?? 'Nie udało się połączyć z serwerem.'), { status: response.status });
  return data;
}
const stateName = (status: string) => status === 'active' ? 'Aktywny' : status === 'archived' ? 'Archiwalny' : 'Zaplanowane';
function ProjectForm({ project, busy, save }: { project?: Project; busy: boolean; save: (payload: object) => Promise<boolean> }) {
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget, values = new FormData(form);
    if (await save({ name: values.get('name'), description: values.get('description'), ...(project ? { expectedVersion: project.version } : {}) })) {
      if (!project) form.reset();
    }
  };
  return <form className="project-form" onSubmit={event => void submit(event)}>
    <h4>{project ? 'Edytuj projekt' : 'Nowy projekt'}</h4>
    <label>Nazwa projektu<input name="name" defaultValue={project?.name} required maxLength={200} disabled={busy} /></label>
    <label>Opis projektu (opcjonalnie)<input name="description" defaultValue={project?.description} maxLength={4000} disabled={busy} /></label>
    <button disabled={busy}>{busy ? 'Zapisywanie…' : project ? 'Zapisz projekt' : 'Utwórz projekt'}</button>
  </form>;
}
function TaskForm({ task, members, busy, save, cancel }: {
  task: Task | null; members: Member[]; busy: boolean; save: (payload: object) => Promise<boolean>; cancel: () => void;
}) {
  const eligible = members.filter(member => member.status === 'active' && member.companyStatus === 'active' && member.accountActive);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget, values = new FormData(form);
    if (await save({ title: values.get('title'), description: values.get('description'), assigneeMembershipId: values.get('assigneeMembershipId'),
      ...(task ? { expectedVersion: task.version } : {}) })) { form.reset(); cancel(); }
  };
  return <form className="task-form" onSubmit={event => void submit(event)}>
    <h4>{task ? 'Edytuj zadanie' : 'Nowe zadanie'}</h4>
    <label>Tytuł zadania<input name="title" defaultValue={task?.title} required maxLength={200} disabled={busy} /></label>
    <label>Opis zadania (opcjonalnie)<input name="description" defaultValue={task?.description} maxLength={4000} disabled={busy} /></label>
    <label>Wykonawca<select aria-label="Wykonawca" name="assigneeMembershipId" defaultValue={task?.assigneeMembershipId ?? ''} required disabled={busy || !eligible.length}>
      <option value="">Wybierz wykonawcę…</option>
      {task && !eligible.some(member => member.membershipId === task.assigneeMembershipId) && <option value={task.assigneeMembershipId} disabled>Poprzedni wykonawca utracił dostęp — wybierz nowego</option>}
      {eligible.map(member => <option key={member.membershipId} value={member.membershipId}>{member.displayName}</option>)}
    </select></label>
    {!eligible.length && <p role="status">Brak aktywnych członków projektu. Administrator firmy musi najpierw dodać przydziały.</p>}
    <div className="project-actions"><button disabled={busy || !eligible.length}>{busy ? 'Zapisywanie…' : task ? 'Zapisz zadanie' : 'Utwórz zadanie'}</button>
      {task && <button type="button" className="secondary" disabled={busy} onClick={cancel}>Anuluj edycję zadania</button>}</div>
  </form>;
}
export function Projects({ organizationId, admin, csrfToken, onAccessChanged }: {
  organizationId: string; admin: boolean; csrfToken: string; onAccessChanged: () => void;
}) {
  const path = `/api/organizations/${encodeURIComponent(organizationId)}/projects`;
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [selected, setSelected] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const lifetime = useRef<AbortController | null>(null);
  useEffect(() => { const controller = new AbortController(); lifetime.current = controller; return () => controller.abort(); }, []);
  useEffect(() => {
    const controller = new AbortController(); setProjects(null); setError('');
    void request<{ projects: Project[] }>(path, controller.signal).then(data => {
      if (!controller.signal.aborted) setProjects(data.projects);
    }).catch(e => { if (!controller.signal.aborted) { setError(e.message); if ([401, 403].includes(e.status)) onAccessChanged(); } });
    return () => controller.abort();
  }, [path, revision, onAccessChanged]);
  const changed = useCallback((project: Project) => setProjects(current => current?.map(item => item.id === project.id ? project : item) ?? null), []);
  const gone = useCallback(() => { setSelected(''); setRevision(value => value + 1); }, []);
  const create = async (payload: object) => {
    const signal = lifetime.current!.signal;
    if (busy) return false;
    setBusy(true); setError('');
    try {
      const data = await request<{ project: Project }>(path, signal, csrfToken, payload);
      if (signal.aborted) return false;
      setProjects(current => [data.project, ...(current ?? [])]); setSelected(data.project.id); return true;
    } catch (e) { if (!signal.aborted) { setError((e as Error).message); if ([401, 403].includes((e as { status: number }).status)) onAccessChanged(); } return false; }
    finally { if (!signal.aborted) setBusy(false); }
  };
  return <section className="projects" aria-labelledby={`projects-${organizationId}`}>
    <div className="project-toolbar"><h3 id={`projects-${organizationId}`}>Projekty</h3>
      <button className="secondary" disabled={busy} onClick={gone}>Odśwież projekty</button></div>
    {error && <p className="error" role="alert">{error}</p>}
    {!projects && !error && <p role="status">Ładowanie projektów…</p>}
    {projects && <div className="project-list">
      {!projects.length && <p role="status">Brak dostępnych projektów. Przydziały nadaje administrator firmy.</p>}
      {projects.map(project => <button className="secondary project-choice" aria-pressed={selected === project.id} key={project.id} onClick={() => setSelected(project.id)}>
        <strong>{project.name}</strong><span>{stateName(project.status)}</span>
      </button>)}
    </div>}
    {selected && <ProjectDetails key={selected} path={`${path}/${encodeURIComponent(selected)}`} csrfToken={csrfToken} onSaved={changed} onGone={gone} onAccessChanged={onAccessChanged} />}
    {admin && <ProjectForm busy={busy} save={create} />}
  </section>;
}
function ProjectDetails({ path, csrfToken, onSaved, onGone, onAccessChanged }: {
  path: string; csrfToken: string; onSaved: (project: Project) => void; onGone: () => void; onAccessChanged: () => void;
}) {
  const [details, setDetails] = useState<Details | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const [editing, setEditing] = useState<Task | null>(null);
  const lifetime = useRef<AbortController | null>(null);
  useEffect(() => { const controller = new AbortController(); lifetime.current = controller; return () => controller.abort(); }, []);
  useEffect(() => {
    const controller = new AbortController(); setDetails(null); setMembers([]); setTasks([]); setEditing(null); setError('');
    void request<Details>(path, controller.signal).then(async data => {
      const [roster, taskList] = await Promise.all([
        data.permissions.administer || data.permissions.manageTasks ? request<{ members: Member[] }>(`${path}/members`, controller.signal) : { members: [] },
        data.permissions.readTasks ? request<{ tasks: Task[] }>(`${path}/tasks`, controller.signal) : { tasks: [] },
      ]);
      if (!controller.signal.aborted) { setDetails(data); setMembers(roster.members); setTasks(taskList.tasks); onSaved(data.project); }
    }).catch(e => { if (!controller.signal.aborted) { setError(e.message); if ([401, 403].includes(e.status)) onAccessChanged(); if (e.status === 404) onGone(); } });
    return () => controller.abort();
  }, [path, revision, onSaved, onGone, onAccessChanged]);
  const mutate = async (suffix: string, payload: object) => {
    const signal = lifetime.current!.signal;
    if (busy) return false;
    setBusy(true); setError(''); setNotice('');
    try {
      await request(`${path}${suffix}`, signal, csrfToken, payload);
      if (signal.aborted) return false;
      setNotice('Zapisano zmianę.'); setRevision(value => value + 1); return true;
    } catch (e) { if (!signal.aborted) {
      setError((e as Error).message);
      const status = (e as { status?: number }).status;
      if (status === 401 || status === 403) { setDetails(null); setTasks([]); setMembers([]); onAccessChanged(); }
      if (status === 404) { setDetails(null); setTasks([]); setMembers([]); onGone(); }
    } return false; } finally { if (!signal.aborted) setBusy(false); }
  };
  return <article className="project-details">
    <div className="project-toolbar"><h4>Szczegóły projektu</h4><button className="secondary" disabled={busy} onClick={() => { setRevision(value => value + 1); }}>Wczytaj aktualne dane</button></div>
    <p className="hint">Wczytanie aktualnych danych zastępuje niezapisane formularze. Po konflikcie Twoja propozycja pozostaje w formularzu.</p>
    {error && <p className="error" role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    {!details && !error && <p role="status">Ładowanie projektu i zadań…</p>}
    {details && <>
      <h4>{details.project.name}</h4><p>{details.project.description || 'Brak opisu projektu.'}</p>
      <p className="hint">{stateName(details.project.status)} · Wersja {details.project.version} · Zmieniono {new Date(details.project.updatedAt).toLocaleString('pl-PL')}</p>
      {details.project.status === 'archived' && <p role="status">Projekt archiwalny — historia pozostaje dostępna do odczytu.</p>}
      {details.permissions.administer && details.project.status === 'active' && <>
        <ProjectForm key={`project-${revision}`} project={details.project} busy={busy} save={payload => mutate('/update', payload)} />
        <button className="secondary" disabled={busy} onClick={() => void mutate('/archive', { expectedVersion: details.project.version })}>Archiwizuj projekt</button>
      </>}
      {(details.permissions.administer || details.permissions.manageTasks) && <section aria-label="Członkowie projektu">
        <h4>Członkowie projektu</h4>
        {!members.length && <p role="status">Brak członków do przydzielenia.</p>}
        <div className="project-roster">{members.map(member => <div className="project-member" key={member.membershipId}>
          <span><strong>{member.displayName}</strong><small>{member.status === 'active' ? 'Przydzielony' : 'Bez przydziału'}{member.companyStatus !== 'active' || !member.accountActive ? ' · Konto lub członkostwo nieaktywne' : ''}</small></span>
          {details.permissions.administer && details.project.status === 'active' && <button className="secondary" disabled={busy || (member.status !== 'active' && (member.companyStatus !== 'active' || !member.accountActive))}
            aria-label={`${member.status === 'active' ? 'Odbierz przydział' : 'Przydziel'}: ${member.displayName}`}
            onClick={() => void mutate(`/members/${encodeURIComponent(member.membershipId)}`, { status: member.status === 'active' ? 'inactive' : 'active', expectedVersion: member.version })}>
            {member.status === 'active' ? 'Odbierz przydział' : 'Przydziel'}</button>}
        </div>)}</div>
      </section>}
      {details.permissions.readTasks ? <section aria-label="Zadania projektu"><h4>Zadania</h4>
        {!tasks.length && <p role="status">Brak zadań w Twoim zakresie.</p>}
        <div className="task-list">{tasks.map(task => <article className="task-row" key={task.id}>
          <div><strong>{task.title}</strong><p>{task.description || 'Brak opisu zadania.'}</p><small>{stateName(task.status)} · {task.assigneeName} · Wersja {task.version}</small></div>
          {details.permissions.manageTasks && details.project.status === 'active' && <button className="secondary" disabled={busy} onClick={() => setEditing(task)}>Edytuj zadanie</button>}
        </article>)}</div>
        {details.permissions.manageTasks && details.project.status === 'active' && <TaskForm key={`${revision}-${editing?.id ?? 'new'}`} task={editing} members={members} busy={busy} cancel={() => setEditing(null)}
          save={payload => mutate(editing ? `/tasks/${encodeURIComponent(editing.id)}/update` : '/tasks', payload)} />}
      </section> : <p role="status">Dostęp do zadań wymaga aktywnego przydziału do projektu i roli kierownika, brygadzisty lub pracownika.</p>}
    </>}
  </article>;
}
