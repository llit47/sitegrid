import { useCallback, useEffect, useRef, useState } from 'react';
import { ContractorFilter, ContractorName, type Directory } from './contractors.js';
import { ProjectForm } from './project-forms.js';
import { ProjectDetails } from './project-details.js';
import { request, stateName, type Project } from './project-api.js';
import { reconcilePreparedProjects } from './offline/account.js';
import { guardWorkspaceChange, guardPendingOperations, usePendingOperation } from './workspace/navigation-safety.js';
export type { Project } from './project-api.js';
export function Projects({ accountId, organizationId, admin, csrfToken, onAccessChanged, directory, onSummary }: {
  accountId: string; organizationId: string; admin: boolean; csrfToken: string; onAccessChanged: () => void; directory: Directory; onSummary: (projects: Project[] | null) => void;
}) {
  const path = `/api/organizations/${encodeURIComponent(organizationId)}/projects`;
  const [creating, setCreating] = useState(false);
  const root = useRef<HTMLElement>(null);
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [selected, setSelected] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const [contractorFilter, setContractorFilter] = useState('');
  usePendingOperation(busy);
  useEffect(() => { onSummary(projects); }, [projects, onSummary]);
  const lifetime = useRef<AbortController | null>(null);
  useEffect(() => { const controller = new AbortController(); lifetime.current = controller; return () => controller.abort(); }, []);
  useEffect(() => {
    const controller = new AbortController(); setProjects(null); setError('');
    void request<{ projects: Project[] }>(path, controller.signal).then(async data => {
      if (!controller.signal.aborted) setProjects(current => current === null ? data.projects : [
        ...current, ...data.projects.filter(project => !current.some(local => local.id === project.id)),
      ]);
      if (!controller.signal.aborted) await reconcilePreparedProjects(organizationId, data.projects.map(project => project.id));
    }).catch(e => { if (!controller.signal.aborted) { setError(e.message); if ([401, 403].includes(e.status)) onAccessChanged(); } });
    return () => controller.abort();
  }, [path, revision, onAccessChanged]);
  const changed = useCallback((project: Project) => setProjects(current => current?.map(item => item.id === project.id ? project : item) ?? null), []);
  const gone = useCallback(() => { setCreating(false); setSelected(''); setRevision(value => value + 1); }, []);
  const startCreating = () => {
    if (!creating && guardWorkspaceChange(root.current!)) { setSelected(''); setCreating(true); }
  };
  const create = async (payload: object) => {
    const signal = lifetime.current!.signal;
    if (busy || !guardPendingOperations()) return false;
    const detailsRoot = root.current?.querySelector('.project-details');
    if (detailsRoot && !guardWorkspaceChange(detailsRoot)) return false;
    setBusy(true); setError('');
    try {
      const data = await request<{ project: Project }>(path, signal, csrfToken, payload);
      if (signal.aborted) return false;
      setProjects(current => [data.project, ...(current ?? [])]); setSelected(data.project.id); setCreating(false); return true;
    } catch (e) { if (!signal.aborted) { setError((e as Error).message); if ([401, 403].includes((e as { status: number }).status)) onAccessChanged(); } return false; }
    finally { if (!signal.aborted) setBusy(false); }
  };
  return <section ref={root} className="projects" aria-labelledby={`projects-${organizationId}`}>
    <div className="project-toolbar"><h3 id={`projects-${organizationId}`}>Lista projektów</h3>
      <div className="project-actions"><button className="secondary" disabled={busy} onClick={() => { if (guardWorkspaceChange(root.current!)) gone(); }}>Odśwież projekty</button>{admin && <button disabled={busy} onClick={startCreating}>Nowy projekt</button>}</div></div>
    {error && <p className="error" role="alert">{error}</p>}
    {!projects && !error && <p role="status">Ładowanie projektów…</p>}
    {projects && <ContractorFilter projects={projects} contractors={directory.contractors} value={contractorFilter} onChange={value => { if (guardWorkspaceChange(root.current!)) { setCreating(false); setContractorFilter(value); setSelected(''); } }} />}
    {projects && <div className="project-list">
      {!projects.length && <p role="status">Brak dostępnych projektów. Przydziały nadaje administrator firmy.</p>}
      {!!projects.length && contractorFilter && !projects.some(project => (project.contractor?.id ?? 'none') === contractorFilter) && <p role="status">Brak projektów dla wybranego kontrahenta.</p>}
      {projects.filter(project => !contractorFilter || (project.contractor?.id ?? 'none') === contractorFilter).map(project => <button className="secondary project-choice" aria-pressed={selected === project.id} key={project.id} onClick={() => { if (project.id !== selected && guardWorkspaceChange(root.current!)) { setCreating(false); setSelected(project.id); } }}>
        <strong>{project.name}</strong><span>{stateName(project.status)}</span>
        <ContractorName contractor={project.contractor} contractors={directory.contractors} />
      </button>)}
    </div>}
    {creating && <ProjectForm contractors={directory.contractors} busy={busy} save={create} cancel={() => setCreating(false)} />}
    {selected && <ProjectDetails key={selected} scope={{ accountId, organizationId, projectId: selected }} path={`${path}/${encodeURIComponent(selected)}`} contractors={directory.contractors} csrfToken={csrfToken} onSaved={changed} onGone={gone} onAccessChanged={onAccessChanged} />}
  </section>;
}
