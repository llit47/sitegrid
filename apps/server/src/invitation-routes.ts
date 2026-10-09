import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import type { Config } from './config.js';
import { readSession, type Session } from './auth/session.js';
import { hashPassword, normalizeEmail, validatePassword } from './auth/password.js';
import { withAuthorizedOrganization, type OrganizationRole } from './organization-access.js';
import { withOrganization, withTransaction } from './organization-context.js';
import { createInvitation, deliverInvitation, invitationColumns, invitationError, invitationHash,
  lockInvitationCompany, requireFirstAdministrator, requireInvitationDelivery } from './invitations.js';

const roles: OrganizationRole[] = ['organization_admin', 'manager', 'foreman', 'worker'];
const uuid = { type: 'string', pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' };
function body(request: FastifyRequest, allowed: string[]) {
  const value = request.body as Record<string, unknown>;
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) {
    throw Object.assign(new Error('Invalid body'), { statusCode: 400 });
  }
  return value;
}
function email(value: unknown) {
  try {
    if (typeof value !== 'string' || /[\p{Cc}<>,;"\\]/u.test(value)) throw new Error('Invalid email');
    return normalizeEmail(value);
  } catch { throw Object.assign(new Error('Invalid email'), { statusCode: 400 }); }
}
export const invitationEmail = email;

export function registerInvitationRoutes(app: FastifyInstance, pool: Pool, config: Config, auth: {
  checkCsrf: (request: FastifyRequest, session?: Session) => boolean;
  reserve: (pool: Pool, key: string, limit: number) => Promise<boolean>;
}) {
  const csrf = (request: FastifyRequest, current?: Session) => {
    if (!auth.checkCsrf(request, current)) throw Object.assign(new Error('Invalid CSRF'), { statusCode: 403 });
  };
  async function administer<T>(request: FastifyRequest, organizationId: string, platform: boolean,
    write: boolean, work: (client: PoolClient, actor: Session) => Promise<T>) {
    const run = async (client: PoolClient) => {
      const actor = await readSession(client, request, config);
      if (!actor?.user_id) throw Object.assign(new Error('Authentication required'), { statusCode: 401 });
      if (write) csrf(request, actor);
      return work(client, actor);
    };
    if (!platform) return withAuthorizedOrganization(pool, request, config, organizationId, run, ['organization_admin']);
    return withOrganization(pool, organizationId, run, async client => {
      const actor = await readSession(client, request, config);
      if (!actor?.user_id) throw Object.assign(new Error('Authentication required'), { statusCode: 401 });
      if (!actor.admin) throw Object.assign(new Error('Access denied'), { statusCode: 403 });
      const { rows } = await client.query("SELECT id FROM organizations WHERE id = $1 AND status = 'active'", [organizationId]);
      if (!rows[0]) throw Object.assign(new Error('Access denied'), { statusCode: 403 });
    });
  }
  for (const platform of [true, false]) {
    const prefix = platform ? '/api/admin/organizations/:id/invitations' : '/api/organizations/:id/invitations';
    const params = { type: 'object', required: ['id'], properties: { id: uuid } };
    app.get<{ Params: { id: string } }>(prefix, { schema: { params } }, request =>
      administer(request, request.params.id, platform, false, async client => ({
        invitations: (await client.query(`SELECT ${invitationColumns} FROM organization_invitations
          WHERE organization_id = $1 AND (NOT $2 OR first_administrator) ORDER BY created_at DESC, id`, [request.params.id, platform])).rows,
      })));
    app.post<{ Params: { id: string } }>(prefix, { schema: { params } }, async (request, reply) => {
      const created = await administer(request, request.params.id, platform, true, async (client, actor) => {
        requireInvitationDelivery(config);
        const fields = body(request, platform ? ['email'] : ['email', 'role']);
        const invitedEmail = email(fields.email);
        const role = platform ? 'organization_admin' : fields.role;
        if (!roles.includes(role as OrganizationRole)) throw Object.assign(new Error('Invalid role'), { statusCode: 400 });
        const result = await createInvitation(client, request.params.id, actor.user_id!, invitedEmail, role as OrganizationRole, platform);
        await client.query("INSERT INTO platform_audit_events(actor_id, event, organization_id) VALUES ($1, 'invitation_created', $2)", [actor.user_id, request.params.id]);
        return result;
      });
      return reply.code(201).send(await deliverInvitation(config, created));
    });
    app.post<{ Params: { id: string; invitationId: string } }>(`${prefix}/:invitationId/revoke`, {
      schema: { params: { type: 'object', required: ['id', 'invitationId'], properties: { id: uuid, invitationId: uuid } } },
    }, request => administer(request, request.params.id, platform, true, async (client, actor) => {
      await lockInvitationCompany(client, request.params.id);
      const { rows } = await client.query(`UPDATE organization_invitations SET revoked_at = clock_timestamp()
        WHERE organization_id = $1 AND id = $2 AND accepted_at IS NULL AND revoked_at IS NULL
          AND (NOT $3 OR first_administrator) RETURNING ${invitationColumns}`, [request.params.id, request.params.invitationId, platform]);
      if (!rows[0]) throw invitationError();
      await client.query("INSERT INTO platform_audit_events(actor_id, event, organization_id) VALUES ($1, 'invitation_revoked', $2)", [actor.user_id, request.params.id]);
      return { invitation: rows[0] };
    }));
  }

  for (const accept of [false, true]) app.post(`/api/invitations/${accept ? 'accept' : 'inspect'}`, async (request, reply) => {
    const current = await readSession(pool, request, config);
    csrf(request, current);
    if (!await auth.reserve(pool, `invitation:${request.ip}`, 60)) {
      return reply.header('Retry-After', '900').code(429).send({ error: 'Spróbuj ponownie później.' });
    }
    const fields = body(request, accept ? ['token', 'email', 'password'] : ['token']);
    if (typeof fields.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(fields.token)) {
      if (accept) throw invitationError();
      return { status: 'unavailable' };
    }
    return withTransaction(pool, async client => {
      const actor = await readSession(client, request, config);
      csrf(request, actor);
      await client.query("SELECT set_config('sitegrid.invitation_hash', $1, true)", [invitationHash(fields.token as string)]);
      const { rows: found } = await client.query(`SELECT organization_id, id FROM organization_invitations WHERE token_hash = $1`, [invitationHash(fields.token as string)]);
      if (!found[0]) {
        if (accept) throw invitationError();
        return { status: 'unavailable' };
      }
      const organizationId = found[0].organization_id as string;
      await lockInvitationCompany(client, organizationId);
      await client.query("SELECT set_config('sitegrid.organization_id', $1::uuid::text, true)", [organizationId]);
      const invitation = (await client.query(`SELECT ${invitationColumns}, issuer_id FROM organization_invitations
        WHERE organization_id = $1 AND id = $2 ${accept ? 'FOR UPDATE' : ''}`, [organizationId, found[0].id])).rows[0];
      const organization = (await client.query("SELECT name FROM organizations WHERE id = $1 AND status = 'active'", [organizationId])).rows[0];
      if (!accept) return { status: invitation.status, ...(invitation.status === 'pending' && organization ? { organizationName: organization.name } : {}) };
      if (invitation.status !== 'pending' || !organization) throw invitationError();
      // Inviting authority must still exist at acceptance; a withdrawn issuer cannot grant a role.
      const issuer = (await client.query(`SELECT u.id FROM users u WHERE u.id = $1 AND u.blocked_at IS NULL AND
        CASE WHEN $3 THEN EXISTS(SELECT 1 FROM platform_admins WHERE user_id = u.id)
        ELSE EXISTS(SELECT 1 FROM organization_memberships m JOIN membership_roles r
          ON (r.organization_id, r.membership_id) = (m.organization_id, m.id)
          WHERE m.organization_id = $2 AND m.user_id = u.id AND m.status = 'active' AND r.role = 'organization_admin') END`,
      [invitation.issuer_id, organizationId, invitation.firstAdministrator])).rows[0];
      if (!issuer) throw invitationError();
      if (invitation.firstAdministrator) await requireFirstAdministrator(client, organizationId);
      let userId = actor!.user_id;
      if (userId) {
        if (actor!.email !== invitation.email) throw invitationError();
      } else {
        if (email(fields.email) !== invitation.email) throw invitationError();
        if (typeof fields.password !== 'string') throw Object.assign(new Error('Invalid password'), { statusCode: 400 });
        try { validatePassword(fields.password); } catch { throw Object.assign(new Error('Invalid password'), { statusCode: 400 }); }
        const passwordHash = await hashPassword(fields.password);
        const { rows } = await client.query('INSERT INTO users(id, email) VALUES ($1, $2) ON CONFLICT(email) DO NOTHING RETURNING id', [randomUUID(), invitation.email]);
        // The same response covers an existing identity and other unavailable invitations.
        if (!rows[0]) throw invitationError();
        userId = rows[0].id as string;
        await client.query('INSERT INTO credentials(user_id, password_hash) VALUES ($1, $2)', [userId, passwordHash]);
      }
      const { rows: memberships } = await client.query(`INSERT INTO organization_memberships(organization_id, user_id, status)
        VALUES ($1, $2, 'active') ON CONFLICT(organization_id, user_id) DO NOTHING RETURNING id`, [organizationId, userId]);
      if (memberships[0]) {
        await client.query('INSERT INTO membership_roles(organization_id, membership_id, role) VALUES ($1, $2, $3)', [organizationId, memberships[0].id, invitation.role]);
      } else {
        // Never modify roles/status of an existing membership, including inactive memberships.
        const existing = (await client.query('SELECT status FROM organization_memberships WHERE organization_id = $1 AND user_id = $2 FOR UPDATE', [organizationId, userId])).rows[0];
        if (existing?.status !== 'active') throw invitationError();
      }
      const accepted = await client.query(`UPDATE organization_invitations SET accepted_at = clock_timestamp(), accepted_by = $3
        WHERE organization_id = $1 AND id = $2 AND accepted_at IS NULL AND revoked_at IS NULL
          AND expires_at > clock_timestamp() RETURNING id`, [organizationId, invitation.id, userId]);
      if (!accepted.rows[0]) throw invitationError();
      await client.query("INSERT INTO platform_audit_events(actor_id, event, organization_id) VALUES ($1, 'invitation_accepted', $2)", [userId, organizationId]);
      return { status: 'accepted' };
    });
  });
}
