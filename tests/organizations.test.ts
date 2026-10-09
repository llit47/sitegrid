import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readConfig } from '../apps/server/src/config.js';
import { createPool } from '../apps/server/src/db.js';
import { buildApp } from '../apps/server/src/app.js';
import { migrate, migrationFiles } from '../apps/server/src/migrations.js';
import { bootstrapAdmin } from '../apps/server/src/auth/bootstrap.js';

test('release schema contract matches migrations', async () => {
  const version = (await migrationFiles('migrations')).length;
  const { schema } = JSON.parse(await readFile('release.json', 'utf8'));
  assert.deepEqual(schema, { target: version, min: version, max: version, upgradeMin: 0, upgradeMax: version });
});

test('platform administrator organization management on PostgreSQL', { skip: !process.env.TEST_DATABASE_URL }, async t => {
  const schema = `organizations_test_${randomBytes(6).toString('hex')}`;
  const adminPool = createPool(process.env.TEST_DATABASE_URL!);
  await adminPool.query(`CREATE SCHEMA ${schema}`);
  const url = new URL(process.env.TEST_DATABASE_URL!);
  url.searchParams.set('options', `-c search_path=${schema}`);
  const config = readConfig({ NODE_ENV: 'test', DATABASE_URL: url.href });
  const pool = createPool(config.databaseUrl);
  const app = await buildApp(config, pool);
  let createdRuntimeRole = false;
  const endpoint = '/api/admin/organizations';
  const password = randomBytes(24).toString('base64url');
  const rowCount = async () => Number((await pool.query('SELECT count(*) FROM organizations')).rows[0].count);
  const auditCount = async () => Number((await pool.query("SELECT count(*) FROM platform_audit_events WHERE event = 'organization_created'")).rows[0].count);
  const anonymous = async () => {
    const response = await app.inject('/api/auth/session');
    return { cookie: response.cookies[0].name + '=' + response.cookies[0].value, origin: config.origin, 'x-csrf-token': response.json().csrfToken };
  };
  const login = async (email: string) => {
    const response = await app.inject({ method: 'POST', url: '/api/auth/login', headers: await anonymous(), payload: { email, password } });
    assert.equal(response.statusCode, 200);
    const cookie = response.cookies[0].name + '=' + response.cookies[0].value;
    const session = await app.inject({ url: '/api/auth/session', headers: { cookie } });
    return { cookie, origin: config.origin, 'x-csrf-token': session.json().csrfToken };
  };
  try {
    const role = (await adminPool.query("SELECT rolsuper, EXISTS(SELECT 1 FROM pg_roles WHERE rolname = 'sitegrid') AS runtime_exists FROM pg_roles WHERE rolname = current_user")).rows[0];
    if (role.rolsuper && !role.runtime_exists) {
      await adminPool.query('CREATE ROLE sitegrid NOLOGIN');
      createdRuntimeRole = true;
    }
    await t.test('schema 2 upgrades without losing accounts; migration is repeatable', async () => {
      const previous = await mkdtemp(join(tmpdir(), 'sitegrid-migrations-'));
      try {
        for (const name of ['001_installation.sql', '002_auth.sql']) await copyFile(join(config.migrationsRoot, name), join(previous, name));
        assert.equal(await migrate(pool, previous), 2);
        await bootstrapAdmin(pool, 'admin@example.test', password);
        const version = (await migrationFiles(config.migrationsRoot)).length;
        assert.equal(await migrate(pool, config.migrationsRoot), version);
        assert.equal(await migrate(pool, config.migrationsRoot), version);
        assert.equal((await pool.query('SELECT count(*) FROM users')).rows[0].count, '1');
      } finally { await rm(previous, { recursive: true, force: true }); }
    });
    const actorId = (await pool.query('SELECT id FROM users')).rows[0].id;
    const headers = await login('admin@example.test');
    const create = (payload: unknown, suppliedHeaders = headers) => app.inject({ method: 'POST', url: endpoint,
      headers: { 'content-type': 'application/json', ...suppliedHeaders }, payload: JSON.stringify(payload) });
    await t.test('missing and anonymous sessions cannot read or create', async () => {
      for (const denied of [{}, await anonymous()]) {
        const list = await app.inject({ url: endpoint, headers: denied });
        assert.equal(list.statusCode, 401);
        assert.deepEqual(Object.keys(list.json()), ['error']);
        assert.equal(list.headers['cache-control'], 'no-store');
        assert.equal((await app.inject({ method: 'POST', url: endpoint, headers: denied, payload: { name: 'Firma' } })).statusCode, 401);
      }
      assert.equal(await rowCount(), 0);
    });
    await t.test('empty list, creation, UUID, defaults, persistence and attributed audit', async () => {
      assert.deepEqual((await app.inject({ url: endpoint, headers })).json(), { organizations: [] });
      const response = await create({ name: '  Żółć Budownictwo  ' });
      assert.equal(response.statusCode, 201);
      const organization = response.json().organization;
      assert.match(organization.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      assert.equal(organization.name, 'Żółć Budownictwo');
      assert.equal(organization.status, 'active');
      assert(Number.isFinite(Date.parse(organization.createdAt)));
      const list = await app.inject({ url: endpoint, headers });
      assert.equal(list.statusCode, 200);
      assert.deepEqual(list.json(), { organizations: [organization] });
      assert.equal((await pool.query('SELECT name FROM organizations WHERE id = $1', [organization.id])).rows[0].name, organization.name);
      assert.deepEqual((await pool.query('SELECT actor_id, event, organization_id FROM platform_audit_events WHERE organization_id = $1', [organization.id])).rows,
        [{ actor_id: actorId, event: 'organization_created', organization_id: organization.id }]);
    });
    await t.test('runtime role can list/create with the migration grants', { skip: !role.rolsuper }, async () => {
      // Session lookup grants already provided by the installer, confined to this test schema.
      await pool.query(`GRANT USAGE ON SCHEMA ${schema} TO sitegrid`);
      await pool.query('GRANT SELECT ON sessions, users, platform_admins TO sitegrid');
      const runtimeUrl = new URL(config.databaseUrl);
      runtimeUrl.searchParams.set('options', `-c search_path=${schema} -c role=sitegrid`);
      const runtimePool = createPool(runtimeUrl.href);
      const runtimeApp = await buildApp(config, runtimePool);
      let organizationId: string | undefined;
      try {
        assert.equal((await runtimePool.query('SELECT current_user')).rows[0].current_user, 'sitegrid');
        assert.equal((await runtimeApp.inject({ url: endpoint, headers })).statusCode, 200);
        const response = await runtimeApp.inject({ method: 'POST', url: endpoint, headers, payload: { name: 'Firma runtime' } });
        assert.equal(response.statusCode, 201);
        organizationId = response.json().organization.id;
        assert.equal((await pool.query('SELECT actor_id FROM platform_audit_events WHERE organization_id = $1', [organizationId])).rows[0].actor_id, actorId);
      } finally {
        await runtimeApp.close(); await runtimePool.end();
        if (organizationId) {
          await pool.query('DELETE FROM platform_audit_events WHERE organization_id = $1', [organizationId]);
          await pool.query('DELETE FROM organizations WHERE id = $1', [organizationId]);
        }
      }
    });
    await t.test('non-administrators cannot read existing companies or create them', async () => {
      const userId = randomUUID();
      await pool.query("INSERT INTO users(id, email) VALUES ($1, 'user@example.test')", [userId]);
      await pool.query('INSERT INTO credentials(user_id, password_hash) SELECT $1, password_hash FROM credentials WHERE user_id = $2', [userId, actorId]);
      const userHeaders = await login('user@example.test');
      const list = await app.inject({ url: endpoint, headers: userHeaders });
      assert.equal(list.statusCode, 403);
      assert.deepEqual(list.json(), { error: 'Brak uprawnień.' });
      assert.equal((await create({ name: 'Firma' }, userHeaders)).statusCode, 403);
      assert.equal(await rowCount(), 1);
      assert.equal(await auditCount(), 1);
    });
    await t.test('invalid names/types/extra fields are rejected without writes', async () => {
      const invalid = ['', ' ', '\u00a0\u2003', 'x'.repeat(201), 'Firma\nDruga', '\tFirma', 'Firma\u0000', 123, null].map(name => ({ name }));
      for (const payload of [...invalid, {}, [], null, { name: 'Firma', status: 'inactive' }]) {
        assert.equal((await create(payload)).statusCode, 400, JSON.stringify(payload));
      }
      assert.equal(await rowCount(), 1);
      assert.equal(await auditCount(), 1);
    });
    await t.test('names accept the 1 and 200 Unicode character boundaries', async () => {
      for (const name of ['F', '🏗'.repeat(200)]) assert.equal((await create({ name })).statusCode, 201);
      assert.equal(await rowCount(), 3);
      assert.equal(await auditCount(), 3);
    });
    await t.test('missing/wrong CSRF and absent/foreign Origin fail without writes', async () => {
      const invalid = [{ cookie: headers.cookie, origin: config.origin }, { ...headers, 'x-csrf-token': 'x'.repeat(43) },
        { ...headers, origin: 'https://evil.test' }, { cookie: headers.cookie, 'x-csrf-token': headers['x-csrf-token'] }];
      for (const denied of invalid) assert.equal((await app.inject({ method: 'POST', url: endpoint, headers: denied, payload: { name: 'Firma' } })).statusCode, 403);
      assert.equal(await rowCount(), 3);
      assert.equal(await auditCount(), 3);
    });
    await t.test('audit failure rolls back the organization', async () => {
      await pool.query("ALTER TABLE platform_audit_events ADD CONSTRAINT reject_organization_audit CHECK (event <> 'organization_created') NOT VALID");
      try {
        const response = await create({ name: 'Firma bez audytu' });
        assert.equal(response.statusCode, 503);
        assert.deepEqual(response.json(), { error: 'Usługa jest chwilowo niedostępna.' });
        assert.equal(await rowCount(), 3);
        assert.equal(await auditCount(), 3);
      } finally { await pool.query('ALTER TABLE platform_audit_events DROP CONSTRAINT reject_organization_audit'); }
    });
    await t.test('blocked accounts, revoked admin permission and expired sessions fail closed', async () => {
      await pool.query('UPDATE users SET blocked_at = now() WHERE id = $1', [actorId]);
      assert.equal((await app.inject({ url: endpoint, headers })).statusCode, 401);
      assert.equal((await create({ name: 'Firma' })).statusCode, 401);
      await pool.query('UPDATE users SET blocked_at = NULL WHERE id = $1', [actorId]);
      await pool.query('DELETE FROM platform_admins WHERE user_id = $1', [actorId]);
      assert.equal((await app.inject({ url: endpoint, headers })).statusCode, 403);
      assert.equal((await create({ name: 'Firma' })).statusCode, 403);
      await pool.query('UPDATE sessions SET expires_at = now() WHERE user_id = $1', [actorId]);
      assert.equal((await app.inject({ url: endpoint, headers })).statusCode, 401);
      assert.equal((await create({ name: 'Firma' })).statusCode, 401);
      assert.equal(await rowCount(), 3);
      assert.equal(await auditCount(), 3);
    });
  } finally {
    await app.close(); await pool.end();
    await adminPool.query(`DROP SCHEMA ${schema} CASCADE`);
    if (createdRuntimeRole) {
      await adminPool.query('DROP OWNED BY sitegrid');
      await adminPool.query('DROP ROLE sitegrid');
    }
    await adminPool.end();
  }
});
