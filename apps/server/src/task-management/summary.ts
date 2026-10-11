import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import type { Config } from '../config.js';
import type { Session } from '../auth/session.js';
import { projectAccess, failure, type Params } from './access.js';

export function registerTaskSummary(app: FastifyInstance, pool: Pool, config: Config,
  checkCsrf: (request: FastifyRequest, session?: Session) => boolean) {
  const { params, scope } = projectAccess(pool, config, checkCsrf);
  app.get<{ Params: Params }>('/api/organizations/:id/task-summary', { schema: params() }, request =>
    scope(request, false, false, async (client, actor) => {
      const manage = (await client.query('SELECT can_manage_tasks($1) AS allowed', [request.params.id])).rows[0].allowed;
      if (!manage && !actor.roles.includes('worker')) throw failure(403);
      // Aggregates and the attention list use the same RLS-filtered snapshot.
      const result = await client.query(`WITH authorized AS MATERIALIZED (
        SELECT t.*, p.name AS project_name FROM tasks t JOIN projects p
          ON (p.organization_id,p.id)=(t.organization_id,t.project_id)
        WHERE t.organization_id=$1 AND p.status='active'
      ), attention AS (
        SELECT id, title, project_id AS "projectId", project_name AS "projectName", status,
          assignee_membership_id AS "assigneeMembershipId" FROM authorized
        WHERE ($2::boolean AND (status='submitted' OR assignee_membership_id IS NULL))
          OR (NOT $2::boolean AND status IN ('planned','in_progress'))
        ORDER BY (status='submitted') DESC, created_at, id LIMIT 8
      ) SELECT count(*)::integer AS total,
        count(*) FILTER (WHERE status='planned' AND assignee_membership_id IS NULL)::integer AS backlog,
        count(*) FILTER (WHERE status='planned' AND assignee_membership_id IS NOT NULL)::integer AS todo,
        count(*) FILTER (WHERE status='in_progress')::integer AS in_progress,
        count(*) FILTER (WHERE status='submitted')::integer AS submitted,
        COALESCE((SELECT json_agg(attention) FROM attention),'[]'::json) AS attention FROM authorized`,
      [request.params.id, manage]);
      return { ...result.rows[0], scope: manage ? 'company' : 'mine' };
    }));
}
