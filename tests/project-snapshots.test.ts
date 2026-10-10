import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { buildApp } from '../apps/server/src/app.js';
import { readConfig } from '../apps/server/src/config.js';
import { migrate } from '../apps/server/src/migrations.js';
import { serializeSnapshot, SnapshotLimitError } from '../apps/server/src/project-snapshots/serialize.js';
import { MAX_SNAPSHOT_TASKS, MAX_SNAPSHOT_BYTES, OFFLINE_ACCESS_MS, type ProjectSnapshotBody } from '../apps/server/src/project-snapshots/contract.js';
import { validateSnapshot } from '../apps/web/src/storage/snapshot.js';

const example = (): ProjectSnapshotBody => {
  const now = new Date().toISOString(), projectId = randomUUID();
  return { format: 1, complete: true, scope: { accountId: randomUUID(), organizationId: randomUUID(), projectId }, generatedAt: now,
    expiresAt: new Date(Date.parse(now) + OFFLINE_ACCESS_MS).toISOString(), taskAccess: 'own',
    project: { id: projectId, name: 'Projekt', description: '', status: 'active', version: 1, createdAt: now, updatedAt: now, contractor: null },
    tasks: [{ id: randomUUID(), title: 'Zadanie', description: '', status: 'planned', version: 1, createdAt: now, updatedAt: now, assigneeName: 'Pracownik' }] };
};
test('snapshot contract validates completeness, scope, fields, uniqueness, integrity and provisional bounds', async () => {
  const body = example(), snapshot = serializeSnapshot(body);
  assert.deepEqual(await validateSnapshot(snapshot, body.scope), snapshot);
  for (const modify of [
    (v: any) => { v.complete = false; }, (v: any) => { v.format = 2; }, (v: any) => { v.scope.accountId = randomUUID(); },
    (v: any) => { v.scope.organizationId = randomUUID(); }, (v: any) => { v.project.id = randomUUID(); },
    (v: any) => { v.integrity.records++; }, (v: any) => { v.integrity.bytes++; }, (v: any) => { v.project.name = 'Tampered'; },
    (v: any) => { v.tasks.push(v.tasks[0]); }, (v: any) => { v.tasks[0].password = 'forbidden'; }, (v: any) => { v.taskAccess = 'none'; },
    (v: any) => { v.expiresAt = new Date(Date.parse(v.generatedAt) + 7 * OFFLINE_ACCESS_MS).toISOString(); },
  ]) { const corrupt = structuredClone(snapshot); modify(corrupt); await assert.rejects(validateSnapshot(corrupt, body.scope)); }
  const many = { ...body, tasks: Array.from({ length: MAX_SNAPSHOT_TASKS }, () => ({ ...body.tasks[0], id: randomUUID() })) };
  assert.equal(serializeSnapshot(many).tasks.length, 500);
  assert.throws(() => serializeSnapshot({ ...many, tasks: [...many.tasks, { ...body.tasks[0], id: randomUUID() }] }), SnapshotLimitError);
  const large = { ...many, tasks: many.tasks.map(task => ({ ...task, description: '界'.repeat(4000) })) };
  assert(Buffer.byteLength(JSON.stringify(large)) > MAX_SNAPSHOT_BYTES); assert.throws(() => serializeSnapshot(large), SnapshotLimitError);
});

