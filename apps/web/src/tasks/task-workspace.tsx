import { Discussion } from '../task-comments/discussion.js';
import { ParentContext, ProgressHistory, Subtasks } from '../subtasks/hierarchy.js';
import { useCallback, useEffect, useRef, useState } from 'react';
import { request, type Project, type Task } from '../project-api.js';
import { TaskProgress } from '../task-progress.js';
import { invalidatePreparedProject, observeAccessFailure } from '../offline/account.js';
import { guardPendingOperations, guardWorkspaceChange, usePendingOperation } from '../workspace/navigation-safety.js';
import { QuickTaskForm, type Assignee } from './task-form.js';
import { Assignment } from './assignment.js';
import './tasks.css';
import { useLiveResource } from './live-resource.js';
import { retainOpenCards } from './retained-cards.js';
export type CompanyTask = Task & { projectId: string; projectName: string; projectStatus: string; retained?: boolean };
type Result = { tasks: CompanyTask[]; hasMore: boolean; permissions: { manageTasks: boolean } };
const views = [['all','Wszystkie'],['mine','Moje'],['backlog','Backlog'],['todo','Do zrobienia'],['in_progress','W toku'],['submitted','Do odbioru']];
export function TaskWorkspace({ organizationId, projects, manage, csrfToken, onAccessChanged, active = true }: {
  active?: boolean; organizationId: string; projects: Project[] | null; manage: boolean; csrfToken: string; onAccessChanged: () => void;
}) {
  const base = `/api/organizations/${organizationId}`;
  const root = useRef<HTMLElement>(null), lifetime = useRef<AbortController | null>(null);
  const pages = useRef(1);
  const [loadingMore, setLoadingMore] = useState(false);
  const [expandedRoots,setExpandedRoots] = useState<Set<string>>(new Set());
  const [tasks,setTasks] = useState<CompanyTask[] | null>(null), [assignees,setAssignees] = useState<Assignee[]>([]);
  const [view,setView] = useState(manage ? 'all' : 'mine'), [projectId,setProjectId] = useState(''), [assignee,setAssignee] = useState('');
  const [q,setQ] = useState(''), [search,setSearch] = useState(''), [projectStatus,setProjectStatus] = useState('active');
  const [revision,setRevision] = useState(0), [hasMore,setHasMore] = useState(false), [creating,setCreating] = useState(false), [assigning,setAssigning] = useState('');
  const [busy,setBusy] = useState(false), [error,setError] = useState(''), [notice,setNotice] = useState('');
  const [directoryError,setDirectoryError] = useState('');
  const [reloadPending,setReloadPending] = useState(false), [pendingProgress,setPendingProgress] = useState<Set<string>>(new Set());
  const trackProgress = useCallback((id: string, pending: boolean) => setPendingProgress(current => {
    if (current.has(id) === pending) return current;
    const next = new Set(current); if (pending) next.add(id); else next.delete(id); return next;
  }), []);
  const [filtersOpen,setFiltersOpen] = useState(() => window.matchMedia('(min-width: 641px)').matches);
  usePendingOperation(busy);
  useEffect(() => { const controller = new AbortController(); lifetime.current = controller; return () => controller.abort(); }, []);
  const query = new URLSearchParams({ view, q:search, projectStatus, ...(projectId ? { projectId } : {}), ...(assignee ? { assigneeMembershipId:assignee } : {}) }).toString();
  const reload = useCallback(() => { pages.current = 1; setLoadingMore(false); setRevision(value => value+1); }, []);
  useEffect(() => {
    // Keep every unresolved M08 component/operation ID mounted until its result is known.
    if (reloadPending && pendingProgress.size === 0) { setReloadPending(false); reload(); }
  }, [reloadPending,pendingProgress,reload]);
  const failed = (e: { message: string; status?: number }) => { setError(e.message); if ([401,403].includes(e.status ?? 0)) { setTasks(null); onAccessChanged(); } };
  useEffect(() => { setTasks(null); setExpandedRoots(new Set()); setHasMore(false); pages.current = 1; }, [base,query]);
  const refreshData = useLiveResource(`${base}?${query}:${revision}`, async signal => {
    const loaded: CompanyTask[] = []; let hasMore = false;
    for (let page = 0; page < pages.current; page++) {
      const data = await request<Result>(`${base}/tasks?${query}&offset=${page * 100}`, signal);
      loaded.push(...data.tasks); hasMore = data.hasMore;
      if (!hasMore) break;
    }
    return { tasks: await retainOpenCards(loaded, tasks, root.current, base, signal), hasMore };
  }, { active, paused: busy || pendingProgress.size > 0 || reloadPending,
    receive: data => {
      setTasks(current => data.tasks.map(task => {
        const previous = current?.find(item => item.id === task.id);
        return previous && previous.version > task.version ? previous : task;
      }));
      setHasMore(data.hasMore); setLoadingMore(false); setError('');
    }, failed: e => { setLoadingMore(false); failed(e); },
  });
  useEffect(() => {
    if (!manage) return;
    const controller = new AbortController(); setDirectoryError('');
    void request<{ assignees: Assignee[] }>(`${base}/task-assignees`,controller.signal).then(data => { if (!controller.signal.aborted) setAssignees(data.assignees); })
      .catch(e => { if (!controller.signal.aborted) { setDirectoryError(e.message); if ([401,403].includes(e.status)) onAccessChanged(); } });
    return () => controller.abort();
  }, [base,manage,revision]);
  const taskPath = (task: CompanyTask) => `${base}/projects/${task.projectId}/tasks/${task.id}`;
  const changeFilter = (change: () => void) => { if (guardWorkspaceChange(root.current!)) { setCreating(false); setAssigning(''); change(); } };
  const changeQuery = (change: () => void) => changeFilter(() => { change(); reload(); });
  const refresh = () => changeFilter(reload);
  const create = async (id: string,payload: object) => {
    if (busy || !guardPendingOperations()) return false;
    const signal = lifetime.current!.signal; setBusy(true); setError(''); setNotice('');
    try {
      await request(`${base}/projects/${id}/tasks`,signal,csrfToken,payload);
      if (signal.aborted) return false;
      setCreating(false); setNotice('Serwer potwierdził utworzenie zadania.'); reload(); return true;
    } catch (e) { if (!signal.aborted) failed(e as Error); return false; }
    finally { if (!signal.aborted) setBusy(false); }
  };
  const assign = async (task: CompanyTask,id: string | null) => {
    if (busy || !guardPendingOperations()) return;
    const signal = lifetime.current!.signal; setBusy(true); setError(''); setNotice('');
    try {
      const data = await request<{ task: Task }>(`${taskPath(task)}/assign`,signal,csrfToken,{ assigneeMembershipId:id,expectedVersion:task.version });
      if (signal.aborted) return;
      if (data.task.assigneeMembershipId !== task.assigneeMembershipId) await invalidatePreparedProject(organizationId,task.projectId);
      if (signal.aborted) return;
      setAssigning(''); setNotice('Serwer potwierdził zapis przydziału.'); reload();
    } catch (e) { if (!signal.aborted) failed(e as Error); }
    finally { if (!signal.aborted) setBusy(false); }
  };
  const more = () => {
    if (busy || loadingMore || !tasks || !guardPendingOperations()) return;
    pages.current++; setLoadingMore(true); refreshData();
  };
  return <section ref={root} className="task-workspace" aria-label={manage ? 'Zadania firmy' : 'Moje zadania'}>
    <div className="project-toolbar"><h2>{manage ? 'Zadania firmy' : 'Moje zadania'}</h2><div className="project-actions">
      <button className="secondary" disabled={busy} onClick={refresh}>Wczytaj aktualne zadania</button>
      {manage && <button disabled={busy || !projects} onClick={() => changeFilter(() => setCreating(true))}>Nowe zadanie</button>}
    </div></div>
    {manage && <div className="task-views" role="group" aria-label="Widok zadań">{views.map(([id,name]) => <button className="secondary" key={id} aria-pressed={view===id} disabled={busy} onClick={() => changeQuery(() => setView(id))}>{name}</button>)}</div>}
    <details className="task-filter-panel" open={filtersOpen} onToggle={event => setFiltersOpen(event.currentTarget.open)}><summary>Filtry i wyszukiwanie</summary><div className="task-filters"><label>Projekt<select aria-label="Projekt" value={projectId} disabled={busy} onChange={event => changeQuery(() => setProjectId(event.target.value))}><option value="">Wszystkie projekty</option>{projects?.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>
      {manage && <label>Wykonawca<select aria-label="Wykonawca" value={assignee} disabled={busy} onChange={event => changeQuery(() => setAssignee(event.target.value))}><option value="">Wszyscy wykonawcy</option>{assignees.map(member => <option key={member.membershipId} value={member.membershipId}>{member.displayName}</option>)}</select></label>}
      <label>Projekty<select aria-label="Projekty" value={projectStatus} disabled={busy} onChange={event => changeQuery(() => setProjectStatus(event.target.value))}><option value="active">Aktywne</option><option value="archived">Archiwalne</option><option value="all">Wszystkie</option></select></label>
      <div className="task-search"><label>Szukaj zadań<input aria-label="Szukaj zadań" type="search" value={q} maxLength={200} onChange={event => setQ(event.target.value)} onKeyDown={event => { if (event.key==='Enter') changeQuery(() => setSearch(q)); }} disabled={busy} /></label><button className="secondary" disabled={busy} onClick={() => changeQuery(() => setSearch(q))}>Szukaj</button></div>
    </div></details>
    {error && <p className="error" role="alert">{error}</p>}{directoryError && <p className="error" role="alert">Nie udało się pobrać wykonawców: {directoryError}. Wczytaj aktualne zadania, aby ponowić.</p>}{notice && <p role="status">{notice}</p>}
    {creating && projects && <QuickTaskForm projects={projects} assignees={assignees} busy={busy} save={create} cancel={() => setCreating(false)} />}
    {!tasks && !error && <p role="status">Ładowanie zadań…</p>}
    {tasks?.length === 0 && <p role="status">{view==='backlog' ? 'Backlog jest pusty. Utwórz zadanie bez wykonawcy.' : manage ? 'Brak zadań dla wybranych filtrów.' : 'Nie masz zadań dla wybranych filtrów.'}</p>}
    <div className="company-task-list">{tasks?.filter(task => !task.parent || !expandedRoots.has(task.parent.id)).map(task => <article key={task.id} data-task-id={task.id} className="company-task" aria-label={task.title}>
      <div className="company-task-content"><small>{task.projectName}{task.projectStatus==='archived' ? ' · Archiwalny' : ''}</small><ParentContext task={task} /><h3>{task.title}</h3>{task.description && <p>{task.description}</p>}
        {manage && <p className="task-assignee-name">{task.assigneeMembershipId ? task.assigneeName : 'Bez wykonawcy · Backlog'}</p>}
        {task.retained && <p className="hint">Zachowano otwarty widok. Zadanie jest poza bieżącą listą.</p>}
      </div><div className="company-task-actions"><TaskProgress task={task} path={taskPath(task)} csrfToken={csrfToken} writable={task.projectStatus==='active'} disabled={busy || !!assigning || (reloadPending && !pendingProgress.has(task.id))} onPendingChange={trackProgress}
        onConfirmed={confirmed => { setTasks(current => current?.map(item => item.id===task.id ? { ...item,...confirmed } : item) ?? null); setNotice(confirmed.status==='in_progress' ? 'Serwer potwierdził rozpoczęcie zadania.' : 'Serwer potwierdził zgłoszenie do odbioru.'); setReloadPending(true); }}
        onAccessChanged={status => { void observeAccessFailure(taskPath(task),status); onAccessChanged(); }} onGone={() => { void observeAccessFailure(taskPath(task),404); setTasks(current => current?.filter(item => item.id!==task.id) ?? null); setError('Zadanie jest już niedostępne. Wczytaj aktualne zadania.'); }} />
        {manage && task.projectStatus==='active' && task.status==='planned' && <button className="secondary" disabled={busy || !!directoryError} onClick={() => changeFilter(() => setAssigning(task.id))}>{task.assigneeMembershipId ? 'Zmień wykonawcę' : 'Przypisz'}</button>}
        {assigning===task.id && <Assignment current={task.assigneeMembershipId} assignees={assignees} busy={busy} save={id => void assign(task,id)} cancel={() => setAssigning('')} />}
      </div>
      <Discussion path={taskPath(task)} title={task.title} csrfToken={csrfToken} writable={task.projectStatus==='active'} onAccessChanged={onAccessChanged} />
      {task.parent && <ProgressHistory path={taskPath(task)} version={task.version} onAccessChanged={onAccessChanged} />}
      {manage && !task.parent && <Subtasks active={active} task={task} path={taskPath(task)} organizationId={organizationId} projectId={task.projectId} csrfToken={csrfToken} assignees={assignees} writable={task.projectStatus==='active'} disabled={busy || !!assigning} pendingOnly={reloadPending ? pendingProgress : undefined} onChanged={() => setReloadPending(true)} onAccessChanged={onAccessChanged} onPendingChange={trackProgress} onOpenChange={open => setExpandedRoots(current => { const next=new Set(current); if(open) next.add(task.id); else next.delete(task.id); return next; })} />}
    </article>)}</div>
    {hasMore && tasks && <button className="secondary" disabled={busy || loadingMore} onClick={more}>Pokaż więcej zadań</button>}
  </section>;
}
