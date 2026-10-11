import { useState } from 'react';
import { request } from '../project-api.js';
import { useLiveResource } from '../tasks/live-resource.js';
import { StatusBadge, statusNames, type StatusTask } from '../tasks/status.js';
import './dashboard.css';

type Summary = Record<keyof typeof statusNames, number> & {
  total: number; scope: 'company' | 'mine';
  attention: (StatusTask & { id: string; title: string; projectName: string })[];
};
export function Dashboard({ organizationId, active, onAccessChanged, openTasks }: {
  organizationId: string; active: boolean; onAccessChanged: () => void; openTasks: () => void;
}) {
  const [summary, setSummary] = useState<Summary | null>(null), [error, setError] = useState('');
  const path = `/api/organizations/${organizationId}/task-summary`;
  useLiveResource(path, signal => request<Summary>(path, signal), { active,
    receive: data => { setSummary(data); setError(''); },
    failed: e => { setError(e.message); if ([401,403].includes(e.status ?? 0)) { setSummary(null); onAccessChanged(); } },
  });
  return <section className="work-dashboard" aria-label="Podsumowanie pracy">
    <div className="project-toolbar"><h2>Podsumowanie pracy</h2><button onClick={openTasks}>Przejdź do zadań</button></div>
    {error && <p className="error" role="alert">{error}</p>}
    {!summary && !error && <p role="status">Ładowanie podsumowania…</p>}
    {summary && <>
      <p>{summary.scope === 'company' ? 'Zadania firmy' : 'Moje zadania'} w aktywnych projektach: <strong data-summary-total>{summary.total}</strong>. Liczniki obejmują zadania i podzadania dostępne dla Twojej roli.</p>
      <dl className="dashboard-counters">{Object.entries(statusNames).map(([key, label]) => <div key={key}>
        <dt>{label}</dt><dd data-status-count={key}>{summary[key as keyof typeof statusNames]}</dd>
      </div>)}</dl>
      <h3>Wymagają uwagi</h3><p className="hint">{summary.scope === 'company' ? 'Zadania do odbioru i bez wykonawcy.' : 'Twoje zadania do rozpoczęcia i w toku.'} Maksymalnie 8 pozycji; pełna lista w Zadaniach.</p>
      {summary.attention.length === 0 && <p>Brak zadań wymagających uwagi.</p>}
      <ul className="dashboard-attention">{summary.attention.map(task => <li key={task.id}>
        <div><strong>{task.title}</strong><small>{task.projectName}</small></div><StatusBadge task={task} />
      </li>)}</ul>
    </>}
  </section>;
}
