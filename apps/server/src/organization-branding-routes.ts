import { lockOrganization } from './common/organization-lock.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import type { Config } from './config.js';
import { readSession, type Session } from './auth/session.js';
import { withAuthorizedOrganization } from './organization-access.js';

import { brandingFailure as failure, logoByteLimit, readBranding, validateLogo } from './organization-branding.js';

function fields(request: FastifyRequest, allowed: string[]) {
  const body = request.body as Record<string, unknown>;
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !allowed.includes(key))) throw failure(400);
  return body;
}
function expectedVersion(value: unknown) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value >= 2147483647) throw failure(400);
  return value;
}
export function registerOrganizationBrandingRoutes(app: FastifyInstance, pool: Pool, config: Config,
  checkCsrf: (request: FastifyRequest, session?: Session) => boolean) {
  type Params = { id: string };
  const schema = { params: { type: 'object', required: ['id'], properties: {
    id: { type: 'string', pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' },
  } } };
  const base = '/api/organizations/:id/branding';
  const read = <T>(request: FastifyRequest<{ Params: Params }>, work: (client: PoolClient) => Promise<T>) =>
    withAuthorizedOrganization(pool, request, config, request.params.id, work);
  async function write(request: FastifyRequest<{ Params: Params }>, version: number, event: string,
    work: (client: PoolClient, nextVersion: number) => Promise<void>) {
    return withAuthorizedOrganization(pool, request, config, request.params.id, async client => {
      let actor = await readSession(client, request, config);
      if (!actor?.user_id) throw failure(401);
      if (!checkCsrf(request, actor)) throw failure(403);
      await lockOrganization(client, request.params.id);
      // A role, account or session may have been revoked while waiting for the lock.
      actor = await readSession(client, request, config);
      if (!actor?.user_id) throw failure(401);
      if (!(await client.query('SELECT can_access_organization_branding($1, true) AS allowed', [request.params.id])).rows[0].allowed) throw failure(403);
      const current = await readBranding(client, request.params.id);
      if (current.version !== version) return { conflict: true as const, branding: current };
      await client.query('INSERT INTO organization_settings(organization_id) VALUES ($1) ON CONFLICT DO NOTHING', [request.params.id]);
      const nextVersion = version + 1;
      await work(client, nextVersion);
      const updated = await client.query(`UPDATE organization_settings SET version = $2, updated_at = clock_timestamp()
        WHERE organization_id = $1 AND version = $3 RETURNING version`, [request.params.id, nextVersion, version]);
      if (!updated.rowCount) throw failure(409);
      const branding = await readBranding(client, request.params.id);
      await client.query(`INSERT INTO organization_audit_events(organization_id, actor_id, subject_id, event, details)
        VALUES ($1, $2, $1, $3, $4)`, [request.params.id, actor.user_id, event, {
        beforeVersion: version, afterVersion: nextVersion,
        ...(event === 'branding_updated' ? { before: { name: current.name, accentColor: current.accentColor }, after: { name: branding.name, accentColor: branding.accentColor } }
          : { beforeLogoVersion: current.logo?.version ?? null, afterLogoVersion: branding.logo?.version ?? null }),
      }]);
      return { conflict: false as const, branding };
    }, ['organization_admin']);
  }
  app.get<{ Params: Params }>(base, { schema }, request => read(request, async client => ({ branding: await readBranding(client, request.params.id) })));
  app.get<{ Params: Params; Querystring: { version?: string } }>(`${base}/logo`, { schema: { ...schema,
    querystring: { type: 'object', additionalProperties: false, properties: { version: { type: 'string', pattern: '^[1-9][0-9]{0,9}$' } } },
  } }, async (request, reply) => {
    const logo = await read(request, async client => (await client.query(`SELECT data, mime_type, version FROM organization_logos WHERE organization_id = $1`, [request.params.id])).rows[0]);
    if (!logo || (request.query.version !== undefined && String(logo.version) !== request.query.version)) throw failure(404);
    const extension = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }[logo.mime_type as string];
    return reply.header('Content-Disposition', `inline; filename="company-logo.${extension}"`).type(logo.mime_type).send(logo.data);
  });
  app.post<{ Params: Params }>(base, { schema }, async (request, reply) => {
    const body = fields(request, ['name', 'accentColor', 'expectedVersion']);
    if (typeof body.name !== 'string' || /\p{Cc}/u.test(body.name) || !body.name.trim() || [...body.name.trim()].length > 200
      || typeof body.accentColor !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(body.accentColor)) throw failure(400);
    const name = body.name.trim(), accentColor = body.accentColor.toLowerCase();
    const result = await write(request, expectedVersion(body.expectedVersion), 'branding_updated', async client => {
      await client.query('UPDATE organizations SET name = $2 WHERE id = $1', [request.params.id, name]);
      await client.query('UPDATE organization_settings SET accent_color = $2 WHERE organization_id = $1', [request.params.id, accentColor]);
    });
    return reply.code(result.conflict ? 409 : 200).send(result.conflict ? { error: 'Dane firmy zmieniły się. Odśwież ustawienia przed ponownym zapisem.', branding: result.branding } : { branding: result.branding });
  });
  app.post<{ Params: Params }>(`${base}/logo`, { schema, bodyLimit: 4 * Math.ceil(logoByteLimit / 3) + 1024 }, async (request, reply) => {
    const body = fields(request, ['mimeType', 'data', 'expectedVersion']);
    const result = await write(request, expectedVersion(body.expectedVersion), 'logo_replaced', async (client, nextVersion) => {
      const logo = await validateLogo(body.mimeType, body.data);
      await client.query(`INSERT INTO organization_logos(organization_id, data, mime_type, version) VALUES ($1, $2, $3, $4)
        ON CONFLICT (organization_id) DO UPDATE SET data = EXCLUDED.data, mime_type = EXCLUDED.mime_type,
          version = EXCLUDED.version, updated_at = clock_timestamp()`, [request.params.id, logo.data, logo.mimeType, nextVersion]);
    });
    return reply.code(result.conflict ? 409 : 200).send(result.conflict ? { error: 'Dane firmy zmieniły się. Odśwież ustawienia przed ponownym zapisem.', branding: result.branding } : { branding: result.branding });
  });
  app.post<{ Params: Params }>(`${base}/logo/delete`, { schema }, async (request, reply) => {
    const body = fields(request, ['expectedVersion']);
    const result = await write(request, expectedVersion(body.expectedVersion), 'logo_removed', async client => {
      await client.query('DELETE FROM organization_logos WHERE organization_id = $1', [request.params.id]);
    });
    return reply.code(result.conflict ? 409 : 200).send(result.conflict ? { error: 'Dane firmy zmieniły się. Odśwież ustawienia przed ponownym zapisem.', branding: result.branding } : { branding: result.branding });
  });
}
