import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import type { Config } from './config.js';
import type { Session } from './auth/session.js';
import { writeOrganizationAudit as audit } from './common/audit.js';
import { contractorIdentifier } from './contractors/domain.js';
import { requireActiveContractor } from './contractors/persistence.js';
import { projectAccess, fields, text, version, failure, uuid, projectColumns, type Params } from './task-management/access.js';

export function registerProjectRoutes(app: FastifyInstance, pool: Pool, config: Config,
  checkCsrf: (request: FastifyRequest, session?: Session) => boolean) {
  const base = '/api/organizations/:id/projects';
  const { params, scope, project, writable, eligible, conflict } = projectAccess(pool, config, checkCsrf);
  app.get<{ Params: Params; Querystring: { contractorId?: string } }>(base, { schema: { ...params(), querystring: {
    type: 'object', additionalProperties: false, properties: { contractorId: { anyOf: [uuid, { const: 'none' }] } },
  } } }, request => scope(request, false, false, async client => ({
    projects: (await client.query(`SELECT ${projectColumns} FROM projects WHERE organization_id = $1
      AND ($2::boolean OR contractor_id IS NOT DISTINCT FROM $3::uuid) ORDER BY created_at DESC, id`,
    [request.params.id, request.query.contractorId === undefined,
      request.query.contractorId === undefined || request.query.contractorId === 'none' ? null : contractorIdentifier(request.query.contractorId)])).rows,
  })));
  app.post<{ Params: Params }>(base, { schema: params() }, async (request, reply) => {
    const result = await scope(request, true, true, async (client, actor) => {
      const body = fields(request, ['name', 'description', 'contractorId']);
      const name = text(body.name, 200, true), description = text(body.description === undefined ? '' : body.description, 4000);
      const contractorId = body.contractorId === undefined ? null : contractorIdentifier(body.contractorId);
      await requireActiveContractor(client, request.params.id, contractorId);
      const created = (await client.query(`INSERT INTO projects(organization_id, name, description, contractor_id) VALUES ($1, $2, $3, $4) RETURNING ${projectColumns}`,
      [request.params.id, name, description, contractorId])).rows[0];
      await audit(client, request.params.id, actor.userId, created.id, 'project_created', { beforeVersion: 0, afterVersion: 1, contractorId });
      return { project: created };
    });
    return reply.code(201).send(result);
  });
  app.get<{ Params: Params }>(`${base}/:projectId`, { schema: params('projectId') }, request => scope(request, false, false, async (client, actor) => {
    const current = await project(client, request);
    const access = (await client.query(`SELECT can_access_project($1, $2, ARRAY['manager', 'foreman', 'worker']) AS "readTasks",
      can_manage_tasks($1) AS "manageTasks"`, [request.params.id, request.params.projectId])).rows[0];
    return { project: current, permissions: { ...access, administer: actor.roles.includes('organization_admin') } };
  }));
  for (const action of ['update', 'archive']) {
    app.post<{ Params: Params }>(`${base}/:projectId/${action}`, { schema: params('projectId') }, async (request, reply) => {
      const result = await scope(request, true, true, async (client, actor) => {
        const body = fields(request, action === 'update' ? ['name', 'description', 'contractorId', 'expectedVersion'] : ['expectedVersion']);
        const expected = version(body.expectedVersion);
        const name = action === 'update' ? text(body.name, 200, true) : '', description = action === 'update' ? text(body.description === undefined ? '' : body.description, 4000) : '';
        const current = await project(client, request);
        if (current.version !== expected) return { stale: current };
        writable(current);
        const contractorId = action === 'archive' || body.contractorId === undefined ? current.contractor?.id ?? null : contractorIdentifier(body.contractorId);
        if (contractorId !== (current.contractor?.id ?? null)) await requireActiveContractor(client, request.params.id, contractorId);
        const updated = (await client.query(`UPDATE projects SET name = $3, description = $4, status = $5, contractor_id = $7, version = version + 1
          WHERE organization_id = $1 AND id = $2 AND version = $6 RETURNING ${projectColumns}`,
        [request.params.id, current.id, action === 'update' ? name : current.name, action === 'update' ? description : current.description,
          action === 'archive' ? 'archived' : 'active', expected, contractorId])).rows[0];
        if (!updated) throw failure(409);
        await audit(client, request.params.id, actor.userId, current.id, action === 'archive' ? 'project_archived' : 'project_updated',
          { beforeVersion: expected, afterVersion: updated.version, beforeContractorId: current.contractor?.id ?? null, afterContractorId: contractorId });
        return { project: updated };
      });
      return 'stale' in result ? conflict(reply, 'project', result.stale) : result;
    });
  }
  app.get<{ Params: Params }>(`${base}/:projectId/members`, { schema: params('projectId') }, request => scope(request, false, false, async (client, actor) => {
    const admin = actor.roles.includes('organization_admin');
    await project(client, request, admin ? undefined : ['organization_admin', 'manager', 'foreman']);
    // Only essential assignee identity; no HR fields, global directory or role management.
    return { members: (await client.query(`SELECT m.id AS "membershipId", COALESCE(e.display_name, u.email) AS "displayName",
      m.status AS "companyStatus", u.blocked_at IS NULL AS "accountActive", pm.status, COALESCE(pm.version, 0) AS version
      FROM organization_memberships m JOIN users u ON u.id = m.user_id
      LEFT JOIN employee_profiles e ON (e.organization_id, e.membership_id) = (m.organization_id, m.id)
      LEFT JOIN project_memberships pm ON (pm.organization_id, pm.membership_id) = (m.organization_id, m.id) AND pm.project_id = $2
      WHERE m.organization_id = $1 AND can_manage_tasks(m.organization_id) AND (($3::boolean AND ((m.status = 'active' AND u.blocked_at IS NULL) OR pm.membership_id IS NOT NULL))
        OR (m.status = 'active' AND u.blocked_at IS NULL))
      ORDER BY COALESCE(e.display_name, u.email), m.id`, [request.params.id, request.params.projectId, admin])).rows };
  }));
  app.post<{ Params: Params }>(`${base}/:projectId/members/:membershipId`, { schema: params('projectId', 'membershipId') }, async (request, reply) => {
    const result = await scope(request, true, true, async (client, actor) => {
      const body = fields(request, ['status', 'expectedVersion']);
      const expected = version(body.expectedVersion, true);
      if (!['active', 'inactive'].includes(body.status as string)) throw failure(400);
      const currentProject = await project(client, request); writable(currentProject);
      const { id, projectId, membershipId } = request.params;
      const current = (await client.query('SELECT status, version FROM project_memberships WHERE organization_id = $1 AND project_id = $2 AND membership_id = $3', [id, projectId, membershipId])).rows[0];
      if ((current?.version ?? 0) !== expected) return { stale: current ?? { status: null, version: 0 } };
      if (!current && body.status !== 'active') throw failure(400);
      if (body.status === 'active') await eligible(client, id, projectId, membershipId, false);
      if (current?.status === body.status) return { membership: current };
      const updated = current
        ? (await client.query(`UPDATE project_memberships SET status = $4, version = version + 1
          WHERE organization_id = $1 AND project_id = $2 AND membership_id = $3 AND version = $5 RETURNING status, version`, [id, projectId, membershipId, body.status, expected])).rows[0]
        : (await client.query(`INSERT INTO project_memberships(organization_id, project_id, membership_id) VALUES ($1, $2, $3) RETURNING status, version`, [id, projectId, membershipId])).rows[0];
      if (!updated) throw failure(409);
      await audit(client, id, actor.userId, membershipId, body.status === 'active' ? 'project_member_assigned' : 'project_member_revoked',
        { projectId, beforeVersion: expected, afterVersion: updated.version, before: current?.status ?? null, after: body.status });
      return { membership: updated };
    });
    return 'stale' in result ? conflict(reply, 'membership', result.stale) : result;
  });
}
