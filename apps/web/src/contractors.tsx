import { useEffect, useRef, useState, type FormEvent } from 'react';

export type ProjectContractor = { id: string; name: string; status: string };
export type Contractor = ProjectContractor & { version: number; createdAt: string; updatedAt: string };
async function request(path: string, signal: AbortSignal, csrfToken: string, payload?: object) {
  const response = await fetch(path, { credentials: 'same-origin', signal, ...(payload ? {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken }, body: JSON.stringify(payload),
  } : {}) }).catch(() => { throw new Error('Nie udało się połączyć z serwerem.'); });
  const data = await response.json().catch(() => { throw new Error('Nieprawidłowa odpowiedź serwera. Ponów połączenie.'); });
  if (!response.ok) throw Object.assign(new Error(data.error ?? 'Nie udało się połączyć z serwerem.'), { status: response.status });
  return data as { contractors: Contractor[]; contractor: Contractor };
}
export function useContractorDirectory(organizationId: string, enabled: boolean, csrfToken: string, onAccessChanged: () => void) {
  const path = `/api/organizations/${encodeURIComponent(organizationId)}/contractors`;
  const [contractors, setContractors] = useState<Contractor[] | null>(null);
  const [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(false), [busy, setBusy] = useState(false), [revision, setRevision] = useState(0);
  const lifetime = useRef<AbortController | null>(null);
  useEffect(() => { const controller = new AbortController(); lifetime.current = controller; return () => controller.abort(); }, []);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController(); setLoading(true); setError('');
    void request(path, controller.signal, csrfToken).then(data => {
      if (!controller.signal.aborted) setContractors(data.contractors);
    }).catch(e => { if (!controller.signal.aborted) {
      setError(e.message);
      if ([401, 403].includes(e.status)) { setContractors(null); onAccessChanged(); }
    } }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [path, enabled, csrfToken, revision, onAccessChanged]);
  const save = async (name: string, current?: Contractor, status = current?.status ?? 'active') => {
    const signal = lifetime.current!.signal;
    if (!enabled || busy || loading || !contractors) return false;
    setBusy(true); setError(''); setNotice('');
    try {
      const data = await request(current ? `${path}/${encodeURIComponent(current.id)}/update` : path, signal, csrfToken,
        current ? { name, status, expectedVersion: current.version } : { name });
      if (signal.aborted) return false;
      setContractors(items => current ? items!.map(item => item.id === current.id ? data.contractor : item) : [...items!, data.contractor]);
      setNotice('Zapisano kontrahenta.'); return true;
    } catch (e) {
      if (!signal.aborted) {
        setError((e as Error).message);
        if ([401, 403].includes((e as { status: number }).status)) { setContractors(null); onAccessChanged(); }
      }
      return false;
    } finally { if (!signal.aborted) setBusy(false); }
  };
  return { contractors: enabled ? contractors : null, loading, busy, error, notice, revision,
    refresh: () => { setNotice(''); setRevision(value => value + 1); }, save };
}
type Directory = ReturnType<typeof useContractorDirectory>;
function ContractorForm({ current, directory }: { current?: Contractor; directory: Directory }) {
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    if (await directory.save(String(new FormData(form).get('name')), current) && !current) form.reset();
  };
  return <form className="contractor-form" onSubmit={event => void submit(event)}>
    <label>{current ? 'Nazwa kontrahenta' : 'Nazwa nowego kontrahenta'}<input name="name" defaultValue={current?.name} required maxLength={200}
      disabled={directory.busy || directory.loading || !directory.contractors} /></label>
    <div className="project-actions"><button disabled={directory.busy || directory.loading || !directory.contractors}>{current ? 'Zapisz kontrahenta' : 'Utwórz kontrahenta'}</button>
      {current && <button type="button" className="secondary" disabled={directory.busy || directory.loading}
        onClick={() => void directory.save(current.name, current, current.status === 'active' ? 'inactive' : 'active')}>
        {current.status === 'active' ? 'Dezaktywuj kontrahenta' : 'Aktywuj kontrahenta'}</button>}</div>
  </form>;
}
export function ContractorDirectory({ directory }: { directory: Directory }) {
  return <section className="contractors" aria-label="Kontrahenci firmy">
    <div className="project-toolbar"><h3>Kontrahenci</h3><button className="secondary" disabled={directory.busy || directory.loading} onClick={directory.refresh}>Wczytaj kontrahentów ponownie</button></div>
    <p className="hint">Dezaktywacja zachowuje powiązania projektów. Po konflikcie propozycja pozostaje w formularzu; ponowne wczytanie zastępuje niezapisane formularze kontrahentów.</p>
    {directory.error && <p className="error" role="alert">{directory.error}</p>}
    {directory.notice && <p role="status">{directory.notice}</p>}
    {directory.loading && <p role="status">Ładowanie kontrahentów…</p>}
    {directory.contractors && <>
      {!directory.contractors.length && <p role="status">Brak kontrahentów. Projekty mogą pozostać bez powiązania.</p>}
      {directory.contractors.map(contractor => <article className="contractor-row" key={`${directory.revision}-${contractor.id}-${contractor.version}`}>
        <h4>{contractor.name}</h4><p>{contractor.status === 'active' ? 'Aktywny kontrahent' : 'Nieaktywny kontrahent'} · Wersja {contractor.version}</p>
        <ContractorForm current={contractor} directory={directory} />
      </article>)}
    </>}
    <ContractorForm directory={directory} />
  </section>;
}
function resolved(contractor: ProjectContractor, contractors: Contractor[] | null) {
  return contractors?.find(item => item.id === contractor.id) ?? contractor;
}
export function ContractorName({ contractor, contractors }: { contractor: ProjectContractor | null; contractors: Contractor[] | null }) {
  if (!contractor) return <span>Bez kontrahenta</span>;
  const current = resolved(contractor, contractors);
  return <span>Kontrahent: {current.name}{current.status === 'inactive' ? ' (nieaktywny)' : ''}</span>;
}
export function ContractorSelect({ contractors, current, value, onChange, disabled }: {
  contractors: Contractor[] | null; current?: ProjectContractor | null; value: string; onChange: (value: string) => void; disabled: boolean;
}) {
  const selected = contractors?.find(item => item.id === value) ?? (current?.id === value ? current : null);
  return <label>Kontrahent projektu<select aria-label="Kontrahent projektu" name="contractorId" value={value} onChange={event => onChange(event.target.value)} disabled={disabled || !contractors}>
    <option value="">Bez kontrahenta (projekt wewnętrzny lub historyczny)</option>
    {selected && selected.status === 'inactive' && <option value={selected.id} disabled>{selected.name} (nieaktywny — {current?.id === selected.id ? 'istniejące powiązanie' : 'wybierz innego'})</option>}
    {!contractors && current && current.status === 'active' && <option value={current.id}>{current.name}</option>}
    {contractors?.filter(item => item.status === 'active').map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
  </select></label>;
}
export function ContractorFilter({ projects, contractors, value, onChange }: {
  projects: { contractor: ProjectContractor | null }[]; contractors: Contractor[] | null; value: string; onChange: (value: string) => void;
}) {
  // Derive choices from already authorized projects, never fetch a worker directory.
  const choices = new Map(projects.flatMap(project => project.contractor ? [[project.contractor.id, resolved(project.contractor, contractors)] as const] : []));
  return <label>Filtruj projekty po kontrahencie<select aria-label="Filtruj projekty po kontrahencie" value={value} onChange={event => onChange(event.target.value)}>
    <option value="">Wszyscy kontrahenci</option><option value="none">Bez kontrahenta</option>
    {[...choices.values()].map(item => <option key={item.id} value={item.id}>{item.name}{item.status === 'inactive' ? ' (nieaktywny)' : ''}</option>)}
  </select></label>;
}
