import { CompanyLogo, type Branding } from '../company-branding.js';
import type { Project } from '../projects.js';
import type { Section } from './layout.js';

export function Dashboard({ branding, projects, admin, navigate }: { branding: Branding; projects: Project[] | null; admin: boolean; navigate: (section: Section) => void }) {
  return <div className="workspace-dashboard">
    <article className="workspace-welcome"><div className="workspace-company-brand"><CompanyLogo key={`${branding.organizationId}-${branding.logo?.version ?? 0}`} branding={branding} /><div><p className="eyebrow">TWOJA FIRMA</p><h2>{branding.name}</h2></div></div>
      <p>Zaplanuj pracę i sprawdź postęp w projektach, do których masz dostęp.</p>
      <button onClick={() => navigate('projects')}>Otwórz projekty <span aria-hidden="true">→</span></button></article>
    <div className="workspace-summary"><article className="tile"><h2>Dostępne projekty</h2>
      {projects ? <><strong className="workspace-metric">{projects.length}</strong><p>{projects.filter(project => project.status === 'active').length} aktywnych · {projects.filter(project => project.status === 'archived').length} archiwalnych</p></> : <p>Listę i aktualny zakres dostępu sprawdzisz w projektach.</p>}
      <p className="hint">Tylko projekty widoczne dla Twojego konta w tej firmie.</p></article>
      <article className="tile"><h2>{admin ? 'Przygotuj zespół do pracy' : 'Twoje zadania w projekcie'}</h2><p>{admin ? 'Zaproś użytkowników, nadaj role, a następnie przydziel członków do projektów.' : 'Otwórz projekt, aby zobaczyć zadania w swoim zakresie. Dostęp wymaga aktywnego przydziału.'}</p>
        <button className="secondary" onClick={() => navigate(admin ? 'invitations' : 'projects')}>{admin ? 'Zaproś do firmy' : 'Przejdź do projektów'}</button></article></div>
    {projects?.length === 0 && <article className="workspace-empty"><h2>Jeszcze bez projektów</h2><p>{admin ? 'Utwórz pierwszy projekt w sekcji Projekty. Kontrahenta możesz powiązać później.' : 'Poproś administratora firmy o aktywny przydział do projektu i odpowiednią rolę.'}</p><button className="secondary" onClick={() => navigate('projects')}>{admin ? 'Przygotuj pierwszy projekt' : 'Sprawdź dostęp do projektów'}</button></article>}
  </div>;
}
