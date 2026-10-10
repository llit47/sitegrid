import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import pg from 'pg';
import { buildApp } from '../apps/server/src/app.js';
import { readConfig } from '../apps/server/src/config.js';
import { migrate, checkMigrations, migrationFiles } from '../apps/server/src/migrations.js';
import { withOrganization } from '../apps/server/src/organization-context.js';
import { lockOrganization } from '../apps/server/src/common/organization-lock.js';
import { contractorInput, contractorIdentifier } from '../apps/server/src/contractors/domain.js';

test('contractor validation permits only names, controlled status/version and nullable UUID associations', () => {
  assert.equal(contractorInput({ name: '  Klient Łódź  ' }).name, 'Klient Łódź');
  assert.equal(contractorIdentifier(null), null);
  const id = randomUUID(); assert.equal(contractorIdentifier(id.toUpperCase()), id);
  for (const value of [undefined, '', 'bad', 4, {}, []]) assert.throws(() => contractorIdentifier(value));
  for (const value of [null, [], {}, { name: ' ' }, { name: 4 }, { name: 'A\nB' }, { name: 'A\u0000B' }, { name: 'x'.repeat(201) }, { name: 'A', organizationId: id }, { name: 'A', status: 'inactive' }]) assert.throws(() => contractorInput(value));
  for (const expectedVersion of [0, -1, 1.5, '1', null, 2147483647]) assert.throws(() => contractorInput({ name: 'A', status: 'active', expectedVersion }, true));
  assert.throws(() => contractorInput({ name: 'A', status: 'archived', expectedVersion: 1 }, true));
});

