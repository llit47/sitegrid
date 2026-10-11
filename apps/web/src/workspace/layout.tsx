import { useEffect, useRef, useState, type ReactNode } from 'react';
import './workspace.css';
import { NavigationIcon } from './navigation-icon.js';

export type Section = 'dashboard' | 'projects' | 'contractors' | 'members' | 'invitations' | 'settings' | 'platform';
export const sectionNames: Record<Section, string> = {
  dashboard: 'Pulpit', projects: 'Projekty', contractors: 'Kontrahenci', members: 'Pracownicy',
  invitations: 'Zaproszenia', settings: 'Ustawienia firmy', platform: 'Administracja platformy',
};
export function WorkspaceLayout({ active, navigate, sections, company, identity, email, busy, onLogout, children }: {
  active: Section; navigate: (section: Section) => void; sections: Section[]; company: ReactNode; identity: ReactNode;
  email: string; busy: boolean; onLogout: () => void; children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const toggle = useRef<HTMLButtonElement>(null), heading = useRef<HTMLHeadingElement>(null);
  const previous = useRef(active);
  useEffect(() => {
    if (previous.current !== active) { heading.current?.focus(); previous.current = active; }
  }, [active]);
  return <div className="workspace">
    <a className="skip-link" href="#workspace-content">Przejdź do treści</a>
    <aside className={`workspace-sidebar${open ? ' is-open' : ''}`} onKeyDown={event => {
      if (open && event.key === 'Escape') { setOpen(false); toggle.current?.focus(); }
    }}>
      <div className="workspace-sidebar-heading"><span className="eyebrow">MIEJSCE PRACY</span>
        <button className="secondary mobile-only" onClick={() => { setOpen(false); toggle.current?.focus(); }} aria-label="Zamknij nawigację">×</button></div>
      <div className="company-switcher">{company}</div>
      <nav id="workspace-navigation" aria-label="Nawigacja główna">
        {sections.map(section => <button key={section} className={`workspace-nav-item${section === 'platform' ? ' platform-link' : ''}`}
          aria-current={active === section ? 'page' : undefined} onClick={() => { navigate(section); setOpen(false); }}>
          <NavigationIcon section={section} />{sectionNames[section]}</button>)}
      </nav>
      <p className="workspace-sidebar-note">Projekty, zespół i bieżąca praca w jednym miejscu.</p>
    </aside>
    <div className="workspace-body">
      <header className="workspace-header"><button ref={toggle} className="secondary mobile-only" aria-label="Otwórz nawigację" aria-expanded={open} aria-controls="workspace-navigation" onClick={() => setOpen(value => !value)}>☰</button>
        <div className="workspace-identity">{identity}</div><div className="workspace-account"><span className="account">{email}</span><button className="secondary" disabled={busy} onClick={onLogout}>Wyloguj się</button></div>
      </header>
      <main id="workspace-content" className="workspace-content"><div className="workspace-page-heading"><p className="eyebrow">SITEGRID / {active === 'platform' ? 'PLATFORMA' : 'FIRMA'}</p><h1 ref={heading} tabIndex={-1}>{sectionNames[active]}</h1></div>{children}</main>
    </div>
  </div>;
}
