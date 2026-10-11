import { useState, type FormEvent } from 'react';
import { ContractorSelect, type Contractor } from './contractors.js';
import type { Project, Task, Member } from './project-api.js';
import { guardWorkspaceChange } from './workspace/navigation-safety.js';
export function ProjectForm({ project, contractors, busy, save, cancel }: { project?: Project; contractors: Contractor[] | null; busy: boolean; save: (payload: object) => Promise<boolean>; cancel: () => void }) {
  const [contractorId, setContractorId] = useState(project?.contractor?.id ?? '');
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget, values = new FormData(form);
    if (await save({ name: values.get('name'), description: values.get('description'), contractorId: contractorId || null, ...(project ? { expectedVersion: project.version } : {}) })) {
      if (!project) { form.reset(); setContractorId(''); }
    }
  };
  return <form className="project-form" onSubmit={event => void submit(event)}>
    <h4>{project ? 'Edytuj projekt' : 'Nowy projekt'}</h4>
    <label>Nazwa projektu<input name="name" defaultValue={project?.name} required maxLength={200} disabled={busy} /></label>
    <label>Opis projektu (opcjonalnie)<input name="description" defaultValue={project?.description} maxLength={4000} disabled={busy} /></label>
    <ContractorSelect contractors={contractors} current={project?.contractor} value={contractorId} onChange={setContractorId} disabled={busy} />
    <div className="project-actions"><button disabled={busy}>{busy ? 'Zapisywanie…' : project ? 'Zapisz projekt' : 'Utwórz projekt'}</button><button type="button" className="secondary" disabled={busy} onClick={event => { if (guardWorkspaceChange(event.currentTarget.form!)) cancel(); }}>Anuluj formularz projektu</button></div>
  </form>;
}
export function TaskForm({ task, members, busy, save, cancel }: {
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
      <button type="button" className="secondary" disabled={busy} onClick={event => { if (guardWorkspaceChange(event.currentTarget.form!)) cancel(); }}>Anuluj formularz zadania</button></div>
  </form>;
}