test('M09C contractors, populated schema 10 upgrade and real unprivileged FORCE RLS', { skip: !process.env.TEST_DATABASE_URL }, async t => {
  assert(process.env.TEST_RUNTIME_DATABASE_URL, 'A real unprivileged runtime URL is required');
  const schema = `contractors_test_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const ownerUrl = new URL(process.env.TEST_DATABASE_URL!), runtimeUrl = new URL(process.env.TEST_RUNTIME_DATABASE_URL);
  for (const url of [ownerUrl, runtimeUrl]) url.searchParams.set('options', `-c search_path=${schema}`);
  const owner = new pg.Pool({ connectionString: ownerUrl.href });
  const runtime = new pg.Pool({ connectionString: runtimeUrl.href, max: 6, application_name: schema });
  const config = readConfig({ NODE_ENV: 'test', DATABASE_URL: runtimeUrl.href });
  const app = await buildApp(config, runtime);
  const org = { a: randomUUID(), b: randomUUID() }, projects = { one: randomUUID(), two: randomUUID(), hidden: randomUUID(), b: randomUUID() };
  const users: Record<string, string> = {}, members: Record<string, string> = {}, headers: Record<string, Record<string, string>> = {};
  const contractors: Record<string, string> = {}, tasks: Record<string, string> = {};
  const base = (tenant = org.a) => `/api/organizations/${tenant}/contractors`;
  const projectBase = (tenant = org.a) => `/api/organizations/${tenant}/projects`;
  const projectPath = (id = projects.one, tenant = org.a) => `${projectBase(tenant)}/${id}`;
  const get = (url: string, actor = 'adminA') => app.inject({ url, headers: headers[actor] });
  const post = (url: string, payload: unknown, actor = 'adminA', supplied?: Record<string, string>) => app.inject({ method: 'POST', url, payload, headers: supplied ?? headers[actor] });
  const current = async (key = 'one') => (await get(base())).json().contractors.find((item: { id: string }) => item.id === contractors[key]);
  const project = async (id = projects.one) => (await get(projectPath(id))).json().project;
  const update = async (key: string, changes: object = {}) => {
    const item = await current(key);
    return post(`${base()}/${item.id}/update`, { name: item.name, status: item.status, expectedVersion: item.version, ...changes });
  };
  const associate = async (id: string, contractorId: string | null) => {
    const item = await project(id);
    return post(`${projectPath(id)}/update`, { name: item.name, description: item.description, contractorId, expectedVersion: item.version });
  };
  const snapshot = async (table: string) => (await owner.query(`SELECT * FROM ${table} ORDER BY to_jsonb(${table})::text`)).rows;
  const unchanged = async (work: () => Promise<void>) => {
    const tables = ['contractors', 'projects', 'tasks', 'project_memberships', 'task_progress_receipts', 'organization_audit_events'];
    const before = await Promise.all(tables.map(snapshot)); await work();
    for (const [i, table] of tables.entries()) assert.deepEqual(await snapshot(table), before[i], table);
  };
  const asActor = <T>(actor: string, tenant: string, work: (client: pg.PoolClient) => Promise<T>) => withOrganization(runtime, tenant, async client => {
    await client.query("SELECT set_config('sitegrid.user_id', $1, true)", [users[actor]]); return work(client);
  });
  const waitForLock = async () => {
    for (let attempt = 0; attempt < 150; attempt++) {
      if (Number((await owner.query("SELECT count(*) FROM pg_stat_activity WHERE application_name = $1 AND wait_event = 'advisory'", [schema])).rows[0].count)) return;
      await owner.query('SELECT pg_sleep(0.01)');
    }
    assert.fail('Request did not wait for the company lock');
  };
  const command = { operationId: randomUUID(), schemaVersion: 1, action: 'start', expectedVersion: 1 };
  const progress = (task: string, proj: string, body: object = command) => post(`${projectPath(proj)}/tasks/${task}/commands`, body, 'worker');
  await admin.query(`CREATE SCHEMA ${schema}`);
  const previous = await mkdtemp(join(tmpdir(), 'contractors-schema10-'));
  try {
    for (const file of (await migrationFiles('migrations')).filter(file => file.version <= 10)) await copyFile(join('migrations', file.name), join(previous, file.name));
    assert.equal(await migrate(owner, previous), 10);
    await owner.query(`GRANT USAGE ON SCHEMA ${schema} TO sitegrid`);
    await owner.query('GRANT SELECT ON installation, schema_migrations, users, credentials, platform_admins TO sitegrid');
    await owner.query('GRANT SELECT, INSERT, DELETE ON sessions TO sitegrid');
    await owner.query('GRANT SELECT, INSERT, UPDATE, DELETE ON auth_rate_limits TO sitegrid');
    for (const [key, id] of Object.entries(org)) await owner.query('INSERT INTO organizations(id,name) VALUES ($1,$2)', [id, `Firma ${key}`]);
    for (const [name, role, status] of [
      ['adminA', 'organization_admin', 'active'], ['adminB', 'organization_admin', 'active'], ['revocable', 'organization_admin', 'active'],
      ['manager', 'manager', 'active'], ['foreman', 'foreman', 'active'], ['worker', 'worker', 'active'], ['worker2', 'worker', 'active'],
      ['unassigned', 'worker', 'active'], ['roleless', '', 'active'], ['platform', 'worker', 'active'], ['blocked', 'worker', 'active'], ['inactive', 'worker', 'inactive'],
    ]) {
      users[name] = randomUUID(); members[name] = randomUUID();
      await owner.query('INSERT INTO users(id,email) VALUES ($1,$2)', [users[name], `${name.toLowerCase()}@example.test`]);
      await owner.query("INSERT INTO credentials(user_id,password_hash) VALUES ($1,'preserved-hash')", [users[name]]);
      const raw = randomBytes(32).toString('base64url'), csrf = randomBytes(32).toString('base64url');
      await owner.query("INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at) VALUES ($1,$2,$3,now()+interval '1 hour')", [createHash('sha256').update(raw).digest('hex'), users[name], csrf]);
      headers[name] = { cookie: `sitegrid=${raw}`, origin: config.origin, 'x-csrf-token': csrf };
      const tenant = name === 'adminB' ? org.b : org.a;
      await owner.query('INSERT INTO organization_memberships(organization_id,id,user_id,status) VALUES ($1,$2,$3,$4)', [tenant, members[name], users[name], status]);
      if (role) await owner.query('INSERT INTO membership_roles(organization_id,membership_id,role) VALUES ($1,$2,$3)', [tenant, members[name], role]);
    }
    members.workerB = randomUUID();
    await owner.query("INSERT INTO organization_memberships(organization_id,id,user_id,status) VALUES ($1,$2,$3,'active')", [org.b, members.workerB, users.worker]);
    await owner.query("INSERT INTO membership_roles(organization_id,membership_id,role) VALUES ($1,$2,'worker')", [org.b, members.workerB]);
    await owner.query('INSERT INTO platform_admins(user_id) VALUES ($1)', [users.platform]);
    await owner.query('UPDATE users SET blocked_at = now() WHERE id = $1', [users.blocked]);
    for (const [key, id] of Object.entries(projects)) await owner.query('INSERT INTO projects(organization_id,id,name) VALUES ($1,$2,$3)', [key === 'b' ? org.b : org.a, id, `Projekt ${key}`]);
    for (const key of ['one', 'two']) for (const actor of ['manager', 'foreman', 'worker', 'worker2']) await owner.query('INSERT INTO project_memberships(organization_id,project_id,membership_id) VALUES ($1,$2,$3)', [org.a, projects[key as 'one' | 'two'], members[actor]]);
    await owner.query('INSERT INTO project_memberships(organization_id,project_id,membership_id) VALUES ($1,$2,$3)', [org.b, projects.b, members.workerB]);
    await withOrganization(owner, org.a, async client => {
      await client.query("SELECT set_config('sitegrid.user_id', $1, true)", [users.manager]);
      for (const key of ['one', 'two']) {
        tasks[key] = (await client.query('INSERT INTO tasks(organization_id,project_id,title,assignee_membership_id,author_membership_id) VALUES ($1,$2,$3,$4,$5) RETURNING id', [org.a, projects[key as 'one' | 'two'], `Zadanie ${key}`, members.worker, members.manager])).rows[0].id;
      }
      await client.query('INSERT INTO tasks(organization_id,project_id,title,assignee_membership_id,author_membership_id) VALUES ($1,$2,$3,$4,$5)', [org.a, projects.one, 'Cudze zadanie', members.worker2, members.manager]);
    });
    await owner.query("INSERT INTO employee_profiles(organization_id,membership_id,display_name) VALUES ($1,$2,'Monter')", [org.a, members.worker]);
    await owner.query("INSERT INTO organization_settings(organization_id,accent_color,version) VALUES ($1,'#123456',3)", [org.a]);
    await owner.query("INSERT INTO organization_logos(organization_id,data,mime_type,version) VALUES ($1,$2,'image/png',3)", [org.a, Buffer.from('preserved-logo')]);
    await owner.query("INSERT INTO organization_invitations(organization_id,email,role,issuer_id,token_hash) VALUES ($1,'invited@example.test','worker',$2,$3)", [org.a, users.adminA, randomBytes(32).toString('hex')]);
    const originalProgress = await progress(tasks.one, projects.one); // populate a real M08 receipt before upgrade
    assert.equal(originalProgress.statusCode, 200);

    await t.test('schema 10 → 11 preserves every populated table, project version, task assignment and receipt', async () => {
      const tables = (await owner.query('SELECT tablename FROM pg_tables WHERE schemaname = $1 ORDER BY tablename', [schema])).rows.map(row => row.tablename as string);
      const before = await Promise.all(tables.map(snapshot));
      assert.equal((await app.inject('/health/ready')).statusCode, 503);
      assert.equal(await migrate(owner, 'migrations'), 11); assert.equal(await migrate(owner, 'migrations'), 11);
      assert.equal(await checkMigrations(owner, 'migrations'), 11);
      for (const [i, table] of tables.entries()) {
        const after = await snapshot(table);
        assert.deepEqual(table === 'schema_migrations' ? after.filter(row => row.version <= 10) : after,
          table === 'projects' ? before[i].map(row => ({ ...row, contractor_id: null })) : before[i], table);
      }
      assert.deepEqual(await snapshot('contractors'), []);
      assert((await get(projectBase())).json().projects.every((item: { contractor: unknown }) => item.contractor === null));
      assert.equal((await app.inject('/health/ready')).statusCode, 200);
      assert.deepEqual(JSON.parse(await readFile('release.json', 'utf8')).schema, { target: 11, min: 11, max: 11, upgradeMin: 0, upgradeMax: 11 });
      await assert.rejects(checkMigrations(owner, previous), /does not match/);
      await assert.rejects(migrate(owner, previous), /Migration history mismatch/);
    });
    await t.test('fresh schema installs all eleven migrations and repeats safely', async () => {
      const fresh = `${schema}_fresh`; await admin.query(`CREATE SCHEMA ${fresh}`);
      const url = new URL(process.env.TEST_DATABASE_URL!); url.searchParams.set('options', `-c search_path=${fresh}`);
      const pool = new pg.Pool({ connectionString: url.href });
      try { assert.equal(await migrate(pool, 'migrations'), 11); assert.equal(await migrate(pool, 'migrations'), 11); assert.equal(await checkMigrations(pool, 'migrations'), 11); }
      finally { await pool.end(); await admin.query(`DROP SCHEMA ${fresh} CASCADE`); }
    });
    await t.test('administrators create independent directories with overlapping names and no new identities', async () => {
      const before = await Promise.all(['organizations', 'users', 'organization_memberships', 'membership_roles', 'organization_invitations'].map(snapshot));
      for (const [key, tenant, actor, name] of [['one', org.a, 'adminA', ' Wspólna nazwa '], ['two', org.a, 'adminA', 'Drugi klient'], ['hidden', org.a, 'adminA', 'Poufny katalog'], ['b', org.b, 'adminB', 'Wspólna nazwa']]) {
        const response = await post(base(tenant), { name }, actor);
        assert.equal(response.statusCode, 201, response.body); const item = response.json().contractor;
        contractors[key] = item.id; assert.equal(item.name, name.trim()); assert.equal(item.status, 'active'); assert.equal(item.version, 1); assert(item.createdAt && item.updatedAt);
        assert.equal(response.headers['cache-control'], 'no-store');
      }
      assert.equal((await get(base())).json().contractors.length, 3);
      assert.equal((await get(base(org.b), 'adminB')).json().contractors.length, 1);
      for (const [i, table] of ['organizations', 'users', 'organization_memberships', 'membership_roles', 'organization_invitations'].entries()) assert.deepEqual(await snapshot(table), before[i], table);
      assert.notEqual(contractors.one, contractors.b);
    });
    await t.test('directory reads and writes require company administration, without platform inheritance', async () => {
      const item = await current();
      for (const actor of ['manager', 'foreman', 'worker', 'worker2', 'unassigned', 'roleless', 'platform', 'inactive', 'adminB']) {
        assert.equal((await get(base(), actor)).statusCode, 403, actor);
        assert.equal((await post(base(), { name: 'Denied' }, actor)).statusCode, 403, actor);
        assert.equal((await post(`${base()}/${item.id}/update`, { name: 'Denied', status: 'inactive', expectedVersion: item.version }, actor)).statusCode, 403, actor);
        assert.equal((await post(`${projectPath()}/update`, { name: 'Denied', contractorId: item.id, expectedVersion: 1 }, actor)).statusCode, 403, actor);
      }
      assert.equal((await app.inject(base())).statusCode, 401);
      assert.equal((await get(base(), 'blocked')).statusCode, 401);
      for (const id of [contractors.b, randomUUID()]) {
        const response = await post(`${base()}/${id}/update`, { name: 'Denied', status: 'active', expectedVersion: 0 });
        assert.equal(response.statusCode, 400); // invalid payload is not a resource lookup
        assert.equal((await post(`${base()}/${id}/update`, { name: 'Denied', status: 'active', expectedVersion: 1 })).statusCode, 404);
      }
      assert.equal((await app.inject({ method: 'DELETE', url: `${base()}/${item.id}`, headers: headers.adminA })).statusCode, 404);
    });
    await t.test('link, change and unlink use project versions/audit; omitted association preserves older clients', async () => {
      const otherTables = ['tasks', 'project_memberships', 'task_progress_receipts'];
      const before = await Promise.all(otherTables.map(snapshot));
      for (const [id, key] of [[projects.one, 'one'], [projects.two, 'two'], [projects.hidden, 'hidden']]) assert.equal((await associate(id, contractors[key])).statusCode, 200);
      assert.equal((await post(`${projectPath(projects.b, org.b)}/update`, { name: 'Projekt b', contractorId: contractors.b, expectedVersion: 1 }, 'adminB')).statusCode, 200);
      const created = await post(projectBase(), { name: 'Drugi projekt pierwszego klienta', contractorId: contractors.one });
      assert.equal(created.statusCode, 201, created.body); assert.equal(created.json().project.contractor.id, contractors.one);
      const first = await project(); assert.deepEqual(first.contractor, { id: contractors.one, name: 'Wspólna nazwa', status: 'active' });
      assert.equal((await associate(projects.one, contractors.two)).statusCode, 200);
      assert.equal((await associate(projects.one, null)).json().project.contractor, null);
      assert.equal((await associate(projects.one, contractors.one)).statusCode, 200);
      const item = await project();
      const legacy = await post(`${projectPath()}/update`, { name: 'Nazwa starszego klienta API', expectedVersion: item.version });
      assert.equal(legacy.statusCode, 200); assert.equal(legacy.json().project.contractor.id, contractors.one);
      assert.equal((await post(`${projectPath()}/update`, { name: 'Stale', contractorId: null, expectedVersion: item.version })).statusCode, 409);
      for (const [i, table] of otherTables.entries()) assert.deepEqual(await snapshot(table), before[i], table);
      const audits = (await snapshot('organization_audit_events')).filter(row => row.event === 'project_updated');
      assert(audits.some(row => row.details.beforeContractorId === contractors.two && row.details.afterContractorId === null));
      for (const row of audits) assert.equal(row.details.afterVersion, row.details.beforeVersion + 1);
    });
    await t.test('authorized project metadata and filters expose no directory or extra project/task permissions', async () => {
      for (const actor of ['manager', 'foreman', 'worker']) {
        const response = await get(projectBase(), actor); assert.equal(response.statusCode, 200);
        assert.deepEqual(response.json().projects.map((item: { id: string }) => item.id).sort(), [projects.one, projects.two].sort());
        for (const item of response.json().projects) assert.deepEqual(Object.keys(item.contractor).sort(), ['id', 'name', 'status']);
        assert.equal((await get(projectPath(projects.hidden), actor)).statusCode, 404);
        assert.equal((await get(`${projectBase()}?contractorId=${contractors.hidden}`, actor)).json().projects.length, 0);
        assert.equal((await get(`${projectBase()}?contractorId=${contractors.b}`, actor)).json().projects.length, 0);
        assert.equal((await get(`${projectBase()}?contractorId=${contractors.one}`, actor)).json().projects.length, 1);
      }
      assert.equal((await get(`${projectBase()}?contractorId=none`, 'worker')).json().projects.length, 0);
      assert.equal((await get(`${projectBase()}?contractorId=bad`)).statusCode, 400);
      assert.equal((await get(projectBase(), 'unassigned')).json().projects.length, 0);
      assert.equal((await get(projectBase(), 'platform')).json().projects.length, 0);
      assert.equal((await get(`${projectPath()}/tasks`, 'worker')).json().tasks.length, 1);
      assert.equal((await get(`${projectPath()}/tasks`, 'manager')).json().tasks.length, 2);
      assert.equal((await get(`${projectPath()}/tasks`)).statusCode, 404); // metadata administration never grants task access
      assert.equal((await get(projectBase(org.b), 'worker')).json().projects[0].contractor.id, contractors.b);
    });
    await t.test('deactivation preserves history, rejects new assignments and allows unrelated edits/archival', async () => {
      const before = await project(), original = await current();
      assert.equal((await update('one', { name: 'Zmieniona nazwa', status: 'inactive' })).statusCode, 200);
      const historical = (await get(projectPath(), 'worker')).json().project;
      assert.equal(historical.version, before.version); assert.equal(historical.contractor.status, 'inactive'); assert.equal(historical.contractor.name, 'Zmieniona nazwa');
      const failedBodies = [];
      await unchanged(async () => {
        for (const id of [contractors.one, contractors.b, randomUUID()]) {
          const response = await post(projectBase(), { name: 'Denied', contractorId: id }); assert.equal(response.statusCode, 400); failedBodies.push(response.body);
          assert.equal((await associate(projects.two, id)).statusCode, 400);
        }
      });
      assert.equal(new Set(failedBodies).size, 1);
      const retained = await post(`${projectPath()}/update`, { name: 'Edytowany z historią', contractorId: contractors.one, expectedVersion: historical.version });
      assert.equal(retained.statusCode, 200, retained.body); assert.equal(retained.json().project.contractor.id, original.id);
      const archived = await post(projectBase(), { name: 'Do archiwum', contractorId: contractors.two });
      const id = archived.json().project.id;
      assert.equal((await post(`${projectPath(id)}/archive`, { expectedVersion: 1 })).statusCode, 200);
      await update('two', { status: 'inactive' });
      assert.equal((await get(projectPath(id))).json().project.contractor.status, 'inactive');
      await update('one', { status: 'active' }); await update('two', { status: 'active' });
      const events = (await snapshot('organization_audit_events')).map(row => row.event);
      assert(events.includes('contractor_deactivated') && events.includes('contractor_reactivated'));
    });
    await t.test('malformed names/status/IDs/versions and immutable input fail without mutations', async () => {
      const item = await current();
      await unchanged(async () => {
        for (const body of [null, [], {}, { name: ' ' }, { name: 4 }, { name: 'x'.repeat(201) }, { name: 'A\nB' }, { name: 'A', organizationId: org.b }, { name: 'A', status: 'inactive' }]) assert.equal((await post(base(), body)).statusCode, 400);
        for (const changes of [{ name: null }, { status: 'archived' }, { expectedVersion: '1' }, { expectedVersion: -1 }, { expectedVersion: 1.5 }, { expectedVersion: 2147483647 }, { actorId: users.adminB }]) assert.equal((await post(`${base()}/${item.id}/update`, { name: 'A', status: 'active', expectedVersion: item.version, ...changes })).statusCode, 400);
        for (const contractorId of ['', 'bad', 5, {}, []]) assert.equal((await post(projectBase(), { name: 'A', contractorId })).statusCode, 400);
        assert.equal((await get('/api/organizations/bad/contractors')).statusCode, 400);
        assert.equal((await post(`${base()}/bad/update`, {})).statusCode, 400);
      });
    });
    await t.test('Origin/CSRF apply to contractor and association mutations', async () => {
      const item = await current(), proj = await project();
      await unchanged(async () => {
        for (const [url, body] of [[base(), { name: 'Denied' }], [`${base()}/${item.id}/update`, { name: 'Denied', status: 'inactive', expectedVersion: item.version }], [`${projectPath()}/update`, { name: 'Denied', contractorId: null, expectedVersion: proj.version }]]) {
          for (const supplied of [{ cookie: headers.adminA.cookie }, { ...headers.adminA, origin: 'https://evil.test' }, { ...headers.adminA, 'x-csrf-token': 'x'.repeat(43) }]) assert.equal((await post(url as string, body, 'adminA', supplied)).statusCode, 403);
        }
      });
    });
    await t.test('concurrent contractor/association edits have one winner and one audit; conflicts preserve authorized current data', async () => {
      const item = await current('two'), proj = await project();
      for (const [url, a, b, resource] of [
        [`${base()}/${item.id}/update`, { name: 'Wygrana A', status: 'active', expectedVersion: item.version }, { name: 'Wygrana B', status: 'active', expectedVersion: item.version }, 'contractor'],
        [`${projectPath()}/update`, { name: 'Wyścig A', contractorId: contractors.one, expectedVersion: proj.version }, { name: 'Wyścig B', contractorId: contractors.two, expectedVersion: proj.version }, 'project'],
      ] as [string, object, object, string][]) {
        const count = (await snapshot('organization_audit_events')).length;
        const responses = await Promise.all([post(url, a), post(url, b)]);
        assert.deepEqual(responses.map(response => response.statusCode).sort(), [200, 409]);
        assert.equal(responses.find(response => response.statusCode === 409)!.json()[resource].version, responses.find(response => response.statusCode === 200)!.json()[resource].version);
        assert.equal((await snapshot('organization_audit_events')).length, count + 1);
      }
      await associate(projects.one, contractors.one);
    });
    await t.test('audit failure rolls back contractor creation/edit/status and project association atomically', async () => {
      await owner.query("CREATE FUNCTION reject_contractor_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Synthetic audit failure'; END $$");
      await owner.query('CREATE TRIGGER reject_contractor_audit BEFORE INSERT ON organization_audit_events FOR EACH ROW EXECUTE FUNCTION reject_contractor_audit()');
      try {
        await unchanged(async () => {
          assert.equal((await post(base(), { name: 'Rollback' })).statusCode, 503);
          assert.equal((await update('one', { name: 'Rollback' })).statusCode, 503);
          assert.equal((await update('one', { status: 'inactive' })).statusCode, 503);
          assert.equal((await associate(projects.one, null)).statusCode, 503);
        });
      } finally { await owner.query('DROP TRIGGER reject_contractor_audit ON organization_audit_events'); await owner.query('DROP FUNCTION reject_contractor_audit()'); }
    });
    await t.test('composite FK, FORCE RLS, column grants, immutable identity and no deletion protect direct SQL', async () => {
      assert.deepEqual((await runtime.query('SELECT current_user, rolsuper, rolbypassrls, rolcreaterole FROM pg_roles WHERE rolname = current_user')).rows[0], { current_user: 'sitegrid', rolsuper: false, rolbypassrls: false, rolcreaterole: false });
      const flags = (await runtime.query(`SELECT relrowsecurity, relforcerowsecurity, row_security_active(c.oid) AS active,
        pg_has_role(current_user, relowner, 'MEMBER') AS owns, has_table_privilege(current_user,c.oid,'DELETE') AS delete,
        has_table_privilege(current_user,c.oid,'TRUNCATE') AS truncate FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname='contractors'`, [schema])).rows[0];
      assert(flags.relrowsecurity && flags.relforcerowsecurity && flags.active); assert(!flags.owns && !flags.delete && !flags.truncate);
      assert.deepEqual((await runtime.query('SELECT * FROM contractors')).rows, []);
      for (const actor of ['manager', 'foreman', 'worker']) await asActor(actor, org.a, async client => {
        assert.deepEqual((await client.query('SELECT id FROM contractors ORDER BY id')).rows.map(row => row.id), [contractors.one, contractors.two].sort());
        assert.equal((await client.query("UPDATE contractors SET name='Denied', version=version+1")).rowCount, 0);
      });
      for (const actor of ['unassigned', 'platform']) assert.deepEqual(await asActor(actor, org.a, async client => (await client.query('SELECT * FROM contractors')).rows), []);
      await assert.rejects(asActor('worker', org.a, client => client.query("INSERT INTO contractors(organization_id,name) VALUES ($1,'Denied')", [org.a])), { code: '42501' });
      await assert.rejects(asActor('adminA', org.a, client => client.query("INSERT INTO contractors(organization_id,name) VALUES ($1,'Foreign')", [org.b])), { code: '42501' });
      await assert.rejects(asActor('adminA', org.a, client => client.query('DELETE FROM contractors')), { code: '42501' });
      await assert.rejects(asActor('adminA', org.a, client => client.query("UPDATE contractors SET organization_id=$1 WHERE id=$2", [org.b, contractors.one])), { code: '42501' });
      await assert.rejects(asActor('adminA', org.a, client => client.query("UPDATE contractors SET name='No version' WHERE id=$1", [contractors.one])), { code: '23514' });
      await assert.rejects(owner.query('UPDATE contractors SET id=$1, version=version+1 WHERE id=$2', [randomUUID(), contractors.one]), { code: '23514' });
      // Disable only the active-assignment guard in an owner transaction to prove
      // the independent composite FK, then ROLLBACK restores that guard as well.
      const client = await owner.connect();
      try {
        await client.query('BEGIN'); await client.query('ALTER TABLE projects DISABLE TRIGGER protect_project_contractor');
        await assert.rejects(client.query("INSERT INTO projects(organization_id,name,contractor_id) VALUES ($1,'Cross FK',$2)", [org.a, contractors.b]), { code: '23503' });
      } finally { await client.query('ROLLBACK'); client.release(); }
      assert.deepEqual((await runtime.query("SELECT NULLIF(current_setting('sitegrid.organization_id',true),'') AS tenant, NULLIF(current_setting('sitegrid.user_id',true),'') AS actor")).rows[0], { tenant: null, actor: null });
    });
    await t.test('writes recheck contractor activity and revoked administrator role after company-lock waits', async () => {
      for (const action of ['create', 'update', 'associate', 'inactive']) {
        const item = await current(), proj = await project();
        const blocker = await owner.connect();
        try {
          await blocker.query('BEGIN'); await lockOrganization(blocker, org.a);
          const waiting = Promise.resolve(action === 'create' ? post(base(), { name: 'Denied after wait' }, 'revocable')
            : action === 'update' ? post(`${base()}/${item.id}/update`, { name: 'Denied', status: 'active', expectedVersion: item.version }, 'revocable')
            : action === 'associate' ? post(`${projectPath()}/update`, { name: 'Denied', contractorId: contractors.two, expectedVersion: proj.version }, 'revocable')
            : post(projectBase(), { name: 'Denied inactive', contractorId: item.id }));
          await waitForLock();
          if (action === 'inactive') await blocker.query("UPDATE contractors SET status='inactive',version=version+1 WHERE organization_id=$1 AND id=$2", [org.a, item.id]);
          else await blocker.query("DELETE FROM membership_roles WHERE organization_id=$1 AND membership_id=$2 AND role='organization_admin'", [org.a, members.revocable]);
          const before = [];
          for (const table of ['contractors', 'projects', 'organization_audit_events']) before.push((await blocker.query(`SELECT * FROM ${table} ORDER BY to_jsonb(${table})::text`)).rows);
          await blocker.query('COMMIT'); assert.equal((await waiting).statusCode, action === 'inactive' ? 400 : 403);
          for (const [i, table] of ['contractors', 'projects', 'organization_audit_events'].entries()) assert.deepEqual(await snapshot(table), before[i], table);
        } finally { await blocker.query('ROLLBACK'); blocker.release(); }
        if (action === 'inactive') await update('one', { status: 'active' });
        else await owner.query("INSERT INTO membership_roles(organization_id,membership_id,role) VALUES ($1,$2,'organization_admin')", [org.a, members.revocable]);
      }
    });
    await t.test('multiple contractor projects retain M08 own-assignee transitions and immutable receipt replay', async () => {
      const response = await progress(tasks.one, projects.one); assert.equal(response.statusCode, 200); assert.deepEqual(response.json(), originalProgress.json());
      assert.equal((await progress(tasks.two, projects.two, { ...command, operationId: randomUUID() })).statusCode, 200);
      assert.equal((await progress(tasks.one, projects.one, { ...command, action: 'submit', expectedVersion: 2, operationId: randomUUID() })).statusCode, 200);
      const task = (await get(`${projectPath()}/tasks`, 'worker')).json().tasks[0]; assert.equal(task.status, 'submitted'); assert.equal(task.version, 3);
      assert.equal((await get(`${projectPath(projects.two)}/tasks`, 'worker')).json().tasks[0].status, 'in_progress');
      await owner.query("UPDATE project_memberships SET status='inactive',version=version+1 WHERE organization_id=$1 AND project_id=$2 AND membership_id=$3", [org.a, projects.one, members.worker]);
      assert.equal((await get(projectPath(), 'worker')).statusCode, 404); assert.equal((await progress(tasks.one, projects.one)).statusCode, 404);
      assert.equal((await get(projectPath(projects.two), 'worker')).statusCode, 200);
      assert.equal((await get(base(), 'worker')).statusCode, 403);
      assert.deepEqual(await asActor('worker', org.a, async client => (await client.query('SELECT id FROM contractors')).rows.map(row => row.id)), [contractors.two]);
    });
  } finally {
    await rm(previous, { recursive: true, force: true }); await app.close(); await runtime.end(); await owner.end();
    try { await admin.query(`DROP SCHEMA ${schema} CASCADE`); } finally { await admin.end(); }
  }
});
