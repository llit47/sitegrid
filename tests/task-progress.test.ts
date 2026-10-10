import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import pg from 'pg';
import { buildApp } from '../apps/server/src/app.js';
import { readConfig } from '../apps/server/src/config.js';
import { migrate, checkMigrations, migrationFiles } from '../apps/server/src/migrations.js';
import { withOrganization, withTransaction } from '../apps/server/src/organization-context.js';
import { lockOrganization } from '../apps/server/src/common/organization-lock.js';
import { parseCommand, requestHash } from '../apps/server/src/task-progress/domain.js';

test('progress command validation and canonical hash', () => {
  const command = { operationId: randomUUID(), schemaVersion: 1, action: 'start', expectedVersion: 1 };
  const scope = { organizationId: randomUUID(), projectId: randomUUID(), taskId: randomUUID(), actorId: randomUUID() };
  assert.equal(requestHash(scope, parseCommand(command)), requestHash(scope, parseCommand({ expectedVersion: 1, action: 'start', operationId: command.operationId.toUpperCase(), schemaVersion: 1 })));
  assert.notEqual(requestHash(scope, parseCommand(command)), requestHash({ ...scope, taskId: randomUUID() }, parseCommand(command)));
  for (const change of [{ expectedVersion: '1' }, { expectedVersion: 0 }, { expectedVersion: 1.5 }, { expectedVersion: 2147483647 }, { operationId: 'bad' }, { schemaVersion: '1' }, { action: 'accept' }, { actorId: scope.actorId }]) assert.throws(() => parseCommand({ ...command, ...change }));
});

