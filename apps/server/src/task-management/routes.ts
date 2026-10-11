import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import type { Config } from '../config.js';
import type { Session } from '../auth/session.js';
import { writeOrganizationAudit } from '../common/audit.js';
import { projectAccess, fields, identifier, version, failure, uuid, text, taskColumns, type Params } from './access.js';

type Filters = { view?: string; projectId?: string; assigneeMembershipId?: string; q?: string; offset?: number; limit?: number; projectStatus?: string };
export function registerCompanyTaskRoutes(app: FastifyInstance, pool: Pool, config: Config,
  checkCsrf: (request: FastifyRequest, session?: Session) => boolean) {
  const { params, scope, project, writable, eligible, conflict } = projectAccess(pool, config, checkCsrf);
  const base = '/api/organizations/:id';
  app.get<{ Params: Params; Querystring: Filters }>(`${base}/tasks`, { schema: { ...params(), querystring: {
    type: 'object', additionalProperties: false, properties: {
      view: { type: 'string', enum: ['all', 'mine', 'backlog', 'todo', 'in_progress', 'submitted'] },
      projectId: uuid,
      assigneeMembershipId: uuid,
      q: { type: 'string', maxLength: 200 }, offset: { type: 'integer', minimum: 0, maximum: 1000000 },
      limit: { type: 'integer', minimum: 1, maximum: 100 }, projectStatus: { type: 'string', enum: ['active','archived','all'] },
    },
  } } }, request => scope(request, false, false, async (client, actor) => {
    const manage = (await client.query('SELECT can_manage_tasks($1) AS allowed', [request.params.id])).rows[0].allowed;
    if (!manage && !actor.roles.includes('worker')) throw failure(403);
    const f = request.query, limit = f.limit ?? 100, offset = f.offset ?? 0;
    if (!manage && ((f.view && !['all','mine','todo','in_progress','submitted'].includes(f.view))
      || (f.assigneeMembershipId && f.assigneeMembershipId.toLowerCase() !== actor.membershipId))) throw failure(403);
    const projectId = f.projectId ? identifier(f.projectId) : null;
    const assignee = f.assigneeMembershipId ? identifier(f.assigneeMembershipId) : null;
    const rows = (await client.query(`SELECT t.id, t.project_id AS "projectId", p.name AS "projectName", p.status AS "projectStatus",
      t.title, t.description, t.assignee_membership_id AS "assigneeMembershipId", t.status, t.version,
      t.created_at AS "createdAt", t.updated_at AS "updatedAt",
      (t.assignee_membership_id = $2::uuid AND $3::boolean) AS "canProgress",
      (SELECT COALESCE(e.display_name,u.email) FROM organization_memberships m JOIN users u ON u.id=m.user_id
        LEFT JOIN employee_profiles e ON (e.organization_id,e.membership_id)=(m.organization_id,m.id)
        WHERE (m.organization_id,m.id)=(t.organization_id,t.assignee_membership_id)) AS "assigneeName"
      FROM tasks t JOIN projects p ON (p.organization_id,p.id)=(t.organization_id,t.project_id)
      WHERE t.organization_id=$1 AND ($4::uuid IS NULL OR t.project_id=$4)
        AND ($5::uuid IS NULL OR t.assignee_membership_id=$5)
        AND ($6='all' OR ($6='mine' AND t.assignee_membership_id=$2)
          OR ($6='backlog' AND t.status='planned' AND t.assignee_membership_id IS NULL)
          OR ($6='todo' AND t.status='planned' AND t.assignee_membership_id IS NOT NULL) OR t.status=$6)
        AND ($7='all' OR p.status=$7) AND strpos(lower(t.title),lower($8))>0
      ORDER BY t.created_at DESC,t.id LIMIT $9 OFFSET $10`, [request.params.id, actor.membershipId,
      actor.roles.some(role => ['worker','foreman','manager'].includes(role)), projectId, assignee,
      f.view ?? (manage ? 'all' : 'mine'), f.projectStatus ?? 'active', text(f.q ?? '',200), limit + 1, offset])).rows;
    return { tasks: rows.slice(0,limit), hasMore: rows.length > limit, permissions: { manageTasks: manage }, membershipId: actor.membershipId };
  }));
  app.get<{ Params: Params }>(`${base}/task-assignees`, { schema: params() }, request => scope(request, false, false, async client => {
    if (!(await client.query('SELECT can_manage_tasks($1) AS allowed',[request.params.id])).rows[0].allowed) throw failure(403);
    return { assignees: (await client.query(`SELECT m.id AS "membershipId", COALESCE(e.display_name,u.email) AS "displayName"
      FROM organization_memberships m JOIN users u ON u.id=m.user_id
      LEFT JOIN employee_profiles e ON (e.organization_id,e.membership_id)=(m.organization_id,m.id)
      WHERE m.organization_id=$1 AND can_manage_tasks(m.organization_id) AND m.status='active' AND u.blocked_at IS NULL
      ORDER BY COALESCE(e.display_name,u.email),m.id`,[request.params.id])).rows };
  }));
  app.post<{ Params: Params }>(`${base}/projects/:projectId/tasks/:taskId/assign`, { schema: params('projectId','taskId') }, async (request, reply) => {
    const result = await scope(request, true, false, async (client, actor) => {
      writable(await project(client, request, ['organization_admin','manager','foreman']));
      const body = fields(request, ['assigneeMembershipId','expectedVersion']);
      const assignee = body.assigneeMembershipId === null ? null : identifier(body.assigneeMembershipId);
      const expected = version(body.expectedVersion), { id,projectId,taskId } = request.params;
      const current = (await client.query(`SELECT ${taskColumns} FROM tasks WHERE (organization_id,project_id,id)=($1,$2,$3)`,[id,projectId,taskId])).rows[0];
      if (!current) throw failure(404);
      if (current.version !== expected) return { stale: current };
      if (current.assigneeMembershipId !== assignee && current.status !== 'planned') return { locked: current };
      if (assignee !== null) await eligible(client,id,projectId,assignee,false);
      if (current.assigneeMembershipId === assignee) return { task: current };
      const task = (await client.query(`UPDATE tasks SET assignee_membership_id=$4,version=version+1
        WHERE (organization_id,project_id,id)=($1,$2,$3) AND version=$5 RETURNING ${taskColumns}`,[id,projectId,taskId,assignee,expected])).rows[0];
      if (!task) throw failure(409);
      await writeOrganizationAudit(client,id,actor.userId,taskId,'task_updated', { projectId, beforeVersion: expected,
        afterVersion: task.version, beforeAssignee: current.assigneeMembershipId, afterAssignee: assignee });
      return { task };
    });
    if ('stale' in result) return conflict(reply,'task',result.stale);
    if ('locked' in result) return reply.code(409).send({ code: 'TASK_ASSIGNMENT_LOCKED', error: 'Nie można zmienić wykonawcy rozpoczętego lub zgłoszonego zadania.', task: result.locked });
    return result;
  });
}
