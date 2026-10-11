import { useState } from 'react';
import { Projects, type Project } from '../projects.js';
import { ContractorDirectory, useContractorDirectory } from '../contractors.js';
import { CompanyMembers } from '../company-members.js';
import { CompanyBranding, type Branding } from '../company-branding.js';
import { InvitationManager } from '../invitations.js';
import { Dashboard } from './dashboard.js';
import type { Section } from './layout.js';

export function CompanyWorkspace({ active, visited, navigate, accountId, organizationId, admin, branding, csrfToken, onSaved, onAccessChanged }: {
  active: Section; visited: Set<Section>; navigate: (section: Section) => void; accountId: string; organizationId: string; admin: boolean;
  branding: Branding; csrfToken: string; onSaved: (branding: Branding) => void; onAccessChanged: () => void;
}) {
  const directory = useContractorDirectory(organizationId, admin, csrfToken, onAccessChanged);
  const [projects, setProjects] = useState<Project[] | null>(null);
  // Hidden sections remain mounted so drafts, Files and M08 operation IDs survive navigation.
  return <>
    <div hidden={active !== 'dashboard'}><Dashboard branding={branding} projects={projects} admin={admin} navigate={navigate} /></div>
    <div hidden={active !== 'projects'}><Projects accountId={accountId} organizationId={organizationId} admin={admin} csrfToken={csrfToken} onAccessChanged={onAccessChanged} directory={directory} onSummary={setProjects} /></div>
    {admin && <>
      {visited.has('contractors') && <div hidden={active !== 'contractors'}><ContractorDirectory directory={directory} /></div>}
      {visited.has('members') && <div hidden={active !== 'members'}><CompanyMembers organizationId={organizationId} csrfToken={csrfToken} onAccessChanged={onAccessChanged} /></div>}
      {visited.has('invitations') && <div hidden={active !== 'invitations'}><p className="hint">Zaproszenie aktywuje konto i członkostwo w firmie. Do pracy w projekcie potrzebny jest także przydział w sekcji Projekty.</p><InvitationManager organizationId={organizationId} csrfToken={csrfToken} /></div>}
      {visited.has('settings') && <div hidden={active !== 'settings'}><CompanyBranding branding={branding} csrfToken={csrfToken} onSaved={onSaved} onAccessChanged={onAccessChanged} /></div>}
    </>}
  </>;
}
