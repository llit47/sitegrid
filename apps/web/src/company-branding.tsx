import { useEffect, useRef, useState, type FormEvent } from 'react';

export type Branding = { organizationId: string; name: string; accentColor: string; version: number;
  logo: { version: number; mimeType: string } | null };
export async function brandingRequest<T>(path: string, signal?: AbortSignal, csrfToken?: string, payload?: unknown): Promise<T> {
  const response = await fetch(path, { credentials: 'same-origin', signal, ...(payload === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken! }, body: JSON.stringify(payload),
  }) });
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(data.error ?? 'Nie udało się połączyć z serwerem.'), { status: response.status });
  return data;
}
export function CompanyLogo({ branding }: { branding: Branding }) {
  const [failed, setFailed] = useState(false);
  return <span className="company-logo">{branding.logo && !failed ? <img
    src={`/api/organizations/${encodeURIComponent(branding.organizationId)}/branding/logo?version=${branding.logo.version}`}
    alt={`Logo firmy ${branding.name}`} onError={() => setFailed(true)} /> : <span aria-hidden="true">{branding.name.slice(0, 1).toUpperCase()}</span>}</span>;
}
export function AccentSwatch({ color }: { color: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const context = canvas.current?.getContext('2d');
    if (context) { context.fillStyle = /^#[0-9a-f]{6}$/.test(color) ? color : '#163638'; context.fillRect(0, 0, 16, 48); }
  }, [color]);
  return <canvas ref={canvas} width={16} height={48} className="accent-swatch" role="img" aria-label={`Kolor firmowy: ${color}`} />;
}
export function CompanyBranding({ branding, csrfToken, onSaved, onAccessChanged }: {
  branding: Branding; csrfToken: string; onSaved: (branding: Branding) => void; onAccessChanged: () => void;
}) {
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [conflict, setConflict] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const controller = useRef(new AbortController());
  useEffect(() => { const active = controller.current; return () => active.abort(); }, []);
  const path = `/api/organizations/${encodeURIComponent(branding.organizationId)}/branding`;
  const fail = (e: unknown) => {
    if (controller.current.signal.aborted) return;
    setError(e instanceof Error ? e.message : 'Błąd połączenia.');
    const status = (e as { status?: number }).status;
    if (status === 409) setConflict(true);
    if (status === 401 || status === 403) onAccessChanged();
  };
  const mutate = async (suffix: string, payload: Record<string, unknown>) => {
    if (busy || conflict) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const data = await brandingRequest<{ branding: Branding }>(path + suffix, controller.current.signal, csrfToken, { ...payload, expectedVersion: branding.version });
      if (!controller.current.signal.aborted) { onSaved(data.branding); setNotice('Zapisano ustawienia firmy.'); setFile(null); }
    } catch (e) { fail(e); }
    finally { if (!controller.current.signal.aborted) setBusy(false); }
  };
  const save = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const data = new FormData(event.currentTarget);
    void mutate('', { name: data.get('name'), accentColor: data.get('accentColor') });
  };
  const upload = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!file || busy || conflict) return;
    if (file.size > 262144) { setError('Logo może mieć najwyżej 256 KiB.'); return; }
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) { setError('Wybierz obraz PNG, JPEG lub WebP.'); return; }
    setBusy(true); setError(''); setNotice('');
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (controller.current.signal.aborted) return;
      // The encoded payload stays in memory and is never persisted in browser storage.
      let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte);
      const data = await brandingRequest<{ branding: Branding }>(path + '/logo', controller.current.signal, csrfToken,
        { mimeType: file.type, data: btoa(binary), expectedVersion: branding.version });
      if (!controller.current.signal.aborted) { onSaved(data.branding); setFile(null); setNotice('Zapisano logo firmy.'); }
    } catch (e) { fail(e); }
    finally { if (!controller.current.signal.aborted) setBusy(false); }
  };
  const refresh = async () => {
    setBusy(true); setError(''); setNotice('');
    try {
      const data = await brandingRequest<{ branding: Branding }>(path, controller.current.signal);
      if (!controller.current.signal.aborted) { onSaved(data.branding); setConflict(false); setNotice('Pobrano aktualne ustawienia. Sprawdź dane przed zapisem.'); }
    } catch (e) { fail(e); }
    finally { if (!controller.current.signal.aborted) setBusy(false); }
  };
  return <section className="company-branding" aria-labelledby="company-settings-title">
    <h3 id="company-settings-title">Ustawienia firmy</h3>
    {error && <p className="error" role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    <p className="hint">Nazwa, kolor i logo dotyczą wyłącznie wybranej firmy.</p>
    {conflict && <p role="status">Zapis jest wstrzymany. Twój formularz pozostaje na ekranie; odświeżenie zastąpi go aktualnymi danymi firmy.</p>}
    <button type="button" className="secondary" disabled={busy} onClick={() => void refresh()}>Odśwież ustawienia</button>
    <form key={`settings-${branding.version}`} onSubmit={save}>
      <label>Nazwa firmy<input name="name" defaultValue={branding.name} maxLength={400} required disabled={busy || conflict} /></label>
      <label>Kolor firmowy<input name="accentColor" type="color" defaultValue={branding.accentColor} disabled={busy || conflict} /></label>
      <button disabled={busy || conflict}>{busy ? 'Zapisywanie…' : 'Zapisz ustawienia'}</button>
    </form>
    <form key={`logo-${branding.version}`} onSubmit={event => void upload(event)}>
      <label>Logo firmy<input name="logo" type="file" accept="image/png,image/jpeg,image/webp" disabled={busy || conflict} onChange={event => { setFile(event.target.files?.[0] ?? null); setError(''); }} /></label>
      <p className="hint">PNG, JPEG lub WebP. Maksymalnie 256 KiB i 1024 × 1024 piksele. Obraz statyczny.</p>
      <div className="branding-actions"><button disabled={!file || busy || conflict}>{busy ? 'Zapisywanie…' : branding.logo ? 'Zastąp logo' : 'Dodaj logo'}</button>
        {branding.logo && <button type="button" className="secondary" disabled={busy || conflict} onClick={() => void mutate('/logo/delete', {})}>Usuń logo</button>}</div>
    </form>
  </section>;
}