test('M10 complete project snapshots use real PostgreSQL 17 and unprivileged FORCE RLS', { skip: !process.env.TEST_DATABASE_URL }, async t => {
  assert(process.env.TEST_RUNTIME_DATABASE_URL);
  const schema = `snapshots_${randomBytes(6).toString('hex')}`, admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const ownerUrl = new URL(process.env.TEST_DATABASE_URL!), runtimeUrl = new URL(process.env.TEST_RUNTIME_DATABASE_URL);
  for (const url of [ownerUrl, runtimeUrl]) url.searchParams.set('options', `-c search_path=${schema}`);
  const owner = new pg.Pool({ connectionString: ownerUrl.href }), runtime = new pg.Pool({ connectionString: runtimeUrl.href });
  const config = readConfig({ NODE_ENV: 'test', DATABASE_URL: runtimeUrl.href }), app = await buildApp(config, runtime);
  const orgA = randomUUID(), orgB = randomUUID(), projectA = randomUUID(), projectB = randomUUID(), hidden = randomUUID(), contractor = randomUUID();
  const users: Record<string, string> = {}, members: Record<string, string> = {}, headers: Record<string, Record<string, string>> = {}, taskIds: string[] = [];
  const get = (actor = 'worker', organization = orgA, project = projectA) => app.inject({ url: `/api/organizations/${organization}/projects/${project}/snapshot`, headers: headers[actor] });
  await admin.query(`CREATE SCHEMA ${schema}`);
  try {
    assert.equal(await migrate(owner, 'migrations'), 11); await owner.query(`GRANT USAGE ON SCHEMA ${schema} TO sitegrid`);
    await owner.query('GRANT SELECT ON installation, schema_migrations, users, credentials, platform_admins TO sitegrid');
    await owner.query('GRANT SELECT, INSERT, DELETE ON sessions TO sitegrid'); await owner.query('GRANT SELECT, INSERT, UPDATE, DELETE ON auth_rate_limits TO sitegrid');
    for (const [id, name] of [[orgA, 'Firma A'], [orgB, 'Firma B']]) await owner.query('INSERT INTO organizations(id,name) VALUES ($1,$2)', [id, name]);
    for (const [actor, role] of [['worker','worker'], ['other','worker'], ['manager','manager'], ['foreman','foreman'], ['admin','organization_admin'], ['platform','worker'], ['unassigned','worker']]) {
      users[actor] = randomUUID(); members[actor] = randomUUID();
      await owner.query('INSERT INTO users(id,email) VALUES ($1,$2)', [users[actor], `${actor}@example.test`]);
      await owner.query("INSERT INTO organization_memberships(organization_id,id,user_id,status) VALUES ($1,$2,$3,'active')", [orgA, members[actor], users[actor]]);
      await owner.query('INSERT INTO membership_roles(organization_id,membership_id,role) VALUES ($1,$2,$3)', [orgA, members[actor], role]);
      const token = randomBytes(32).toString('base64url'); headers[actor] = { cookie: `sitegrid=${token}` };
      await owner.query("INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at) VALUES ($1,$2,'synthetic',now()+interval '1 hour')", [createHash('sha256').update(token).digest('hex'), users[actor]]);
    }
    await owner.query('INSERT INTO platform_admins(user_id) VALUES ($1)', [users.platform]);
    members.workerB = randomUUID();
    await owner.query("INSERT INTO organization_memberships(organization_id,id,user_id,status) VALUES ($1,$2,$3,'active')", [orgB, members.workerB, users.worker]);
    await owner.query("INSERT INTO membership_roles(organization_id,membership_id,role) VALUES ($1,$2,'organization_admin')", [orgB, members.workerB]);
    await owner.query('INSERT INTO contractors(organization_id,id,name) VALUES ($1,$2,$3)', [orgA, contractor, 'Klient A']);
    await owner.query('INSERT INTO contractors(organization_id,name) VALUES ($1,$2)', [orgA, 'Ukryty kontrahent']);
    for (const [organization, id, name, client] of [[orgA, projectA, 'Projekt A', contractor], [orgA, hidden, 'Ukryty projekt', null], [orgB, projectB, 'Projekt B', null]]) {
      await owner.query('INSERT INTO projects(organization_id,id,name,description,contractor_id) VALUES ($1,$2,$3,$4,$5)', [organization,id,name,'Opis projektu',client]);
    }
    for (const actor of ['worker','other','manager','foreman']) await owner.query('INSERT INTO project_memberships(organization_id,project_id,membership_id) VALUES ($1,$2,$3)', [orgA, projectA, members[actor]]);
    const seed = await owner.connect();
    try {
      await seed.query('BEGIN'); await seed.query("SELECT set_config('sitegrid.user_id',$1,true)", [users.manager]);
      for (const actor of ['worker','other']) {
        const id = randomUUID(); taskIds.push(id);
        await seed.query('INSERT INTO tasks(organization_id,project_id,id,title,assignee_membership_id,author_membership_id) VALUES ($1,$2,$3,$4,$5,$6)', [orgA,projectA,id,`Zadanie ${actor}`,members[actor],members.manager]);
      }
      await seed.query('COMMIT');
    } finally { seed.release(); }
    await t.test('stable account identity, minimal contractor, own tasks and no-store complete envelope', async () => {
      const response = await get(), body = response.json(); assert.equal(response.statusCode, 200); assert.equal(response.headers['cache-control'], 'no-store');
      assert.deepEqual(body.scope, { accountId: users.worker, organizationId: orgA, projectId: projectA });
      assert.deepEqual(body.project.contractor, { id: contractor, name: 'Klient A', status: 'active' });
      assert.equal(body.taskAccess, 'own'); assert.deepEqual(body.tasks.map((task: any) => task.id), [taskIds[0]]);
      assert.equal(body.tasks[0].assigneeName, 'worker@example.test'); await validateSnapshot(body, body.scope);
      assert(!response.body.includes('Ukryty kontrahent')); assert(!response.body.includes('other@example.test')); assert(!response.body.includes('csrf'));
      assert.equal((await app.inject({ url: '/api/auth/session', headers: headers.worker })).json().user.id, users.worker);
    });
    await t.test('manager/foreman scopes and administrative metadata remain separate, including shared account', async () => {
      for (const actor of ['manager','foreman']) { const body = (await get(actor)).json(); assert.equal(body.taskAccess,'project'); assert.equal(body.tasks.length,2); }
      const admin = (await get('admin')).json(); assert.equal(admin.taskAccess,'none'); assert.deepEqual(admin.tasks,[]);
      const shared = (await get('worker',orgB,projectB)).json(); assert.equal(shared.scope.accountId,users.worker); assert.equal(shared.taskAccess,'none'); assert.deepEqual(shared.tasks,[]);
      assert.equal((await get('platform')).statusCode,404); assert.equal((await get('unassigned')).statusCode,404);
      assert.equal((await get('worker',orgA,hidden)).statusCode,404); assert.equal((await get('worker',orgB,projectA)).statusCode,404);
      assert.equal((await app.inject({ url:`/api/organizations/${orgA}/projects/${projectA}/snapshot` })).statusCode,401);
    });
    await t.test('project/task/contractor share one database moment during concurrent changes', async () => {
      const connect = runtime.connect.bind(runtime); let modified = false;
      (runtime as any).connect = async () => {
        const client = await connect(), query = client.query.bind(client), release = client.release.bind(client);
        (client as any).query = async (sql: string, ...args: any[]) => {
          const result = await (query as any)(sql,...args);
          if (!modified && sql.includes('FROM projects WHERE organization_id')) {
            modified = true; const writer = await owner.connect();
            try {
              await writer.query('BEGIN'); await writer.query("SELECT set_config('sitegrid.user_id',$1,true)",[users.manager]);
              await writer.query("UPDATE contractors SET name='Klient nowy', version=version+1 WHERE id=$1",[contractor]);
              await writer.query("UPDATE projects SET name='Projekt nowy',version=version+1 WHERE id=$1",[projectA]);
              await writer.query("UPDATE tasks SET title='Zadanie nowe',version=version+1 WHERE id=$1",[taskIds[0]]); await writer.query('COMMIT');
            } finally { writer.release(); }
          }
          return result;
        };
        client.release = (...args) => { client.query = query as any; client.release = release; release(...args); }; return client;
      };
      try { const body = (await get()).json(); assert(modified); assert.equal(body.project.name,'Projekt A'); assert.equal(body.project.contractor.name,'Klient A'); assert.equal(body.tasks[0].title,'Zadanie worker'); }
      finally { runtime.connect = connect as any; }
      const next = (await get()).json(); assert.equal(next.project.name,'Projekt nowy'); assert.equal(next.project.contractor.name,'Klient nowy'); assert.equal(next.tasks[0].title,'Zadanie nowe');
      const pooled = await runtime.connect(); try { const state = (await pooled.query("SELECT current_setting('sitegrid.user_id',true) AS actor,current_setting('sitegrid.organization_id',true) AS org,current_setting('transaction_isolation') AS isolation")).rows[0]; assert(!state.actor); assert(!state.org); assert.equal(state.isolation,'read committed'); } finally { pooled.release(); }
    });
    await t.test('blocked account and revoked project/company/role access are never bypassed', async () => {
      await owner.query('UPDATE users SET blocked_at=now() WHERE id=$1',[users.worker]); assert.equal((await get()).statusCode,401);
      await owner.query('UPDATE users SET blocked_at=NULL WHERE id=$1',[users.worker]);
      await owner.query("UPDATE project_memberships SET status='inactive',version=version+1 WHERE membership_id=$1",[members.worker]); assert.equal((await get()).statusCode,404);
      await owner.query("UPDATE project_memberships SET status='active',version=version+1 WHERE membership_id=$1",[members.worker]);
      await owner.query("UPDATE organization_memberships SET status='inactive' WHERE id=$1",[members.worker]); assert.equal((await get()).statusCode,403);
      await owner.query("UPDATE organization_memberships SET status='active' WHERE id=$1",[members.worker]);
      await owner.query('DELETE FROM membership_roles WHERE membership_id=$1',[members.worker]); const body=(await get()).json(); assert.equal(body.taskAccess,'none'); assert.deepEqual(body.tasks,[]);
      await owner.query("INSERT INTO membership_roles(organization_id,membership_id,role) VALUES ($1,$2,'worker')",[orgA,members.worker]);
    });
    await t.test('record and byte overflow explicitly reject rather than returning a partial snapshot', async () => {
      const writer=await owner.connect(); try {
        await writer.query('BEGIN'); await writer.query("SELECT set_config('sitegrid.user_id',$1,true)",[users.manager]);
        await writer.query("INSERT INTO tasks(organization_id,project_id,title,description,assignee_membership_id,author_membership_id) SELECT $1,$2,'Bulk',repeat('界',4000),$3,$4 FROM generate_series(1,499)",[orgA,projectA,members.worker,members.manager]); await writer.query('COMMIT');
      } finally { writer.release(); }
      const byteOverflow=await get(); assert.equal(byteOverflow.statusCode,413); assert(!byteOverflow.json().complete); assert.match(byteOverflow.json().error,/2 MiB/);
      const edit = await owner.connect(); try { await edit.query('BEGIN'); await edit.query("SELECT set_config('sitegrid.user_id',$1,true)",[users.manager]);
        await edit.query("UPDATE tasks SET description='',version=version+1 WHERE title='Bulk'"); await edit.query('COMMIT'); } finally { edit.release(); }
      assert.equal((await get()).json().tasks.length,500);
      const writer2=await owner.connect(); try { await writer2.query('BEGIN'); await writer2.query("SELECT set_config('sitegrid.user_id',$1,true)",[users.manager]); await writer2.query("INSERT INTO tasks(organization_id,project_id,title,assignee_membership_id,author_membership_id) VALUES ($1,$2,'Overflow',$3,$4)",[orgA,projectA,members.worker,members.manager]); await writer2.query('COMMIT'); } finally { writer2.release(); }
      assert.equal((await get()).statusCode,413); assert.equal((await get('admin')).statusCode,200);
    });
    await t.test('inactive contractor and archived project retain authorized read-only history', async () => {
      await owner.query("DELETE FROM tasks WHERE title IN ('Bulk','Overflow')");
      await owner.query("UPDATE contractors SET status='inactive',version=version+1 WHERE id=$1",[contractor]);
      await owner.query("UPDATE projects SET status='archived',version=version+1 WHERE id=$1",[projectA]);
      const body=(await get()).json(); assert.equal(body.project.status,'archived'); assert.equal(body.project.contractor.status,'inactive'); assert.equal(body.tasks.length,1); await validateSnapshot(body,body.scope);
      const flags=(await owner.query("SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_class WHERE relnamespace=$1::regnamespace AND relname IN ('projects','tasks','contractors')",[schema])).rows;
      assert(flags.every(row=>row.relrowsecurity && row.relforcerowsecurity));
      assert.deepEqual((await runtime.query('SELECT rolsuper,rolbypassrls,rolcreaterole FROM pg_roles WHERE rolname=current_user')).rows[0], {rolsuper:false,rolbypassrls:false,rolcreaterole:false});
    });
  } finally { await app.close(); await owner.end(); await runtime.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); }
});
