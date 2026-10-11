import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import type { Config } from '../config.js';
import type { Session } from '../auth/session.js';
import { writeOrganizationAudit as audit } from '../common/audit.js';
import { projectAccess, fields, text, version, failure, taskColumns, identifier, type Params } from './access.js';

export function registerProjectTaskRoutes(app: FastifyInstance, pool: Pool, config: Config,
  checkCsrf: (request: FastifyRequest, session?: Session) => boolean) {
  const base = '/api/organizations/:id/projects';
  const { params, scope, project, writable, eligible, conflict } = projectAccess(pool, config, checkCsrf);
  app.get<{ Params: Params }>(`${base}/:projectId/tasks`, { schema: params('projectId') }, request => scope(request, false, false, async client => {
    await project(client, request, ['manager', 'foreman', 'worker']);
    return { tasks: (await client.query(`SELECT ${taskColumns},
      (SELECT COALESCE(e.display_name, u.email) FROM organization_memberships m JOIN users u ON u.id = m.user_id
        LEFT JOIN employee_profiles e ON (e.organization_id, e.membership_id) = (m.organization_id, m.id)
        WHERE (m.organization_id, m.id) = (tasks.organization_id, tasks.assignee_membership_id)) AS "assigneeName"
      FROM tasks WHERE organization_id = $1 AND project_id = $2 ORDER BY created_at DESC, id`, [request.params.id, request.params.projectId])).rows };
  }));
  app.get<{ Params: Params }>(`${base}/:projectId/tasks/:taskId`, { schema: params('projectId', 'taskId') }, request => scope(request, false, false, async client => {
    await project(client, request, ['manager', 'foreman', 'worker']);
    const task = (await client.query(`SELECT ${taskColumns} FROM tasks WHERE organization_id = $1 AND project_id = $2 AND id = $3`,
    [request.params.id, request.params.projectId, request.params.taskId])).rows[0];
    if (!task) throw failure(404);
    return { task };
  }));
  for (const edit of [false, true]) {
    app.post<{ Params: Params }>(edit ? `${base}/:projectId/tasks/:taskId/update` : `${base}/:projectId/tasks`,
      { schema: params('projectId', ...(edit ? ['taskId'] : [])) }, async (request, reply) => {
        const result = await scope(request, true, false, async (client, actor) => {
          const currentProject = await project(client, request, ['organization_admin', 'manager', 'foreman']); writable(currentProject);
          const body = fields(request, ['title', 'description', 'assigneeMembershipId', ...(edit ? ['expectedVersion'] : [])]);
          const title = text(body.title, 200, true), description = text(body.description === undefined ? '' : body.description, 4000);
          const suppliedAssignee = body.assigneeMembershipId == null ? null : identifier(body.assigneeMembershipId);
          const expected = edit ? version(body.expectedVersion) : 0;
          const { id, projectId, taskId } = request.params;
          const current = edit ? (await client.query(`SELECT ${taskColumns} FROM tasks WHERE organization_id = $1 AND project_id = $2 AND id = $3`, [id, projectId, taskId])).rows[0] : undefined;
          if (edit && !current) throw failure(404);
          const assignee = edit && body.assigneeMembershipId === undefined ? current.assigneeMembershipId : suppliedAssignee;
          if (edit && current.version !== expected) return { stale: current };
          if (edit && current.assigneeMembershipId !== assignee && current.status !== 'planned') return { assignmentConflict: current };
          if (assignee !== null) await eligible(client, id, projectId, assignee, false);
          const task = edit
            ? (await client.query(`UPDATE tasks SET title = $4, description = $5, assignee_membership_id = $6, version = version + 1
              WHERE organization_id = $1 AND project_id = $2 AND id = $3 AND version = $7 RETURNING ${taskColumns}`, [id, projectId, taskId, title, description, assignee, expected])).rows[0]
            : (await client.query(`INSERT INTO tasks(organization_id, project_id, title, description, assignee_membership_id, author_membership_id)
              VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${taskColumns}`, [id, projectId, title, description, assignee, actor.membershipId])).rows[0];
          if (!task) throw failure(409);
          await audit(client, id, actor.userId, task.id, edit ? 'task_updated' : 'task_created',
            { projectId, beforeVersion: expected, afterVersion: task.version, beforeAssignee: current?.assigneeMembershipId ?? null, afterAssignee: assignee });
          return { task };
        });
        if ('stale' in result) return conflict(reply, 'task', result.stale);
        if ('assignmentConflict' in result) return reply.code(409).send({ code: 'TASK_ASSIGNMENT_LOCKED', error: 'Nie można zmienić wykonawcy rozpoczętego lub zgłoszonego zadania.', task: result.assignmentConflict });
        return reply.code(edit ? 200 : 201).send(result);
      });
  }
}
