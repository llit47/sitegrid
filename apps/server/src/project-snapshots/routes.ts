import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import type { Config } from '../config.js';
import { withAuthorizedOrganization } from '../organization-access.js';
import { contractorUuid } from '../contractors/domain.js';
import { serializeSnapshot, SnapshotLimitError } from './serialize.js';
import { MAX_SNAPSHOT_TASKS, OFFLINE_ACCESS_MS, type ProjectSnapshotBody } from './contract.js';

export function registerProjectSnapshotRoutes(app: FastifyInstance, pool: Pool, config: Config) {
  app.get<{ Params: { id: string; projectId: string } }>('/api/organizations/:id/projects/:projectId/snapshot', {
    schema: { params: { type: 'object', required: ['id', 'projectId'], properties: { id: contractorUuid, projectId: contractorUuid } } },
  }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    try { return await withAuthorizedOrganization(pool, request, config, request.params.id, async client => {
      const { id, projectId } = request.params;
      const project = (await client.query(`SELECT id, name, description, status, version, created_at AS "createdAt", updated_at AS "updatedAt",
        (SELECT json_build_object('id', c.id, 'name', c.name, 'status', c.status) FROM contractors c
         WHERE (c.organization_id, c.id) = (projects.organization_id, projects.contractor_id)) AS contractor
        FROM projects WHERE organization_id = $1 AND id = $2`, [id, projectId])).rows[0];
      if (!project) throw Object.assign(new Error('Projekt jest niedostępny.'), { statusCode: 404 });
      await client.query("SELECT set_config('sitegrid.project_id', $1::uuid::text, true)", [projectId]);
      const access = (await client.query(`SELECT current_setting('sitegrid.user_id') AS "accountId",
        transaction_timestamp() AS "generatedAt", can_access_project($1,$2,ARRAY['manager','foreman']) AS full,
        can_access_project($1,$2,ARRAY['worker']) AS own`, [id, projectId])).rows[0];
      const tasks = access.full || access.own ? (await client.query(`SELECT id, title, description, status, version,
        created_at AS "createdAt", updated_at AS "updatedAt",
        (SELECT COALESCE(e.display_name, u.email) FROM organization_memberships m JOIN users u ON u.id = m.user_id
         LEFT JOIN employee_profiles e ON (e.organization_id,e.membership_id) = (m.organization_id,m.id)
         WHERE (m.organization_id,m.id) = (tasks.organization_id,tasks.assignee_membership_id)) AS "assigneeName"
        FROM tasks WHERE organization_id = $1 AND project_id = $2 ORDER BY created_at, id LIMIT $3`, [id, projectId, MAX_SNAPSHOT_TASKS + 1])).rows : [];
      // LIMIT+1 bounds work and detects overflow; the serializer rejects, never truncates.
      const body = JSON.parse(JSON.stringify({ format: 1, complete: true,
        scope: { accountId: access.accountId, organizationId: id.toLowerCase(), projectId: projectId.toLowerCase() },
        generatedAt: access.generatedAt, expiresAt: new Date(access.generatedAt.getTime() + OFFLINE_ACCESS_MS),
        taskAccess: access.full ? 'project' : access.own ? 'own' : 'none', project, tasks })) as ProjectSnapshotBody;
      return serializeSnapshot(body);
    }, [], { isolation: 'repeatable read', readOnly: true }); }
    catch (error) {
      if (error instanceof SnapshotLimitError) return reply.code(413).send({ error: error.message, code: 'snapshot_limit' });
      throw error;
    }
  });
}
