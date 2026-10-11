import type { PoolClient } from 'pg';
export function parentColumns(alias = 'tasks') {
  return `(SELECT json_build_object('id',c.task_id,'title',c.title) FROM task_parent_contexts c
    WHERE (c.organization_id,c.project_id,c.task_id)=(${alias}.organization_id,${alias}.project_id,${alias}.parent_task_id)) AS parent`;
}
type Progress = { total: number; planned: number; inProgress: number; submitted: number };
export async function withSubtaskProgress<T extends { id: string; parent?: unknown; projectId?: string }>(
  client: PoolClient, tenant: string, tasks: T[], projectId?: string,
) {
  if (!tasks.length || !(await client.query('SELECT can_manage_tasks($1) AS allowed',[tenant])).rows[0].allowed) return tasks;
  const roots = tasks.filter(task => !task.parent).map(task => task.id);
  const rows = (await client.query<Progress & { id: string; projectId: string }>(`SELECT parent_task_id AS id,project_id AS "projectId",count(*)::int AS total,
    count(*) FILTER (WHERE status='planned')::int AS planned,
    count(*) FILTER (WHERE status='in_progress')::int AS "inProgress",
    count(*) FILTER (WHERE status='submitted')::int AS submitted
    FROM tasks WHERE organization_id=$1 AND parent_task_id=ANY($2::uuid[])
      AND ($3::uuid IS NULL OR project_id=$3) GROUP BY project_id,parent_task_id`,[tenant,roots,projectId ?? null])).rows;
  const progress = new Map(rows.map(({ id,projectId: project,...counts }) => [`${project}/${id}`,counts]));
  return tasks.map(task => task.parent ? task : { ...task,
    subtaskProgress: progress.get(`${(projectId ?? task.projectId)?.toLowerCase()}/${task.id}`) ?? { total:0,planned:0,inProgress:0,submitted:0 } });
}
