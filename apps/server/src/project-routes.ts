import { lockOrganization } from './common/organization-lock.js';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { writeOrganizationAudit as audit } from './common/audit.js';
import type { Config } from './config.js';
import { readSession, type Session } from './auth/session.js';
import { withAuthorizedOrganization } from './organization-access.js';

const uuidPattern = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const uuid = { type: 'string', pattern: uuidPattern.source };
const failure = (statusCode: number) => Object.assign(new Error('Invalid project action'), { statusCode });
const projectColumns = 'id, name, description, status, version, created_at AS "createdAt", updated_at AS "updatedAt"';
const taskColumns = 'id, title, description, assignee_membership_id AS "assigneeMembershipId", author_membership_id AS "authorMembershipId", status, version, created_at AS "createdAt", updated_at AS "updatedAt", can_progress_assignment(organization_id, project_id, assignee_membership_id) AS "canProgress"';
type Params = { id: string; projectId: string; membershipId: string; taskId: string };
type Project = { id: string; name: string; description: string; status: string; version: number };
function fields(request: FastifyRequest, allowed: string[]) {
  const body = request.body as Record<string, unknown>;
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !allowed.includes(key))) throw failure(400);
  return body;
}
function text(value: unknown, max: number, required = false) {
  if (typeof value !== 'string' || /\p{Cc}/u.test(value)) throw failure(400);
  const result = value.trim();
  if ([...result].length > max || (required && !result)) throw failure(400);
  return result;
}
function version(value: unknown, allowZero = false) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < (allowZero ? 0 : 1) || value >= 2147483647) throw failure(400);
  return value;
}
function identifier(value: unknown) {
  if (typeof value !== 'string' || !uuidPattern.test(value)) throw failure(400);
  return value;
}