test('M08 task progress on real PostgreSQL with unprivileged FORCE RLS', { skip: !process.env.TEST_DATABASE_URL }, async t => {
  assert(process.env.TEST_RUNTIME_DATABASE_URL, 'Real runtime URL is required');
  const schema = `progress_test_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const ownerUrl = new URL(process.env.TEST_DATABASE_URL!); ownerUrl.searchParams.set('options', `-c search_path=${schema}`);
  const runtimeUrl = new URL(process.env.TEST_RUNTIME_DATABASE_URL); runtimeUrl.searchParams.set('options', `-c search_path=${schema}`);
  const owner = new pg.Pool({ connectionString: ownerUrl.href });
  const runtime = new pg.Pool({ connectionString: runtimeUrl.href, max: 8, application_name: schema });
  const config = readConfig({ NODE_ENV: 'test', DATABASE_URL: runtimeUrl.href });
  const app = await buildApp(config, runtime);
  // A real socket response loss AFTER the handler's transaction has committed.
  app.addHook('onSend', async (request, _reply, payload) => {
    if (request.headers['x-test-drop-response'] === 'yes') request.raw.socket.destroy();
    return payload;
  });
  const org = { a: randomUUID(), b: randomUUID() };
  const project = { a: randomUUID(), other: randomUUID(), b: randomUUID() };
  const names = ['admin', 'dual', 'manager', 'foreman', 'worker', 'other', 'roleless', 'unassigned', 'platform'];
  const users: Record<string, string> = {}, members: Record<string, string> = {}, headers: Record<string, Record<string, string>> = {};
  const path = (task: string, tenant = org.a, proj = project.a) => `/api/organizations/${tenant}/projects/${proj}/tasks/${task}`;
  const command = (action = 'start', expectedVersion = 1, operationId = randomUUID()) => ({ operationId, schemaVersion: 1, action, expectedVersion });
  const post = (task: string, body = command(), actor = 'worker', tenant = org.a, proj = project.a) => app.inject({ method: 'POST', url: `${path(task, tenant, proj)}/commands`, payload: body, headers: headers[actor] });
  const snapshot = async (table: string) => (await owner.query(`SELECT * FROM ${table} ORDER BY to_jsonb(${table})::text`)).rows;
  const unchanged = async (work: () => Promise<unknown>) => {
    const tables = ['tasks', 'task_progress_receipts', 'organization_audit_events'];
    const before = await Promise.all(tables.map(snapshot)); await work();
    for (const [i, table] of tables.entries()) assert.deepEqual(await snapshot(table), before[i], table);
  };
  const asActor = <T>(actor: string, tenant: string, proj: string, work: (client: pg.PoolClient) => Promise<T>) => withOrganization(runtime, tenant, async client => {
    await client.query("SELECT set_config('sitegrid.user_id', $1, true), set_config('sitegrid.project_id', $2, true)", [users[actor], proj]);
    return work(client);
  });
  const createTask = async (assignee = 'worker', tenant = org.a, proj = project.a) => {
    const actor = tenant === org.a ? 'manager' : 'worker';
    return withTransaction(owner, async client => {
      await client.query("SELECT set_config('sitegrid.user_id', $1, true)", [users[actor]]);
      return (await client.query(`INSERT INTO tasks(organization_id, project_id, title, assignee_membership_id, author_membership_id)
        VALUES ($1, $2, 'Zadanie testowe', $3, $4) RETURNING id`, [tenant, proj, members[tenant === org.b ? 'workerB' : assignee], members[tenant === org.b ? 'workerB' : actor]])).rows[0].id as string;
    });
  };
  const waitForLock = async () => {
    for (let i = 0; i < 200; i++) {
      if (Number((await owner.query("SELECT count(*) FROM pg_stat_activity WHERE application_name = $1 AND wait_event = 'advisory'", [schema])).rows[0].count)) return;
      await owner.query('SELECT pg_sleep(0.01)');
    }
    assert.fail('Command did not acquire the shared lock');
  };
  await admin.query(`CREATE SCHEMA ${schema}`);
  try {
    const previous = await mkdtemp(join(tmpdir(), 'progress-schema9-'));
    try {
      for (const file of (await migrationFiles('migrations')).filter(file => file.version <= 9)) await copyFile(join('migrations', file.name), join(previous, file.name));
      await migrate(owner, previous);
      for (const name of names) {
        users[name] = randomUUID(); members[name] = randomUUID();
        await owner.query('INSERT INTO users(id, email) VALUES ($1, $2)', [users[name], `${name}@example.test`]);
        await owner.query("INSERT INTO credentials(user_id, password_hash) VALUES ($1, 'existing-hash')", [users[name]]);
        const raw = randomBytes(32).toString('base64url'), csrf = randomBytes(32).toString('base64url');
        await owner.query("INSERT INTO sessions(token_hash, user_id, csrf_token, expires_at) VALUES ($1, $2, $3, now() + interval '1 hour')", [createHash('sha256').update(raw).digest('hex'), users[name], csrf]);
        headers[name] = { cookie: `sitegrid=${raw}`, origin: config.origin, 'x-csrf-token': csrf };
      }
      for (const id of Object.values(org)) await owner.query("INSERT INTO organizations(id, name) VALUES ($1, 'Firma')", [id]);
      for (const name of names.filter(name => name !== 'platform')) {
        await owner.query("INSERT INTO organization_memberships(organization_id, id, user_id, status) VALUES ($1, $2, $3, 'active')", [org.a, members[name], users[name]]);
        const roles = name === 'dual' ? ['organization_admin', 'worker'] : name === 'admin' ? ['organization_admin'] : name === 'roleless' ? [] : [name === 'other' || name === 'unassigned' ? 'worker' : name];
        for (const role of roles) await owner.query('INSERT INTO membership_roles(organization_id, membership_id, role) VALUES ($1, $2, $3)', [org.a, members[name], role]);
      }
      members.workerB = randomUUID();
      await owner.query("INSERT INTO organization_memberships(organization_id, id, user_id, status) VALUES ($1, $2, $3, 'active')", [org.b, members.workerB, users.worker]);
      await owner.query("INSERT INTO membership_roles(organization_id, membership_id, role) VALUES ($1, $2, 'manager')", [org.b, members.workerB]);
      await owner.query('INSERT INTO platform_admins(user_id) VALUES ($1)', [users.platform]);
      for (const [id, tenant] of [[project.a, org.a], [project.other, org.a], [project.b, org.b]]) await owner.query("INSERT INTO projects(organization_id, id, name) VALUES ($1, $2, 'Projekt')", [tenant, id]);
      for (const name of names.filter(name => !['platform', 'unassigned'].includes(name))) await owner.query('INSERT INTO project_memberships(organization_id, project_id, membership_id) VALUES ($1, $2, $3)', [org.a, project.a, members[name]]);
      await owner.query('INSERT INTO project_memberships(organization_id, project_id, membership_id) VALUES ($1, $2, $3)', [org.b, project.b, members.workerB]);
      for (const name of ['worker', 'manager']) await owner.query('INSERT INTO project_memberships(organization_id, project_id, membership_id) VALUES ($1, $2, $3)', [org.a, project.other, members[name]]);
      const oldTask = await createTask();
      await owner.query("INSERT INTO employee_profiles(organization_id, membership_id, display_name) VALUES ($1, $2, 'Pracownik')", [org.a, members.worker]);
      await owner.query("INSERT INTO organization_settings(organization_id, accent_color, version) VALUES ($1, '#123456', 5)", [org.a]);
      await owner.query("INSERT INTO organization_logos(organization_id, data, mime_type, version) VALUES ($1, $2, 'image/png', 5)", [org.a, Buffer.from('preserved-existing-logo')]);
      await owner.query("INSERT INTO organization_invitations(organization_id, email, role, issuer_id, token_hash) VALUES ($1, 'invite@example.test', 'worker', $2, $3)", [org.a, users.admin, randomBytes(32).toString('hex')]);
      await owner.query("INSERT INTO organization_audit_events(organization_id, actor_id, subject_id, event) VALUES ($1, $2, $3, 'task_created')", [org.a, users.manager, oldTask]);
      await t.test('schema 9 to current preserves all populated tables, credentials, sessions and task versions', async () => {
        const tables = (await owner.query('SELECT tablename FROM pg_tables WHERE schemaname = $1 ORDER BY tablename', [schema])).rows.map(row => row.tablename as string);
        const before = await Promise.all(tables.map(snapshot));
        assert.equal(await migrate(owner, 'migrations'), 11); assert.equal(await migrate(owner, 'migrations'), 11);
        assert.equal(await checkMigrations(owner, 'migrations'), 11);
        for (const [i, table] of tables.entries()) assert.deepEqual(table === 'schema_migrations' ? (await snapshot(table)).filter(row => row.version <= 9) : await snapshot(table), table === 'projects' ? before[i].map(row => ({ ...row, contractor_id: null })) : before[i], table);
        assert.deepEqual(JSON.parse(await readFile('release.json', 'utf8')).schema, { target: 11, min: 11, max: 11, upgradeMin: 0, upgradeMax: 11 });
        await assert.rejects(checkMigrations(owner, previous), /does not match/);
      });
    } finally { await rm(previous, { recursive: true, force: true }); }
    await owner.query(`GRANT USAGE ON SCHEMA ${schema} TO sitegrid`);
    await owner.query('GRANT SELECT ON installation, schema_migrations, users, credentials, platform_admins TO sitegrid');
    await owner.query('GRANT SELECT, INSERT, DELETE ON sessions TO sitegrid');
    await owner.query('GRANT SELECT, INSERT, UPDATE, DELETE ON auth_rate_limits TO sitegrid');

    await t.test('worker, foreman, manager and company admin with worker role progress only their own tasks', async () => {
      for (const actor of ['worker', 'foreman', 'manager', 'dual']) {
        const task = await createTask(actor);
        for (const other of ['worker', 'foreman', 'manager', 'dual', 'admin', 'roleless', 'unassigned']) if (actor !== other) await unchanged(async () => assert.equal((await post(task, command(), other)).statusCode, 404, `${actor}/${other}`));
        const start = await post(task, command(), actor); assert.equal(start.statusCode, 200, start.body);
        assert.equal(start.json().task.status, 'in_progress'); assert.equal(start.json().task.version, 2); assert(start.json().task.updatedAt.endsWith('Z'));
        const submit = await post(task, command('submit', 2), actor); assert.equal(submit.statusCode, 200, submit.body);
        assert.equal(submit.json().task.status, 'submitted'); assert.equal(submit.json().task.version, 3);
      }
      for (const actor of ['admin', 'roleless']) {
        const task = await createTask(actor);
        assert.equal((await post(task, command(), actor)).statusCode, 404);
      }
      assert.equal((await post(randomUUID(), command(), 'platform')).statusCode, 403);
    });
    await t.test('invalid transitions, unsupported schemas, immutable actor/scope fields and CSRF change nothing', async () => {
      const task = await createTask();
      await unchanged(async () => {
        for (const data of [command('accept'), { ...command(), actorId: users.worker }, { ...command(), organizationId: org.b }, { ...command(), projectId: project.b }, { ...command(), expectedVersion: '1' }, { ...command(), schemaVersion: '1' }, { ...command(), taskId: task }]) assert.equal((await post(task, data as ReturnType<typeof command>)).statusCode, 400);
        const unsupported = await post(task, { ...command(), schemaVersion: 2 }); assert.equal(unsupported.statusCode, 400); assert.equal(unsupported.json().code, 'UNSUPPORTED_COMMAND_SCHEMA');
        const invalid = await post(task, command('submit')); assert.equal(invalid.statusCode, 409); assert.equal(invalid.json().code, 'INVALID_TASK_TRANSITION');
        for (const supplied of [{ ...headers.worker, origin: 'https://foreign.test' }, { ...headers.worker, 'x-csrf-token': randomBytes(32).toString('base64url') }]) assert.equal((await app.inject({ method: 'POST', url: `${path(task)}/commands`, payload: command(), headers: supplied })).statusCode, 403);
        assert.equal((await app.inject({ method: 'POST', url: `${path(task)}/commands`, payload: command() })).statusCode, 401);
      });
      assert.equal((await post(task)).statusCode, 200);
      await unchanged(async () => assert.equal((await post(task, command('start', 2))).json().code, 'INVALID_TASK_TRANSITION'));
      assert.equal((await post(task, command('submit', 2))).statusCode, 200);
      for (const action of ['start', 'submit']) await unchanged(async () => assert.equal((await post(task, command(action, 3))).json().code, 'INVALID_TASK_TRANSITION'));
    });
    await t.test('foreign company/project/task substitutions never reveal a record or receipt; shared account scopes remain separate', async () => {
      const taskA = await createTask(), taskB = await createTask('worker', org.b, project.b), taskOther = await createTask('worker', org.a, project.other);
      const op = command(); assert.equal((await post(taskA, op)).statusCode, 200);
      await unchanged(async () => {
        for (const [id, tenant, proj] of [[taskA, org.b, project.b], [taskB, org.a, project.a], [taskOther, org.a, project.a], [taskA, org.a, project.other], [randomUUID(), org.a, project.a], [taskA, org.a, project.b]]) {
          const result = await post(id, op, 'worker', tenant, proj); assert.equal(result.statusCode, 404, result.body); assert(!result.body.includes('task')); assert(!result.body.includes(op.operationId));
        }
        assert.equal((await post(taskA, op, 'other')).statusCode, 404);
      });
      assert.equal((await post(taskB, op, 'worker', org.b, project.b)).statusCode, 200);
      assert.equal((await owner.query('SELECT count(*) FROM task_progress_receipts WHERE operation_id = $1', [op.operationId])).rows[0].count, '2');
    });
    await t.test('uppercase UUID paths accept commands and casing changes replay the identical receipt', async () => {
      const task = await createTask(), op = command();
      const first = await post(task.toUpperCase(), { ...op, operationId: op.operationId.toUpperCase() }, 'worker', org.a.toUpperCase(), project.a.toUpperCase());
      assert.equal(first.statusCode, 200, first.body);
      assert.equal(first.json().task.status, 'in_progress'); assert.equal(first.json().task.version, 2);
      await unchanged(async () => {
        for (const [id, tenant, proj] of [
          [task, org.a, project.a],
          [task.toUpperCase(), org.a, project.a],
          [task, org.a.toUpperCase(), project.a],
          [task, org.a, project.a.toUpperCase()],
        ]) {
          const retry = await post(id, op, 'worker', tenant, proj);
          assert.equal(retry.statusCode, 200, retry.body);
          assert.deepEqual(retry.json(), first.json());
        }
      });
      assert.equal((await owner.query('SELECT count(*) FROM task_progress_receipts WHERE task_id = $1', [task])).rows[0].count, '1');
      assert.equal((await owner.query("SELECT count(*) FROM organization_audit_events WHERE subject_id = $1 AND event = 'task_started'", [task])).rows[0].count, '1');
    });
    await t.test('canonical identical retries replay the committed snapshot; different content or path is rejected atomically', async () => {
      const task = await createTask(), op = command();
      const first = await post(task, op); assert.equal(first.statusCode, 200);
      await unchanged(async () => {
        const duplicate = await post(task, { expectedVersion: 1, action: 'start', schemaVersion: 1, operationId: op.operationId.toUpperCase() }); assert.deepEqual(duplicate.json(), first.json());
        for (const change of [{ action: 'submit' }, { expectedVersion: 2 }]) { const result = await post(task, { ...op, ...change }); assert.equal(result.statusCode, 409); assert.equal(result.json().code, 'OPERATION_ID_REUSED'); }
      });
      const another = await createTask(), anotherProject = await createTask('worker', org.a, project.other);
      for (const [id, proj] of [[another, project.a], [anotherProject, project.other]]) await unchanged(async () => {
        const result = await post(id, op, 'worker', org.a, proj); assert.equal(result.statusCode, 409, result.body); assert.equal(result.json().code, 'OPERATION_ID_REUSED');
      });
      await post(task, command('submit', 2));
      await unchanged(async () => assert.deepEqual((await post(task, op)).json(), first.json()));
      const receipt = (await owner.query('SELECT * FROM task_progress_receipts WHERE operation_id = $1', [op.operationId])).rows[0];
      assert.equal(receipt.request_hash.length, 64); assert(receipt.committed_at); assert.equal(receipt.result.task.version, 2);
      const event = (await owner.query('SELECT * FROM organization_audit_events WHERE id = $1', [receipt.audit_id])).rows[0];
      assert.equal(event.actor_id, users.worker); assert.equal(event.subject_id, task); assert.equal(event.event, 'task_started');
      assert.deepEqual(event.details, { projectId: project.a, operationId: op.operationId, schemaVersion: 1, beforeVersion: 1, afterVersion: 2, beforeStatus: 'planned', afterStatus: 'in_progress' });
    });
    await t.test('parallel identical commands perform one mutation and audit; conflicting devices get an explicit stale version', async () => {
      const task = await createTask(), op = command();
      const results = await Promise.all(Array.from({ length: 10 }, () => post(task, op)));
      for (const result of results) { assert.equal(result.statusCode, 200, result.body); assert.deepEqual(result.json(), results[0].json()); }
      assert.equal((await owner.query('SELECT version FROM tasks WHERE id = $1', [task])).rows[0].version, 2);
      assert.equal((await owner.query("SELECT count(*) FROM organization_audit_events WHERE subject_id = $1 AND event = 'task_started'", [task])).rows[0].count, '1');
      assert.equal((await owner.query('SELECT count(*) FROM task_progress_receipts WHERE task_id = $1', [task])).rows[0].count, '1');
      const otherTask = await createTask();
      const devices = await Promise.all([post(otherTask, command()), post(otherTask, command())]);
      assert.deepEqual(devices.map(result => result.statusCode).sort(), [200, 409]);
      const stale = devices.find(result => result.statusCode === 409)!; assert.equal(stale.json().code, 'STALE_TASK_VERSION'); assert.equal(stale.json().task.version, 2);
      await unchanged(async () => assert.equal((await post(otherTask, command('submit', 1))).json().code, 'STALE_TASK_VERSION'));
    });
    await t.test('lost HTTP response after commit and retry in a restarted Node process use persisted receipts', async () => {
      const origin = await app.listen({ host: '127.0.0.1', port: 0 });
      const task = await createTask(), op = command();
      await assert.rejects(fetch(`${origin}${path(task)}/commands`, { method: 'POST', headers: { ...headers.worker, 'content-type': 'application/json', 'x-test-drop-response': 'yes' }, body: JSON.stringify(op) }));
      const receipt = (await owner.query('SELECT result FROM task_progress_receipts WHERE operation_id = $1', [op.operationId])).rows[0].result;
      assert.equal(receipt.task.version, 2);
      await unchanged(async () => {
        const retry = await fetch(`${origin}${path(task)}/commands`, { method: 'POST', headers: { ...headers.worker, 'content-type': 'application/json' }, body: JSON.stringify(op) });
        assert.equal(retry.status, 200); assert.deepEqual(await retry.json(), receipt);
        const result = await new Promise<{ statusCode: number; body: unknown }>((resolve, reject) => {
          const child = spawn(process.execPath, ['--import', 'tsx', 'tests/helpers/task-progress-process.mjs'], { stdio: ['pipe', 'pipe', 'pipe'] });
          let output = '', error = ''; child.stdout.on('data', chunk => output += chunk); child.stderr.on('data', chunk => error += chunk);
          child.on('error', reject); child.on('close', code => code === 0 ? resolve(JSON.parse(output)) : reject(new Error(error)));
          child.stdin.end(JSON.stringify({ databaseUrl: runtimeUrl.href, origin: config.origin, url: `${path(task)}/commands`, headers: headers.worker, payload: op }));
        });
        assert.equal(result.statusCode, 200); assert.deepEqual(result.body, receipt);
      });
    });
    await t.test('audit and receipt failures roll back task status, timestamp, version and all records', async () => {
      for (const table of ['organization_audit_events', 'task_progress_receipts']) {
        const task = await createTask(), op = command();
        await owner.query(`CREATE FUNCTION fail_progress() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Synthetic failure'; END $$`);
        await owner.query(`CREATE TRIGGER fail_progress BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION fail_progress()`);
        try { await unchanged(async () => assert.equal((await post(task, op)).statusCode, 503)); }
        finally { await owner.query(`DROP TRIGGER fail_progress ON ${table}`); await owner.query('DROP FUNCTION fail_progress()'); }
        assert.equal((await post(task, op)).statusCode, 200);
      }
    });
    await t.test('every command including replay rechecks revocations and session expiry after waiting for the company lock', async () => {
      for (const replay of [false, true]) for (const scenario of ['role', 'project', 'membership', 'company', 'blocked', 'expired', 'session', 'assignee']) {
        const task = await createTask(), op = command(); if (replay) assert.equal((await post(task, op)).statusCode, 200);
        if (scenario === 'expired') await owner.query("UPDATE sessions SET expires_at = clock_timestamp() + interval '400 milliseconds' WHERE user_id = $1", [users.worker]);
        const blocker = await owner.connect();
        const before = await snapshot('task_progress_receipts'), taskBefore = await snapshot('tasks'), auditBefore = await snapshot('organization_audit_events');
        try {
          await blocker.query('BEGIN'); await lockOrganization(blocker, org.a);
          const waiting = Promise.resolve(post(task, op)); await waitForLock();
          if (scenario === 'role') await blocker.query("DELETE FROM membership_roles WHERE membership_id = $1 AND role = 'worker'", [members.worker]);
          if (scenario === 'project') await blocker.query("UPDATE project_memberships SET status = 'inactive', version = version + 1 WHERE project_id = $1 AND membership_id = $2", [project.a, members.worker]);
          if (scenario === 'membership') await blocker.query("UPDATE organization_memberships SET status = 'inactive' WHERE id = $1", [members.worker]);
          if (scenario === 'company') await blocker.query("UPDATE organizations SET status = 'inactive' WHERE id = $1", [org.a]);
          if (scenario === 'blocked') await blocker.query('UPDATE users SET blocked_at = now() WHERE id = $1', [users.worker]);
          if (scenario === 'expired') await blocker.query('SELECT pg_sleep(0.45)');
          if (scenario === 'session') await blocker.query('DELETE FROM sessions WHERE user_id = $1', [users.worker]);
          if (scenario === 'assignee') {
            await blocker.query("SELECT set_config('sitegrid.user_id', $1, true)", [users.manager]);
            await blocker.query('UPDATE tasks SET assignee_membership_id = $2, version = version + 1 WHERE id = $1', [task, members.other]);
          }
          await blocker.query('COMMIT');
          const result = await waiting; assert.equal(result.statusCode, ['blocked', 'expired', 'session'].includes(scenario) ? 401 : ['membership', 'company'].includes(scenario) ? 403 : 404, `${replay}/${scenario}/${result.body}`);
          assert(!result.body.includes(op.operationId)); assert(!result.body.includes(task));
          assert.deepEqual(await snapshot('task_progress_receipts'), before); assert.deepEqual(await snapshot('organization_audit_events'), auditBefore);
          if (scenario !== 'assignee') assert.deepEqual(await snapshot('tasks'), taskBefore);
          const deniedRetry = await post(task, op); assert.equal(deniedRetry.statusCode, result.statusCode);
          await asActor('worker', org.a, project.a, async client => {
            assert.equal((await client.query('SELECT * FROM task_progress_receipts WHERE operation_id = $1', [op.operationId])).rows.length, ['expired', 'session'].includes(scenario) ? (replay ? 1 : 0) : 0);
          }); // Session is enforced by API; raw SQL context is a trusted server boundary.
        } finally {
          await blocker.query('ROLLBACK'); blocker.release();
          if (scenario === 'role') await owner.query("INSERT INTO membership_roles(organization_id, membership_id, role) VALUES ($1, $2, 'worker')", [org.a, members.worker]);
          if (scenario === 'project') await owner.query("UPDATE project_memberships SET status = 'active', version = version + 1 WHERE project_id = $1 AND membership_id = $2", [project.a, members.worker]);
          if (scenario === 'membership') await owner.query("UPDATE organization_memberships SET status = 'active' WHERE id = $1", [members.worker]);
          if (scenario === 'company') await owner.query("UPDATE organizations SET status = 'active' WHERE id = $1", [org.a]);
          if (scenario === 'blocked') await owner.query('UPDATE users SET blocked_at = NULL WHERE id = $1', [users.worker]);
          if (scenario === 'expired') await owner.query("UPDATE sessions SET expires_at = clock_timestamp() + interval '1 hour' WHERE user_id = $1", [users.worker]);
          if (scenario === 'session') await owner.query("INSERT INTO sessions(token_hash, user_id, csrf_token, expires_at) VALUES ($1, $2, $3, now() + interval '1 hour')", [createHash('sha256').update(headers.worker.cookie.slice('sitegrid='.length)).digest('hex'), users.worker, headers.worker['x-csrf-token']]);
        }
      }
      const taskB = await createTask('worker', org.b, project.b);
      await owner.query("UPDATE organization_memberships SET status = 'inactive' WHERE id = $1", [members.worker]);
      try { assert.equal((await post(taskB, command(), 'worker', org.b, project.b)).statusCode, 200); }
      finally { await owner.query("UPDATE organization_memberships SET status = 'active' WHERE id = $1", [members.worker]); }
    });
    await t.test('runtime FORCE RLS, immutable receipts and ordinary edit APIs cannot bypass progress rules', async () => {
      const role = (await runtime.query('SELECT rolsuper, rolbypassrls, rolcreaterole FROM pg_roles WHERE rolname = current_user')).rows[0];
      assert.deepEqual(role, { rolsuper: false, rolbypassrls: false, rolcreaterole: false });
      const flags = (await owner.query("SELECT relrowsecurity, relforcerowsecurity, pg_get_userbyid(relowner) AS owner FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND relname = 'task_progress_receipts'", [schema])).rows[0];
      assert(flags.relrowsecurity && flags.relforcerowsecurity); assert.notEqual(flags.owner, 'sitegrid');
      assert.deepEqual((await runtime.query('SELECT * FROM task_progress_receipts')).rows, []);
      const task = await createTask();
      await unchanged(async () => {
        for (const status of ['in_progress', 'submitted', 'accepted', 'planned']) {
          const result = await app.inject({ method: 'POST', url: `${path(task)}/update`, headers: headers.manager, payload: { title: 'Zmiana', assigneeMembershipId: members.worker, expectedVersion: 1, status } }); assert.equal(result.statusCode, 400);
        }
        await assert.rejects(asActor('worker', org.a, project.a, client => client.query("UPDATE tasks SET title = 'Bypass', version = version + 1 WHERE id = $1", [task])), { code: '23514' });
        await assert.rejects(asActor('manager', org.a, project.a, client => client.query("UPDATE tasks SET status = 'in_progress', version = version + 1 WHERE id = $1", [task])), { code: '23514' });
        assert.equal((await asActor('worker', org.b, project.b, client => client.query('UPDATE tasks SET version = version + 1 WHERE id = $1', [task]))).rowCount, 0);
      });
      const op = command(); await post(task, op);
      await asActor('worker', org.a, project.a, async client => { assert.equal((await client.query('SELECT * FROM task_progress_receipts WHERE operation_id = $1', [op.operationId])).rows.length, 1); });
      await asActor('manager', org.a, project.a, async client => { assert.equal((await client.query('SELECT * FROM task_progress_receipts WHERE operation_id = $1', [op.operationId])).rows.length, 0); });
      for (const sql of ['UPDATE task_progress_receipts SET request_hash = request_hash', 'DELETE FROM task_progress_receipts', 'TRUNCATE task_progress_receipts']) await assert.rejects(asActor('worker', org.a, project.a, client => client.query(sql)), { code: '42501' });
      const edited = await app.inject({ method: 'POST', url: `${path(task)}/update`, headers: headers.manager, payload: { title: 'Nowy opis', assigneeMembershipId: members.worker, expectedVersion: 2 } });
      assert.equal(edited.statusCode, 200, edited.body); assert.equal(edited.json().task.status, 'in_progress');
      const solo = new pg.Pool({ connectionString: runtimeUrl.href, max: 1 });
      try {
        await withOrganization(solo, org.a, async client => { await client.query("SELECT set_config('sitegrid.task_progress_action', 'start', true), set_config('sitegrid.project_id', $1, true)", [project.a]); });
        await assert.rejects(withOrganization(solo, org.a, async client => { await client.query("SELECT set_config('sitegrid.task_progress_action', 'submit', true)"); throw new Error('rollback'); }));
        const result = (await solo.query("SELECT NULLIF(current_setting('sitegrid.task_progress_action', true), '') AS action, NULLIF(current_setting('sitegrid.organization_id', true), '') AS tenant, NULLIF(current_setting('sitegrid.project_id', true), '') AS project")).rows[0]; assert.deepEqual(result, { action: null, tenant: null, project: null });
      } finally { await solo.end(); }
    });
    await t.test('archived projects block new progress while preserving authorized receipts and history', async () => {
      const task = await createTask(), op = command(); const before = await post(task, op);
      await owner.query("UPDATE projects SET status = 'archived', version = version + 1 WHERE id = $1", [project.a]);
      await unchanged(async () => {
        assert.deepEqual((await post(task, op)).json(), before.json());
        const result = await post(task, command('submit', 2)); assert.equal(result.statusCode, 409); assert.equal(result.json().code, 'PROJECT_ARCHIVED');
      });
    });
  } finally {
    await app.close(); await runtime.end(); await owner.end();
    try { await admin.query(`DROP SCHEMA ${schema} CASCADE`); } finally { await admin.end(); }
  }
});
