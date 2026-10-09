import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { readConfig } from '../apps/server/src/config.js';
import { createPool } from '../apps/server/src/db.js';
import { buildApp } from '../apps/server/src/app.js';
import { migrate } from '../apps/server/src/migrations.js';
import { bootstrapAdmin } from '../apps/server/src/auth/bootstrap.js';
import { withAuthorizedOrganization } from '../apps/server/src/organization-access.js';
import { withTransaction } from '../apps/server/src/organization-context.js';

test('session-authorized organization API and discovery RLS on PostgreSQL 17', { skip: !process.env.TEST_DATABASE_URL }, async t => {
  assert(process.env.TEST_RUNTIME_DATABASE_URL, 'Organization API tests require a real unprivileged sitegrid login');
  const schema = `context_test_${randomBytes(6).toString('hex')}`;
  const admin = createPool(process.env.TEST_DATABASE_URL!);
  const ownerUrl = new URL(process.env.TEST_DATABASE_URL!);
  ownerUrl.searchParams.set('options', `-c search_path=${schema}`);
  const owner = createPool(ownerUrl.href);
  const runtimeUrl = new URL(process.env.TEST_RUNTIME_DATABASE_URL);
  runtimeUrl.searchParams.set('options', `-c search_path=${schema}`);
  const runtime = new pg.Pool({ connectionString: runtimeUrl.href, max: 1, connectionTimeoutMillis: 3000 });
  const config = readConfig({ NODE_ENV: 'test', DATABASE_URL: runtimeUrl.href });
  const app = await buildApp(config, runtime);
  const password = randomBytes(24).toString('base64url');
  const org = { a: randomUUID(), b: randomUUID(), pending: randomUUID(), inactive: randomUUID(), disabled: randomUUID() };
  const user = { a: randomUUID(), shared: randomUUID(), pending: randomUUID(), inactive: randomUUID(), roleless: randomUUID() };
  const listPath = '/api/me/organizations';
  const contextPath = (id: string) => `/api/organizations/${id}/context`;
  const get = (url: string, cookie?: string, extra: Record<string, string> = {}) => app.inject({ url, headers: { ...(cookie ? { cookie } : {}), ...extra } });
  const login = async (email: string) => {
    const initial = await app.inject('/api/auth/session');
    const response = await app.inject({ method: 'POST', url: '/api/auth/login', headers: {
      cookie: `${initial.cookies[0].name}=${initial.cookies[0].value}`, origin: config.origin, 'x-csrf-token': initial.json().csrfToken,
    }, payload: { email, password } });
    assert.equal(response.statusCode, 200);
    return `${response.cookies[0].name}=${response.cookies[0].value}`;
  };
  app.get<{ Params: { id: string } }>('/test/manager/:id', request =>
    withAuthorizedOrganization(runtime, request, config, request.params.id, async () => ({ ok: true }), ['manager']));
  app.get<{ Params: { id: string } }>('/test/tenant/:id', request =>
    withAuthorizedOrganization(runtime, request, config, request.params.id, async client => {
      const settings = (await client.query("SELECT current_setting('sitegrid.organization_id') AS organization, current_setting('sitegrid.user_id') AS actor")).rows[0];
      const memberships = (await client.query('SELECT organization_id FROM organization_memberships')).rows;
      return { settings, memberships };
    }));
  for (const kind of ['sql', 'callback']) app.get<{ Params: { id: string } }>(`/test/${kind}-error/:id`, request =>
    withAuthorizedOrganization(runtime, request, config, request.params.id, async client => {
      if (kind === 'sql') await client.query('SELECT 1 / 0');
      throw new Error('Synthetic callback error');
    }));
  await admin.query(`CREATE SCHEMA ${schema}`);
  try {
    await t.test('migration 4 to 5 preserves accounts, memberships, roles and sessions; repeatable', async () => {
      const previous = await mkdtemp(join(tmpdir(), 'sitegrid-m03-migrations-'));
      try {
        for (const name of ['001_installation.sql', '002_auth.sql', '003_organizations.sql', '004_memberships_roles.sql']) {
          await copyFile(join('migrations', name), join(previous, name));
        }
        assert.equal(await migrate(owner, previous), 4);
        await bootstrapAdmin(owner, 'platform@example.test', password);
        for (const [name, id] of Object.entries(user)) {
          await owner.query('INSERT INTO users(id, email) VALUES ($1, $2)', [id, `${name}@example.test`]);
          await owner.query('INSERT INTO credentials(user_id, password_hash) SELECT $1, password_hash FROM credentials LIMIT 1', [id]);
        }
        for (const [name, id] of Object.entries(org)) {
          await owner.query('INSERT INTO organizations(id, name, status) VALUES ($1, $2, $3)', [id, `Firma ${name}`, name === 'disabled' ? 'inactive' : 'active']);
        }
        const membership = async (organization: string, actor: string, status: string, roles: string[]) => {
          const id = randomUUID();
          await owner.query('INSERT INTO organization_memberships(organization_id, id, user_id, status) VALUES ($1, $2, $3, $4)', [organization, id, actor, status]);
          for (const role of roles) await owner.query('INSERT INTO membership_roles(organization_id, membership_id, role) VALUES ($1, $2, $3)', [organization, id, role]);
        };
        await membership(org.a, user.a, 'active', ['worker']);
        await membership(org.a, user.shared, 'active', ['organization_admin', 'manager']);
        await membership(org.b, user.shared, 'active', ['foreman', 'worker']);
        await membership(org.pending, user.shared, 'pending', ['manager']);
        await membership(org.inactive, user.shared, 'inactive', ['worker']);
        await membership(org.disabled, user.shared, 'active', ['manager']);
        await membership(org.a, user.pending, 'pending', ['manager']);
        await membership(org.a, user.inactive, 'inactive', ['worker']);
        await membership(org.a, user.roleless, 'active', []);
        await owner.query("INSERT INTO sessions(token_hash, user_id, csrf_token, expires_at) VALUES ($1, $2, $3, now() + interval '1 hour')",
          [randomBytes(32).toString('hex'), user.shared, randomBytes(32).toString('base64url')]);
        const tables = ['users', 'credentials', 'platform_admins', 'sessions', 'organizations', 'organization_memberships', 'membership_roles'];
        const before = await Promise.all(tables.map(table => owner.query(`SELECT * FROM ${table} ORDER BY to_jsonb(${table})::text`)));
        assert.equal(await migrate(owner, 'migrations'), 5);
        assert.equal(await migrate(owner, 'migrations'), 5);
        for (const [i, table] of tables.entries()) assert.deepEqual((await owner.query(`SELECT * FROM ${table} ORDER BY to_jsonb(${table})::text`)).rows, before[i].rows);
      } finally { await rm(previous, { recursive: true, force: true }); }
    });
    // The installer already grants global auth privileges; reproduce them only in the test schema.
    await owner.query(`GRANT USAGE ON SCHEMA ${schema} TO sitegrid`);
    await owner.query('GRANT SELECT, INSERT, UPDATE, DELETE ON installation, users, credentials, platform_admins, sessions, auth_rate_limits TO sitegrid');
    await t.test('actual runtime login has no bypass, ownership or privileged role membership', async () => {
      const identity = (await runtime.query('SELECT current_user, session_user, rolsuper, rolbypassrls, rolcreaterole FROM pg_roles WHERE rolname = current_user')).rows[0];
      assert.deepEqual(identity, { current_user: 'sitegrid', session_user: 'sitegrid', rolsuper: false, rolbypassrls: false, rolcreaterole: false });
      assert.equal((await runtime.query(`SELECT count(*) FROM pg_roles WHERE pg_has_role('sitegrid', oid, 'MEMBER')
        AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolname = 'sitegrid_test')`)).rows[0].count, '0');
      const tables = (await runtime.query(`SELECT c.relrowsecurity, c.relforcerowsecurity, row_security_active(c.oid) AS active,
        pg_has_role(current_user, c.relowner, 'MEMBER') AS owns FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relname IN ('organization_memberships', 'membership_roles')`, [schema])).rows;
      assert.equal(tables.length, 2);
      for (const row of tables) assert.deepEqual(row, { relrowsecurity: true, relforcerowsecurity: true, active: true, owns: false });
    });
    const cookies = {
      a: await login('a@example.test'), shared: await login('shared@example.test'), platform: await login('platform@example.test'),
      pending: await login('pending@example.test'), inactive: await login('inactive@example.test'), roleless: await login('roleless@example.test'),
    };
    const expectedA = { id: org.a, name: 'Firma a', roles: ['worker'] };
    const expectedShared = [{ id: org.a, name: 'Firma a', roles: ['manager', 'organization_admin'] },
      { id: org.b, name: 'Firma b', roles: ['foreman', 'worker'] }];
    await t.test('A cannot access B; shared user sees both with only their own roles', async () => {
      const list = await get(listPath, cookies.a);
      assert.equal(list.statusCode, 200);
      assert.equal(list.headers['cache-control'], 'no-store');
      assert.deepEqual(list.json(), { organizations: [expectedA] });
      assert.deepEqual((await get(contextPath(org.a), cookies.a)).json(), { organization: expectedA });
      const denied = await get(contextPath(org.b), cookies.a);
      assert.equal(denied.statusCode, 403);
      assert.deepEqual(denied.json(), (await get(contextPath(randomUUID()), cookies.a)).json());
      assert.deepEqual((await get(listPath, cookies.shared)).json(), { organizations: expectedShared });
      for (const organization of expectedShared) assert.deepEqual((await get(contextPath(organization.id), cookies.shared)).json(), { organization });
      const tenant = (await get(`/test/tenant/${org.a}`, cookies.a)).json();
      assert.deepEqual(tenant.settings, { organization: org.a, actor: user.a });
      assert(tenant.memberships.length > 1);
      assert(tenant.memberships.every((row: { organization_id: string }) => row.organization_id === org.a));
    });
    await t.test('pending/inactive memberships and inactive firms are denied; roleless active context is minimal', async () => {
      for (const cookie of [cookies.pending, cookies.inactive]) {
        assert.deepEqual((await get(listPath, cookie)).json(), { organizations: [] });
        assert.equal((await get(contextPath(org.a), cookie)).statusCode, 403);
      }
      for (const id of [org.pending, org.inactive, org.disabled]) assert.equal((await get(contextPath(id), cookies.shared)).statusCode, 403);
      assert.deepEqual((await get(contextPath(org.a), cookies.roleless)).json().organization.roles, []);
      assert.equal((await get(`/test/manager/${org.a}`, cookies.roleless)).statusCode, 403);
    });
    await t.test('platform admin has no automatic company access; existing admin panel and creation still work', async () => {
      assert.deepEqual((await get(listPath, cookies.platform)).json(), { organizations: [] });
      assert.equal((await get(contextPath(org.a), cookies.platform)).statusCode, 403);
      assert.equal((await get('/api/admin/overview', cookies.platform)).statusCode, 200);
      assert.equal((await get('/api/admin/organizations', cookies.platform)).json().organizations.length, 5);
      assert.equal((await get('/api/admin/organizations', cookies.a)).statusCode, 403);
      const session = (await get('/api/auth/session', cookies.platform)).json();
      const created = await app.inject({ method: 'POST', url: '/api/admin/organizations', headers: {
        cookie: cookies.platform, origin: config.origin, 'x-csrf-token': session.csrfToken,
      }, payload: { name: 'Firma platformy' } });
      assert.equal(created.statusCode, 201);
      assert.equal((await get(contextPath(created.json().organization.id), cookies.platform)).statusCode, 403);
    });
    await t.test('missing, anonymous, malformed and forged sessions cannot supply actor/organization/roles', async () => {
      const anonymous = await app.inject('/api/auth/session');
      for (const cookie of [undefined, 'sitegrid=bad', `sitegrid=${randomBytes(32).toString('base64url')}`,
        `${anonymous.cookies[0].name}=${anonymous.cookies[0].value}`]) {
        assert.equal((await get(listPath, cookie)).statusCode, 401);
        assert.equal((await get(contextPath(org.a), cookie)).statusCode, 401);
      }
      const spoof = `?user_id=${user.shared}&organization_id=${org.a}&role=manager`;
      assert.equal((await get(contextPath(org.b) + spoof, cookies.a, { 'x-user-id': user.shared, 'x-organization-id': org.a })).statusCode, 403);
      assert.deepEqual((await get(listPath + spoof, cookies.a)).json(), { organizations: [expectedA] });
      assert.equal((await get('/api/organizations/not-a-uuid/context', cookies.a)).statusCode, 400);
    });
    await t.test('role and membership revocation, firm deactivation and blocked account take effect without login', async () => {
      assert.equal((await get(`/test/manager/${org.a}`, cookies.shared)).statusCode, 200);
      await owner.query("DELETE FROM membership_roles WHERE organization_id = $1 AND role = 'manager'", [org.a]);
      // organization_admin does not inherit the manager role.
      assert.equal((await get(`/test/manager/${org.a}`, cookies.shared)).statusCode, 403);
      assert.deepEqual((await get(contextPath(org.a), cookies.shared)).json().organization.roles, ['organization_admin']);
      await owner.query("UPDATE organization_memberships SET status = 'inactive' WHERE organization_id = $1 AND user_id = $2", [org.b, user.shared]);
      assert.equal((await get(contextPath(org.b), cookies.shared)).statusCode, 403);
      assert.equal((await get(listPath, cookies.shared)).json().organizations.length, 1);
      await owner.query("UPDATE organization_memberships SET status = 'active' WHERE organization_id = $1 AND user_id = $2", [org.b, user.shared]);
      await owner.query("UPDATE organizations SET status = 'inactive' WHERE id = $1", [org.a]);
      assert.equal((await get(contextPath(org.a), cookies.a)).statusCode, 403);
      assert.deepEqual((await get(listPath, cookies.a)).json(), { organizations: [] });
      await owner.query("UPDATE organizations SET status = 'active' WHERE id = $1", [org.a]);
      await owner.query('UPDATE users SET blocked_at = now() WHERE id = $1', [user.a]);
      assert.equal((await get(contextPath(org.a), cookies.a)).statusCode, 401);
      assert.equal((await get(listPath, cookies.a)).statusCode, 401);
      await owner.query('UPDATE users SET blocked_at = NULL WHERE id = $1', [user.a]);
      await owner.query('DELETE FROM membership_roles WHERE organization_id = $1 AND membership_id IN (SELECT id FROM organization_memberships WHERE user_id = $2)', [org.a, user.a]);
      await owner.query('DELETE FROM organization_memberships WHERE organization_id = $1 AND user_id = $2', [org.a, user.a]);
      assert.equal((await get(contextPath(org.a), cookies.a)).statusCode, 403);
    });
    await t.test('discovery permits no writes or foreign reads; both contexts reset on the same backend after every path', async () => {
      const pid = (await runtime.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      const clean = async () => {
        const row = (await runtime.query(`SELECT pg_backend_pid() AS pid,
          NULLIF(current_setting('sitegrid.organization_id', true), '') AS organization,
          NULLIF(current_setting('sitegrid.user_id', true), '') AS actor`)).rows[0];
        assert.deepEqual(row, { pid, organization: null, actor: null });
        for (const table of ['organization_memberships', 'membership_roles']) assert.deepEqual((await runtime.query(`SELECT * FROM ${table}`)).rows, []);
      };
      await withTransaction(runtime, async client => {
        await client.query("SELECT set_config('sitegrid.user_id', $1, true)", [user.shared]);
        assert.deepEqual((await client.query('SELECT organization_id FROM organization_memberships ORDER BY organization_id')).rows.map(row => row.organization_id), [org.a, org.b].sort());
        assert.deepEqual((await client.query('SELECT * FROM organization_memberships WHERE user_id <> $1', [user.shared])).rows, []);
        assert.equal((await client.query('UPDATE organization_memberships SET status = status')).rowCount, 0);
        assert.equal((await client.query('DELETE FROM membership_roles')).rowCount, 0);
      });
      await assert.rejects(withTransaction(runtime, async client => {
        await client.query("SELECT set_config('sitegrid.user_id', $1, true)", [user.shared]);
        await client.query('INSERT INTO organization_memberships(organization_id, user_id) VALUES ($1, $2)', [org.b, user.roleless]);
      }), { code: '42501' });
      await clean();
      for (const [path, cookie, status] of [
        [listPath, cookies.shared, 200], [contextPath(org.a), cookies.shared, 200], [contextPath(org.b), cookies.shared, 200],
        [contextPath(org.b), cookies.roleless, 403], [listPath, 'sitegrid=bad', 401],
        [`/test/sql-error/${org.a}`, cookies.shared, 503], [`/test/callback-error/${org.b}`, cookies.shared, 503],
      ] as const) {
        assert.equal((await get(path, cookie)).statusCode, status);
        await clean();
      }
      const parallel = await Promise.all(Array.from({ length: 8 }, (_, i) => get(contextPath(i % 2 ? org.a : org.b), cookies.shared)));
      assert(parallel.every(response => response.statusCode === 200));
      await clean();
    });
    await t.test('expired and logged-out sessions lose organization access immediately', async () => {
      await owner.query('UPDATE sessions SET expires_at = now() WHERE user_id = $1', [user.roleless]);
      assert.equal((await get(contextPath(org.a), cookies.roleless)).statusCode, 401);
      assert.equal((await get(listPath, cookies.roleless)).statusCode, 401);
      const session = (await get('/api/auth/session', cookies.shared)).json();
      assert.equal((await app.inject({ method: 'POST', url: '/api/auth/logout', headers: {
        cookie: cookies.shared, origin: config.origin, 'x-csrf-token': session.csrfToken,
      } })).statusCode, 200);
      assert.equal((await get(contextPath(org.a), cookies.shared)).statusCode, 401);
      assert.equal((await get(listPath, cookies.shared)).statusCode, 401);
    });
  } finally {
    await app.close(); await runtime.end(); await owner.end();
    try { await admin.query(`DROP SCHEMA ${schema} CASCADE`); } finally { await admin.end(); }
  }
});
