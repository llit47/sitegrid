import { useState, type FormEvent } from 'react';
import type { Project } from '../project-api.js';
import { guardWorkspaceChange } from '../workspace/navigation-safety.js';
export type Assignee = { membershipId: string; displayName: string };
export function QuickTaskForm({ projects, assignees, busy, save, cancel }: {
  projects: Project[]; assignees: Assignee[]; busy: boolean; save: (projectId: string, payload: object) => Promise<boolean>; cancel: () => void;
}) {
  const [projectId, setProjectId] = useState('');
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const values = new FormData(event.currentTarget);
    await save(projectId, { title: values.get('title'), description: values.get('description'), assigneeMembershipId: values.get('assigneeMembershipId') || null });
  };
  return <form className="quick-task-form" onSubmit={event => void submit(event)}>
    <h3>Nowe zadanie</h3>
    <label>Projekt<select aria-label="Projekt" name="projectId" value={projectId} onChange={event => setProjectId(event.target.value)} required disabled={busy}>
      <option value="">Wybierz projekt…</option>{projects.filter(project => project.status === 'active').map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
    </select></label>
    <label>Tytuł zadania<input name="title" required maxLength={200} disabled={busy} autoFocus /></label>
    <label>Wykonawca (opcjonalnie)<select aria-label="Wykonawca (opcjonalnie)" name="assigneeMembershipId" disabled={busy}><option value="">Bez wykonawcy — backlog</option>
      {assignees.map(member => <option key={member.membershipId} value={member.membershipId}>{member.displayName}</option>)}
    </select></label>
    <label>Opis zadania (opcjonalnie)<input name="description" maxLength={4000} disabled={busy} /></label>
    <div className="project-actions"><button disabled={busy}>{busy ? 'Zapisywanie…' : 'Utwórz zadanie'}</button><button type="button" className="secondary" disabled={busy} onClick={event => { if (guardWorkspaceChange(event.currentTarget.form!)) cancel(); }}>Anuluj formularz zadania</button></div>
  </form>;
}
