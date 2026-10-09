import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import cookie from '@fastify/cookie';
import type { FastifyInstance, FastifyReply, FastifyRequest, FastifyError } from 'fastify';
import type { Pool } from 'pg';
import type { Config } from '../config.js';
import { hashPassword, normalizeEmail, verifyPassword } from './password.js';
import { readSession, type Session } from './session.js';
import { registerOrganizationRoutes } from '../organization-routes.js';
import { invitationEmail, registerInvitationRoutes } from '../invitation-routes.js';
import { createInvitation, deliverInvitation, requireInvitationDelivery } from '../invitations.js';
import { withTransaction } from '../organization-context.js';

const token = () => randomBytes(32).toString('base64url');
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

async function reserve(pool: Pool, key: string, limit: number) {
  const { rows } = await pool.query<{ attempts: number }>(`
    INSERT INTO auth_rate_limits(key_hash, attempts, expires_at) VALUES ($1, 1, now() + interval '15 minutes')
    ON CONFLICT(key_hash) DO UPDATE SET
      attempts = CASE WHEN auth_rate_limits.expires_at <= now() THEN 1 ELSE auth_rate_limits.attempts + 1 END,
      expires_at = CASE WHEN auth_rate_limits.expires_at <= now() THEN now() + interval '15 minutes' ELSE auth_rate_limits.expires_at END
    RETURNING attempts`, [digest(key)]);
  return rows[0].attempts <= limit;
}

