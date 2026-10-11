import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import type { Config } from '../config.js';
import type { Session } from '../auth/session.js';
import { projectAccess, fields, text, identifier, failure, taskColumns, type Params } from '../task-management/access.js';
import { writeOrganizationAudit } from '../common/audit.js';

export function registerSubtaskRoutes(app: FastifyInstance, pool: Pool, config: Config,
  checkCsrf: (request: FastifyRequest, session?: Session) => boolean) {
  const { params,scope,project,writable,eligible } = projectAccess(pool,config,checkCsrf);
  const base='/api/organizations/:id/projects/:projectId/tasks/:taskId';
  app.get<{ Params: Params }>(`${base}/subtasks`,{schema:params('projectId','taskId')},request=>scope(request,false,false,async client=>{
    await project(client,request,['organization_admin','manager','foreman']);
    const { id,projectId,taskId }=request.params;
    const root=(await client.query('SELECT id FROM tasks WHERE (organization_id,project_id,id)=($1,$2,$3) AND parent_task_id IS NULL',[id,projectId,taskId])).rows[0];
    if(!root) throw failure(404);
    return { tasks:(await client.query(`SELECT ${taskColumns},
      (SELECT COALESCE(e.display_name,u.email) FROM organization_memberships m JOIN users u ON u.id=m.user_id
        LEFT JOIN employee_profiles e ON (e.organization_id,e.membership_id)=(m.organization_id,m.id)
        WHERE (m.organization_id,m.id)=(tasks.organization_id,tasks.assignee_membership_id)) AS "assigneeName"
      FROM tasks WHERE (organization_id,project_id,parent_task_id)=($1,$2,$3) ORDER BY created_at,id`,[id,projectId,taskId])).rows };
  }));
  app.post<{ Params: Params }>(`${base}/subtasks`,{schema:params('projectId','taskId')},async(request,reply)=>{
    const result=await scope(request,true,false,async(client,actor)=>{
      writable(await project(client,request,['organization_admin','manager','foreman']));
      const { id,projectId,taskId }=request.params;
      const parent=(await client.query('SELECT id,parent_task_id FROM tasks WHERE (organization_id,project_id,id)=($1,$2,$3)',[id,projectId,taskId])).rows[0];
      if(!parent) throw failure(404);
      if(parent.parent_task_id) return { depthLimit: true };
      const body=fields(request,['title','description','assigneeMembershipId']);
      const title=text(body.title,200,true), description=text(body.description ?? '',4000);
      const assignee=body.assigneeMembershipId==null?null:identifier(body.assigneeMembershipId);
      if(assignee) await eligible(client,id,projectId,assignee,false);
      const task=(await client.query(`INSERT INTO tasks(organization_id,project_id,parent_task_id,title,description,assignee_membership_id,author_membership_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING ${taskColumns}`,[id,projectId,taskId,title,description,assignee,actor.membershipId])).rows[0];
      await writeOrganizationAudit(client,id,actor.userId,task.id,'task_created',{projectId,parentTaskId:taskId,beforeVersion:0,afterVersion:1,afterAssignee:assignee});
      return {task};
    });
    if ('depthLimit' in result) return reply.code(409).send({code:'SUBTASK_DEPTH_LIMIT',error:'Podzadanie nie może zawierać podzadań.'});
    return reply.code(201).send(result);
  });
  app.get<{ Params: Params }>(`${base}/progress-history`,{schema:params('projectId','taskId')},request=>scope(request,false,false,async client=>{
    await project(client,request,['organization_admin','manager','foreman','worker']);
    const {id,projectId,taskId}=request.params;
    if(!(await client.query('SELECT id FROM tasks WHERE (organization_id,project_id,id)=($1,$2,$3)',[id,projectId,taskId])).rows[0]) throw failure(404);
    return { history:(await client.query(`SELECT event,created_at AS "createdAt",details->>'afterStatus' AS status,
      (details->>'afterVersion')::int AS version FROM organization_audit_events
      WHERE organization_id=$1 AND subject_id=$2 AND lower(details->>'projectId')=$3::uuid::text AND event IN ('task_started','task_submitted') ORDER BY created_at,id`,[id,taskId,projectId])).rows };
  }));
}
