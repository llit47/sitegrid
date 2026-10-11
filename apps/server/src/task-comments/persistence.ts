import type { PoolClient } from 'pg';
import { failure, type Params } from '../task-management/access.js';
export async function requireTask(client:PoolClient,params:Params) {
  const {id,projectId,taskId}=params;
  if(!(await client.query('SELECT id FROM tasks WHERE (organization_id,project_id,id)=($1,$2,$3)',[id,projectId,taskId])).rows[0]) throw failure(404);
}
export const commentColumns=`c.id,c.text,c.author_membership_id AS "authorMembershipId",c.author_name AS "authorName",c.created_at AS "createdAt",
  COALESCE((SELECT json_agg(json_build_object('id',m.id,'width',m.width,'height',m.height) ORDER BY m.position)
    FROM task_comment_media m WHERE (m.organization_id,m.project_id,m.task_id,m.comment_id)=(c.organization_id,c.project_id,c.task_id,c.id)),'[]'::json) AS photos`;
export async function readComment(client:PoolClient,params:Params,id:string) {
  return (await client.query(`SELECT ${commentColumns} FROM task_comments c WHERE (c.organization_id,c.project_id,c.task_id,c.id)=($1,$2,$3,$4)`,[params.id,params.projectId,params.taskId,id])).rows[0];
}
