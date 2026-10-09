import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { buildApp } from '../apps/server/src/app.js';
import { readConfig } from '../apps/server/src/config.js';
import { createPool } from '../apps/server/src/db.js';
import { migrate, migrationFiles, checkMigrations } from '../apps/server/src/migrations.js';
import { withOrganization } from '../apps/server/src/organization-context.js';
import { lockInvitationCompany } from '../apps/server/src/invitations.js';

test('PR10 company members and employees under real runtime FORCE RLS', { skip: !process.env.TEST_DATABASE_URL }, async t => {
  assert(process.env.TEST_RUNTIME_DATABASE_URL, 'Set a real unprivileged sitegrid runtime URL');
  const schema = `company_members_test_${randomBytes(6).toString('hex')}`;
  const admin = createPool(process.env.TEST_DATABASE_URL!);
  const ownerUrl = new URL(process.env.TEST_DATABASE_URL!); ownerUrl.searchParams.set('options', `-c search_path=${schema}`);
  const owner = createPool(ownerUrl.href);
  const runtimeUrl = new URL(process.env.TEST_RUNTIME_DATABASE_URL); runtimeUrl.searchParams.set('options', `-c search_path=${schema}`);
  const runtime = new pg.Pool({ connectionString: runtimeUrl.href, max: 6, application_name: schema });
  const config = readConfig({ NODE_ENV: 'test', DATABASE_URL: runtimeUrl.href, INVITATION_MANUAL_LINKS: 'true' });
  const app = await buildApp(config, runtime);
  const org = { a: randomUUID(), b: randomUUID(), disabled: randomUUID() };
  const users = Object.fromEntries(['adminA', 'otherA', 'adminB', 'shared', 'pending', 'platform'].map(name => [name, randomUUID()]));
  const memberships: Record<string, string> = {};
  const headers: Record<string, Record<string, string>> = {};
  const base = (id = org.a) => `/api/organizations/${id}`;
  const get = (path: string, actor = 'adminA') => app.inject({ url: path, headers: headers[actor] });
  const post = (path: string, payload: unknown = {}, actor = 'adminA', custom?: Record<string, string>) => app.inject({ method: 'POST', url: path, headers: custom ?? headers[actor], payload });
  const sql = <T>(id: string, work: (client: pg.PoolClient) => Promise<T>) => withOrganization(runtime, id, work);
  const snapshot = async (table: string) => (await owner.query(`SELECT * FROM ${table} ORDER BY to_jsonb(${table})::text`)).rows;
  const waitForCompanyLocks = async (count: number) => {
    for (let i = 0; i < 100; i++) {
      const waiting = (await owner.query("SELECT count(*) FROM pg_stat_activity WHERE application_name = $1 AND wait_event = 'advisory'", [schema])).rows[0].count;
      if (Number(waiting) >= count) return;
      await owner.query('SELECT pg_sleep(0.01)');
    }
    assert.fail(`Expected ${count} requests waiting on the company lock`);
  };
  const seedMember = async (organizationId: string, userId: string, roles: string[], status = 'active') => {
    const id = randomUUID();
    await owner.query('INSERT INTO organization_memberships(organization_id, id, user_id, status) VALUES ($1, $2, $3, $4)', [organizationId, id, userId, status]);
    for (const role of roles) await owner.query('INSERT INTO membership_roles(organization_id, membership_id, role) VALUES ($1, $2, $3)', [organizationId, id, role]);
    return id;
  };
  let employeeA = '', employeeB = '', standalone = '';
  await admin.query(`CREATE SCHEMA ${schema}`);
  try {
    await t.test('schema 6 to 7 preserves populated PR9 data and requires the new release contract', async () => {
      const previous = await mkdtemp(join(tmpdir(), 'sitegrid-pr10-migrations-'));
      try {
        for (const file of (await migrationFiles('migrations')).filter(file => file.version <= 6)) await copyFile(join('migrations', file.name), join(previous, file.name));
        assert.equal(await migrate(owner, previous), 6);
        for (const [name, id] of Object.entries(users)) {
          await owner.query('INSERT INTO users(id, email) VALUES ($1, $2)', [id, `${name.toLowerCase()}@example.test`]);
          await owner.query("INSERT INTO credentials(user_id, password_hash) VALUES ($1, 'preserved-synthetic-hash')", [id]);
          const raw = randomBytes(32).toString('base64url'), csrf = randomBytes(32).toString('base64url');
          await owner.query("INSERT INTO sessions(token_hash, user_id, csrf_token, expires_at) VALUES ($1, $2, $3, now() + interval '1 hour')", [createHash('sha256').update(raw).digest('hex'), id, csrf]);
          headers[name] = { cookie: `sitegrid=${raw}`, origin: config.origin, 'x-csrf-token': csrf };
        }
        await owner.query('INSERT INTO platform_admins(user_id) VALUES ($1)', [users.platform]);
        for (const [name, id] of Object.entries(org)) await owner.query('INSERT INTO organizations(id, name, status) VALUES ($1, $2, $3)', [id, `Firma ${name}`, name === 'disabled' ? 'inactive' : 'active']);
        memberships.adminA = await seedMember(org.a, users.adminA, ['organization_admin']);
        memberships.otherA = await seedMember(org.a, users.otherA, ['organization_admin']);
        memberships.sharedA = await seedMember(org.a, users.shared, ['worker']);
        memberships.pending = await seedMember(org.a, users.pending, ['worker'], 'pending');
        memberships.adminB = await seedMember(org.b, users.adminB, ['organization_admin']);
        memberships.sharedB = await seedMember(org.b, users.shared, ['manager']);
        await owner.query('INSERT INTO organization_invitations(organization_id, email, role, issuer_id, token_hash) VALUES ($1, $2, $3, $4, $5)', [org.a, 'pending@example.test', 'worker', users.adminA, randomBytes(32).toString('hex')]);
        const tables = ['installation', 'users', 'credentials', 'sessions', 'platform_admins', 'organizations', 'organization_memberships', 'membership_roles', 'organization_invitations', 'platform_audit_events'];
        const before = await Promise.all(tables.map(snapshot));
        assert.equal(await migrate(owner, 'migrations'), 7);
        assert.equal(await migrate(owner, 'migrations'), 7);
        assert.equal(await checkMigrations(owner, 'migrations'), 7);
        for (const [i, table] of tables.entries()) assert.deepEqual(await snapshot(table), before[i], table);
        assert.equal((await owner.query('SELECT count(*) FROM employee_profiles')).rows[0].count, '0');
        assert.equal((await owner.query('SELECT count(*) FROM organization_audit_events')).rows[0].count, '0');
        const release = JSON.parse(await readFile('release.json', 'utf8'));
        assert.deepEqual(release.schema, { target: 7, min: 7, max: 7, upgradeMin: 0, upgradeMax: 7 });
        await assert.rejects(checkMigrations(owner, previous), /does not match/);
      } finally { await rm(previous, { recursive: true, force: true }); }
    });
    await owner.query(`GRANT USAGE ON SCHEMA ${schema} TO sitegrid`);
    await owner.query('GRANT SELECT ON installation, schema_migrations, users, credentials, platform_admins TO sitegrid');
    await owner.query('GRANT SELECT, INSERT, DELETE ON sessions TO sitegrid');
    await owner.query('GRANT SELECT, INSERT, UPDATE, DELETE ON auth_rate_limits TO sitegrid');
    const globalBefore = await Promise.all(['users', 'credentials', 'platform_admins'].map(snapshot));
    await t.test('active admin required; manager, worker, pending member and platform admin get no directory', async () => {
      for (const actor of ['shared', 'pending', 'platform']) {
        for (const kind of ['members', 'employees']) assert.equal((await get(`${base()}/${kind}`, actor)).statusCode, 403);
        assert.equal((await post(`${base()}/employees`, { displayName: 'Forbidden' }, actor)).statusCode, 403);
        assert.equal((await post(`${base()}/members/${memberships.adminA}/roles/assign`, { role: 'organization_admin' }, actor)).statusCode, 403);
        assert.equal((await post(`${base()}/members/${memberships.sharedA}/deactivate`, {}, actor)).statusCode, 403);
      }
      assert.equal((await get(`${base(org.b)}/members`, 'shared')).statusCode, 403, 'manager alone cannot administer');
      for (const id of [org.b, org.disabled, randomUUID()]) assert.equal((await get(`${base(id)}/members`)).statusCode, 403);
      assert.equal((await app.inject(`${base()}/members`)).statusCode, 401);
      assert.equal((await post(`${base()}/employees`, { displayName: 'Anonymous' }, 'adminA', {})).statusCode, 401);
      const list = await get(`${base()}/members`);
      assert.equal(list.headers['cache-control'], 'no-store');
      assert.equal(list.json().members.length, 4);
      assert(list.json().members.every((m: { email: string }) => !m.email.includes('adminb')));
    });
    await t.test('minimal local employee profiles work with and without accounts', async () => {
      const before = await snapshot('users');
      const createA = await post(`${base()}/employees`, { membershipId: memberships.sharedA, displayName: 'Jan w A', position: 'Monter', phone: '+48 123' });
      assert.equal(createA.statusCode, 201, createA.body); employeeA = createA.json().employee.id;
      const createB = await post(`${base(org.b)}/employees`, { membershipId: memberships.sharedB, displayName: 'Jan w B' }, 'adminB');
      assert.equal(createB.statusCode, 201, createB.body); employeeB = createB.json().employee.id;
      const unlinked = await post(`${base()}/employees`, { displayName: ' Anna Nowak ' });
      assert.equal(unlinked.statusCode, 201, unlinked.body); standalone = unlinked.json().employee.id;
      assert.equal(unlinked.json().employee.membershipId, null);
      assert.equal(unlinked.json().employee.displayName, 'Anna Nowak');
      assert.deepEqual(await snapshot('users'), before);
      assert.equal((await post(`${base()}/employees/${employeeA}/update`, { displayName: 'Jan Kowalski', position: 'Monter', phone: '123456' })).statusCode, 200);
      const list = (await get(`${base()}/members`)).json().members;
      assert.equal(list.find((m: { id: string }) => m.id === memberships.sharedA).employee.displayName, 'Jan Kowalski');
      assert.equal((await get(`${base(org.b)}/employees`, 'adminB')).json().employees[0].displayName, 'Jan w B');
      assert.equal((await post(`${base()}/employees`, { membershipId: memberships.sharedA, displayName: 'Duplicate' })).statusCode, 409);
      assert.equal((await post(`${base()}/employees`, { membershipId: memberships.pending, displayName: 'Pending' })).statusCode, 409);
    });
    await t.test('cross-company IDs and profile associations cannot read or mutate company B', async () => {
      const before = await snapshot('employee_profiles');
      assert.equal((await post(`${base()}/employees`, { membershipId: memberships.sharedB, displayName: 'Foreign' })).statusCode, 404);
      assert.equal((await post(`${base()}/employees/${employeeB}/update`, { displayName: 'Foreign' })).statusCode, 404);
      assert.equal((await post(`${base()}/employees/${employeeB}/deactivate`)).statusCode, 404);
      assert.equal((await post(`${base()}/members/${memberships.sharedB}/deactivate`)).statusCode, 404);
      assert.equal((await post(`${base()}/members/${memberships.sharedB}/roles/assign`, { role: 'worker' })).statusCode, 404);
      assert.equal((await post(`${base()}/members/${memberships.sharedB}/roles/remove`, { role: 'manager' })).statusCode, 404);
      assert.deepEqual(await snapshot('employee_profiles'), before);
    });
    await t.test('roles are explicit, additive and local; revocation applies to the next request', async () => {
      const target = `${base()}/members/${memberships.sharedA}/roles`;
      for (const role of ['manager', 'foreman', 'organization_admin']) assert.equal((await post(`${target}/assign`, { role })).statusCode, 200);
      const rolesA = () => get(`${base()}/members`).then(r => r.json().members.find((m: { id: string }) => m.id === memberships.sharedA).roles);
      assert.deepEqual(await rolesA(), ['foreman', 'manager', 'organization_admin', 'worker']);
      assert.equal((await get(`${base()}/members`, 'shared')).statusCode, 200);
      assert.equal((await get('/api/admin/overview', 'shared')).statusCode, 403);
      assert.equal((await post(`${target}/remove`, { role: 'organization_admin' })).statusCode, 200);
      assert.equal((await get(`${base()}/members`, 'shared')).statusCode, 403);
      assert.equal((await post(`${target}/remove`, { role: 'manager' })).statusCode, 200);
      assert.deepEqual(await rolesA(), ['foreman', 'worker']);
      assert.deepEqual((await get(`${base(org.b)}/context`, 'shared')).json().organization.roles, ['manager']);
      const auditBefore = await snapshot('organization_audit_events');
      assert.equal((await post(`${target}/assign`, { role: 'worker' })).statusCode, 200);
      assert.equal((await post(`${target}/remove`, { role: 'manager' })).statusCode, 200);
      assert.deepEqual(await snapshot('organization_audit_events'), auditBefore, 'idempotent role actions do not invent changes');
    });
    await t.test('deactivation in A preserves roles, identity, history and access to B; profile statuses agree', async () => {
      const rolesBefore = await snapshot('membership_roles');
      assert.equal((await post(`${base()}/members/${memberships.sharedA}/deactivate`)).statusCode, 200);
      assert.equal((await get(`${base()}/context`, 'shared')).statusCode, 403);
      assert.equal((await get(`${base(org.b)}/context`, 'shared')).statusCode, 200);
      const contexts = (await get('/api/me/organizations', 'shared')).json().organizations;
      assert.deepEqual(contexts.map((o: { id: string }) => o.id), [org.b]);
      assert.equal((await get(`${base()}/employees`)).json().employees.find((e: { id: string }) => e.id === employeeA).status, 'inactive');
      assert.deepEqual(await snapshot('membership_roles'), rolesBefore);
      assert.equal((await post(`${base()}/members/${memberships.sharedA}/reactivate`)).statusCode, 200);
      assert.equal((await get(`${base()}/context`, 'shared')).statusCode, 200);
      assert.equal((await post(`${base()}/employees/${employeeA}/deactivate`)).statusCode, 200);
      assert.equal((await get(`${base()}/context`, 'shared')).statusCode, 403);
      assert.equal((await post(`${base()}/employees/${employeeA}/reactivate`)).statusCode, 200);
      assert.equal((await get(`${base()}/context`, 'shared')).statusCode, 200);
      assert.equal((await post(`${base()}/employees/${standalone}/deactivate`)).statusCode, 200);
      assert.equal((await post(`${base()}/employees/${standalone}/reactivate`)).statusCode, 200);
      assert.equal((await post(`${base()}/members/${memberships.pending}/reactivate`)).statusCode, 409);
      assert.equal((await post(`${base()}/members/${memberships.pending}/deactivate`)).statusCode, 409);
    });
    await t.test('validation, CSRF and Origin protect every new write', async () => {
      const writes: [string, unknown][] = [
        ['employees', { displayName: 'CSRF' }], [`employees/${employeeA}/update`, { displayName: 'CSRF' }],
        [`employees/${employeeA}/deactivate`, {}], [`employees/${employeeA}/reactivate`, {}],
        [`members/${memberships.sharedA}/deactivate`, {}], [`members/${memberships.sharedA}/reactivate`, {}],
        [`members/${memberships.sharedA}/roles/assign`, { role: 'manager' }], [`members/${memberships.sharedA}/roles/remove`, { role: 'worker' }],
      ];
      for (const bad of [{ cookie: headers.adminA.cookie }, { ...headers.adminA, origin: 'https://evil.test' }, { ...headers.adminA, 'x-csrf-token': 'x'.repeat(43) }]) {
        for (const [suffix, body] of writes) assert.equal((await post(`${base()}/${suffix}`, body, 'adminA', bad)).statusCode, 403);
      }
      for (const body of [{ displayName: '' }, { displayName: 12 }, { displayName: 'a'.repeat(121) }, { displayName: 'a\n' }, { displayName: 'Valid', phone: 12 },
        { displayName: 'Valid', organizationId: org.b }, { displayName: 'Valid', userId: users.platform }, { displayName: 'Valid', email: 'changed@example.test' },
        { displayName: 'Valid', status: 'inactive' }, { displayName: 'Valid', membershipId: 'bad' }, { displayName: 'Valid', phone: null }]) {
        assert.equal((await post(`${base()}/employees`, body)).statusCode, 400);
      }
      for (const role of ['platform_admin', 'unknown', 12, null]) assert.equal((await post(`${base()}/members/${memberships.sharedA}/roles/assign`, { role })).statusCode, 400);
      assert.equal((await post(`${base()}/members/${memberships.sharedA}/deactivate`, { userId: users.shared })).statusCode, 400);
      assert.equal((await post(`${base()}/employees/${employeeA}/update`, { displayName: 'Name', membershipId: memberships.adminA })).statusCode, 400);
      assert.equal((await get('/api/organizations/bad/members')).statusCode, 400);
    });
    await t.test('last administrator is protected for roles, memberships and linked employee actions including parallel requests', async () => {
      for (const actions of [['roles/remove', 'roles/remove'], ['deactivate', 'deactivate'], ['roles/remove', 'deactivate'], ['employee', 'employee']]) {
        const id = randomUUID(); await owner.query("INSERT INTO organizations(id, name) VALUES ($1, 'Parallel')", [id]);
        const ids = [await seedMember(id, users.adminA, ['organization_admin']), await seedMember(id, users.otherA, ['organization_admin'])];
        const employeeIds: string[] = [];
        if (actions[0] === 'employee') for (let i = 0; i < 2; i++) {
          const created = await post(`${base(id)}/employees`, { displayName: 'Admin', membershipId: ids[i] }, i ? 'otherA' : 'adminA');
          assert.equal(created.statusCode, 201, created.body); employeeIds.push(created.json().employee.id);
        }
        const blocker = await owner.connect();
        let results;
        try {
          await blocker.query('BEGIN'); await lockInvitationCompany(blocker, id);
          const requests = actions.map((action, i) => post(action === 'employee'
            ? `${base(id)}/employees/${employeeIds[i]}/deactivate` : `${base(id)}/members/${ids[i]}/${action}`,
          action === 'roles/remove' ? { role: 'organization_admin' } : {}, i ? 'otherA' : 'adminA'));
          // Fastify's inject thenables start when awaited.
          const pending = Promise.all(requests);
          await waitForCompanyLocks(2);
          await blocker.query('COMMIT');
          results = await pending;
        } finally { await blocker.query('ROLLBACK'); blocker.release(); }
        assert.deepEqual(results.map(r => r.statusCode).sort(), [200, 409], results.map(r => r.body).join('\n'));
        const remaining = (await owner.query(`SELECT m.id FROM organization_memberships m JOIN membership_roles r
          ON (r.organization_id, r.membership_id) = (m.organization_id, m.id)
          WHERE m.organization_id = $1 AND m.status = 'active' AND r.role = 'organization_admin'`, [id])).rows;
        assert.equal(remaining.length, 1);
        const loser = results.findIndex(result => result.statusCode === 409);
        const actor = loser ? 'otherA' : 'adminA';
        assert.equal((await post(`${base(id)}/members/${remaining[0].id}/roles/remove`, { role: 'organization_admin' }, actor)).statusCode, 409);
        assert.equal((await post(`${base(id)}/members/${remaining[0].id}/deactivate`, {}, actor)).statusCode, 409);
        assert.equal((await get(`${base(id)}/members`, loser ? 'adminA' : 'otherA')).statusCode, 403);
      }
    });
    await t.test('database guard serializes direct concurrent SQL and fails closed with a stale isolation snapshot', async () => {
      const id = randomUUID(); await owner.query("INSERT INTO organizations(id, name) VALUES ($1, 'SQL guard')", [id]);
      const ids = [await seedMember(id, users.adminA, ['organization_admin']), await seedMember(id, users.otherA, ['organization_admin'])];
      const blocker = await owner.connect();
      let results;
      try {
        await blocker.query('BEGIN'); await lockInvitationCompany(blocker, id);
        const pending = Promise.allSettled(ids.map(memberId => sql(id, client => client.query("DELETE FROM membership_roles WHERE organization_id = $1 AND membership_id = $2 AND role = 'organization_admin'", [id, memberId]))));
        await waitForCompanyLocks(2);
        await blocker.query('COMMIT');
        results = await pending;
      } finally { await blocker.query('ROLLBACK'); blocker.release(); }
      assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
      const rejected = results.find(r => r.status === 'rejected');
      assert(rejected?.status === 'rejected'); assert.equal(rejected.reason.constraint, 'company_last_administrator');
      await assert.rejects(sql(id, client => client.query("UPDATE membership_roles SET role = 'manager' WHERE organization_id = $1 AND role = 'organization_admin'", [id])), { constraint: 'company_last_administrator' });
      await assert.rejects(sql(id, client => client.query("DELETE FROM organization_memberships WHERE organization_id = $1 AND id IN (SELECT membership_id FROM membership_roles WHERE role = 'organization_admin')", [id])), { constraint: 'company_last_administrator' });
      await assert.rejects(sql(id, client => client.query("UPDATE organization_memberships SET status = 'inactive' WHERE organization_id = $1 AND id = ANY($2::uuid[])", [id, ids])), { constraint: 'company_last_administrator' });
      const client = await runtime.connect();
      try {
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
        await client.query("SELECT set_config('sitegrid.organization_id', $1, true)", [id]);
        await assert.rejects(client.query("DELETE FROM membership_roles WHERE organization_id = $1 AND role = 'organization_admin'", [id]), { code: '40001' });
      } finally { await client.query('ROLLBACK'); client.release(); }
    });
    await t.test('member and invitation requests waiting for the company lock recheck a revoked actor', async () => {
      for (const [suffix, payload] of [['employees', { displayName: 'Must not exist' }], ['invitations', { email: 'must-not-exist@example.test', role: 'worker' }]] as const) {
        const blocker = await owner.connect();
        try {
          await blocker.query('BEGIN'); await lockInvitationCompany(blocker, org.a);
          const waiting = post(`${base()}/${suffix}`, payload, 'otherA');
          // Start inject before verifying that the request really is waiting.
          const pending = Promise.resolve(waiting);
          await waitForCompanyLocks(1);
          await blocker.query("DELETE FROM membership_roles WHERE organization_id = $1 AND membership_id = $2 AND role = 'organization_admin'", [org.a, memberships.otherA]);
          await blocker.query('COMMIT');
          assert.equal((await pending).statusCode, 403);
        } finally { await blocker.query('ROLLBACK'); blocker.release(); }
        await owner.query("INSERT INTO membership_roles(organization_id, membership_id, role) VALUES ($1, $2, 'organization_admin')", [org.a, memberships.otherA]);
      }
      assert.equal((await owner.query("SELECT count(*) FROM employee_profiles WHERE display_name = 'Must not exist'")).rows[0].count, '0');
      assert.equal((await owner.query("SELECT count(*) FROM organization_invitations WHERE email = 'must-not-exist@example.test'")).rows[0].count, '0');
    });
    await t.test('FORCE RLS and composite FKs isolate employees and immutable audit under runtime login', async () => {
      assert.deepEqual((await runtime.query('SELECT current_user, session_user, rolsuper, rolbypassrls, rolcreaterole FROM pg_roles WHERE rolname = current_user')).rows[0],
        { current_user: 'sitegrid', session_user: 'sitegrid', rolsuper: false, rolbypassrls: false, rolcreaterole: false });
      const flags = (await runtime.query(`SELECT relname, relrowsecurity, relforcerowsecurity, row_security_active(c.oid) AS active,
        pg_has_role(current_user, relowner, 'MEMBER') AS owns, has_table_privilege(current_user, c.oid, 'TRUNCATE') AS truncate
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1
        AND relname IN ('employee_profiles', 'organization_audit_events')`, [schema])).rows;
      assert.equal(flags.length, 2);
      for (const flag of flags) { assert(flag.relrowsecurity && flag.relforcerowsecurity && flag.active); assert(!flag.owns && !flag.truncate); }
      for (const table of ['employee_profiles', 'organization_audit_events']) assert.deepEqual((await runtime.query(`SELECT * FROM ${table}`)).rows, []);
      await sql(org.a, async client => {
        assert.deepEqual((await client.query('SELECT * FROM employee_profiles WHERE id = $1', [employeeB])).rows, []);
        assert.equal((await client.query("UPDATE employee_profiles SET phone = 'foreign' WHERE id = $1", [employeeB])).rowCount, 0);
        assert.deepEqual((await client.query('SELECT * FROM organization_audit_events WHERE organization_id = $1', [org.b])).rows, []);
      });
      await assert.rejects(sql(org.a, client => client.query('INSERT INTO employee_profiles(organization_id, display_name) VALUES ($1, $2)', [org.b, 'Foreign'])), { code: '42501' });
      await assert.rejects(sql(org.a, client => client.query('INSERT INTO employee_profiles(organization_id, membership_id, display_name) VALUES ($1, $2, $3)', [org.a, memberships.sharedB, 'Foreign'])), { code: '23503' });
      await assert.rejects(sql(org.a, client => client.query('INSERT INTO organization_audit_events(organization_id, actor_id, subject_id, event) VALUES ($1, $2, $3, $4)', [org.b, users.adminA, employeeA, 'employee_updated'])), { code: '42501' });
      await assert.rejects(sql(org.a, client => client.query('DELETE FROM organization_audit_events')), { code: '42501' });
      await assert.rejects(sql(org.a, client => client.query("UPDATE credentials SET password_hash = 'changed'")), { code: '42501' });
      await assert.rejects(sql(org.a, client => client.query("UPDATE users SET email = 'changed@example.test'")), { code: '42501' });
      await assert.rejects(sql(org.a, client => client.query('DELETE FROM employee_profiles')), { code: '42501' });
      const settings = (await runtime.query("SELECT NULLIF(current_setting('sitegrid.organization_id', true), '') AS tenant, NULLIF(current_setting('sitegrid.user_id', true), '') AS actor")).rows[0];
      assert.deepEqual(settings, { tenant: null, actor: null });
    });
    await t.test('audit failure rolls back profile, status synchronization and roles together', async () => {
      await owner.query(`CREATE FUNCTION reject_company_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Synthetic audit failure'; END $$`);
      await owner.query('CREATE TRIGGER reject_company_audit BEFORE INSERT ON organization_audit_events FOR EACH ROW EXECUTE FUNCTION reject_company_audit()');
      const tables = ['employee_profiles', 'organization_memberships', 'membership_roles', 'organization_audit_events'];
      const before = await Promise.all(tables.map(snapshot));
      try {
        for (const [suffix, payload] of [
          ['employees', { displayName: 'Rolled back' }], [`employees/${employeeA}/update`, { displayName: 'Rolled back' }],
          [`employees/${employeeA}/deactivate`, {}], [`members/${memberships.sharedA}/deactivate`, {}],
          [`members/${memberships.sharedA}/roles/assign`, { role: 'manager' }], [`members/${memberships.sharedA}/roles/remove`, { role: 'worker' }],
        ] as [string, unknown][]) assert.equal((await post(`${base()}/${suffix}`, payload)).statusCode, 503);
        for (const [i, table] of tables.entries()) assert.deepEqual(await snapshot(table), before[i], table);
      } finally { await owner.query('DROP TRIGGER reject_company_audit ON organization_audit_events'); await owner.query('DROP FUNCTION reject_company_audit()'); }
      const auditRows = (await owner.query('SELECT event, actor_id, subject_id, details FROM organization_audit_events WHERE organization_id = $1', [org.a])).rows;
      for (const event of ['employee_created', 'employee_updated', 'employee_deactivated', 'employee_reactivated', 'membership_deactivated', 'membership_reactivated', 'role_assigned', 'role_removed']) assert(auditRows.some(row => row.event === event), event);
      assert(auditRows.every(row => row.actor_id && row.subject_id));
      for (const [i, table] of ['users', 'credentials', 'platform_admins'].entries()) assert.deepEqual(await snapshot(table), globalBefore[i], table);
    });
  } finally {
    await app.close(); await runtime.end(); await owner.end();
    try { await admin.query(`DROP SCHEMA ${schema} CASCADE`); } finally { await admin.end(); }
  }
});
