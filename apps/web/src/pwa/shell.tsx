import { useEffect, useState, type ReactNode } from 'react';
import { checkLocalStorage } from '../storage/indexed-db.js';
import { registerShell, subscribeAccountChanges, type ShellState } from './lifecycle.js';
import './style.css';
import { OfflineViewer } from '../offline/viewer.js';
import { invalidateOfflineAccount } from '../storage/offline-access.js';

type InstallPrompt = Event & { prompt(): Promise<void> };
export function PwaShell({ children }: { children: ReactNode }) {
  const [online, setOnline] = useState(navigator.onLine);
  const [localView, setLocalView] = useState(false);
  const [revision, setRevision] = useState(0);
  const [shell, setShell] = useState<ShellState>('preparing');
  const [storageFailed, setStorageFailed] = useState(false);
  const [prompt, setPrompt] = useState<InstallPrompt | null>(null);
  const [standalone, setStandalone] = useState(() => matchMedia('(display-mode: standalone)').matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true);
  useEffect(() => registerShell(setShell), []);
  useEffect(() => {
    void checkLocalStorage().catch(() => setStorageFailed(true));
    const connectivity = () => { setOnline(navigator.onLine); setLocalView(false); setRevision(value => value + 1); };
    const restored = (event: PageTransitionEvent) => { if (event.persisted) connectivity(); };
    const unsubscribe = subscribeAccountChanges(legacy => {
      if (legacy) void invalidateOfflineAccount().catch(() => setStorageFailed(true));
      connectivity();
    });
    window.addEventListener('online', connectivity); window.addEventListener('offline', connectivity);
    window.addEventListener('pageshow', restored);
    return () => {
      unsubscribe(); window.removeEventListener('online', connectivity); window.removeEventListener('offline', connectivity);
      window.removeEventListener('pageshow', restored);
    };
  }, []);
  useEffect(() => {
    const offered = (event: Event) => { event.preventDefault(); setPrompt(event as InstallPrompt); };
    const installed = () => { setPrompt(null); setStandalone(true); };
    window.addEventListener('beforeinstallprompt', offered); window.addEventListener('appinstalled', installed);
    return () => { window.removeEventListener('beforeinstallprompt', offered); window.removeEventListener('appinstalled', installed); };
  }, []);
  return <main className="shell"><header className="brand"><span className="brand-mark" aria-hidden="true">S</span> SiteGrid</header>
    <aside className="pwa-status" aria-label="Stan aplikacji">
      <p role="status">{localView ? 'Odczyt lokalny — tylko wcześniej przygotowane dane z ważnym dostępem.' : online ? 'Tryb online.' : 'Brak połączenia. Odczyt tylko wcześniej przygotowanych projektów z ważnym dostępem.'}</p>
      {online && <><button type="button" className="secondary" onClick={() => setLocalView(value => !value)}>{localView ? 'Wróć do trybu online' : 'Czytaj przygotowane dane lokalnie'}</button>
        {!localView && <p className="hint">Odczyt lokalny działa także przy niedostępnym serwerze. Przejście zamyka bieżące formularze online.</p>}</>}
      {shell === 'ready' && <p>Powłoka aplikacji gotowa do otwarcia offline.</p>}
      {shell === 'preparing' && <p>Przygotowanie powłoki offline…</p>}
      {shell === 'unavailable' && <p>Powłoka offline niedostępna. Korzystaj z aplikacji online.</p>}
      {shell === 'update' && <p role="status">Nowa wersja gotowa. Zamknij wszystkie karty i okna SiteGrid, a następnie otwórz aplikację ponownie.</p>}
      {shell === 'activating' && <p role="status">Uruchamianie wersji aplikacji…</p>}
      {storageFailed && <p role="alert">Pamięć lokalna niedostępna lub zapis nie powiódł się. Funkcje online pozostają dostępne.</p>}
      {!standalone && <details><summary>Zainstaluj SiteGrid</summary>
        <p>Android i komputer: w menu przeglądarki wybierz „Zainstaluj aplikację” lub „Dodaj do ekranu głównego”.</p>
        <p>iPhone/iPad: otwórz SiteGrid w Safari, wybierz „Udostępnij”, następnie „Do ekranu głównego” i „Dodaj”.</p>
        <p>Jeśli instalacja jest niedostępna, korzystaj z SiteGrid w przeglądarce. Instalacja nie pobiera danych projektów.</p>
        {prompt && <button type="button" onClick={() => { const current = prompt; setPrompt(null); void current.prompt().catch(() => { /* Menu guidance stays available. */ }); }}>Zainstaluj aplikację</button>}
      </details>}
    </aside>
    {online && !localView ? <div key={revision}>{children}</div> : <OfflineViewer key={revision} localOnly={online} />}
    <footer>SiteGrid · samodzielna instalacja</footer>
  </main>;
}
