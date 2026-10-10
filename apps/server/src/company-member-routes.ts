import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import type { Config } from './config.js';
import { readSession, type Session } from './auth/session.js';
import { withAuthorizedOrganization } from './organization-access.js';
import { lockInvitationCompany } from './invitations.js';

const roles = ['organization_admin', 'manager', 'foreman', 'worker'];
const uuid = { type: 'string', pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' };
const failure = (statusCode: number) => Object.assign(new Error('Invalid company member action'), { statusCode });
function fields(request: FastifyRequest, allowed: string[]) {
  const value = request.body as Record<string, unknown>;
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) throw failure(400);
  return value;
}
function text(value: unknown, max: number, required = false) {
  if (typeof value !== 'string' || /\p{Cc}/u.test(value)) throw failure(400);
  const result = value.trim();
  if ([...result].length > max || (required && !result)) throw failure(400);
  return result;
}
const employeeColumns = 'id, membership_id AS "membershipId", display_name AS "displayName", position, phone, status';

export function registerCompanyMemberRoutes(app: FastifyInstance, pool: Pool, config: Config,
  checkCsrf: (request: FastifyRequest, session?: Session) => boolean) {
  type Params = { id: string; membershipId: string; employeeId: string };
  const params = (...names: string[]) => ({ params: { type: 'object', required: ['id', ...names],
    properties: Object.fromEntries(['id', ...names].map(name => [name, uuid])) } });
  const base = '/api/organizations/:id';
  async function administer<T>(request: FastifyRequest<{ Params: Params }>, write: boolean,
    work: (client: PoolClient, actorId: string) => Promise<T>) {
    try {
      return await withAuthorizedOrganization(pool, request, config, request.params.id, async client => {
        const actor = await readSession(client, request, config);
        if (!actor?.user_id) throw failure(401);
        if (write) {
          if (!checkCsrf(request, actor)) throw failure(403);
          await lockInvitationCompany(client, request.params.id);
          // Authorization before the lock may have become stale while waiting.
          const authorized = await client.query(`SELECT m.id FROM organization_memberships m
            JOIN membership_roles r ON (r.organization_id, r.membership_id) = (m.organization_id, m.id)
            JOIN organizations o ON o.id = m.organization_id
            WHERE m.organization_id = $1 AND m.user_id = $2 AND m.status = 'active'
              AND o.status = 'active' AND r.role = 'organization_admin'`, [request.params.id, actor.user_id]);
          if (!await readSession(client, request, config)) throw failure(401);
          if (!authorized.rows[0]) throw failure(403);
        }
        return work(client, actor.user_id);
      }, ['organization_admin']);
    } catch (error) {
      if ((error as { constraint?: string }).constraint === 'company_last_administrator') {
        throw Object.assign(failure(409), { code: 'SG_LAST_ADMIN' });
      }
      if ((error as { code?: string }).code === '23505') throw failure(409);
      throw error;
    }
  }
  const audit = (client: PoolClient, organizationId: string, actorId: string, subjectId: string, event: string, details = {}) =>
    client.query(`INSERT INTO organization_audit_events(organization_id, actor_id, subject_id, event, details)
      VALUES ($1, $2, $3, $4, $5)`, [organizationId, actorId, subjectId, event, details]);
  async function member(client: PoolClient, organizationId: string, membershipId: string) {
    const result = await client.query('SELECT id, status FROM organization_memberships WHERE organization_id = $1 AND id = $2 FOR UPDATE', [organizationId, membershipId]);
    if (!result.rows[0]) throw failure(404);
    return result.rows[0] as { id: string; status: string };
  }
  app.get<{ Params: Params }>(`${base}/members`, { schema: params() }, request => administer(request, false, async client => ({
    members: (await client.query(`SELECT m.id, u.email, m.status,
      ARRAY(SELECT role FROM membership_roles r WHERE (r.organization_id, r.membership_id) = (m.organization_id, m.id) ORDER BY role) AS roles,
      (SELECT row_to_json(profile) FROM (SELECT ${employeeColumns} FROM employee_profiles e
        WHERE (e.organization_id, e.membership_id) = (m.organization_id, m.id)) profile) AS employee
      FROM organization_memberships m JOIN users u ON u.id = m.user_id
      WHERE m.organization_id = $1 ORDER BY m.created_at, m.id`, [request.params.id])).rows,
  })));
  app.get<{ Params: Params }>(`${base}/employees`, { schema: params() }, request => administer(request, false, async client => ({
    employees: (await client.query(`SELECT ${employeeColumns} FROM employee_profiles WHERE organization_id = $1 ORDER BY display_name, id`, [request.params.id])).rows,
  })));
  for (const action of ['assign', 'remove']) {
    app.post<{ Params: Params }>(`${base}/members/:membershipId/roles/${action}`, { schema: params('membershipId') }, request => administer(request, true, async (client, actorId) => {
      const body = fields(request, ['role']);
      if (typeof body.role !== 'string' || !roles.includes(body.role)) throw failure(400);
      await member(client, request.params.id, request.params.membershipId);
      const result = action === 'assign'
        ? await client.query('INSERT INTO membership_roles(organization_id, membership_id, role) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING role', [request.params.id, request.params.membershipId, body.role])
        : await client.query('DELETE FROM membership_roles WHERE organization_id = $1 AND membership_id = $2 AND role = $3 RETURNING role', [request.params.id, request.params.membershipId, body.role]);
      if (result.rowCount && action === 'remove' && body.role === 'organization_admin') {
        await client.query(`UPDATE organization_invitations SET revoked_at = clock_timestamp()
          WHERE organization_id = $1 AND accepted_at IS NULL AND revoked_at IS NULL
            AND issuer_id = (SELECT user_id FROM organization_memberships WHERE organization_id = $1 AND id = $2)`,
        [request.params.id, request.params.membershipId]);
      }
      if (result.rowCount) await audit(client, request.params.id, actorId, request.params.membershipId, action === 'assign' ? 'role_assigned' : 'role_removed', { role: body.role });
      return { ok: true };
    }));
  }
  for (const action of ['deactivate', 'reactivate']) {
    const status = action === 'deactivate' ? 'inactive' : 'active';
    app.post<{ Params: Params }>(`${base}/members/:membershipId/${action}`, { schema: params('membershipId') }, request => administer(request, true, async (client, actorId) => {
      fields(request, []);
      const current = await member(client, request.params.id, request.params.membershipId);
      if (current.status === 'pending') throw failure(409);
      if (current.status !== status) {
        await client.query('UPDATE organization_memberships SET status = $3 WHERE organization_id = $1 AND id = $2', [request.params.id, current.id, status]);
        if (action === 'deactivate') {
          await client.query(`UPDATE organization_invitations SET revoked_at = clock_timestamp()
            WHERE organization_id = $1 AND accepted_at IS NULL AND revoked_at IS NULL
              AND issuer_id = (SELECT user_id FROM organization_memberships WHERE organization_id = $1 AND id = $2)`,
          [request.params.id, current.id]);
        }
        await audit(client, request.params.id, actorId, current.id, action === 'deactivate' ? 'membership_deactivated' : 'membership_reactivated', { before: current.status, after: status });
      }
      return { ok: true };
    }));
  }
  app.post<{ Params: Params }>(`${base}/employees`, { schema: params() }, async (request, reply) => {
    const result = await administer(request, true, async (client, actorId) => {
      const body = fields(request, ['membershipId', 'displayName', 'position', 'phone']);
      const displayName = text(body.displayName, 120, true), position = text(body.position === undefined ? '' : body.position, 120), phone = text(body.phone === undefined ? '' : body.phone, 40);
      let status = 'active';
      if (body.membershipId !== undefined && body.membershipId !== null) {
        if (typeof body.membershipId !== 'string' || !new RegExp(uuid.pattern).test(body.membershipId)) throw failure(400);
        status = (await member(client, request.params.id, body.membershipId)).status;
        if (status === 'pending') throw failure(409);
      }
      const employee = (await client.query(`INSERT INTO employee_profiles(organization_id, membership_id, display_name, position, phone, status)
        VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${employeeColumns}`, [request.params.id, body.membershipId ?? null, displayName, position, phone, status])).rows[0];
      await audit(client, request.params.id, actorId, employee.id, 'employee_created', { membershipId: employee.membershipId });
      return { employee };
    });
    return reply.code(201).send(result);
  });
  app.post<{ Params: Params }>(`${base}/employees/:employeeId/update`, { schema: params('employeeId') }, request => administer(request, true, async (client, actorId) => {
    const body = fields(request, ['displayName', 'position', 'phone']);
    const displayName = text(body.displayName, 120, true), position = text(body.position === undefined ? '' : body.position, 120), phone = text(body.phone === undefined ? '' : body.phone, 40);
    const employee = (await client.query(`UPDATE employee_profiles SET display_name = $3, position = $4, phone = $5
      WHERE organization_id = $1 AND id = $2 RETURNING ${employeeColumns}`, [request.params.id, request.params.employeeId, displayName, position, phone])).rows[0];
    if (!employee) throw failure(404);
    await audit(client, request.params.id, actorId, employee.id, 'employee_updated');
    return { employee };
  }));
  for (const action of ['deactivate', 'reactivate']) {
    const status = action === 'deactivate' ? 'inactive' : 'active';
    app.post<{ Params: Params }>(`${base}/employees/:employeeId/${action}`, { schema: params('employeeId') }, request => administer(request, true, async (client, actorId) => {
      fields(request, []);
      const current = (await client.query(`SELECT ${employeeColumns} FROM employee_profiles WHERE organization_id = $1 AND id = $2 FOR UPDATE`, [request.params.id, request.params.employeeId])).rows[0];
      if (!current) throw failure(404);
      if (current.status !== status) {
        await client.query('UPDATE employee_profiles SET status = $3 WHERE organization_id = $1 AND id = $2', [request.params.id, current.id, status]);
        if (action === 'deactivate' && current.membershipId) {
          await client.query(`UPDATE organization_invitations SET revoked_at = clock_timestamp()
            WHERE organization_id = $1 AND accepted_at IS NULL AND revoked_at IS NULL
              AND issuer_id = (SELECT user_id FROM organization_memberships WHERE organization_id = $1 AND id = $2)`,
          [request.params.id, current.membershipId]);
        }
        await audit(client, request.params.id, actorId, current.id, action === 'deactivate' ? 'employee_deactivated' : 'employee_reactivated', { before: current.status, after: status, membershipId: current.membershipId });
      }
      return { ok: true };
    }));
  }
}
