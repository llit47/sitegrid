import { Discussion } from '../task-comments/discussion.js';
import { useEffect, useRef, useState } from 'react';
import { request, type Task } from '../project-api.js';
import { TaskProgress, taskStateName } from '../task-progress.js';
import { Assignment } from '../tasks/assignment.js';
import type { Assignee } from '../tasks/task-form.js';
import { guardPendingOperations, guardWorkspaceChange, usePendingOperation } from '../workspace/navigation-safety.js';
import { invalidatePreparedProject, observeAccessFailure } from '../offline/account.js';
import './subtasks.css';
import { useLiveResource } from '../tasks/live-resource.js';
export function ParentContext({ task }: { task: Pick<Task, 'parent'> }) {
  return task.parent ? <p className="parent-context">Podzadanie · {task.parent.title}</p> : null;
}
export function ProgressHistory({ path, version, onAccessChanged }: { path: string; version: number; onAccessChanged: () => void }) {
  const [open,setOpen]=useState(false), [history,setHistory]=useState<{event:string;createdAt:string;status:string;version:number}[] | null>(null), [error,setError]=useState('');
  useEffect(()=>{
    if(!open) return;
    const controller=new AbortController(); setHistory(null); setError('');
    void request<{history:NonNullable<typeof history>}>(`${path}/progress-history`,controller.signal).then(data=>{if(!controller.signal.aborted) setHistory(data.history);})
      .catch(e=>{if(!controller.signal.aborted) {setError(e.message); if([401,403,404].includes(e.status)) onAccessChanged();}});
    return ()=>controller.abort();
  },[path,open,version]);
  return <div className="progress-history"><button className="secondary" aria-expanded={open} onClick={()=>setOpen(!open)}>Historia postępu</button>
    {open && <>{error && <p className="error" role="alert">{error}</p>}{!history && !error && <p role="status">Ładowanie historii…</p>}
      {history?.length===0 && <p>Brak zmian postępu.</p>}{history && <ol>{history.map((entry,i)=><li key={i}>{taskStateName(entry.status)} · Wersja {entry.version} · {new Date(entry.createdAt).toLocaleString('pl-PL')}</li>)}</ol>}</>}
  </div>;
}
export function Subtasks({ task,path,organizationId,projectId,csrfToken,assignees,writable,disabled,onChanged,onProgressConfirmed,onAccessChanged,onPendingChange,onOpenChange,pendingOnly, active = true }: {
  active?: boolean; task:Task; path:string; organizationId:string; projectId:string; csrfToken:string; assignees:Assignee[]; writable:boolean; disabled:boolean;
  onChanged:()=>void; onProgressConfirmed?:()=>void; onAccessChanged:()=>void; onPendingChange?:(id:string,pending:boolean)=>void; onOpenChange?:(open:boolean)=>void; pendingOnly?:Set<string>;
}) {
  const root=useRef<HTMLElement>(null), lifetime=useRef<AbortController | null>(null), sending=useRef(false);
  const [open,setOpen]=useState(false),[tasks,setTasks]=useState<Task[] | null>(null),[creating,setCreating]=useState(false),[assigning,setAssigning]=useState('');
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
  usePendingOperation(busy);
  useEffect(()=>{const controller=new AbortController(); lifetime.current=controller; return ()=>controller.abort();},[]);
  const [revision,setRevision] = useState(0);
  useLiveResource(`${path}:${revision}`, signal => request<{tasks:Task[]}>(`${path}/subtasks`, signal), {
    active: open && active, paused: busy || !!pendingOnly,
    receive: data => { setTasks(current => data.tasks.map(child => {
      const previous = current?.find(item => item.id === child.id);
      return previous && previous.version > child.version ? previous : child;
    })); setError(''); },
    failed: e => { setError(e.message); if ([401,403,404].includes(e.status ?? 0)) {setTasks(null); onAccessChanged();} },
  });
  const childPath=(id:string)=>`${path.slice(0,path.lastIndexOf('/'))}/${id}`;
  const mutate=async(url:string,payload:object,assignment?:Task)=>{
    if(sending.current || disabled || !guardPendingOperations()) return;
    sending.current=true; setBusy(true); setError(''); setNotice(''); const signal=lifetime.current!.signal;
    try {
      const data=await request<{task:Task}>(url,signal,csrfToken,payload);
      if(signal.aborted) return;
      if(assignment && data.task.assigneeMembershipId!==assignment.assigneeMembershipId) await invalidatePreparedProject(organizationId,projectId);
      if(signal.aborted) return;
      setCreating(false); setAssigning(''); setRevision(value => value + 1); setNotice('Serwer potwierdził zapis podzadania.'); onChanged();
    } catch(e) {if(!signal.aborted) {setError((e as Error).message); if([401,403,404].includes((e as {status:number}).status)) {setTasks(null); onAccessChanged();}}}
    finally {if(!signal.aborted) {sending.current=false; setBusy(false);}}
  };
  const summary=task.subtaskProgress;
  return <section ref={root} className="subtasks" aria-label={`Podzadania: ${task.title}`}>
    {summary && <p className="subtask-summary">Podzadania: {summary.total} · Zaplanowane: {summary.planned} · W toku: {summary.inProgress} · Do odbioru: {summary.submitted}</p>}
    <button className="secondary" disabled={disabled || busy} aria-expanded={open} onClick={()=>{
      if(guardWorkspaceChange(root.current!)) {setOpen(!open); onOpenChange?.(!open);}
    }}>{open ? 'Zwiń podzadania' : 'Pokaż podzadania'}</button>
    {open && <>
      {error && <p className="error" role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
      {!tasks && !error && <p role="status">Ładowanie podzadań…</p>}{tasks?.length===0 && <p>Brak podzadań.</p>}
      {writable && <button disabled={busy || disabled} onClick={()=>{if(guardWorkspaceChange(root.current!)) {setCreating(true); setAssigning('');}}}>Dodaj podzadanie</button>}
      {creating && <form className="subtask-form" onSubmit={event=>{
        event.preventDefault(); const values=new FormData(event.currentTarget);
        void mutate(`${path}/subtasks`,{title:values.get('title'),description:values.get('description'),assigneeMembershipId:values.get('assigneeMembershipId') || null});
      }}><label>Tytuł podzadania<input name="title" required maxLength={200} autoFocus disabled={busy} /></label>
        <label>Opis podzadania<textarea name="description" maxLength={4000} disabled={busy} /></label>
        <label>Wykonawca podzadania<select name="assigneeMembershipId" disabled={busy}><option value="">Bez wykonawcy — backlog</option>{assignees.map(member=><option key={member.membershipId} value={member.membershipId}>{member.displayName}</option>)}</select></label>
        <div className="project-actions"><button disabled={busy}>Utwórz podzadanie</button><button type="button" className="secondary" disabled={busy} onClick={event=>{if(guardWorkspaceChange(event.currentTarget.form!)) setCreating(false);}}>Anuluj podzadanie</button></div>
      </form>}
      <div className="subtask-list">{tasks?.map(child=><article className="subtask-row" key={child.id} aria-label={child.title}>
        <h4>{child.title}</h4>{child.description && <p>{child.description}</p>}<p>{child.assigneeName || 'Bez wykonawcy · Backlog'}</p>
        <TaskProgress task={child} path={childPath(child.id)} csrfToken={csrfToken} writable={writable} disabled={busy || disabled || !!assigning || (!!pendingOnly && !pendingOnly.has(child.id))} onPendingChange={onPendingChange}
          onConfirmed={confirmed=>{setTasks(current=>current?.map(item=>item.id===child.id && item.version<=confirmed.version?{...item,...confirmed}:item) ?? null); (onProgressConfirmed ?? onChanged)();}}
          onAccessChanged={status=>{void observeAccessFailure(path,status); setTasks(null); onAccessChanged();}} onGone={()=>{void observeAccessFailure(path,404); setTasks(null); onAccessChanged();}} />
        {writable && child.status==='planned' && <button className="secondary" disabled={busy || disabled} onClick={()=>{if(guardWorkspaceChange(root.current!)) {setAssigning(child.id); setCreating(false);}}}>{child.assigneeMembershipId?'Zmień wykonawcę podzadania':'Przypisz podzadanie'}</button>}
        {assigning===child.id && <Assignment current={child.assigneeMembershipId} assignees={assignees} busy={busy} cancel={()=>setAssigning('')}
          save={id=>void mutate(`${childPath(child.id)}/assign`,{assigneeMembershipId:id,expectedVersion:child.version},child)} />}
        <Discussion path={childPath(child.id)} title={child.title} csrfToken={csrfToken} writable={writable} onAccessChanged={onAccessChanged} />
        <ProgressHistory path={childPath(child.id)} version={child.version} onAccessChanged={onAccessChanged} />
      </article>)}</div>
    </>}
  </section>;
}
