import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import type { Config } from '../config.js';
import { readSession, type Session } from '../auth/session.js';
import { withAuthorizedOrganization } from '../organization-access.js';
import { lockOrganization } from '../common/organization-lock.js';
import { parseCommand, uuidPattern } from './domain.js';
import { executeProgress } from './service.js';

type Params = { id: string; projectId: string; taskId: string };
const failure = (statusCode: number) => Object.assign(new Error('Progress access denied'), { statusCode });
export function registerTaskProgressRoutes(app: FastifyInstance, pool: Pool, config: Config,
  checkCsrf: (request: FastifyRequest, session?: Session) => boolean) {
  app.post<{ Params: Params }>('/api/organizations/:id/projects/:projectId/tasks/:taskId/commands', {
    schema: { params: { type: 'object', required: ['id', 'projectId', 'taskId'],
      properties: Object.fromEntries(['id', 'projectId', 'taskId'].map(name => [name, { type: 'string', pattern: uuidPattern.source }])) } },
  }, async (request, reply) => {
    try {
      const result = await withAuthorizedOrganization(pool, request, config, request.params.id, async client => {
        const before = await readSession(client, request, config);
        if (!checkCsrf(request, before)) throw failure(403);
        await lockOrganization(client, request.params.id);
        const session = await readSession(client, request, config);
        if (!session?.user_id) throw failure(401);
        if (!checkCsrf(request, session)) throw failure(403);
        // Fresh statement snapshots after waiting: roles, membership and company state.
        const member = await client.query(`SELECT m.id FROM organization_memberships m JOIN organizations o ON o.id = m.organization_id
          WHERE m.organization_id = $1 AND m.user_id = $2 AND m.status = 'active' AND o.status = 'active'`, [request.params.id, session.user_id]);
        if (!member.rows[0]) throw failure(403);
        const allowed = await client.query("SELECT can_access_project($1, $2, ARRAY['manager', 'foreman', 'worker']) AS allowed", [request.params.id, request.params.projectId]);
        if (!allowed.rows[0].allowed) throw failure(404);
        await client.query("SELECT set_config('sitegrid.project_id', $1::uuid::text, true)", [request.params.projectId]);
        return executeProgress(client, { organizationId: request.params.id, projectId: request.params.projectId,
          taskId: request.params.taskId, actorId: session.user_id }, parseCommand(request.body));
      });
      // withAuthorizedOrganization returns only after COMMIT. No success before commit.
      return reply.code(result.status).send(result.body);
    } catch (error) {
      const failure = error as { code?: string; constraint?: string };
      // A receipt in another authorized scope may be hidden by RLS. The global
      // actor/tenant operation key still rejects reuse and rolls back all writes.
      if (failure.code === '23505' && failure.constraint === 'task_progress_receipts_pkey') {
        return reply.code(409).send({ code: 'OPERATION_ID_REUSED', error: 'Identyfikator operacji został użyty z inną treścią.' });
      }
      if (failure.code === 'UNSUPPORTED_COMMAND_SCHEMA') {
        return reply.code(400).send({ code: failure.code, error: 'Nieobsługiwana wersja komendy. Zaktualizuj aplikację.' });
      }
      throw error;
    }
  });
}
