import { lockOrganization } from '../common/organization-lock.js';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import type { Config } from '../config.js';
import { readSession, type Session } from '../auth/session.js';
import { withAuthorizedOrganization } from '../organization-access.js';

export const uuidPattern = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
export const uuid = { type: 'string', pattern: uuidPattern.source };
export const failure = (statusCode: number) => Object.assign(new Error('Invalid project action'), { statusCode });
export const projectColumns = `id, name, description, status, version, created_at AS "createdAt", updated_at AS "updatedAt",
  (SELECT json_build_object('id', c.id, 'name', c.name, 'status', c.status) FROM contractors c
    WHERE (c.organization_id, c.id) = (projects.organization_id, projects.contractor_id)) AS contractor`;
export const taskColumns = 'id, title, description, assignee_membership_id AS "assigneeMembershipId", author_membership_id AS "authorMembershipId", status, version, created_at AS "createdAt", updated_at AS "updatedAt", can_progress_assignment(organization_id, project_id, assignee_membership_id) AS "canProgress"';
export type Params = { id: string; projectId: string; membershipId: string; taskId: string };
export type Project = { id: string; name: string; description: string; status: string; version: number; contractor: { id: string; name: string; status: string } | null };
export function fields(request: FastifyRequest, allowed: string[]) {
  const body = request.body as Record<string, unknown>;
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !allowed.includes(key))) throw failure(400);
  return body;
}
export function text(value: unknown, max: number, required = false) {
  if (typeof value !== 'string' || /\p{Cc}/u.test(value)) throw failure(400);
  const result = value.trim();
  if ([...result].length > max || (required && !result)) throw failure(400);
  return result;
}
export function version(value: unknown, allowZero = false) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < (allowZero ? 0 : 1) || value >= 2147483647) throw failure(400);
  return value;
}
export function identifier(value: unknown) {
  if (typeof value !== 'string' || !uuidPattern.test(value)) throw failure(400);
  return value.toLowerCase();
}

export function projectAccess(pool: Pool, config: Config, checkCsrf: (request: FastifyRequest, session?: Session) => boolean) {
  const params = (...names: string[]) => ({ params: { type: 'object', required: ['id', ...names],
    properties: Object.fromEntries(['id', ...names].map(name => [name, uuid])) } });
  async function scope<T>(request: FastifyRequest<{ Params: Params }>, write: boolean, admin: boolean,
    work: (client: PoolClient, actor: { userId: string; membershipId: string; roles: string[] }) => Promise<T>) {
    return withAuthorizedOrganization(pool, request, config, request.params.id, async client => {
      if (write) {
        const session = await readSession(client, request, config);
        if (!checkCsrf(request, session)) throw failure(403);
        await lockOrganization(client, request.params.id);
      }
      // Fresh checks after lock acquisition also cover revocations while waiting.
      const session = await readSession(client, request, config);
      if (!session?.user_id) throw failure(401);
      if (write && !checkCsrf(request, session)) throw failure(403);
      const member = (await client.query(`SELECT m.id, ARRAY(SELECT role FROM membership_roles r
        WHERE (r.organization_id, r.membership_id) = (m.organization_id, m.id)) AS roles
        FROM organization_memberships m JOIN organizations o ON o.id = m.organization_id
        WHERE m.organization_id = $1 AND m.user_id = $2 AND m.status = 'active' AND o.status = 'active'`,
      [request.params.id, session.user_id])).rows[0];
      if (!member || (admin && !member.roles.includes('organization_admin'))) throw failure(403);
      return work(client, { userId: session.user_id, membershipId: member.id, roles: member.roles });
    }, admin ? ['organization_admin'] : []);
  }
  async function project(client: PoolClient, request: FastifyRequest<{ Params: Params }>, requiredRoles?: string[]) {
    const { id, projectId } = request.params;
    // Administrative metadata and business access are deliberately separate.
    if (requiredRoles && !(await client.query('SELECT can_access_project($1, $2, $3::text[]) AS allowed', [id, projectId, requiredRoles])).rows[0].allowed) throw failure(404);
    const current = (await client.query(`SELECT ${projectColumns} FROM projects WHERE organization_id = $1 AND id = $2`, [id, projectId])).rows[0] as Project | undefined;
    if (!current) throw failure(404);
    await client.query("SELECT set_config('sitegrid.project_id', $1::uuid::text, true)", [projectId]);
    return current;
  }
  function writable(current: Project) { if (current.status !== 'active') throw failure(409); }
  async function eligible(client: PoolClient, tenant: string, projectId: string, memberId: string, projectRequired: boolean) {
    const result = await client.query(`SELECT m.id FROM organization_memberships m JOIN users u ON u.id = m.user_id
      WHERE m.organization_id = $1 AND m.id = $2 AND m.status = 'active' AND u.blocked_at IS NULL
        AND (NOT $4::boolean OR EXISTS (SELECT 1 FROM project_memberships pm
          WHERE (pm.organization_id, pm.project_id, pm.membership_id) = ($1, $3, m.id) AND pm.status = 'active'))`,
    [tenant, memberId, projectId, projectRequired]);
    if (!result.rows[0]) throw failure(400);
  }
  const conflict = (reply: FastifyReply, resource: string, current: unknown) => reply.code(409).send({ error: 'Rekord zmienił się. Odśwież dane przed ponownym zapisem.', [resource]: current });

  return { params, scope, project, writable, eligible, conflict };
}
