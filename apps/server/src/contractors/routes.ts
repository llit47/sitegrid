import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import type { Config } from '../config.js';
import { readSession, type Session } from '../auth/session.js';
import { withAuthorizedOrganization } from '../organization-access.js';
import { lockOrganization } from '../common/organization-lock.js';
import { writeOrganizationAudit } from '../common/audit.js';
import { contractorUuid, contractorInput, contractorFailure } from './domain.js';
import { createContractor, listContractors, readContractor, updateContractor } from './persistence.js';

type Params = { id: string; contractorId: string };
export function registerContractorRoutes(app: FastifyInstance, pool: Pool, config: Config,
  checkCsrf: (request: FastifyRequest, session?: Session) => boolean) {
  const base = '/api/organizations/:id/contractors';
  const schema = (detail = false) => ({ params: { type: 'object', required: detail ? ['id', 'contractorId'] : ['id'],
    properties: { id: contractorUuid, ...(detail ? { contractorId: contractorUuid } : {}) } } });
  const scope = <T>(request: FastifyRequest<{ Params: Params }>, write: boolean, work: (client: PoolClient, actorId: string) => Promise<T>) =>
    withAuthorizedOrganization(pool, request, config, request.params.id, async client => {
      if (write) {
        if (!checkCsrf(request, await readSession(client, request, config))) throw contractorFailure(403);
        await lockOrganization(client, request.params.id);
      }
      const actor = await readSession(client, request, config);
      if (!actor?.user_id) throw contractorFailure(401);
      if (write && !checkCsrf(request, actor)) throw contractorFailure(403);
      if (!(await client.query('SELECT can_access_organization_branding($1, true) AS allowed', [request.params.id])).rows[0].allowed) throw contractorFailure(403);
      return work(client, actor.user_id);
    }, ['organization_admin']);

  app.get<{ Params: Params }>(base, { schema: schema() }, request => scope(request, false, async client => ({ contractors: await listContractors(client, request.params.id) })));
  app.post<{ Params: Params }>(base, { schema: schema() }, async (request, reply) => {
    const result = await scope(request, true, async (client, actorId) => {
      const input = contractorInput(request.body);
      const contractor = await createContractor(client, request.params.id, input.name);
      await writeOrganizationAudit(client, request.params.id, actorId, contractor.id, 'contractor_created', { beforeVersion: 0, afterVersion: contractor.version });
      return { contractor };
    });
    return reply.code(201).send(result);
  });
  app.post<{ Params: Params }>(`${base}/:contractorId/update`, { schema: schema(true) }, async (request, reply) => {
    const result = await scope(request, true, async (client, actorId) => {
      const input = contractorInput(request.body, true);
      const current = await readContractor(client, request.params.id, request.params.contractorId);
      if (current.version !== input.expectedVersion) return { stale: current };
      const contractor = await updateContractor(client, request.params.id, current.id, input.name, input.status, input.expectedVersion);
      const event = current.status === contractor.status ? 'contractor_updated' : contractor.status === 'active' ? 'contractor_reactivated' : 'contractor_deactivated';
      await writeOrganizationAudit(client, request.params.id, actorId, current.id, event,
        { beforeVersion: current.version, afterVersion: contractor.version, beforeStatus: current.status, afterStatus: contractor.status });
      return { contractor };
    });
    return 'stale' in result ? reply.code(409).send({ error: 'Rekord zmienił się. Odśwież dane przed ponownym zapisem.', contractor: result.stale }) : result;
  });
}
