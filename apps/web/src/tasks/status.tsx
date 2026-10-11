export type StatusTask = { status: string; assigneeMembershipId?: string | null };
export const statusNames = { backlog: 'Backlog', todo: 'Do zrobienia', in_progress: 'W toku', submitted: 'Do odbioru' };
export function statusKey(task: StatusTask): keyof typeof statusNames {
  return task.status === 'planned' ? task.assigneeMembershipId ? 'todo' : 'backlog' : task.status as keyof typeof statusNames;
}
export function StatusBadge({ task }: { task: StatusTask }) {
  const status = statusKey(task);
  return <span className={`status-badge status-${status}`}>{statusNames[status] ?? task.status}</span>;
}