export async function registerAuth(app: FastifyInstance, pool: Pool, config: Config) {
  await app.register(cookie);
  const name = config.production ? '__Host-sitegrid' : 'sitegrid';
  const cookieOptions = { httpOnly: true, secure: config.production, sameSite: 'strict' as const, path: '/' };
  const dummyHash = await hashPassword(token());
  const session = (request: FastifyRequest) => readSession(pool, request, config);
  const checkCsrf = (request: FastifyRequest, current?: Session) => {
    const supplied = request.headers['x-csrf-token'];
    return current !== undefined && request.headers.origin === config.origin && typeof supplied === 'string'
      && /^[A-Za-z0-9_-]{43}$/.test(supplied)
      && timingSafeEqual(Buffer.from(supplied), Buffer.from(current.csrf_token));
  };
  const issue = async (reply: FastifyReply, userId: string | null, previous?: string) => {
    const raw = token(), csrf = token(), hours = userId ? 12 : 0.5;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      if (previous) await client.query('DELETE FROM sessions WHERE token_hash = $1', [previous]);
      await client.query("INSERT INTO sessions(token_hash, user_id, csrf_token, expires_at) VALUES ($1, $2, $3, now() + $4 * interval '1 hour')", [digest(raw), userId, csrf, hours]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
    reply.setCookie(name, raw, { ...cookieOptions, maxAge: hours * 3600 });
    return csrf;
  };
  app.addHook('onSend', async (request, reply) => {
    if (request.url.startsWith('/api/')) reply.header('Cache-Control', 'no-store');
  });
  app.setErrorHandler<FastifyError>((error, request, reply) => {
    const status = error.statusCode && error.statusCode >= 400 && error.statusCode < 500 ? error.statusCode : 503;
    if (status === 503) app.log.error({ requestId: request.id }, 'Request failed; check service/database availability');
    const message = status === 503 ? 'Usługa jest chwilowo niedostępna.'
      : status === 401 ? 'Zaloguj się, aby kontynuować.' : status === 403 ? 'Brak uprawnień.' : 'Nieprawidłowe żądanie.';
    return reply.code(status).send({ error: message });
  });
  registerOrganizationRoutes(app, pool, config);
  registerInvitationRoutes(app, pool, config, { checkCsrf, reserve });
  app.get('/api/auth/session', async (request, reply) => {
    if (!await reserve(pool, `session:${request.ip}`, 120)) return reply.header('Retry-After', '900').code(429).send({ error: 'Spróbuj ponownie później.' });
    await pool.query('DELETE FROM sessions WHERE token_hash IN (SELECT token_hash FROM sessions WHERE expires_at <= now() LIMIT 1000)');
    await pool.query('DELETE FROM auth_rate_limits WHERE key_hash IN (SELECT key_hash FROM auth_rate_limits WHERE expires_at <= now() LIMIT 1000)');
    const current = await session(request);
    if (current) return { csrfToken: current.csrf_token, user: current.user_id ? { email: current.email, platformAdmin: current.admin } : null };
    return { csrfToken: await issue(reply, null), user: null };
  });
  app.post<{ Body: { email: string; password: string } }>('/api/auth/login', {
    schema: { body: { type: 'object', additionalProperties: false, required: ['email', 'password'], properties: {
      email: { type: 'string', minLength: 3, maxLength: 254 }, password: { type: 'string', minLength: 1, maxLength: 128 },
    } } },
  }, async (request, reply) => {
    const current = await session(request);
    if (!checkCsrf(request, current)) return reply.code(403).send({ error: 'Odśwież stronę i spróbuj ponownie.' });
    let email: string;
    try { email = normalizeEmail(request.body.email); }
    catch { email = ''; }
    const ipAllowed = await reserve(pool, `login-ip:${request.ip}`, 30);
    if (!ipAllowed) return reply.header('Retry-After', '900').code(429).send({ error: 'Zbyt wiele prób. Spróbuj ponownie później.' });
    const emailAllowed = await reserve(pool, `login-email:${email}`, 10);
    if (!emailAllowed) return reply.header('Retry-After', '900').code(429).send({ error: 'Zbyt wiele prób. Spróbuj ponownie później.' });
    const { rows } = await pool.query<{ id: string; password_hash: string }>(`
      SELECT u.id, c.password_hash FROM users u JOIN credentials c ON c.user_id = u.id WHERE u.email = $1 AND u.blocked_at IS NULL`, [email]);
    const account = rows[0];
    const valid = await verifyPassword(account?.password_hash ?? dummyHash, request.body.password);
    if (!account || !valid) return reply.code(401).send({ error: 'Nieprawidłowy email lub hasło.' });
    await issue(reply, account.id, current!.token_hash);
    return { ok: true };
  });
  app.post('/api/auth/logout', async (request, reply) => {
    const current = await session(request);
    if (!checkCsrf(request, current)) return reply.code(403).send({ error: 'Odśwież stronę i spróbuj ponownie.' });
    await pool.query('DELETE FROM sessions WHERE token_hash = $1', [current!.token_hash]);
    reply.clearCookie(name, cookieOptions);
    return { ok: true };
  });
  app.get('/api/admin/overview', async (request, reply) => {
    const current = await session(request);
    if (!current?.user_id) return reply.code(401).send({ error: 'Zaloguj się, aby kontynuować.' });
    if (!current.admin) return reply.code(403).send({ error: 'Brak uprawnień.' });
    const { rows } = await pool.query('SELECT created_at FROM installation WHERE id = true');
    return { email: current.email, installedAt: rows[0].created_at, status: 'ready' };
  });
  app.get('/api/admin/organizations', async (request, reply) => {
    const current = await session(request);
    if (!current?.user_id) return reply.code(401).send({ error: 'Zaloguj się, aby kontynuować.' });
    if (!current.admin) return reply.code(403).send({ error: 'Brak uprawnień.' });
    const { rows } = await pool.query('SELECT id, name, status, created_at AS "createdAt" FROM organizations ORDER BY created_at DESC, id DESC');
    return { organizations: rows };
  });
  app.post('/api/admin/organizations', async (request, reply) => {
    const current = await session(request);
    if (!current?.user_id) return reply.code(401).send({ error: 'Zaloguj się, aby kontynuować.' });
    if (!current.admin) return reply.code(403).send({ error: 'Brak uprawnień.' });
    if (!checkCsrf(request, current)) return reply.code(403).send({ error: 'Odśwież stronę i spróbuj ponownie.' });
    // Validate raw input: do not coerce types or silently accept extra fields.
    const body = request.body as { name?: unknown; administratorEmail?: unknown } | null | undefined;
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !['name', 'administratorEmail'].includes(key)) || typeof body.name !== 'string') {
      return reply.code(400).send({ error: 'Podaj nazwę firmy i opcjonalny email administratora jako tekst.' });
    }
    const name = body.name.trim();
    if ([...name].length < 1 || [...name].length > 200 || /\p{Cc}/u.test(body.name)) {
      return reply.code(400).send({ error: 'Nazwa firmy musi mieć od 1 do 200 znaków i nie może zawierać znaków sterujących.' });
    }
    const email = body.administratorEmail === undefined ? undefined : invitationEmail(body.administratorEmail);
    if (email) requireInvitationDelivery(config);
    const created = await withTransaction(pool, async client => {
      const { rows } = await client.query('INSERT INTO organizations(name) VALUES ($1) RETURNING id, name, status, created_at AS "createdAt"', [name]);
      await client.query("INSERT INTO platform_audit_events(actor_id, event, organization_id) VALUES ($1, 'organization_created', $2)", [current.user_id, rows[0].id]);
      let invitation: Awaited<ReturnType<typeof createInvitation>> | undefined;
      if (email) {
        await client.query("SELECT set_config('sitegrid.organization_id', $1::uuid::text, true)", [rows[0].id]);
        invitation = await createInvitation(client, rows[0].id, current.user_id!, email, 'organization_admin', true);
        await client.query("INSERT INTO platform_audit_events(actor_id, event, organization_id) VALUES ($1, 'invitation_created', $2)", [current.user_id, rows[0].id]);
      }
      return { organization: rows[0], invitation };
    });
    return reply.code(201).send({ organization: created.organization, ...(created.invitation ? await deliverInvitation(config, created.invitation) : {}) });
  });
}
