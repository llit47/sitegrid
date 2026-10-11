import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { taskFixture } from './helpers/task-management-fixture.js';
import { migrate, checkMigrations } from '../apps/server/src/migrations.js';
import { lockOrganization } from '../apps/server/src/common/organization-lock.js';
import { withOrganization } from '../apps/server/src/organization-context.js';
import { validateSnapshot } from '../apps/web/src/storage/snapshot.js';

test('PR21 populated schema 11 → 12 preserves every record and checksum, including M08 receipt', { skip: !process.env.TEST_DATABASE_URL }, async () => {
  const f=await taskFixture({ legacy:true });
  try {
    const contractor=randomUUID();
    await f.owner.query("INSERT INTO contractors(organization_id,id,name) VALUES ($1,$2,'Kontrahent zachowany')",[f.organizations.a,contractor]);
    await f.owner.query('UPDATE projects SET contractor_id=$2,version=version+1 WHERE id=$1',[f.projects[0],contractor]);
    await f.owner.query("INSERT INTO organization_settings(organization_id,accent_color,version) VALUES ($1,'#123456',3)",[f.organizations.a]);
    await f.owner.query("INSERT INTO organization_logos(organization_id,data,mime_type,version) VALUES ($1,$2,'image/png',3)",[f.organizations.a,Buffer.from('preserved-logo')]);
    await f.owner.query("INSERT INTO organization_invitations(organization_id,email,role,issuer_id,token_hash) VALUES ($1,'invite@example.test','worker',$2,$3)",[f.organizations.a,f.users.admin,'b'.repeat(64)]);
    const client=await f.owner.connect();
    try {
      await client.query('BEGIN'); await client.query("SELECT set_config('sitegrid.user_id',$1,true),set_config('sitegrid.organization_id',$2,true),set_config('sitegrid.project_id',$3,true)",[f.users.manager,f.organizations.a,f.projects[0]]);
      for (const name of ['manager','worker']) await client.query('INSERT INTO project_memberships(organization_id,project_id,membership_id) VALUES ($1,$2,$3)',[f.organizations.a,f.projects[0],f.members[name]]);
      await client.query("INSERT INTO tasks(organization_id,project_id,title,assignee_membership_id,author_membership_id) VALUES ($1,$2,'Istniejące',$3,$4)",[f.organizations.a,f.projects[0],f.members.worker,f.members.manager]); await client.query('COMMIT');
    } finally { client.release(); }
    const task=(await f.owner.query('SELECT * FROM tasks')).rows[0], operationId=randomUUID();
    const progress=await f.app.inject({ method:'POST',url:`/api/organizations/${f.organizations.a}/projects/${f.projects[0]}/tasks/${task.id}/commands`,headers:f.headers.worker,payload:{ operationId,schemaVersion:1,action:'start',expectedVersion:1 } });
    assert.equal(progress.statusCode,200,progress.body);
    const tables=(await f.owner.query('SELECT tablename FROM pg_tables WHERE schemaname=$1 ORDER BY tablename',[f.schema])).rows.map(row=>row.tablename);
    const snapshot=async (table:string)=>(await f.owner.query(`SELECT * FROM ${table} ORDER BY to_jsonb(${table})::text`)).rows;
    const before=await Promise.all(tables.map(snapshot));
    assert.equal(await migrate(f.owner,'migrations'),13); assert.equal(await migrate(f.owner,'migrations'),13); assert.equal(await checkMigrations(f.owner,'migrations'),13);
    for (const [i,table] of tables.entries()) assert.deepEqual(table==='schema_migrations' ? (await snapshot(table)).filter(row=>row.version<=11) : await snapshot(table),table==='tasks' ? before[i].map(row=>({...row,parent_task_id:null,hierarchy_root:true})) : before[i],table);
    const replay=await f.app.inject({ method:'POST',url:`/api/organizations/${f.organizations.a}/projects/${f.projects[0]}/tasks/${task.id}/commands`,headers:f.headers.worker,payload:{ operationId,schemaVersion:1,action:'start',expectedVersion:1 } });
    assert.equal(replay.statusCode,200); assert.deepEqual(replay.json(),progress.json());
    assert.equal((await f.app.inject('/health/ready')).json().schema,13);
  } finally { await f.close(); }
});

