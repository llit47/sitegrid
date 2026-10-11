import type { Section } from './layout.js';
const paths: Record<Section, string> = {
  dashboard: 'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',
  projects: 'M3 7V4h6l2 3h10v13H3z M7 11h10 M7 15h6',
  contractors: 'M3 7h18v13H3z M8 7V3h8v4 M3 12h18 M10 12v3h4v-3',
  members: 'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8 M2 21v-3a7 7 0 0 1 14 0v3 M17 4a4 4 0 0 1 0 8 M19 15a5 5 0 0 1 3 5v1',
  invitations: 'M3 5h18v14H3z M3 5l9 7 9-7',
  settings: 'M9 3h6l1 4 4 1v8l-4 1-1 4H9l-1-4-4-1V8l4-1z M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8',
  platform: 'M12 3l9 4v6c0 5-9 9-9 9s-9-4-9-9V7z M8 12l3 3 5-6',
};
export function NavigationIcon({ section }: { section: Section }) {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[section]} /></svg>;
}
