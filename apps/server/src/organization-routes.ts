import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import type { Config } from './config.js';
import { listActorOrganizations, withAuthorizedOrganization } from './organization-access.js';

export function registerOrganizationRoutes(app: FastifyInstance, pool: Pool, config: Config) {
  app.get('/api/me/organizations', async request => ({
    organizations: await listActorOrganizations(pool, request, config),
  }));
  app.get<{ Params: { id: string } }>('/api/organizations/:id/context', {
    schema: { params: { type: 'object', required: ['id'], properties: {
      id: { type: 'string', pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' },
    } } },
  }, async request => withAuthorizedOrganization(pool, request, config, request.params.id,
    async (_client, context) => ({ organization: context })));
}