test('PR21 company backlog, task-derived access, atomic assignment and security under FORCE RLS', { skip: !process.env.TEST_DATABASE_URL }, async t => {
  const f=await taskFixture(), base=`/api/organizations/${f.organizations.a}`;
  const get=(url=base+'/tasks',actor='manager')=>f.app.inject({ url,headers:f.headers[actor] });
  const post=(url:string,payload:object,actor='manager')=>f.app.inject({ method:'POST',url,payload,headers:f.headers[actor] });
  const path=(task:any)=>`${base}/projects/${task.projectId}/tasks/${task.id}`;
  const created:any[]=[];
  try {
    await t.test('admin without manager, manager and foreman without project membership create ten backlog tasks across projects', async()=>{
      for (let i=0;i<10;i++) {
        const projectId=f.projects[i%3],actor=['admin','manager','foreman'][i%3];
        const response=await post(`${base}/projects/${projectId}/tasks`,{ title:`Backlog ${i+1}`, ...(i%2===0 ? { assigneeMembershipId:null } : {}) },actor);
        assert.equal(response.statusCode,201,response.body); assert.equal(response.json().task.assigneeMembershipId,null); assert.equal(response.json().task.status,'planned');
        created.push({ ...response.json().task,projectId });
      }
      assert.equal((await f.owner.query('SELECT count(*) FROM project_memberships')).rows[0].count,'0');
      for (const actor of ['admin','manager','foreman']) { const result=await get(base+'/tasks?view=backlog',actor); assert.equal(result.statusCode,200); assert.equal(result.json().tasks.length,10); assert.equal(result.headers['cache-control'],'no-store'); }
      assert.equal((await get(base+'/tasks?view=backlog','worker')).statusCode,403);
      assert.deepEqual((await get(base+'/tasks','worker')).json().tasks,[]);
    });
    await t.test('assign, reassign and unassign planned tasks without creating project memberships',async()=>{
      for (let i=0;i<6;i++) { const response=await post(path(created[i])+'/assign',{ assigneeMembershipId:f.members[i%2?'other':'worker'],expectedVersion:1 },i%2?'foreman':'admin'); assert.equal(response.statusCode,200,response.body); created[i]={...created[i],...response.json().task}; }
      const reassigned=await post(path(created[0])+'/assign',{ assigneeMembershipId:f.members.other,expectedVersion:2 }); assert.equal(reassigned.statusCode,200);
      const cleared=await post(path(created[0])+'/assign',{ assigneeMembershipId:null,expectedVersion:3 }); assert.equal(cleared.statusCode,200); created[0]={...created[0],...cleared.json().task};
      assert.equal((await get(base+'/tasks?view=backlog')).json().tasks.length,5);
      assert.equal((await f.owner.query('SELECT count(*) FROM project_memberships')).rows[0].count,'0');
      assert.equal((await get(base+'/task-assignees','foreman')).json().assignees.length,6);
      assert.equal((await get(base+'/task-assignees','worker')).statusCode,403);
    });
    await t.test('worker sees only own tasks across projects, minimal projects, no backlog/foreign task/member counts',async()=>{
      const result=await get(base+'/tasks','worker'); assert.equal(result.statusCode,200); assert.equal(result.json().tasks.length,2);
      assert(result.json().tasks.every((task:any)=>task.assigneeMembershipId===f.members.worker && task.canProgress));
      assert(!result.body.includes('private-phone')); assert(!result.body.includes('Backlog 10')); assert(!result.body.includes('other@example.test'));
      assert.equal((await get(base+'/tasks?assigneeMembershipId='+f.members.other,'worker')).statusCode,403);
      assert.equal((await get(base+'/tasks?q=Backlog%2010','worker')).json().tasks.length,0);
      assert.equal((await get(base+'/projects','worker')).json().projects.length,2);
      for (const task of created.filter(task=>task.assigneeMembershipId!==f.members.worker)) assert.equal((await get(path(task),'worker')).statusCode,404);
      for (const id of f.projects) assert.equal((await get(`${base}/projects/${id}/members`,'worker')).statusCode,404);
      assert.equal((await get(`/api/organizations/${f.organizations.b}/tasks`)).statusCode,403);
      assert.deepEqual((await get(`/api/organizations/${f.organizations.b}/tasks`,'worker')).json().tasks,[]);
      assert.equal((await get(base+'/tasks','platform')).statusCode,403);
      assert.equal((await get(base+'/tasks','roleless')).statusCode,403);
      assert.equal((await post(`${base}/projects/${f.foreignProject}/tasks`,{ title:'Foreign' })).statusCode,404);
      assert.equal((await post(path(created[6])+'/assign',{ assigneeMembershipId:f.members.foreign,expectedVersion:1 })).statusCode,400);
    });
    await t.test('authorized server filters, bounded paging and snapshots share the same scope including nullable assignee',async()=>{
      assert.equal((await get(base+'/tasks?limit=3')).json().tasks.length,3); assert.equal((await get(base+'/tasks?limit=3')).json().hasMore,true);
      const ids=(await get(base+'/tasks?limit=3')).json().tasks.map((task:any)=>task.id);
      assert((await get(base+'/tasks?limit=3&offset=3')).json().tasks.every((task:any)=>!ids.includes(task.id)));
      assert.equal((await get(base+'/tasks?q=%00')).statusCode,400); assert.equal((await get(base+'/tasks?limit=101')).statusCode,400); assert.equal((await get(base+'/tasks?projectId=not-a-uuid')).statusCode,400);
      assert.equal((await get(base+'/tasks?view=todo')).json().tasks.length,5);
      assert.equal((await get(base+'/tasks?view=mine','manager')).json().tasks.length,0);
      for (const actor of ['admin','manager','foreman','worker']) for (const projectId of f.projects) {
        const result=await get(`${base}/projects/${projectId}/snapshot`,actor);
        if(actor==='worker' && projectId===f.projects[0]) { assert.equal(result.statusCode,404); continue; }
        assert.equal(result.statusCode,200,result.body); const body=result.json(); await validateSnapshot(body,body.scope);
        assert.equal(body.taskAccess,actor==='worker'?'own':'project');
        assert.equal(body.tasks.length,actor==='worker'?1:created.filter(task=>task.projectId===projectId).length);
      }
    });
    await t.test('M08 own progress and receipts work without project membership; started/submitted assignments explicitly conflict',async()=>{
      const task=created[2],op={ operationId:randomUUID(),schemaVersion:1,action:'start',expectedVersion:2 };
      assert.equal((await post(path(task)+'/commands',op,'manager')).statusCode,404);
      const response=await post(path(task)+'/commands',op,'worker'); assert.equal(response.statusCode,200,response.body);
      assert.deepEqual((await post(path(task)+'/commands',op,'worker')).json(),response.json());
      const same=await post(path(task)+'/assign',{assigneeMembershipId:f.members.worker.toUpperCase(),expectedVersion:3}); assert.equal(same.statusCode,200); assert.equal(same.json().task.version,3);
      for (const assigneeMembershipId of [null,f.members.other]) {
        const result=await post(path(task)+'/assign',{ assigneeMembershipId,expectedVersion:3 }); assert.equal(result.statusCode,409); assert.equal(result.json().code,'TASK_ASSIGNMENT_LOCKED');
        assert.equal((await post(path(task)+'/update',{ title:task.title,assigneeMembershipId,expectedVersion:3 })).statusCode,409);
      }
      assert.equal((await post(path(task)+'/commands',{ operationId:randomUUID(),schemaVersion:1,action:'submit',expectedVersion:3 },'worker')).statusCode,200);
      assert.equal((await post(path(task)+'/assign',{ assigneeMembershipId:null,expectedVersion:4 })).json().code,'TASK_ASSIGNMENT_LOCKED');
      assert.equal((await post(path(created[6])+'/commands',{ ...op,operationId:randomUUID(),expectedVersion:1 },'worker')).statusCode,404);
    });
    await t.test('concurrent assignment has one winner and one audit; version conflicts disclose only authorized task',async()=>{
      const task=created[6],before=Number((await f.owner.query('SELECT count(*) FROM organization_audit_events')).rows[0].count);
      const result=await Promise.all(['worker','other'].map(actor=>post(path(task)+'/assign',{ assigneeMembershipId:f.members[actor],expectedVersion:1 })));
      assert.deepEqual(result.map(response=>response.statusCode).sort(),[200,409]); assert.equal(result.find(response=>response.statusCode===409)!.json().task.version,2);
      assert.equal(Number((await f.owner.query('SELECT count(*) FROM organization_audit_events')).rows[0].count),before+1);
      assert.equal((await post(path(created[7])+'/assign',{ assigneeMembershipId:f.members.worker,expectedVersion:9 })).statusCode,409);
      assert.equal((await post(path(created[7])+'/assign',{ assigneeMembershipId:f.members.worker,expectedVersion:9 },'worker')).statusCode,404);
    });
    await t.test('role, membership, account and assignee revocation are checked after lock waits',async()=>{
      for (const scenario of ['role','membership','blocked','assignee']) {
        const blocker=await f.owner.connect();
        try {
          await blocker.query('BEGIN'); await lockOrganization(blocker,f.organizations.a);
          const waiting=Promise.resolve(post(path(created[8])+'/assign',{ assigneeMembershipId:f.members.other,expectedVersion:1 }));
          let waitingSeen=false;
          for (let i=0;i<100;i++) { if(Number((await f.owner.query("SELECT count(*) FROM pg_stat_activity WHERE application_name=$1 AND wait_event='advisory'",[f.schema])).rows[0].count)) { waitingSeen=true; break; } await f.owner.query('SELECT pg_sleep(0.01)'); }
          assert(waitingSeen);
          if(scenario==='role') await blocker.query("DELETE FROM membership_roles WHERE membership_id=$1",[f.members.manager]);
          if(scenario==='membership') await blocker.query("UPDATE organization_memberships SET status='inactive' WHERE id=$1",[f.members.manager]);
          if(scenario==='blocked') await blocker.query('UPDATE users SET blocked_at=now() WHERE id=$1',[f.users.manager]);
          if(scenario==='assignee') await blocker.query("UPDATE organization_memberships SET status='inactive' WHERE id=$1",[f.members.other]);
          await blocker.query('COMMIT'); assert.equal((await waiting).statusCode,scenario==='blocked'?401:scenario==='membership'?403:scenario==='assignee'?400:404);
        } finally { await blocker.query('ROLLBACK'); blocker.release(); }
        if(scenario==='role') await f.owner.query("INSERT INTO membership_roles(organization_id,membership_id,role) VALUES ($1,$2,'manager')",[f.organizations.a,f.members.manager]);
        if(scenario==='membership') await f.owner.query("UPDATE organization_memberships SET status='active' WHERE id=$1",[f.members.manager]);
        if(scenario==='blocked') await f.owner.query('UPDATE users SET blocked_at=NULL WHERE id=$1',[f.users.manager]);
        if(scenario==='assignee') await f.owner.query("UPDATE organization_memberships SET status='active' WHERE id=$1",[f.members.other]);
      }
      const assigned=created[4]; assert.equal((await post(path(assigned)+'/assign',{ assigneeMembershipId:null,expectedVersion:2 })).statusCode,200);
      assert.equal((await get(path(assigned),'worker')).statusCode,404); assert.equal((await get(`${base}/projects/${assigned.projectId}/snapshot`,'worker')).statusCode,404);
    });
    await t.test('FORCE RLS independently restricts company/worker scope, composite FK and immutable started assignment',async()=>{
      const flags=(await f.runtime.query("SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE relnamespace=$1::regnamespace AND relname='tasks'",[f.schema])).rows[0]; assert(flags.relrowsecurity && flags.relforcerowsecurity);
      assert.deepEqual((await f.runtime.query('SELECT * FROM tasks')).rows,[]);
      for (const actor of ['admin','manager','foreman','worker']) await withOrganization(f.runtime,f.organizations.a,async client=>{
        await client.query("SELECT set_config('sitegrid.user_id',$1,true)",[f.users[actor]]);
        const result=(await client.query('SELECT * FROM tasks')).rows; assert.equal(result.length,actor==='worker'?Number((await f.owner.query('SELECT count(*) FROM tasks WHERE assignee_membership_id=$1',[f.members.worker])).rows[0].count):10); assert(result.every(task=>task.organization_id===f.organizations.a));
        if(actor==='worker') assert(result.every(task=>task.assignee_membership_id===f.members.worker));
      });
      const client=await f.owner.connect();
      try { await client.query('BEGIN'); await client.query('ALTER TABLE tasks DISABLE TRIGGER USER');
        await assert.rejects(client.query("INSERT INTO tasks(organization_id,project_id,title,assignee_membership_id,author_membership_id) VALUES ($1,$2,'Foreign FK',$3,$4)",[f.organizations.a,f.projects[0],f.members.foreign,f.members.manager]),{ code:'23503' });
      } finally { await client.query('ROLLBACK'); client.release(); }
      await withOrganization(f.runtime,f.organizations.a,async client=>{ await client.query("SELECT set_config('sitegrid.user_id',$1,true),set_config('sitegrid.project_id',$2,true)",[f.users.manager,created[2].projectId]); await assert.rejects(client.query('UPDATE tasks SET assignee_membership_id=NULL,version=version+1 WHERE id=$1',[created[2].id]),{ code:'23514' }); });
    });
    await t.test('CSRF and audit failure leave creation and quick assignment unchanged',async()=>{
      const task=created[9],url=path(task)+'/assign',payload={ assigneeMembershipId:f.members.worker,expectedVersion:1 };
      for (const headers of [{ cookie:f.headers.manager.cookie },{...f.headers.manager,origin:'https://evil.test'}]) assert.equal((await f.app.inject({ method:'POST',url,headers,payload })).statusCode,403);
      await f.owner.query("CREATE FUNCTION fail_task_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Synthetic'; END $$");
      await f.owner.query('CREATE TRIGGER fail_task_audit BEFORE INSERT ON organization_audit_events FOR EACH ROW EXECUTE FUNCTION fail_task_audit()');
      try { assert.equal((await post(url,payload)).statusCode,503); assert.equal((await get(path(task))).json().task.version,1); assert.equal((await post(`${base}/projects/${f.projects[0]}/tasks`,{ title:'Rollback' })).statusCode,503); }
      finally { await f.owner.query('DROP TRIGGER fail_task_audit ON organization_audit_events'); await f.owner.query('DROP FUNCTION fail_task_audit()'); }
    });
  } finally { await f.close(); }
});
