import { DiscussionDrafts } from '../task-comments/drafts.js';
import { useState } from 'react';
import { Projects, type Project } from '../projects.js';
import { ContractorDirectory, useContractorDirectory } from '../contractors.js';
import { CompanyMembers } from '../company-members.js';
import { CompanyBranding, type Branding } from '../company-branding.js';
import { InvitationManager } from '../invitations.js';
import { Dashboard } from './dashboard.js';
import { TaskWorkspace } from '../tasks/task-workspace.js';
import type { Section } from './layout.js';

export function CompanyWorkspace({ active, visited, accountId, organizationId, admin, manageTasks, readTasks, branding, csrfToken, onSaved, onAccessChanged, openTasks }: {
  active: Section; visited: Set<Section>; accountId: string; organizationId: string; admin: boolean; manageTasks: boolean; readTasks: boolean;
  branding: Branding; csrfToken: string; onSaved: (branding: Branding) => void; onAccessChanged: () => void; openTasks: () => void;
}) {
  const directory = useContractorDirectory(organizationId, admin, csrfToken, onAccessChanged);
  const [projects, setProjects] = useState<Project[] | null>(null);
  // Hidden sections remain mounted so drafts, Files and M08 operation IDs survive navigation.
  return <DiscussionDrafts scope={`${accountId}:${organizationId}`}>
    <div hidden={active !== 'dashboard'}>{readTasks ? <Dashboard organizationId={organizationId} active={active === 'dashboard'} openTasks={openTasks} onAccessChanged={onAccessChanged} /> : <p role="status">Brak uprawnień do zadań w tej firmie.</p>}</div>
    {visited.has('tasks') && <div hidden={active !== 'tasks'}>{readTasks ? <TaskWorkspace organizationId={organizationId} active={active === 'tasks'} projects={projects} manage={manageTasks} csrfToken={csrfToken} onAccessChanged={onAccessChanged} /> : <p role="status">Brak uprawnień do zadań w tej firmie.</p>}</div>}
    <div hidden={active !== 'projects'}><Projects active={active === 'projects'} accountId={accountId} organizationId={organizationId} admin={admin} csrfToken={csrfToken} onAccessChanged={onAccessChanged} directory={directory} onSummary={setProjects} /></div>
    {admin && <>
      {visited.has('contractors') && <div hidden={active !== 'contractors'}><ContractorDirectory directory={directory} /></div>}
      {visited.has('members') && <div hidden={active !== 'members'}><CompanyMembers organizationId={organizationId} csrfToken={csrfToken} onAccessChanged={onAccessChanged} /></div>}
      {visited.has('invitations') && <div hidden={active !== 'invitations'}><p className="hint">Zaproszenie aktywuje konto i członkostwo w firmie. Przypisane zadanie automatycznie udostępnia pracownikowi potrzebny kontekst projektu.</p><InvitationManager organizationId={organizationId} csrfToken={csrfToken} /></div>}
      {visited.has('settings') && <div hidden={active !== 'settings'}><CompanyBranding branding={branding} csrfToken={csrfToken} onSaved={onSaved} onAccessChanged={onAccessChanged} /></div>}
    </>}
  </DiscussionDrafts>;
}
