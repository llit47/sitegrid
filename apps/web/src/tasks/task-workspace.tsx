import { useEffect, useRef, useState } from 'react';
import { request, type Project, type Task } from '../project-api.js';
import { TaskProgress } from '../task-progress.js';
import { observeAccessFailure } from '../offline/account.js';
import { guardPendingOperations, guardWorkspaceChange, usePendingOperation } from '../workspace/navigation-safety.js';
import { QuickTaskForm, type Assignee } from './task-form.js';
import { Assignment } from './assignment.js';
import './tasks.css';
export type CompanyTask = Task & { projectId: string; projectName: string; projectStatus: string };
type Result = { tasks: CompanyTask[]; hasMore: boolean; permissions: { manageTasks: boolean } };
const views = [['all','Wszystkie'],['mine','Moje'],['backlog','Backlog'],['todo','Do zrobienia'],['in_progress','W trakcie'],['submitted','Do odbioru']];
export function TaskWorkspace({ organizationId, projects, manage, csrfToken, onAccessChanged }: {
  organizationId: string; projects: Project[] | null; manage: boolean; csrfToken: string; onAccessChanged: () => void;
}) {
  const base = `/api/organizations/${organizationId}`;
  const root = useRef<HTMLElement>(null), lifetime = useRef<AbortController | null>(null);
  const [tasks,setTasks] = useState<CompanyTask[] | null>(null), [assignees,setAssignees] = useState<Assignee[]>([]);
  const [view,setView] = useState(manage ? 'all' : 'mine'), [projectId,setProjectId] = useState(''), [assignee,setAssignee] = useState('');
  const [q,setQ] = useState(''), [search,setSearch] = useState(''), [projectStatus,setProjectStatus] = useState('active');
  const [revision,setRevision] = useState(0), [hasMore,setHasMore] = useState(false), [creating,setCreating] = useState(false), [assigning,setAssigning] = useState('');
  const [busy,setBusy] = useState(false), [error,setError] = useState(''), [notice,setNotice] = useState('');
  const [directoryError,setDirectoryError] = useState('');
  const [filtersOpen,setFiltersOpen] = useState(() => window.matchMedia('(min-width: 641px)').matches);
  usePendingOperation(busy);
  useEffect(() => { const controller = new AbortController(); lifetime.current = controller; return () => controller.abort(); }, []);
  const query = new URLSearchParams({ view, q:search, projectStatus, ...(projectId ? { projectId } : {}), ...(assignee ? { assigneeMembershipId:assignee } : {}) }).toString();
  const failed = (e: { message: string; status?: number }) => { setError(e.message); if ([401,403].includes(e.status ?? 0)) { setTasks(null); onAccessChanged(); } };
  useEffect(() => {
    const controller = new AbortController(); setTasks(null); setError('');
    void request<Result>(`${base}/tasks?${query}`,controller.signal).then(data => { if (!controller.signal.aborted) { setTasks(data.tasks); setHasMore(data.hasMore); } })
      .catch(e => { if (!controller.signal.aborted) failed(e); });
    return () => controller.abort();
  }, [base,query,revision]);
  useEffect(() => {
    if (!manage) return;
    const controller = new AbortController(); setDirectoryError('');
    void request<{ assignees: Assignee[] }>(`${base}/task-assignees`,controller.signal).then(data => { if (!controller.signal.aborted) setAssignees(data.assignees); })
      .catch(e => { if (!controller.signal.aborted) { setDirectoryError(e.message); if ([401,403].includes(e.status)) onAccessChanged(); } });
    return () => controller.abort();
  }, [base,manage,revision]);
  const taskPath = (task: CompanyTask) => `${base}/projects/${task.projectId}/tasks/${task.id}`;
  const changeFilter = (change: () => void) => { if (guardWorkspaceChange(root.current!)) { setCreating(false); setAssigning(''); change(); } };
  const refresh = () => changeFilter(() => { void observeAccessFailure(base,403); setRevision(value => value+1); });
  const create = async (id: string,payload: object) => {
    if (busy || !guardPendingOperations()) return false;
    const signal = lifetime.current!.signal; setBusy(true); setError(''); setNotice('');
    try {
      await request(`${base}/projects/${id}/tasks`,signal,csrfToken,payload);
      if (signal.aborted) return false;
      setCreating(false); setNotice('Serwer potwierdził utworzenie zadania.'); setRevision(value => value+1); return true;
    } catch (e) { if (!signal.aborted) failed(e as Error); return false; }
    finally { if (!signal.aborted) setBusy(false); }
  };
  const assign = async (task: CompanyTask,id: string | null) => {
    if (busy || !guardPendingOperations()) return;
    const signal = lifetime.current!.signal; setBusy(true); setError(''); setNotice('');
    try {
      const data = await request<{ task: Task }>(`${taskPath(task)}/assign`,signal,csrfToken,{ assigneeMembershipId:id,expectedVersion:task.version });
      if (signal.aborted) return;
      // The project command context gives canProgress for the response; retain project metadata.
      setTasks(current => current?.map(item => item.id === task.id ? { ...item,...data.task,assigneeName:assignees.find(member => member.membershipId === id)?.displayName ?? null } : item) ?? null);
      setAssigning(''); setNotice('Serwer potwierdził zapis przydziału.'); await observeAccessFailure(base,403);
    } catch (e) { if (!signal.aborted) failed(e as Error); }
    finally { if (!signal.aborted) setBusy(false); }
  };
  const more = async () => {
    if (busy || !tasks || !guardPendingOperations()) return;
    const signal = lifetime.current!.signal; setBusy(true);
    try { const data = await request<Result>(`${base}/tasks?${query}&offset=${tasks.length}`,signal);
      if (!signal.aborted) { setTasks(current => [...(current ?? []),...data.tasks.filter(item => !current?.some(existing => existing.id === item.id))]); setHasMore(data.hasMore); }
    } catch (e) { if (!signal.aborted) failed(e as Error); } finally { if (!signal.aborted) setBusy(false); }
  };
  return <section ref={root} className="task-workspace" aria-label={manage ? 'Zadania firmy' : 'Moje zadania'}>
    <div className="project-toolbar"><h2>{manage ? 'Zadania firmy' : 'Moje zadania'}</h2><div className="project-actions">
      <button className="secondary" disabled={busy} onClick={refresh}>Wczytaj aktualne zadania</button>
      {manage && <button disabled={busy || !projects} onClick={() => changeFilter(() => setCreating(true))}>Nowe zadanie</button>}
    </div></div>
    {manage && <div className="task-views" role="group" aria-label="Widok zadań">{views.map(([id,name]) => <button className="secondary" key={id} aria-pressed={view===id} disabled={busy} onClick={() => changeFilter(() => setView(id))}>{name}</button>)}</div>}
    <details className="task-filter-panel" open={filtersOpen} onToggle={event => setFiltersOpen(event.currentTarget.open)}><summary>Filtry i wyszukiwanie</summary><div className="task-filters"><label>Projekt<select aria-label="Projekt" value={projectId} disabled={busy} onChange={event => changeFilter(() => setProjectId(event.target.value))}><option value="">Wszystkie projekty</option>{projects?.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>
      {manage && <label>Wykonawca<select aria-label="Wykonawca" value={assignee} disabled={busy} onChange={event => changeFilter(() => setAssignee(event.target.value))}><option value="">Wszyscy wykonawcy</option>{assignees.map(member => <option key={member.membershipId} value={member.membershipId}>{member.displayName}</option>)}</select></label>}
      <label>Projekty<select aria-label="Projekty" value={projectStatus} disabled={busy} onChange={event => changeFilter(() => setProjectStatus(event.target.value))}><option value="active">Aktywne</option><option value="archived">Archiwalne</option><option value="all">Wszystkie</option></select></label>
      <div className="task-search"><label>Szukaj zadań<input aria-label="Szukaj zadań" type="search" value={q} maxLength={200} onChange={event => setQ(event.target.value)} onKeyDown={event => { if (event.key==='Enter') changeFilter(() => setSearch(q)); }} disabled={busy} /></label><button className="secondary" disabled={busy} onClick={() => changeFilter(() => setSearch(q))}>Szukaj</button></div>
    </div></details>
    {error && <p className="error" role="alert">{error}</p>}{directoryError && <p className="error" role="alert">Nie udało się pobrać wykonawców: {directoryError}. Wczytaj aktualne zadania, aby ponowić.</p>}{notice && <p role="status">{notice}</p>}
    {creating && projects && <QuickTaskForm projects={projects} assignees={assignees} busy={busy} save={create} cancel={() => setCreating(false)} />}
    {!tasks && !error && <p role="status">Ładowanie zadań…</p>}
    {tasks?.length === 0 && <p role="status">{view==='backlog' ? 'Backlog jest pusty. Utwórz zadanie bez wykonawcy.' : manage ? 'Brak zadań dla wybranych filtrów.' : 'Nie masz zadań dla wybranych filtrów.'}</p>}
    <div className="company-task-list">{tasks?.map(task => <article key={task.id} className="company-task" aria-label={task.title}>
      <div className="company-task-content"><small>{task.projectName}{task.projectStatus==='archived' ? ' · Archiwalny' : ''}</small><h3>{task.title}</h3>{task.description && <p>{task.description}</p>}
        {manage && <p className="task-assignee-name">{task.assigneeMembershipId ? task.assigneeName : 'Bez wykonawcy · Backlog'}</p>}
      </div><div className="company-task-actions"><TaskProgress task={task} path={taskPath(task)} csrfToken={csrfToken} writable={task.projectStatus==='active'} disabled={busy}
        onConfirmed={confirmed => setTasks(current => current?.map(item => item.id===task.id ? { ...item,...confirmed } : item) ?? null)}
        onAccessChanged={status => { void observeAccessFailure(taskPath(task),status); onAccessChanged(); }} onGone={() => { void observeAccessFailure(taskPath(task),404); setTasks(current => current?.filter(item => item.id!==task.id) ?? null); setError('Zadanie jest już niedostępne. Wczytaj aktualne zadania.'); }} />
        {manage && task.projectStatus==='active' && task.status==='planned' && <button className="secondary" disabled={busy || !!directoryError} onClick={() => changeFilter(() => setAssigning(task.id))}>{task.assigneeMembershipId ? 'Zmień wykonawcę' : 'Przypisz'}</button>}
        {assigning===task.id && <Assignment current={task.assigneeMembershipId} assignees={assignees} busy={busy} save={id => void assign(task,id)} cancel={() => setAssigning('')} />}
      </div>
    </article>)}</div>
    {hasMore && tasks && <button className="secondary" disabled={busy} onClick={() => void more()}>Pokaż więcej zadań</button>}
  </section>;
}
