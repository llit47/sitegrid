import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { createPool } from '../apps/server/src/db.js';
import { migrate, checkMigrations, migrationFiles } from '../apps/server/src/migrations.js';
import { withOrganization } from '../apps/server/src/organization-context.js';

test('memberships, composite relations and RLS on PostgreSQL 17', { skip: !process.env.TEST_DATABASE_URL }, async t => {
  assert(process.env.TEST_RUNTIME_DATABASE_URL, 'Set TEST_RUNTIME_DATABASE_URL to a real sitegrid login; RLS tests must not use the migration owner');
  const schema = `memberships_test_${randomBytes(6).toString('hex')}`;
  const adminPool = createPool(process.env.TEST_DATABASE_URL!);
  const migrationUrl = new URL(process.env.TEST_DATABASE_URL!);
  migrationUrl.searchParams.set('options', `-c search_path=${schema}`);
  const pool = createPool(migrationUrl.href);
  const runtimeUrl = new URL(process.env.TEST_RUNTIME_DATABASE_URL);
  runtimeUrl.searchParams.set('options', `-c search_path=${schema}`);
  // Reusing exactly one backend proves that transaction context cannot leak through a pool.
  const runtime = new pg.Pool({ connectionString: runtimeUrl.href, max: 1, connectionTimeoutMillis: 3000 });
  const organizationA = randomUUID(), organizationB = randomUUID();
  const sharedUser = randomUUID(), pendingUser = randomUUID();
  const membershipA = randomUUID(), membershipB = randomUUID(), pendingMembership = randomUUID();
  const inOrganization = <T>(id: string, work: (client: pg.PoolClient) => Promise<T>) => withOrganization(runtime, id, work);
  const expectSqlError = (code: string, id: string, sql: string, values: unknown[] = []) =>
    assert.rejects(inOrganization(id, client => client.query(sql, values)), { code });
  const tenantTables = ['organization_memberships', 'membership_roles'];
  await adminPool.query(`CREATE SCHEMA ${schema}`);
  try {
    await t.test('schema 3 upgrades preserving identities, organizations and authentication data', async () => {
      const previous = await mkdtemp(join(tmpdir(), 'sitegrid-m02b-migrations-'));
      try {
        for (const name of ['001_installation.sql', '002_auth.sql', '003_organizations.sql']) {
          await copyFile(join('migrations', name), join(previous, name));
        }
        assert.equal(await migrate(pool, previous), 3);
        await pool.query('INSERT INTO users(id, email) VALUES ($1, $2), ($3, $4)',
          [sharedUser, 'shared@example.test', pendingUser, 'pending@example.test']);
        await pool.query("INSERT INTO credentials(user_id, password_hash) VALUES ($1, 'synthetic-password-hash')", [sharedUser]);
        await pool.query('INSERT INTO platform_admins(user_id) VALUES ($1)', [sharedUser]);
        await pool.query("INSERT INTO sessions(token_hash, user_id, csrf_token, expires_at) VALUES ($1, $2, $3, now() + interval '1 hour')",
          [randomBytes(32).toString('hex'), sharedUser, randomBytes(32).toString('base64url')]);
        await pool.query("UPDATE installation SET bootstrap_completed_at = now() WHERE id = true");
        await pool.query("INSERT INTO organizations(id, name) VALUES ($1, 'Firma A'), ($2, 'Firma B')", [organizationA, organizationB]);
        await pool.query("INSERT INTO platform_audit_events(actor_id, organization_id, event) VALUES ($1, $2, 'organization_created')", [sharedUser, organizationA]);
        const preservedTables = ['installation', 'users', 'credentials', 'platform_admins', 'sessions', 'organizations', 'platform_audit_events', 'schema_migrations'];
        const before = await Promise.all(preservedTables.map(table => pool.query(`SELECT * FROM ${table} ORDER BY 1`)));
        const version = (await migrationFiles('migrations')).length;
        assert.equal(await migrate(pool, 'migrations'), version);
        assert.equal(await migrate(pool, 'migrations'), version);
        assert.equal(await checkMigrations(pool, 'migrations'), version);
        for (const [i, table] of preservedTables.entries()) {
          const after = await pool.query(`SELECT * FROM ${table}${table === 'schema_migrations' ? ' WHERE version <= 3' : ''} ORDER BY 1`);
          assert.deepEqual(after.rows, before[i].rows, `Migration must preserve ${table}`);
        }
        assert.equal((await pool.query('SELECT count(*) FROM organization_memberships')).rows[0].count, '0');
        assert.equal((await pool.query('SELECT count(*) FROM membership_roles')).rows[0].count, '0');
      } finally { await rm(previous, { recursive: true, force: true }); }
    });
    await pool.query(`GRANT USAGE ON SCHEMA ${schema} TO sitegrid`);
    await t.test('runtime really logs in as a non-owner without RLS bypass or privileged memberships', async () => {
      const identity = (await runtime.query(`
        SELECT current_user, session_user, r.rolsuper, r.rolbypassrls, r.rolcreaterole
        FROM pg_roles r WHERE rolname = current_user`)).rows[0];
      assert.deepEqual(identity, { current_user: 'sitegrid', session_user: 'sitegrid', rolsuper: false, rolbypassrls: false, rolcreaterole: false });
      assert.equal((await runtime.query(`SELECT count(*) FROM pg_roles
        WHERE pg_has_role('sitegrid', oid, 'MEMBER') AND (rolsuper OR rolbypassrls OR rolcreaterole)`)).rows[0].count, '0');
      const tables = await runtime.query(`SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity,
        pg_has_role(current_user, c.relowner, 'MEMBER') AS owns,
        row_security_active(c.oid) AS rls_active,
        has_table_privilege(current_user, c.oid, 'TRUNCATE') AS can_truncate
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relname = ANY($2::text[]) ORDER BY c.relname`, [schema, tenantTables]);
      assert.equal(tables.rows.length, 2);
      for (const row of tables.rows) {
        assert.equal(row.relrowsecurity, true);
        assert.equal(row.relforcerowsecurity, true);
        assert.equal(row.owns, false);
        assert.equal(row.rls_active, true);
        assert.equal(row.can_truncate, false);
      }
      const migration = (await migrationFiles('migrations'))[3];
      await assert.rejects(runtime.query(migration.sql), /separate owner role/);
      const client = await runtime.connect();
      try {
        await client.query('BEGIN');
        await client.query('SET LOCAL row_security = off');
        await assert.rejects(client.query('SELECT * FROM organization_memberships'), { code: '42501' });
      } finally { await client.query('ROLLBACK'); client.release(); }
    });
    await t.test('one global user belongs to two firms with independent statuses and multiple explicit roles', async () => {
      await inOrganization(organizationA, async client => {
        await client.query("INSERT INTO organization_memberships(organization_id, id, user_id, status) VALUES ($1, $2, $3, 'active')", [organizationA, membershipA, sharedUser]);
        await client.query('INSERT INTO organization_memberships(organization_id, id, user_id) VALUES ($1, $2, $3)', [organizationA, pendingMembership, pendingUser]);
        await client.query("INSERT INTO membership_roles(organization_id, membership_id, role) VALUES ($1, $2, 'organization_admin'), ($1, $2, 'manager'), ($1, $3, 'foreman')", [organizationA, membershipA, pendingMembership]);
      });
      await inOrganization(organizationB, async client => {
        await client.query("INSERT INTO organization_memberships(organization_id, id, user_id, status) VALUES ($1, $2, $3, 'inactive')", [organizationB, membershipB, sharedUser]);
        await client.query("INSERT INTO membership_roles(organization_id, membership_id, role) VALUES ($1, $2, 'worker')", [organizationB, membershipB]);
      });
      const snapshot = (id: string) => inOrganization(id, client => client.query(`SELECT m.organization_id, m.user_id, m.status, r.role
        FROM organization_memberships m JOIN membership_roles r ON (r.organization_id, r.membership_id) = (m.organization_id, m.id)
        WHERE m.user_id = $1 ORDER BY r.role`, [sharedUser]));
      assert.deepEqual((await snapshot(organizationA)).rows, [
        { organization_id: organizationA, user_id: sharedUser, status: 'active', role: 'manager' },
        { organization_id: organizationA, user_id: sharedUser, status: 'active', role: 'organization_admin' },
      ]);
      assert.deepEqual((await snapshot(organizationB)).rows, [
        { organization_id: organizationB, user_id: sharedUser, status: 'inactive', role: 'worker' },
      ]);
      assert.equal((await pool.query('SELECT count(*) FROM users WHERE id = $1', [sharedUser])).rows[0].count, '1');
      const pending = await inOrganization(organizationA, client => client.query('SELECT status FROM organization_memberships WHERE id = $1', [pendingMembership]));
      assert.equal(pending.rows[0].status, 'pending');
      await inOrganization(organizationA, client => client.query("UPDATE organization_memberships SET status = 'inactive' WHERE id = $1", [membershipA]));
      await inOrganization(organizationB, client => client.query("UPDATE organization_memberships SET status = 'active' WHERE id = $1", [membershipB]));
      assert.equal((await snapshot(organizationA)).rows[0].status, 'inactive');
      assert.deepEqual((await snapshot(organizationB)).rows, [
        { organization_id: organizationB, user_id: sharedUser, status: 'active', role: 'worker' },
      ]);
    });
    await t.test('no organization context means no reads or writes, including inside an explicit transaction', async () => {
      for (const table of tenantTables) {
        assert.deepEqual((await runtime.query(`SELECT * FROM ${table}`)).rows, []);
        assert.equal((await runtime.query(`UPDATE ${table} SET organization_id = organization_id`)).rowCount, 0);
        assert.equal((await runtime.query(`DELETE FROM ${table}`)).rowCount, 0);
      }
      await assert.rejects(runtime.query('INSERT INTO organization_memberships(organization_id, user_id) VALUES ($1, $2)', [organizationB, pendingUser]), { code: '42501' });
      await assert.rejects(runtime.query("INSERT INTO membership_roles(organization_id, membership_id, role) VALUES ($1, $2, 'foreman')", [organizationB, membershipB]), { code: '42501' });
      const client = await runtime.connect();
      try {
        await client.query('BEGIN');
        for (const table of tenantTables) assert.deepEqual((await client.query(`SELECT * FROM ${table}`)).rows, []);
        await client.query("SELECT set_config('sitegrid.organization_id', '', true)");
        assert.deepEqual((await client.query('SELECT * FROM organization_memberships')).rows, []);
        await client.query('COMMIT');
      } finally { client.release(); }
    });
    await t.test('foreign IDs cannot be read, changed, deleted, inserted or moved into another tenant', async () => {
      await inOrganization(organizationA, async client => {
        assert.deepEqual((await client.query('SELECT * FROM organization_memberships WHERE id = $1', [membershipB])).rows, []);
        assert.deepEqual((await client.query('SELECT * FROM membership_roles WHERE membership_id = $1', [membershipB])).rows, []);
        for (const table of tenantTables) {
          assert.equal((await client.query(`UPDATE ${table} SET organization_id = organization_id WHERE organization_id = $1`, [organizationB])).rowCount, 0);
          assert.equal((await client.query(`DELETE FROM ${table} WHERE organization_id = $1`, [organizationB])).rowCount, 0);
        }
        assert.equal((await client.query('SELECT count(*) FROM organization_memberships')).rows[0].count, '2');
      });
      await inOrganization(organizationB, async client => {
        assert.deepEqual((await client.query('SELECT * FROM organization_memberships WHERE id = $1', [membershipA])).rows, []);
        assert.equal((await client.query('SELECT count(*) FROM membership_roles')).rows[0].count, '1');
      });
      await expectSqlError('42501', organizationA, 'INSERT INTO organization_memberships(organization_id, user_id) VALUES ($1, $2)', [organizationB, pendingUser]);
      await expectSqlError('42501', organizationA, "INSERT INTO membership_roles(organization_id, membership_id, role) VALUES ($1, $2, 'manager')", [organizationB, membershipB]);
      await expectSqlError('42501', organizationA, 'UPDATE organization_memberships SET organization_id = $1 WHERE id = $2', [organizationB, pendingMembership]);
      await expectSqlError('42501', organizationA, 'UPDATE membership_roles SET organization_id = $1 WHERE membership_id = $2', [organizationB, membershipA]);
    });
    await t.test('composite FKs reject cross-company and nonexistent relations, even with a valid context', async () => {
      await expectSqlError('23503', organizationA, "INSERT INTO membership_roles(organization_id, membership_id, role) VALUES ($1, $2, 'worker')", [organizationA, membershipB]);
      await expectSqlError('23503', organizationB, "INSERT INTO membership_roles(organization_id, membership_id, role) VALUES ($1, $2, 'manager')", [organizationB, membershipA]);
      await expectSqlError('23503', organizationA, "UPDATE membership_roles SET membership_id = $1 WHERE membership_id = $2 AND role = 'manager'", [membershipB, membershipA]);
      await expectSqlError('23503', organizationA, 'INSERT INTO organization_memberships(organization_id, user_id) VALUES ($1, $2)', [organizationA, randomUUID()]);
      const missingOrganization = randomUUID();
      await expectSqlError('23503', missingOrganization, 'INSERT INTO organization_memberships(organization_id, user_id) VALUES ($1, $2)', [missingOrganization, sharedUser]);
      await expectSqlError('23503', organizationA, "INSERT INTO membership_roles(organization_id, membership_id, role) VALUES ($1, $2, 'worker')", [organizationA, randomUUID()]);
      await expectSqlError('23503', organizationA, 'DELETE FROM organization_memberships WHERE id = $1', [membershipA]);
    });
    await t.test('membership and role duplicates, invalid statuses and platform roles are rejected', async () => {
      await expectSqlError('23505', organizationA, 'INSERT INTO organization_memberships(organization_id, user_id) VALUES ($1, $2)', [organizationA, sharedUser]);
      await expectSqlError('23505', organizationA, "INSERT INTO membership_roles(organization_id, membership_id, role) VALUES ($1, $2, 'manager')", [organizationA, membershipA]);
      await expectSqlError('23514', organizationA, "UPDATE organization_memberships SET status = 'blocked' WHERE id = $1", [membershipA]);
      await expectSqlError('23514', organizationA, "INSERT INTO membership_roles(organization_id, membership_id, role) VALUES ($1, $2, 'platform_admin')", [organizationA, membershipA]);
    });
    await t.test('commit, callback failure and SQL failure never leak context on the same pooled backend', async () => {
      const backend = (await runtime.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      const assertClean = async () => {
        const client = await runtime.connect();
        try {
          await client.query('BEGIN');
          const row = (await client.query("SELECT pg_backend_pid() AS pid, NULLIF(current_setting('sitegrid.organization_id', true), '') AS context")).rows[0];
          assert.deepEqual(row, { pid: backend, context: null });
          for (const table of tenantTables) assert.deepEqual((await client.query(`SELECT * FROM ${table}`)).rows, []);
          await client.query('COMMIT');
        } finally { client.release(); }
      };
      for (const id of [organizationA, organizationB]) {
        await inOrganization(id, async client => {
          const row = (await client.query("SELECT pg_backend_pid() AS pid, current_setting('sitegrid.organization_id') AS context")).rows[0];
          assert.deepEqual(row, { pid: backend, context: id });
          const memberships = await client.query('SELECT organization_id FROM organization_memberships');
          assert(memberships.rows.length > 0);
          assert(memberships.rows.every(row => row.organization_id === id));
        });
        await assertClean();
      }
      const failure = new Error('synthetic callback failure');
      await assert.rejects(inOrganization(organizationA, async client => {
        await client.query("UPDATE organization_memberships SET status = 'pending' WHERE id = $1", [membershipA]);
        throw failure;
      }), error => error === failure);
      await assertClean();
      const afterRollback = await inOrganization(organizationA, client => client.query('SELECT status FROM organization_memberships WHERE id = $1', [membershipA]));
      assert.equal(afterRollback.rows[0].status, 'inactive');
      await expectSqlError('22012', organizationB, 'SELECT 1 / 0');
      await assertClean();
      await assert.rejects(inOrganization('', async () => undefined), /valid organization UUID/);
      await assertClean();
      const accessible = await inOrganization(organizationB, client => client.query('SELECT status FROM organization_memberships WHERE id = $1', [membershipB]));
      assert.equal(accessible.rows[0].status, 'active');
      await assertClean();
    });
  } finally {
    await runtime.end(); await pool.end();
    try { await adminPool.query(`DROP SCHEMA ${schema} CASCADE`); }
    finally { await adminPool.end(); }
  }
});
