import type { Assignee } from './task-form.js';
import { guardWorkspaceChange } from '../workspace/navigation-safety.js';
export function Assignment({ current, assignees, busy, save, cancel }: { current: string | null; assignees: Assignee[]; busy: boolean; save: (id: string | null) => void; cancel: () => void }) {
  return <form className="task-assignment" onSubmit={event => { event.preventDefault(); save(new FormData(event.currentTarget).get('assigneeMembershipId') as string || null); }}>
    <label>Wykonawca<select aria-label="Wykonawca" name="assigneeMembershipId" defaultValue={current ?? ''} disabled={busy}>
      <option value="">Bez wykonawcy — backlog</option>
      {current && !assignees.some(member => member.membershipId === current) && <option value={current} disabled>Poprzedni wykonawca utracił dostęp</option>}
      {assignees.map(member => <option key={member.membershipId} value={member.membershipId}>{member.displayName}</option>)}
    </select></label>
    <div className="project-actions"><button disabled={busy}>Zapisz przydział</button><button className="secondary" type="button" disabled={busy} onClick={event => { if (guardWorkspaceChange(event.currentTarget.form!)) cancel(); }}>Anuluj przydział</button></div>
  </form>;
}
