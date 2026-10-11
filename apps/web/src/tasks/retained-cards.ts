import { request, type Details, type Task } from '../project-api.js';
import { hasDirtyForms } from '../workspace/navigation-safety.js';
import type { CompanyTask } from './task-workspace.js';

// A changed filter match or page boundary must not destroy an open editor.
// Reauthorize each retained card separately; revoked access always removes it.
export async function retainOpenCards(next: CompanyTask[], previous: CompanyTask[] | null,
  root: HTMLElement | null, base: string, signal: AbortSignal) {
  const retained: CompanyTask[] = [];
  for (const known of previous ?? []) {
    if (next.some(task => task.id === known.id)) continue;
    const card = root?.querySelector<HTMLElement>(`[data-task-id="${known.id}"]`);
    if (!card || (!hasDirtyForms(card) && !card.querySelector('[aria-expanded="true"]'))) continue;
    const path = `${base}/projects/${known.projectId}`;
    try {
      const [data, context] = await Promise.all([
        request<{ task: Task }>(`${path}/tasks/${known.id}`, signal), request<Details>(path, signal),
      ]);
      retained.push({ ...known, ...data.task, projectName: context.project.name,
        projectStatus: context.project.status, retained: true });
    } catch (error) {
      if ((error as { status?: number }).status !== 404) throw error;
    }
  }
  return [...next, ...retained];
}