export function registerProjectRoutes(app: FastifyInstance, pool: Pool, config: Config,
  checkCsrf: (request: FastifyRequest, session?: Session) => boolean) {
  const base = '/api/organizations/:id/projects';
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

  app.get<{ Params: Params }>(base, { schema: params() }, request => scope(request, false, false, async client => ({
    projects: (await client.query(`SELECT ${projectColumns} FROM projects WHERE organization_id = $1 ORDER BY created_at DESC, id`, [request.params.id])).rows,
  })));
  app.post<{ Params: Params }>(base, { schema: params() }, async (request, reply) => {
    const result = await scope(request, true, true, async (client, actor) => {
      const body = fields(request, ['name', 'description']);
      const name = text(body.name, 200, true), description = text(body.description === undefined ? '' : body.description, 4000);
      const created = (await client.query(`INSERT INTO projects(organization_id, name, description) VALUES ($1, $2, $3) RETURNING ${projectColumns}`,
      [request.params.id, name, description])).rows[0];
      await audit(client, request.params.id, actor.userId, created.id, 'project_created', { beforeVersion: 0, afterVersion: 1 });
      return { project: created };
    });
    return reply.code(201).send(result);
  });
  app.get<{ Params: Params }>(`${base}/:projectId`, { schema: params('projectId') }, request => scope(request, false, false, async (client, actor) => {
    const current = await project(client, request);
    const access = (await client.query(`SELECT can_access_project($1, $2, ARRAY['manager', 'foreman', 'worker']) AS "readTasks",
      can_access_project($1, $2, ARRAY['manager']) AS "manageTasks"`, [request.params.id, request.params.projectId])).rows[0];
    return { project: current, permissions: { ...access, administer: actor.roles.includes('organization_admin') } };
  }));
  for (const action of ['update', 'archive']) {
    app.post<{ Params: Params }>(`${base}/:projectId/${action}`, { schema: params('projectId') }, async (request, reply) => {
      const result = await scope(request, true, true, async (client, actor) => {
        const body = fields(request, action === 'update' ? ['name', 'description', 'expectedVersion'] : ['expectedVersion']);
        const expected = version(body.expectedVersion);
        const name = action === 'update' ? text(body.name, 200, true) : '', description = action === 'update' ? text(body.description === undefined ? '' : body.description, 4000) : '';
        const current = await project(client, request);
        if (current.version !== expected) return { stale: current };
        writable(current);
        const updated = (await client.query(`UPDATE projects SET name = $3, description = $4, status = $5, version = version + 1
          WHERE organization_id = $1 AND id = $2 AND version = $6 RETURNING ${projectColumns}`,
        [request.params.id, current.id, action === 'update' ? name : current.name, action === 'update' ? description : current.description,
          action === 'archive' ? 'archived' : 'active', expected])).rows[0];
        if (!updated) throw failure(409);
        await audit(client, request.params.id, actor.userId, current.id, action === 'archive' ? 'project_archived' : 'project_updated',
          { beforeVersion: expected, afterVersion: updated.version });
        return { project: updated };
      });
      return 'stale' in result ? conflict(reply, 'project', result.stale) : result;
    });
  }
  app.get<{ Params: Params }>(`${base}/:projectId/members`, { schema: params('projectId') }, request => scope(request, false, false, async (client, actor) => {
    const admin = actor.roles.includes('organization_admin');
    await project(client, request, admin ? undefined : ['manager']);
    // Only essential assignee identity; no HR fields, global directory or role management.
    return { members: (await client.query(`SELECT m.id AS "membershipId", COALESCE(e.display_name, u.email) AS "displayName",
      m.status AS "companyStatus", u.blocked_at IS NULL AS "accountActive", pm.status, COALESCE(pm.version, 0) AS version
      FROM organization_memberships m JOIN users u ON u.id = m.user_id
      LEFT JOIN employee_profiles e ON (e.organization_id, e.membership_id) = (m.organization_id, m.id)
      LEFT JOIN project_memberships pm ON (pm.organization_id, pm.membership_id) = (m.organization_id, m.id) AND pm.project_id = $2
      WHERE m.organization_id = $1 AND (($3::boolean AND ((m.status = 'active' AND u.blocked_at IS NULL) OR pm.membership_id IS NOT NULL))
        OR (pm.status = 'active' AND m.status = 'active' AND u.blocked_at IS NULL))
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
  app.get<{ Params: Params }>(`${base}/:projectId/tasks`, { schema: params('projectId') }, request => scope(request, false, false, async client => {
    await project(client, request, ['manager', 'foreman', 'worker']);
    return { tasks: (await client.query(`SELECT ${taskColumns},
      (SELECT COALESCE(e.display_name, u.email) FROM organization_memberships m JOIN users u ON u.id = m.user_id
        LEFT JOIN employee_profiles e ON (e.organization_id, e.membership_id) = (m.organization_id, m.id)
        WHERE (m.organization_id, m.id) = (tasks.organization_id, tasks.assignee_membership_id)) AS "assigneeName"
      FROM tasks WHERE organization_id = $1 AND project_id = $2 ORDER BY created_at DESC, id`, [request.params.id, request.params.projectId])).rows };
  }));
  app.get<{ Params: Params }>(`${base}/:projectId/tasks/:taskId`, { schema: params('projectId', 'taskId') }, request => scope(request, false, false, async client => {
    await project(client, request, ['manager', 'foreman', 'worker']);
    const task = (await client.query(`SELECT ${taskColumns} FROM tasks WHERE organization_id = $1 AND project_id = $2 AND id = $3`,
    [request.params.id, request.params.projectId, request.params.taskId])).rows[0];
    if (!task) throw failure(404);
    return { task };
  }));
  for (const edit of [false, true]) {
    app.post<{ Params: Params }>(edit ? `${base}/:projectId/tasks/:taskId/update` : `${base}/:projectId/tasks`,
      { schema: params('projectId', ...(edit ? ['taskId'] : [])) }, async (request, reply) => {
        const result = await scope(request, true, false, async (client, actor) => {
          const currentProject = await project(client, request, ['manager']); writable(currentProject);
          const body = fields(request, ['title', 'description', 'assigneeMembershipId', ...(edit ? ['expectedVersion'] : [])]);
          const title = text(body.title, 200, true), description = text(body.description === undefined ? '' : body.description, 4000), assignee = identifier(body.assigneeMembershipId);
          const expected = edit ? version(body.expectedVersion) : 0;
          const { id, projectId, taskId } = request.params;
          const current = edit ? (await client.query(`SELECT ${taskColumns} FROM tasks WHERE organization_id = $1 AND project_id = $2 AND id = $3`, [id, projectId, taskId])).rows[0] : undefined;
          if (edit && !current) throw failure(404);
          if (edit && current.version !== expected) return { stale: current };
          await eligible(client, id, projectId, assignee, true);
          const task = edit
            ? (await client.query(`UPDATE tasks SET title = $4, description = $5, assignee_membership_id = $6, version = version + 1
              WHERE organization_id = $1 AND project_id = $2 AND id = $3 AND version = $7 RETURNING ${taskColumns}`, [id, projectId, taskId, title, description, assignee, expected])).rows[0]
            : (await client.query(`INSERT INTO tasks(organization_id, project_id, title, description, assignee_membership_id, author_membership_id)
              VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${taskColumns}`, [id, projectId, title, description, assignee, actor.membershipId])).rows[0];
          if (!task) throw failure(409);
          await audit(client, id, actor.userId, task.id, edit ? 'task_updated' : 'task_created',
            { projectId, beforeVersion: expected, afterVersion: task.version, beforeAssignee: current?.assigneeMembershipId ?? null, afterAssignee: assignee });
          return { task };
        });
        if ('stale' in result) return conflict(reply, 'task', result.stale);
        return reply.code(edit ? 200 : 201).send(result);
      });
  }
}
