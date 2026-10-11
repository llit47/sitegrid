import { useLiveResource } from './tasks/live-resource.js';
import { Discussion } from './task-comments/discussion.js';
import { ParentContext, ProgressHistory, Subtasks } from './subtasks/hierarchy.js';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ContractorName, type Contractor } from './contractors.js';
import { ProjectForm, TaskForm } from './project-forms.js';
import { request, stateName, type Details, type Project, type Task, type Member } from './project-api.js';
import { TaskProgress } from './task-progress.js';
import { OfflinePreparation } from './offline/preparation.js';
import { observeAccessFailure, reconcilePreparedTasks } from './offline/account.js';
import type { StorageScope } from './storage/indexed-db.js';
import { guardWorkspaceChange, guardPendingOperations, usePendingOperation } from './workspace/navigation-safety.js';
export function ProjectDetails({ scope, path, contractors, csrfToken, onSaved, onGone, onAccessChanged, active = true }: {
  active?: boolean; scope: StorageScope; path: string; contractors: Contractor[] | null; csrfToken: string; onSaved: (project: Project) => void; onGone: () => void; onAccessChanged: () => void;
}) {
  const [details, setDetails] = useState<Details | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [reloadPending,setReloadPending] = useState(false), [pendingProgress,setPendingProgress] = useState<Set<string>>(new Set());
  const [hierarchyRefreshPending, setHierarchyRefreshPending] = useState(false);
  const trackProgress = useCallback((id: string, pending: boolean) => setPendingProgress(current => {const next=new Set(current); if(pending) next.add(id); else next.delete(id); return next;}),[]);
  useEffect(() => {if(reloadPending && pendingProgress.size===0) {setReloadPending(false); setRevision(value => value+1);}},[reloadPending,pendingProgress]);
  const [expandedRoots,setExpandedRoots] = useState<Set<string>>(new Set());
  const [tasks, setTasks] = useState<Task[]>([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const [editing, setEditing] = useState<Task | null>(null);
  const [editingProject, setEditingProject] = useState<Project | null>(null);
  const [showTaskForm, setShowTaskForm] = useState(false);
  const root = useRef<HTMLElement>(null);
  usePendingOperation(busy);
  const lifetime = useRef<AbortController | null>(null);
  useEffect(() => { const controller = new AbortController(); lifetime.current = controller; return () => controller.abort(); }, []);
  useEffect(() => {
    setDetails(null); setMembers([]); setTasks([]); setExpandedRoots(new Set());
    setEditing(null); setEditingProject(null); setShowTaskForm(false); setError('');
  }, [path]);
  useLiveResource(`${path}:${revision}`, async signal => {
    const data = await request<Details>(path, signal);
    const [roster, taskList] = await Promise.all([
      data.permissions.administer || data.permissions.manageTasks ? request<{ members: Member[] }>(`${path}/members`, signal) : { members: [] },
      data.permissions.readTasks ? request<{ tasks: Task[] }>(`${path}/tasks`, signal) : { tasks: [] },
    ]);
    if (!signal.aborted) await reconcilePreparedTasks(scope.organizationId, scope.projectId, taskList.tasks.map(task => task.id));
    return { data, roster, taskList };
  }, { active, paused: busy || pendingProgress.size > 0 || reloadPending || hierarchyRefreshPending,
    receive: ({data, roster, taskList}) => {
      setDetails(data); setMembers(roster.members); setError('');
      setTasks(current => taskList.tasks.map(task => {
        const known = current.find(item => item.id === task.id);
        return known && known.version > task.version ? known : task;
      })); onSaved(data.project);
    }, failed: e => {
      setError(e.message);
      if ([401,403,404].includes(e.status ?? 0)) { setDetails(null); setTasks([]); setMembers([]); }
      if ([401,403].includes(e.status ?? 0)) onAccessChanged();
      if (e.status === 404) onGone();
    },
  });
  useEffect(() => {
    if (hierarchyRefreshPending && !pendingProgress.size && !busy) {
      setHierarchyRefreshPending(false); setRevision(value => value + 1);
    }
  }, [hierarchyRefreshPending,pendingProgress,busy]);
  const mutate = async (suffix: string, payload: object) => {
    const signal = lifetime.current!.signal;
    if (busy || !guardPendingOperations()) return false;
    setBusy(true); setError(''); setNotice('');
    try {
      await request(`${path}${suffix}`, signal, csrfToken, payload);
      if (signal.aborted) return false;
      setEditing(null); setEditingProject(null); setShowTaskForm(false); setNotice('Zapisano zmianę.'); setRevision(value => value + 1); return true;
    } catch (e) { if (!signal.aborted) {
      setError((e as Error).message);
      const status = (e as { status?: number }).status;
      if (status === 401 || status === 403) { setDetails(null); setTasks([]); setMembers([]); onAccessChanged(); }
      if (status === 404) { setDetails(null); setTasks([]); setMembers([]); onGone(); }
    } return false; } finally { if (!signal.aborted) setBusy(false); }
  };
  return <article ref={root} className="project-details">
    <div className="project-toolbar"><h4>Szczegóły projektu</h4><button className="secondary" disabled={busy} onClick={() => { if (guardWorkspaceChange(root.current!)) setRevision(value => value + 1); }}>Wczytaj aktualne dane</button></div>
    {details?.project.status === 'active' && (details.permissions.administer || details.permissions.manageTasks) && <p className="hint">Dane odświeżają się automatycznie z zachowaniem szkiców. Po konflikcie Twoja propozycja pozostaje w formularzu.</p>}
    {error && <p className="error" role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    {!details && !error && <p role="status">Ładowanie projektu i zadań…</p>}
    {details && <>
      <h4>{details.project.name}</h4><p>{details.project.description || 'Brak opisu projektu.'}</p>
      <p><ContractorName contractor={details.project.contractor} contractors={contractors} /></p>
      <p className="hint">{stateName(details.project.status)} · Wersja {details.project.version} · Zmieniono {new Date(details.project.updatedAt).toLocaleString('pl-PL')}</p>
      <OfflinePreparation scope={scope} />
      {details.project.status === 'archived' && <p role="status">Projekt archiwalny — historia pozostaje dostępna do odczytu.</p>}
      {details.permissions.administer && details.project.status === 'active' && <>
        <div className="project-actions"><button className="secondary" disabled={busy} onClick={() => { if (!editingProject && guardWorkspaceChange(root.current!)) { setShowTaskForm(false); setEditing(null); setEditingProject(details.project); } }}>Edytuj projekt</button></div>
        {editingProject && <ProjectForm project={editingProject} contractors={contractors} busy={busy} save={payload => mutate('/update', payload)} cancel={() => setEditingProject(null)} />}
        <button className="secondary" disabled={busy} onClick={() => { if (guardWorkspaceChange(root.current!)) void mutate('/archive', { expectedVersion: details.project.version }); }}>Archiwizuj projekt</button>
      </>}
      {(details.permissions.administer || details.permissions.manageTasks) && <section aria-label="Członkowie projektu">
        <h4>Członkowie projektu</h4>
        {!members.length && <p role="status">Brak członków do przydzielenia.</p>}
        <div className="project-roster">{members.map(member => <div className="project-member" key={member.membershipId}>
          <span><strong>{member.displayName}</strong><small>{member.status === 'active' ? 'Przydzielony' : 'Bez przydziału'}{member.companyStatus !== 'active' || !member.accountActive ? ' · Konto lub członkostwo nieaktywne' : ''}</small></span>
          {details.permissions.administer && details.project.status === 'active' && <button className="secondary" disabled={busy || (member.status !== 'active' && (member.companyStatus !== 'active' || !member.accountActive))}
            aria-label={`${member.status === 'active' ? 'Odbierz przydział' : 'Przydziel'}: ${member.displayName}`}
            onClick={() => { if (guardWorkspaceChange(root.current!)) void mutate(`/members/${encodeURIComponent(member.membershipId)}`, { status: member.status === 'active' ? 'inactive' : 'active', expectedVersion: member.version }); }}>
            {member.status === 'active' ? 'Odbierz przydział' : 'Przydziel'}</button>}
        </div>)}</div>
      </section>}
      {details.permissions.readTasks ? <section aria-label="Zadania projektu"><div className="project-toolbar"><h4>Zadania</h4>{details.permissions.manageTasks && details.project.status === 'active' && <button disabled={busy} onClick={() => { if (guardWorkspaceChange(root.current!)) { setEditingProject(null); setEditing(null); setShowTaskForm(true); } }}>Nowe zadanie</button>}</div>
        {!tasks.length && <p role="status">Brak zadań w Twoim zakresie.</p>}
        <div className="task-list">{tasks.filter(task => !task.parent || !expandedRoots.has(task.parent.id)).map(task => <article className="task-row" key={task.id}>
          <div><ParentContext task={task} /><strong>{task.title}</strong><p>{task.description || 'Brak opisu zadania.'}</p><small>{task.assigneeName}</small></div>
          <TaskProgress task={task} path={`${path}/tasks/${encodeURIComponent(task.id)}`} csrfToken={csrfToken}
            writable={details.project.status === 'active'} disabled={busy || ((reloadPending || hierarchyRefreshPending) && !pendingProgress.has(task.id))} onPendingChange={trackProgress} onAccessChanged={status => { void observeAccessFailure(path, status); onAccessChanged(); }} onGone={() => { void observeAccessFailure(path, 404); onGone(); }}
            onConfirmed={confirmed => { setTasks(current => current.map(item => item.id === confirmed.id && item.version <= confirmed.version ? { ...item, ...confirmed } : item)); if (task.parent) setHierarchyRefreshPending(true); }} />
          {details.permissions.manageTasks && details.project.status === 'active' && <button className="secondary" disabled={busy} onClick={() => { if (guardWorkspaceChange(root.current!)) { setEditingProject(null); setEditing(task); setShowTaskForm(true); } }}>Edytuj zadanie</button>}
          <Discussion path={`${path}/tasks/${task.id}`} title={task.title} csrfToken={csrfToken} writable={details.project.status==='active'} onAccessChanged={onAccessChanged} />
          {task.parent && <ProgressHistory path={`${path}/tasks/${task.id}`} version={task.version} onAccessChanged={onAccessChanged} />}
          {details.permissions.manageTasks && !task.parent && <Subtasks active={active} task={task} path={`${path}/tasks/${task.id}`} organizationId={scope.organizationId} projectId={scope.projectId} csrfToken={csrfToken} assignees={members.filter(member => member.companyStatus==='active' && member.accountActive)} writable={details.project.status==='active'} disabled={busy} pendingOnly={reloadPending || hierarchyRefreshPending ? pendingProgress : undefined} onPendingChange={trackProgress} onChanged={() => setReloadPending(true)} onProgressConfirmed={() => setHierarchyRefreshPending(true)} onAccessChanged={onAccessChanged} onOpenChange={open => setExpandedRoots(current => {const next=new Set(current); if(open) next.add(task.id); else next.delete(task.id); return next;})} />}
        </article>)}</div>
        {showTaskForm && details.permissions.manageTasks && details.project.status === 'active' && <TaskForm key={editing?.id ?? 'new'} task={editing} members={members} busy={busy} cancel={() => { setEditing(null); setShowTaskForm(false); }}
          save={payload => mutate(editing ? `/tasks/${encodeURIComponent(editing.id)}/update` : '/tasks', payload)} />}
      </section> : <p role="status">Dostęp do zadań wymaga roli administratora firmy, kierownika, brygadzisty lub przypisanego pracownika.</p>}
    </>}
  </article>;
}
