import type { FastifyRequest } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import type { Config } from './config.js';
import { readSession } from './auth/session.js';
import { withOrganization, withTransaction } from './organization-context.js';

export type OrganizationRole = 'organization_admin' | 'manager' | 'foreman' | 'worker';
export type OrganizationContext = { id: string; name: string; roles: OrganizationRole[] };

async function authorizeActor(client: PoolClient, request: FastifyRequest, config: Config) {
  const session = await readSession(client, request, config);
  if (!session?.user_id) throw Object.assign(new Error('Authentication required'), { statusCode: 401 });
  await client.query("SELECT set_config('sitegrid.user_id', $1::uuid::text, true)", [session.user_id]);
}

// Only the actor's own active memberships and roles are visible through discovery RLS.
async function availableOrganizations(client: PoolClient, organizationId?: string) {
  const { rows } = await client.query<OrganizationContext>(`
    SELECT o.id, o.name, COALESCE(array_agg(r.role ORDER BY r.role)
      FILTER (WHERE r.role IS NOT NULL), ARRAY[]::text[]) AS roles
    FROM organization_memberships m JOIN organizations o ON o.id = m.organization_id
    LEFT JOIN membership_roles r ON (r.organization_id, r.membership_id) = (m.organization_id, m.id)
    WHERE m.user_id = NULLIF(current_setting('sitegrid.user_id', true), '')::uuid
      AND m.status = 'active' AND o.status = 'active' AND ($1::uuid IS NULL OR o.id = $1)
    GROUP BY o.id, o.name ORDER BY o.name, o.id`, [organizationId ?? null]);
  return rows;
}

export async function listActorOrganizations(pool: Pool, request: FastifyRequest, config: Config) {
  return withTransaction(pool, async client => {
    await authorizeActor(client, request, config);
    return availableOrganizations(client);
  });
}

// requiredRoles comes from server route definitions, never from request data.
// An active member may read the minimal context even if no role has been assigned.
export async function withAuthorizedOrganization<T>(
  pool: Pool, request: FastifyRequest, config: Config, organizationId: string,
  work: (client: PoolClient, context: OrganizationContext) => Promise<T>,
  requiredRoles: readonly OrganizationRole[] = [],
): Promise<T> {
  let context: OrganizationContext;
  return withOrganization(pool, organizationId, client => work(client, context), async client => {
    await authorizeActor(client, request, config);
    const [available] = await availableOrganizations(client, organizationId);
    if (!available || (requiredRoles.length > 0 && !requiredRoles.some(role => available.roles.includes(role)))) {
      throw Object.assign(new Error('Organization access denied'), { statusCode: 403 });
    }
    context = available;
  });
}
