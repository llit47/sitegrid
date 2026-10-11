import { observeAccessFailure } from './offline/account.js';
import type { ProjectContractor } from './contractors.js';
export type Project = { id: string; name: string; description: string; status: string; version: number; createdAt: string; updatedAt: string; contractor: ProjectContractor | null };
export type Task = { id: string; title: string; description: string; assigneeMembershipId: string; assigneeName?: string; canProgress?: boolean; status: string; version: number };
export type Member = { membershipId: string; displayName: string; companyStatus: string; accountActive: boolean; status: string | null; version: number };
export type Details = { project: Project; permissions: { administer: boolean; readTasks: boolean; manageTasks: boolean } };
export async function request<T>(path: string, signal: AbortSignal, csrfToken?: string, payload?: unknown): Promise<T> {
  const response = await fetch(path, { credentials: 'same-origin', signal, ...(payload === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken! }, body: JSON.stringify(payload),
  }) });
  const data = await response.json();
  if (!response.ok) { await observeAccessFailure(path, response.status); throw Object.assign(new Error(data.error ?? 'Nie udało się połączyć z serwerem.'), { status: response.status }); }
  return data;
}
export const stateName = (status: string) => status === 'active' ? 'Aktywny' : status === 'archived' ? 'Archiwalny' : 'Zaplanowane';
