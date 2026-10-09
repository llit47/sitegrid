import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';

function App() {
  const [ready, setReady] = useState<boolean | null>(null);
  useEffect(() => { void fetch('/health/ready').then(r => setReady(r.ok)).catch(() => setReady(false)); }, []);
  return <main className="shell"><header className="brand"><span className="brand-mark" aria-hidden="true">S</span> SiteGrid</header>
    <section className="card"><p className="eyebrow">FUNDAMENT PLATFORMY</p><h1>Twoje miejsce pracy.</h1>
      <p>SiteGrid uruchomiony. Konfiguracja instalacji pozostaje po stronie serwera.</p>
      <p role="status" className="status">{ready === null ? 'Sprawdzanie połączenia…' : ready ? 'API i baza danych są gotowe.' : 'Baza danych wymaga uwagi operatora.'}</p>
    </section><footer>SiteGrid · samodzielna instalacja</footer></main>;
}
createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
