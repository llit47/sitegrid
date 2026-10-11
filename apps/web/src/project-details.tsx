import { useEffect, useRef, useState } from 'react';
import { ContractorName, type Contractor } from './contractors.js';
import { ProjectForm, TaskForm } from './project-forms.js';
import { request, stateName, type Details, type Project, type Task, type Member } from './project-api.js';
import { TaskProgress } from './task-progress.js';
import { OfflinePreparation } from './offline/preparation.js';
import { observeAccessFailure, reconcilePreparedTasks } from './offline/account.js';
import type { StorageScope } from './storage/indexed-db.js';
import { guardWorkspaceChange, guardPendingOperations, usePendingOperation } from './workspace/navigation-safety.js';
export function ProjectDetails({ scope, path, contractors, csrfToken, onSaved, onGone, onAccessChanged }: {
  scope: StorageScope; path: string; contractors: Contractor[] | null; csrfToken: string; onSaved: (project: Project) => void; onGone: () => void; onAccessChanged: () => void;
}) {
  const [details, setDetails] = useState<Details | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const [editing, setEditing] = useState<Task | null>(null);
  const [editingProject, setEditingProject] = useState(false);
  const [showTaskForm, setShowTaskForm] = useState(false);
  const root = useRef<HTMLElement>(null);
  usePendingOperation(busy);
  const lifetime = useRef<AbortController | null>(null);
  useEffect(() => { const controller = new AbortController(); lifetime.current = controller; return () => controller.abort(); }, []);
  useEffect(() => {
    const controller = new AbortController(); setDetails(null); setMembers([]); setTasks([]); setEditing(null); setEditingProject(false); setShowTaskForm(false); setError('');
    void request<Details>(path, controller.signal).then(async data => {
      const [roster, taskList] = await Promise.all([
        data.permissions.administer || data.permissions.manageTasks ? request<{ members: Member[] }>(`${path}/members`, controller.signal) : { members: [] },
        data.permissions.readTasks ? request<{ tasks: Task[] }>(`${path}/tasks`, controller.signal) : { tasks: [] },
      ]);
      if (!controller.signal.aborted) await reconcilePreparedTasks(scope.organizationId, scope.projectId, taskList.tasks.map(task => task.id));
      if (!controller.signal.aborted) { setDetails(data); setMembers(roster.members); setTasks(taskList.tasks); onSaved(data.project); }
    }).catch(e => { if (!controller.signal.aborted) { setError(e.message); if ([401, 403].includes(e.status)) onAccessChanged(); if (e.status === 404) onGone(); } });
    return () => controller.abort();
  }, [path, revision, onSaved, onGone, onAccessChanged]);
  const mutate = async (suffix: string, payload: object) => {
    const signal = lifetime.current!.signal;
    if (busy || !guardPendingOperations()) return false;
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
  return <article ref={root} className="project-details">
    <div className="project-toolbar"><h4>Szczegóły projektu</h4><button className="secondary" disabled={busy} onClick={() => { if (guardWorkspaceChange(root.current!)) setRevision(value => value + 1); }}>Wczytaj aktualne dane</button></div>
    {details?.project.status === 'active' && (details.permissions.administer || details.permissions.manageTasks) && <p className="hint">Wczytanie aktualnych danych zastępuje niezapisane formularze. Po konflikcie Twoja propozycja pozostaje w formularzu.</p>}
    {error && <p className="error" role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    {!details && !error && <p role="status">Ładowanie projektu i zadań…</p>}
    {details && <>
      <h4>{details.project.name}</h4><p>{details.project.description || 'Brak opisu projektu.'}</p>
      <p><ContractorName contractor={details.project.contractor} contractors={contractors} /></p>
      <p className="hint">{stateName(details.project.status)} · Wersja {details.project.version} · Zmieniono {new Date(details.project.updatedAt).toLocaleString('pl-PL')}</p>
      <OfflinePreparation scope={scope} />
      {details.project.status === 'archived' && <p role="status">Projekt archiwalny — historia pozostaje dostępna do odczytu.</p>}
      {details.permissions.administer && details.project.status === 'active' && <>
        <div className="project-actions"><button className="secondary" disabled={busy} onClick={() => { if (!editingProject && guardWorkspaceChange(root.current!)) { setShowTaskForm(false); setEditing(null); setEditingProject(true); } }}>Edytuj projekt</button></div>
        {editingProject && <ProjectForm key={`project-${revision}`} project={details.project} contractors={contractors} busy={busy} save={payload => mutate('/update', payload)} cancel={() => setEditingProject(false)} />}
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
      {details.permissions.readTasks ? <section aria-label="Zadania projektu"><div className="project-toolbar"><h4>Zadania</h4>{details.permissions.manageTasks && details.project.status === 'active' && <button disabled={busy} onClick={() => { if (guardWorkspaceChange(root.current!)) { setEditingProject(false); setEditing(null); setShowTaskForm(true); } }}>Nowe zadanie</button>}</div>
        {!tasks.length && <p role="status">Brak zadań w Twoim zakresie.</p>}
        <div className="task-list">{tasks.map(task => <article className="task-row" key={task.id}>
          <div><strong>{task.title}</strong><p>{task.description || 'Brak opisu zadania.'}</p><small>{task.assigneeName}</small></div>
          <TaskProgress task={task} path={`${path}/tasks/${encodeURIComponent(task.id)}`} csrfToken={csrfToken}
            writable={details.project.status === 'active'} disabled={busy} onAccessChanged={status => { void observeAccessFailure(path, status); onAccessChanged(); }} onGone={() => { void observeAccessFailure(path, 404); onGone(); }}
            onConfirmed={confirmed => setTasks(current => current.map(item => item.id === confirmed.id && item.version <= confirmed.version ? { ...item, ...confirmed } : item))} />
          {details.permissions.manageTasks && details.project.status === 'active' && <button className="secondary" disabled={busy} onClick={() => { if (guardWorkspaceChange(root.current!)) { setEditingProject(false); setEditing(task); setShowTaskForm(true); } }}>Edytuj zadanie</button>}
        </article>)}</div>
        {showTaskForm && details.permissions.manageTasks && details.project.status === 'active' && <TaskForm key={`${revision}-${editing?.id ?? 'new'}`} task={editing} members={members} busy={busy} cancel={() => { setEditing(null); setShowTaskForm(false); }}
          save={payload => mutate(editing ? `/tasks/${encodeURIComponent(editing.id)}/update` : '/tasks', payload)} />}
      </section> : <p role="status">Dostęp do zadań wymaga roli administratora firmy, kierownika, brygadzisty lub przypisanego pracownika.</p>}
    </>}
  </article>;
}
