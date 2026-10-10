import { lockOrganization } from '../apps/server/src/common/organization-lock.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import pg from 'pg';
import sharp from 'sharp';
import { buildApp } from '../apps/server/src/app.js';
import { readConfig } from '../apps/server/src/config.js';
import { migrate, checkMigrations, migrationFiles } from '../apps/server/src/migrations.js';
import { withOrganization } from '../apps/server/src/organization-context.js';

test('PR12 M07 projects and tasks with real unprivileged PostgreSQL FORCE RLS', { skip: !process.env.TEST_DATABASE_URL }, async t => {
  assert(process.env.TEST_RUNTIME_DATABASE_URL, 'A real unprivileged runtime URL is required');
  const schema = `projects_test_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const ownerUrl = new URL(process.env.TEST_DATABASE_URL!); ownerUrl.searchParams.set('options', `-c search_path=${schema}`);
  const runtimeUrl = new URL(process.env.TEST_RUNTIME_DATABASE_URL); runtimeUrl.searchParams.set('options', `-c search_path=${schema}`);
  const owner = new pg.Pool({ connectionString: ownerUrl.href });
  const runtime = new pg.Pool({ connectionString: runtimeUrl.href, max: 6, application_name: schema });
  const config = readConfig({ NODE_ENV: 'test', DATABASE_URL: runtimeUrl.href });
  const app = await buildApp(config, runtime);
  const org = { a: randomUUID(), b: randomUUID() };
  const actorNames = ['adminA', 'adminB', 'dual', 'manager', 'manager2', 'foreman', 'worker', 'worker2', 'shared', 'roleless', 'pending', 'inactive', 'blocked', 'platform'];
  const users = Object.fromEntries(actorNames.map(name => [name, randomUUID()]));
  const memberships: Record<string, string> = {}, headers: Record<string, Record<string, string>> = {};
  const projects: Record<string, string> = {}, tasks: Record<string, string> = {};
  const base = (tenant = org.a) => `/api/organizations/${tenant}/projects`;
  const path = (project = projects.p1, tenant = org.a) => `${base(tenant)}/${project}`;
  const get = (url: string, actor = 'manager') => app.inject({ url, headers: headers[actor] });
  const post = (url: string, payload: unknown, actor = 'adminA', supplied?: Record<string, string>) => app.inject({ method: 'POST', url, payload, headers: supplied ?? headers[actor] });
  const assign = (project: string, member: string, status = 'active', expectedVersion = 0, tenant = org.a, actor = 'adminA') =>
    post(`${path(project, tenant)}/members/${memberships[member]}`, { status, expectedVersion }, actor);
  const payload = (assignee = 'worker', title = 'Zamontuj drzwi') => ({ title, description: 'Opis zadania', assigneeMembershipId: memberships[assignee] });
  const task = async (id = tasks.worker, project = projects.p1, actor = 'manager', tenant = org.a) => (await get(`${path(project, tenant)}/tasks/${id}`, actor)).json().task;
  const currentProject = async (id = projects.p1) => (await get(path(id), 'adminA')).json().project;
  const snapshot = async (table: string) => (await owner.query(`SELECT * FROM ${table} ORDER BY to_jsonb(${table})::text`)).rows;
  const changedTables = ['projects', 'project_memberships', 'tasks', 'organization_audit_events'];
  const asActor = <T>(tenant: string, actor: string, project: string | null, work: (client: pg.PoolClient) => Promise<T>) => withOrganization(runtime, tenant, async client => {
    await client.query("SELECT set_config('sitegrid.user_id', $1, true), set_config('sitegrid.project_id', $2, true)", [users[actor], project ?? '']);
    return work(client);
  });
  const waitForLock = async () => {
    for (let i = 0; i < 150; i++) {
      if (Number((await owner.query("SELECT count(*) FROM pg_stat_activity WHERE application_name = $1 AND wait_event = 'advisory'", [schema])).rows[0].count)) return;
      await owner.query('SELECT pg_sleep(0.01)');
    }
    assert.fail('Request should wait for the company lock');
  };
  await admin.query(`CREATE SCHEMA ${schema}`);
  try {
    await t.test('schema 8 to current preserves populated PR11 data and the release contract', async () => {
      const previous = await mkdtemp(join(tmpdir(), 'sitegrid-pr12-migrations-'));
      try {
        for (const file of (await migrationFiles('migrations')).filter(file => file.version <= 8)) await copyFile(join('migrations', file.name), join(previous, file.name));
        assert.equal(await migrate(owner, previous), 8);
        for (const [name, id] of Object.entries(users)) {
          await owner.query('INSERT INTO users(id, email) VALUES ($1, $2)', [id, `${name.toLowerCase()}@example.test`]);
          await owner.query("INSERT INTO credentials(user_id, password_hash) VALUES ($1, 'preserved-test-hash')", [id]);
          const raw = randomBytes(32).toString('base64url'), csrf = randomBytes(32).toString('base64url');
          await owner.query("INSERT INTO sessions(token_hash, user_id, csrf_token, expires_at) VALUES ($1, $2, $3, now() + interval '1 hour')", [createHash('sha256').update(raw).digest('hex'), id, csrf]);
          headers[name] = { cookie: `sitegrid=${raw}`, origin: config.origin, 'x-csrf-token': csrf };
        }
        for (const [name, id] of Object.entries(org)) await owner.query('INSERT INTO organizations(id, name) VALUES ($1, $2)', [id, `Firma ${name}`]);
        const seedMember = async (tenant: string, name: string, roles: string[], key = name) => {
          const id = randomUUID(); memberships[key] = id;
          await owner.query('INSERT INTO organization_memberships(organization_id, id, user_id, status) VALUES ($1, $2, $3, $4)', [tenant, id, users[name], ['pending', 'inactive'].includes(name) ? name : 'active']);
          for (const role of roles) await owner.query('INSERT INTO membership_roles(organization_id, membership_id, role) VALUES ($1, $2, $3)', [tenant, id, role]);
        };
        await seedMember(org.a, 'adminA', ['organization_admin']); await seedMember(org.b, 'adminB', ['organization_admin']);
        await seedMember(org.a, 'dual', ['organization_admin', 'manager']);
        for (const name of ['manager', 'manager2', 'foreman', 'worker', 'worker2', 'shared', 'roleless', 'pending', 'inactive', 'blocked']) {
          await seedMember(org.a, name, name === 'roleless' ? [] : [name.startsWith('manager') ? 'manager' : name === 'foreman' ? 'foreman' : 'worker']);
        }
        await seedMember(org.b, 'shared', ['manager'], 'sharedB'); await seedMember(org.b, 'worker2', ['worker'], 'workerB');
        await owner.query('UPDATE users SET blocked_at = now() WHERE id = $1', [users.blocked]);
        await owner.query('INSERT INTO platform_admins(user_id) VALUES ($1)', [users.platform]);
        await owner.query("INSERT INTO employee_profiles(organization_id, membership_id, display_name, phone) VALUES ($1, $2, 'Jan Monter', 'private-phone')", [org.a, memberships.worker]);
        await owner.query("INSERT INTO organization_settings(organization_id, accent_color, version) VALUES ($1, '#12ab34', 4)", [org.a]);
        const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#12ab34' } }).png().toBuffer();
        await owner.query("INSERT INTO organization_logos(organization_id, data, mime_type, version) VALUES ($1, $2, 'image/png', 4)", [org.a, png]);
        await owner.query("INSERT INTO organization_audit_events(organization_id, actor_id, subject_id, event, details) VALUES ($1, $2, $1, 'logo_replaced', '{\"beforeVersion\":3,\"afterVersion\":4}')", [org.a, users.adminA]);
        await owner.query("INSERT INTO organization_invitations(organization_id, email, role, issuer_id, token_hash) VALUES ($1, 'invited@example.test', 'worker', $2, $3)", [org.a, users.adminA, randomBytes(32).toString('hex')]);
        await owner.query("INSERT INTO platform_audit_events(actor_id, event, organization_id) VALUES ($1, 'organization_created', $2)", [users.platform, org.a]);
        const tables = (await owner.query('SELECT tablename FROM pg_tables WHERE schemaname = $1 ORDER BY tablename', [schema])).rows.map(row => row.tablename as string);
        const before = await Promise.all(tables.map(snapshot));
        assert.equal(await migrate(owner, 'migrations'), 10); assert.equal(await migrate(owner, 'migrations'), 10);
        assert.equal(await checkMigrations(owner, 'migrations'), 10);
        for (const [i, table] of tables.entries()) assert.deepEqual(table === 'schema_migrations' ? (await snapshot(table)).filter(row => row.version <= 8) : await snapshot(table), before[i], table);
        assert.deepEqual(JSON.parse(await readFile('release.json', 'utf8')).schema, { target: 10, min: 10, max: 10, upgradeMin: 0, upgradeMax: 10 });
        await assert.rejects(checkMigrations(owner, previous), /does not match/);
      } finally { await rm(previous, { recursive: true, force: true }); }
    });
    await owner.query(`GRANT USAGE ON SCHEMA ${schema} TO sitegrid`);
    await owner.query('GRANT SELECT ON installation, schema_migrations, users, credentials, platform_admins TO sitegrid');
    await owner.query('GRANT SELECT, INSERT, DELETE ON sessions TO sitegrid');
    await owner.query('GRANT SELECT, INSERT, UPDATE, DELETE ON auth_rate_limits TO sitegrid');
    await t.test('company admins create projects without automatic assignments; all other roles are denied', async () => {
      for (const actor of ['manager', 'foreman', 'worker', 'shared', 'roleless', 'pending', 'inactive', 'platform', 'adminB']) {
        assert.equal((await post(base(), { name: 'Denied' }, actor)).statusCode, 403, actor);
      }
      assert.equal((await app.inject(base())).statusCode, 401);
      assert.equal((await get(base(), 'blocked')).statusCode, 401);
      for (const [key, tenant, actor] of [['p1', org.a, 'adminA'], ['p2', org.a, 'adminA'], ['b', org.b, 'adminB']]) {
        const response = await post(base(tenant), { name: ` Projekt ${key} `, description: 'Opis' }, actor);
        assert.equal(response.statusCode, 201, response.body); const project = response.json().project;
        assert.equal(project.name, `Projekt ${key}`); assert.equal(project.status, 'active'); assert.equal(project.version, 1); assert(project.createdAt && project.updatedAt);
        projects[key] = project.id;
      }
      assert.equal((await snapshot('project_memberships')).length, 0);
      assert.equal((await get(base())).json().projects.length, 0);
      assert.equal((await get(base(), 'adminA')).json().projects.length, 2);
    });
    await t.test('explicit assignments require active local company members and preserve revocation versions', async () => {
      for (const name of ['pending', 'inactive', 'blocked', 'adminB']) assert.equal((await assign(projects.p1, name)).statusCode, 400, name);
      assert.equal((await assign(projects.p1, 'worker', 'active', 0, org.a, 'manager')).statusCode, 403);
      for (const name of ['adminA', 'dual', 'manager', 'foreman', 'worker', 'worker2', 'shared', 'roleless']) assert.equal((await assign(projects.p1, name)).statusCode, 200, name);
      for (const name of ['manager2', 'worker2']) assert.equal((await assign(projects.p2, name)).statusCode, 200);
      for (const name of ['sharedB', 'workerB']) assert.equal((await assign(projects.b, name, 'active', 0, org.b, 'adminB')).statusCode, 200);
      assert.equal((await assign(projects.p1, 'worker', 'inactive', 0)).statusCode, 409);
      assert.equal((await assign(projects.p1, 'worker', 'active', 1)).json().membership.version, 1);
      assert.equal((await assign(projects.p1, 'worker', 'inactive', 1)).json().membership.version, 2);
      assert.equal((await assign(projects.p1, 'worker', 'active', 2)).json().membership.version, 3);
      const roster = await get(`${path()}/members`); assert.equal(roster.statusCode, 200, roster.body);
      assert(!roster.body.includes('private-phone')); assert(!roster.body.includes('adminb@example.test'));
      for (const actor of ['worker', 'foreman', 'roleless', 'manager2']) assert.equal((await get(`${path()}/members`, actor)).statusCode, 404, actor);
    });
    await t.test('task planning is limited to assigned managers; company and platform roles confer no task access', async () => {
      for (const actor of ['adminA', 'manager2', 'foreman', 'worker', 'roleless', 'platform', 'adminB']) {
        const result = await post(`${path()}/tasks`, payload(), actor);
        assert.equal(result.statusCode, ['platform', 'adminB'].includes(actor) ? 403 : 404, actor);
      }
      for (const [key, project, tenant, actor, assignee] of [
        ['worker', projects.p1, org.a, 'manager', 'worker'], ['worker2', projects.p1, org.a, 'dual', 'worker2'],
        ['p2', projects.p2, org.a, 'manager2', 'worker2'], ['b', projects.b, org.b, 'shared', 'workerB'],
      ]) {
        const response = await post(`${path(project, tenant)}/tasks`, payload(assignee, `Zadanie ${key}`), actor);
        assert.equal(response.statusCode, 201, response.body); const created = response.json().task;
        tasks[key] = created.id; assert.equal(created.status, 'planned'); assert.equal(created.version, 1);
        assert.equal(created.authorMembershipId, memberships[actor === 'shared' ? 'sharedB' : actor]);
        assert(created.createdAt && created.updatedAt);
      }
      assert.equal((await get(path(), 'adminA')).json().permissions.readTasks, false);
      assert.equal((await get(path(), 'dual')).json().permissions.manageTasks, true);
      assert.equal((await get(`${path()}/tasks`, 'adminA')).statusCode, 404);
      assert.equal((await get(`${path()}/tasks`, 'roleless')).statusCode, 404);
    });
    await t.test('workers read only own tasks; foremen and managers read their assigned project scope', async () => {
      for (const actor of ['manager', 'foreman', 'dual']) {
        const response = await get(`${path()}/tasks`, actor); assert.equal(response.statusCode, 200, response.body);
        assert.deepEqual(response.json().tasks.map((row: { id: string }) => row.id).sort(), [tasks.worker, tasks.worker2].sort());
        assert.equal(response.headers['cache-control'], 'no-store');
        assert.equal((await get(`${path(projects.p2)}/tasks`, actor)).statusCode, 404);
      }
      assert.deepEqual((await get(`${path()}/tasks`, 'worker')).json().tasks.map((row: { id: string }) => row.id), [tasks.worker]);
      assert.equal((await get(`${path()}/tasks/${tasks.worker2}`, 'worker')).statusCode, 404);
      assert.equal((await get(`${path()}/tasks/${tasks.worker}`, 'worker')).statusCode, 200);
      assert.equal((await get(`${path()}/tasks`, 'shared')).json().tasks.length, 0);
      assert.equal((await get(`${path(projects.b, org.b)}/tasks`, 'shared')).json().tasks.length, 1);
      assert.equal((await get(base(), 'worker')).json().projects.length, 1);
      assert.equal((await get(base(), 'worker2')).json().projects.length, 2);
    });
    await t.test('foreign company/project/task substitutions and unauthorized assignments are rejected', async () => {
      for (const url of [base(org.b), path(projects.b, org.b), `${path(projects.b, org.b)}/tasks`]) assert.equal((await get(url)).statusCode, 403);
      for (const url of [path(projects.b), path(randomUUID()), `${path(projects.p2)}/tasks`, `${path()}/tasks/${tasks.p2}`, `${path()}/tasks/${tasks.b}`]) assert.equal((await get(url)).statusCode, 404, url);
      assert.equal((await post(`${path(projects.b)}/update`, { name: 'Wrong', expectedVersion: 1 })).statusCode, 404);
      for (const member of ['adminB', 'pending', 'inactive', 'blocked', 'manager2', 'workerB']) {
        assert.equal((await post(`${path()}/tasks`, payload(member), 'manager')).statusCode, 400, member);
      }
      assert.equal((await post(`${path()}/tasks`, { ...payload(), assigneeMembershipId: randomUUID() }, 'manager')).statusCode, 400);
      assert.equal((await post(`${path()}/tasks/${tasks.worker}/update`, { ...payload('workerB'), expectedVersion: 1 }, 'manager')).statusCode, 400);
      assert.equal((await post(`${path()}/tasks/${tasks.p2}/update`, { ...payload(), expectedVersion: 1 }, 'manager')).statusCode, 404);
    });
    await t.test('manager edits and reassigns tasks; author and initial status remain unchanged', async () => {
      const before = await task();
      const response = await post(`${path()}/tasks/${tasks.worker}/update`, { ...payload('worker2', 'Nowy tytuł'), expectedVersion: before.version }, 'manager');
      assert.equal(response.statusCode, 200, response.body); assert.equal(response.json().task.version, before.version + 1);
      assert.equal(response.json().task.authorMembershipId, before.authorMembershipId); assert.equal(response.json().task.status, 'planned');
      assert.equal((await get(`${path()}/tasks`, 'worker')).json().tasks.length, 0);
      assert.equal((await get(`${path()}/tasks`, 'worker2')).json().tasks.length, 2);
      const restored = await post(`${path()}/tasks/${tasks.worker}/update`, { ...payload(), expectedVersion: before.version + 1 }, 'dual'); assert.equal(restored.statusCode, 200);
      for (const actor of ['worker', 'foreman', 'adminA']) assert.equal((await post(`${path()}/tasks/${tasks.worker}/update`, { ...payload(), expectedVersion: before.version + 2 }, actor)).statusCode, 404);
    });
    await t.test('raw input validates UUIDs, text, versions and immutable context/actor fields', async () => {
      for (const invalid of [null, [], {}, { name: '' }, { name: 'X'.repeat(201) }, { name: 'A\nB' }, { name: 5 }, { name: 'A', description: null }, { name: 'A', description: 'X'.repeat(4001) }, { name: 'A', organizationId: org.b }, { name: 'A', actorId: users.adminB }, { name: 'A', status: 'archived' }]) assert.equal((await post(base(), invalid)).statusCode, 400);
      for (const url of ['/api/organizations/bad/projects', `${base()}/bad`, `${path()}/tasks/bad`, `${path()}/members/bad`]) assert.equal((await get(url)).statusCode, url.endsWith('/members/bad') ? 404 : 400);
      assert.equal((await get(`/api/organizations/${org.a.toUpperCase()}/projects/${projects.p1.toUpperCase()}/tasks/${tasks.worker.toUpperCase()}`)).statusCode, 200);
      for (const url of [`${base()}/bad/update`, `${path()}/members/bad`, `${path()}/tasks/bad/update`]) assert.equal((await post(url, {})).statusCode, 400);
      const current = await task();
      for (const extra of [{ status: 'in_progress' }, { authorMembershipId: memberships.worker }, { actorId: users.worker }, { projectId: projects.p2 }, { companyId: org.b }, { title: '' }, { description: null }, { assigneeMembershipId: 'bad' }, { title: 'A\u0000B' }]) {
        assert.equal((await post(`${path()}/tasks/${tasks.worker}/update`, { ...payload(), expectedVersion: current.version, ...extra }, 'manager')).statusCode, 400);
      }
      for (const expectedVersion of ['1', 0, -1, 1.5, null, 2147483647, Number.MAX_SAFE_INTEGER]) {
        assert.equal((await post(`${path()}/update`, { name: 'A', expectedVersion })).statusCode, 400);
        assert.equal((await post(`${path()}/tasks/${tasks.worker}/update`, { ...payload(), expectedVersion }, 'manager')).statusCode, 400);
      }
    });
    await t.test('every mutation requires exact Origin and session CSRF; errors leave no changes', async () => {
      const before = await Promise.all(changedTables.map(snapshot));
      const project = await currentProject(), current = await task();
      for (const [url, data, actor] of [
        [base(), { name: 'Denied' }, 'adminA'], [`${path()}/update`, { name: 'Denied', expectedVersion: project.version }, 'adminA'],
        [`${path()}/archive`, { expectedVersion: project.version }, 'adminA'], [`${path()}/members/${memberships.worker}`, { status: 'inactive', expectedVersion: 3 }, 'adminA'],
        [`${path()}/tasks`, payload(), 'manager'], [`${path()}/tasks/${tasks.worker}/update`, { ...payload(), expectedVersion: current.version }, 'manager'],
      ] as [string, unknown, string][]) {
        for (const supplied of [{ cookie: headers[actor].cookie }, { ...headers[actor], origin: 'https://evil.test' }, { ...headers[actor], 'x-csrf-token': 'x'.repeat(43) }]) {
          assert.equal((await post(url, data, actor, supplied)).statusCode, 403, url);
        }
      }
      for (const [i, table] of changedTables.entries()) assert.deepEqual(await snapshot(table), before[i], table);
    });
    await t.test('concurrent project, membership and task edits have one winner; stale reads are authorized', async () => {
      const project = await currentProject(), current = await task();
      for (const [url, data, actor, resource, expected] of [
        [`${path()}/update`, { name: 'Wyścig', expectedVersion: project.version }, 'adminA', 'project', project.version + 1],
        [`${path()}/tasks/${tasks.worker}/update`, { ...payload(), expectedVersion: current.version }, 'manager', 'task', current.version + 1],
        [`${path()}/members/${memberships.foreman}`, { status: 'inactive', expectedVersion: 1 }, 'adminA', 'membership', 2],
      ] as [string, object, string, string, number][]) {
        const before = (await snapshot('organization_audit_events')).length;
        const responses = await Promise.all([post(url, data, actor), post(url, data, actor)]);
        assert.deepEqual(responses.map(response => response.statusCode).sort(), [200, 409]);
        assert.equal(responses.find(response => response.statusCode === 409)!.json()[resource].version, expected);
        assert.equal((await snapshot('organization_audit_events')).length, before + 1);
      }
      assert.equal((await assign(projects.p1, 'foreman', 'active', 2)).statusCode, 200);
    });
    await t.test('audit failure rolls back creation, metadata, archive, assignments and task versions', async () => {
      await owner.query(`CREATE FUNCTION reject_project_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Synthetic audit failure'; END $$`);
      await owner.query('CREATE TRIGGER reject_project_audit BEFORE INSERT ON organization_audit_events FOR EACH ROW EXECUTE FUNCTION reject_project_audit()');
      const before = await Promise.all(changedTables.map(snapshot)), project = await currentProject(), current = await task();
      try {
        for (const [url, data, actor] of [
          [base(), { name: 'Rollback' }, 'adminA'], [`${path()}/update`, { name: 'Rollback', expectedVersion: project.version }, 'adminA'],
          [`${path()}/archive`, { expectedVersion: project.version }, 'adminA'], [`${path()}/members/${memberships.worker}`, { status: 'inactive', expectedVersion: 3 }, 'adminA'],
          [`${path()}/members/${memberships.manager2}`, { status: 'active', expectedVersion: 0 }, 'adminA'],
          [`${path()}/tasks`, payload(), 'manager'], [`${path()}/tasks/${tasks.worker}/update`, { ...payload(), expectedVersion: current.version }, 'manager'],
        ] as [string, unknown, string][]) {
          assert.equal((await post(url, data, actor)).statusCode, 503, url);
          for (const [i, table] of changedTables.entries()) assert.deepEqual(await snapshot(table), before[i], table);
        }
      } finally { await owner.query('DROP TRIGGER reject_project_audit ON organization_audit_events'); await owner.query('DROP FUNCTION reject_project_audit()'); }
      const audit = (await snapshot('organization_audit_events')).filter(row => row.event.startsWith('project_') || row.event.startsWith('task_'));
      for (const row of audit) { assert(row.actor_id && row.organization_id && row.subject_id); assert.equal(row.details.afterVersion, row.details.beforeVersion + 1); }
      assert(audit.some(row => row.event === 'task_updated' && row.details.beforeAssignee !== row.details.afterAssignee));
    });
    await t.test('FORCE RLS, project context, composite foreign keys and immutable records protect direct runtime SQL', async () => {
      assert.deepEqual((await runtime.query('SELECT current_user, session_user, rolsuper, rolbypassrls, rolcreaterole FROM pg_roles WHERE rolname = current_user')).rows[0],
        { current_user: 'sitegrid', session_user: 'sitegrid', rolsuper: false, rolbypassrls: false, rolcreaterole: false });
      const flags = (await runtime.query(`SELECT relname, relrowsecurity, relforcerowsecurity, row_security_active(c.oid) AS active,
        pg_has_role(current_user, relowner, 'MEMBER') AS owns, has_table_privilege(current_user, c.oid, 'DELETE') AS delete,
        has_table_privilege(current_user, c.oid, 'TRUNCATE') AS truncate FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND relname IN ('projects', 'project_memberships', 'tasks')`, [schema])).rows;
      assert.equal(flags.length, 3); for (const row of flags) { assert(row.relrowsecurity && row.relforcerowsecurity && row.active); assert(!row.owns && !row.delete && !row.truncate); }
      for (const table of ['projects', 'project_memberships', 'tasks']) assert.deepEqual((await runtime.query(`SELECT * FROM ${table}`)).rows, []);
      await asActor(org.a, 'manager', projects.p1, async client => {
        assert.equal((await client.query('SELECT * FROM tasks')).rows.length, 2);
        assert.equal((await client.query('SELECT * FROM tasks WHERE project_id = $1 OR organization_id = $2', [projects.p2, org.b])).rows.length, 0);
        assert.equal((await client.query('SELECT * FROM project_memberships WHERE project_id = $1', [projects.p2])).rows.length, 0);
      });
      await asActor(org.a, 'manager', projects.p2, async client => { assert.equal((await client.query('SELECT * FROM tasks')).rows.length, 0); });
      await asActor(org.a, 'worker', projects.p1, async client => { assert.deepEqual((await client.query('SELECT id FROM tasks')).rows.map(row => row.id), [tasks.worker]); });
      for (const actor of ['adminA', 'roleless', 'platform']) await asActor(org.a, actor, projects.p1, async client => { assert.equal((await client.query('SELECT * FROM tasks')).rows.length, 0); });
      await asActor(org.a, 'manager', null, async client => { assert.equal((await client.query('SELECT * FROM tasks')).rows.length, 0); });
      await assert.rejects(asActor(org.a, 'adminA', projects.p1, client => client.query("INSERT INTO projects(organization_id, name) VALUES ($1, 'Foreign')", [org.b])), { code: '42501' });
      await assert.rejects(asActor(org.a, 'adminA', projects.p1, client => client.query("INSERT INTO tasks(organization_id, project_id, title, assignee_membership_id, author_membership_id) VALUES ($1, $2, 'Denied', $3, $4)", [org.a, projects.p1, memberships.worker, memberships.adminA])), { code: '42501' });
      await assert.rejects(owner.query("INSERT INTO project_memberships(organization_id, project_id, membership_id, status) VALUES ($1, $2, $3, 'inactive')", [org.a, projects.p1, memberships.adminB]), { code: '23503' });
      // Disable only user triggers as migration owner to exercise the actual FK independently of eligibility guards.
      await owner.query('ALTER TABLE tasks DISABLE TRIGGER USER');
      try {
        for (const [tenant, projectId, assignee, author] of [[org.a, projects.p1, memberships.workerB, memberships.manager], [org.a, projects.p2, memberships.worker, memberships.manager2], [org.a, projects.b, memberships.workerB, memberships.sharedB]]) {
          await assert.rejects(owner.query("INSERT INTO tasks(organization_id, project_id, title, assignee_membership_id, author_membership_id) VALUES ($1, $2, 'Bad FK', $3, $4)", [tenant, projectId, assignee, author]), { code: '23503' });
        }
      } finally { await owner.query('ALTER TABLE tasks ENABLE TRIGGER USER'); }
      for (const change of ["status = 'in_progress'", 'author_membership_id = assignee_membership_id', 'project_id = $3', 'version = version + 5']) {
        await assert.rejects(asActor(org.a, 'manager', projects.p1, client => client.query(`UPDATE tasks SET ${change}, ${change.startsWith('version') ? 'title = title' : 'version = version + 1'} WHERE organization_id = $1 AND id = $2`, change.includes('$3') ? [org.a, tasks.worker, projects.p2] : [org.a, tasks.worker])), { code: '23514' });
      }
      await asActor(org.a, 'manager', projects.p1, async client => {
        assert.equal((await client.query("UPDATE tasks SET title = 'Foreign', version = version + 1 WHERE project_id = $1", [projects.p2])).rowCount, 0);
      });
      const pooled = new pg.Pool({ connectionString: runtimeUrl.href, max: 1 });
      try {
        let pid = 0;
        await withOrganization(pooled, org.a, async client => { pid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid; await client.query("SELECT set_config('sitegrid.user_id', $1, true), set_config('sitegrid.project_id', $2, true)", [users.manager, projects.p1]); });
        await assert.rejects(withOrganization(pooled, org.a, async client => { await client.query("SELECT set_config('sitegrid.project_id', $1, true)", [projects.p1]); throw new Error('rollback'); }), /rollback/);
        const result = (await pooled.query("SELECT pg_backend_pid() AS pid, NULLIF(current_setting('sitegrid.organization_id', true), '') AS tenant, NULLIF(current_setting('sitegrid.user_id', true), '') AS actor, NULLIF(current_setting('sitegrid.project_id', true), '') AS project")).rows[0];
        assert.deepEqual(result, { pid, tenant: null, actor: null, project: null });
      } finally { await pooled.end(); }
    });
    await t.test('revoked roles, project assignments and company memberships apply immediately and after lock waits', async () => {
      const blocker = await owner.connect();
      try {
        await blocker.query('BEGIN'); await lockOrganization(blocker, org.a);
        const waiting = Promise.resolve(post(`${path()}/tasks`, payload(), 'manager'));
        await waitForLock();
        await blocker.query("UPDATE project_memberships SET status = 'inactive', version = version + 1 WHERE organization_id = $1 AND project_id = $2 AND membership_id = $3", [org.a, projects.p1, memberships.manager]);
        await blocker.query('COMMIT'); assert.equal((await waiting).statusCode, 404);
      } finally { await blocker.query('ROLLBACK'); blocker.release(); }
      assert.equal((await get(`${path()}/tasks`)).statusCode, 404);
      assert.equal((await get(path())).statusCode, 404);
      assert.equal((await assign(projects.p1, 'manager', 'active', 2)).statusCode, 200);
      await owner.query("DELETE FROM membership_roles WHERE organization_id = $1 AND membership_id = $2 AND role = 'manager'", [org.a, memberships.manager]);
      assert.equal((await post(`${path()}/tasks`, payload(), 'manager')).statusCode, 404);
      await owner.query("INSERT INTO membership_roles(organization_id, membership_id, role) VALUES ($1, $2, 'manager')", [org.a, memberships.manager]);
      assert.equal((await assign(projects.p1, 'worker', 'inactive', 3)).statusCode, 200);
      assert.equal((await get(`${path()}/tasks`, 'worker')).statusCode, 404);
      assert.equal((await post(`${path()}/tasks`, payload(), 'manager')).statusCode, 400);
      assert.equal((await assign(projects.p1, 'worker', 'active', 4)).statusCode, 200);
      await owner.query("UPDATE organization_memberships SET status = 'inactive' WHERE organization_id = $1 AND id = $2", [org.a, memberships.shared]);
      assert.equal((await get(`${path()}/tasks`, 'shared')).statusCode, 403);
      assert.equal((await get(`${path(projects.b, org.b)}/tasks`, 'shared')).statusCode, 200);
      await owner.query('UPDATE users SET blocked_at = now() WHERE id = $1', [users.worker]);
      assert.equal((await get(`${path()}/tasks`, 'worker')).statusCode, 401);
      assert.equal((await post(`${path()}/tasks`, payload(), 'manager')).statusCode, 400);
    });
    await t.test('waiting writes recheck admin roles, assignee eligibility and real-time session expiry', async () => {
      for (const scenario of ['admin', 'assignee', 'session']) {
        const blocker = await owner.connect();
        const before = await Promise.all(changedTables.map(snapshot));
        const current = await currentProject();
        if (scenario === 'session') await owner.query("UPDATE sessions SET expires_at = clock_timestamp() + interval '500 milliseconds' WHERE user_id = $1", [users.manager]);
        try {
          await blocker.query('BEGIN'); await lockOrganization(blocker, org.a);
          const waiting = Promise.resolve(scenario === 'admin'
            ? post(`${path()}/update`, { name: 'Denied after wait', expectedVersion: current.version }, 'dual')
            : post(`${path()}/tasks`, payload('worker2'), 'manager'));
          await waitForLock();
          if (scenario === 'admin') await blocker.query("DELETE FROM membership_roles WHERE organization_id = $1 AND membership_id = $2 AND role = 'organization_admin'", [org.a, memberships.dual]);
          else if (scenario === 'assignee') await blocker.query("UPDATE organization_memberships SET status = 'inactive' WHERE organization_id = $1 AND id = $2", [org.a, memberships.worker2]);
          else await blocker.query('SELECT pg_sleep(0.55)');
          await blocker.query('COMMIT');
          assert.equal((await waiting).statusCode, scenario === 'admin' ? 403 : scenario === 'assignee' ? 400 : 401, scenario);
          for (const [i, table] of changedTables.entries()) assert.deepEqual(await snapshot(table), before[i], table);
        } finally { await blocker.query('ROLLBACK'); blocker.release(); }
        if (scenario === 'admin') await owner.query("INSERT INTO membership_roles(organization_id, membership_id, role) VALUES ($1, $2, 'organization_admin')", [org.a, memberships.dual]);
        else if (scenario === 'assignee') await owner.query("UPDATE organization_memberships SET status = 'active' WHERE organization_id = $1 AND id = $2", [org.a, memberships.worker2]);
        else await owner.query("UPDATE sessions SET expires_at = clock_timestamp() + interval '1 hour' WHERE user_id = $1", [users.manager]);
      }
    });
    await t.test('archiving preserves tasks, assignments and audit and rejects further mutations', async () => {
      const beforeTasks = await snapshot('tasks'), beforeMembers = await snapshot('project_memberships');
      const project = await currentProject();
      const responses = await Promise.all([post(`${path()}/archive`, { expectedVersion: project.version }), post(`${path()}/update`, { name: 'Concurrent', expectedVersion: project.version })]);
      assert.deepEqual(responses.map(response => response.statusCode).sort(), [200, 409]);
      if ((await currentProject()).status !== 'archived') assert.equal((await post(`${path()}/archive`, { expectedVersion: project.version + 1 })).statusCode, 200);
      const archived = await currentProject(); assert.equal(archived.status, 'archived');
      assert.equal((await get(`${path()}/tasks`)).statusCode, 200);
      for (const [url, data, actor] of [[`${path()}/update`, { name: 'Denied', expectedVersion: archived.version }, 'adminA'], [`${path()}/tasks`, payload('worker2'), 'manager'], [`${path()}/members/${memberships.worker2}`, { status: 'inactive', expectedVersion: 1 }, 'adminA']] as [string, unknown, string][]) assert.equal((await post(url, data, actor)).statusCode, 409);
      assert.deepEqual(await snapshot('tasks'), beforeTasks); assert.deepEqual(await snapshot('project_memberships'), beforeMembers);
      const events = await snapshot('organization_audit_events'); assert(events.some(row => row.event === 'project_archived'));
      await owner.query("UPDATE organizations SET status = 'inactive' WHERE id = $1", [org.a]);
      assert.equal((await get(base(), 'adminA')).statusCode, 403); assert.equal((await get(`${path()}/tasks`)).statusCode, 403);
    });
  } finally {
    await app.close(); await runtime.end(); await owner.end();
    try { await admin.query(`DROP SCHEMA ${schema} CASCADE`); } finally { await admin.end(); }
  }
});
