import { useState } from 'react';
import type { Assignee } from './task-form.js';
import { guardWorkspaceChange } from '../workspace/navigation-safety.js';
export function Assignment({ current, expectedVersion, assignees, busy, save, cancel }: { current: string | null; expectedVersion: number; assignees: Assignee[]; busy: boolean; save: (id: string | null, version: number) => void; cancel: () => void }) {
  // Polling updates the card, while an open editor keeps its original conflict boundary.
  const [original] = useState({ current, expectedVersion });
  return <form className="task-assignment" onSubmit={event => { event.preventDefault(); save(new FormData(event.currentTarget).get('assigneeMembershipId') as string || null, original.expectedVersion); }}>
    <label>Wykonawca<select aria-label="Wykonawca" name="assigneeMembershipId" defaultValue={original.current ?? ''} disabled={busy}>
      <option value="">Bez wykonawcy — backlog</option>
      {original.current && !assignees.some(member => member.membershipId === original.current) && <option value={original.current} disabled>Poprzedni wykonawca utracił dostęp</option>}
      {assignees.map(member => <option key={member.membershipId} value={member.membershipId}>{member.displayName}</option>)}
    </select></label>
    <div className="project-actions"><button disabled={busy}>Zapisz przydział</button><button className="secondary" type="button" disabled={busy} onClick={event => { if (guardWorkspaceChange(event.currentTarget.form!)) cancel(); }}>Anuluj przydział</button></div>
  </form>;
}
