import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { taskFixture } from './helpers/task-management-fixture.js';
import { migrate, checkMigrations } from '../apps/server/src/migrations.js';
import { withOrganization } from '../apps/server/src/organization-context.js';
import { validateSnapshot } from '../apps/web/src/storage/snapshot.js';
import { serializeSnapshot } from '../apps/server/src/project-snapshots/serialize.js';

test('PR22 populated schema 12 → 13 preserves all records, checksums, backlog and M08 replay', { skip: !process.env.TEST_DATABASE_URL },async()=>{
  const f=await taskFixture({legacy:true,legacyVersion:12});
  try {
    const client=await f.owner.connect(); let id:string;
    try {await client.query('BEGIN'); await client.query("SELECT set_config('sitegrid.user_id',$1,true)",[f.users.manager]);
      id=(await client.query("INSERT INTO tasks(organization_id,project_id,title,description,assignee_membership_id,author_membership_id) VALUES ($1,$2,'Rodzic','Zachowany opis',$3,$4) RETURNING id",[f.organizations.a,f.projects[0],f.members.worker,f.members.manager])).rows[0].id;
      await client.query("INSERT INTO tasks(organization_id,project_id,title,author_membership_id) VALUES ($1,$2,'Backlog',$3)",[f.organizations.a,f.projects[1],f.members.manager]); await client.query('COMMIT');
    }finally{client.release();}
    const url=`/api/organizations/${f.organizations.a}/projects/${f.projects[0]}/tasks/${id!}/commands`,payload={operationId:randomUUID(),schemaVersion:1,action:'start',expectedVersion:1};
    const beforeReceipt=await f.app.inject({method:'POST',url,payload,headers:f.headers.worker}); assert.equal(beforeReceipt.statusCode,200,beforeReceipt.body);
    const tables=(await f.owner.query('SELECT tablename FROM pg_tables WHERE schemaname=$1 ORDER BY tablename',[f.schema])).rows.map(row=>row.tablename);
    const snapshot=async(table:string)=>(await f.owner.query(`SELECT * FROM ${table} ORDER BY to_jsonb(${table})::text`)).rows;
    const before=await Promise.all(tables.map(snapshot));
    assert.equal(await migrate(f.owner,'migrations'),13); assert.equal(await migrate(f.owner,'migrations'),13); assert.equal(await checkMigrations(f.owner,'migrations'),13);
    for(const [i,table] of tables.entries()) {
      const after=await snapshot(table);
      assert.deepEqual(table==='schema_migrations'?after.filter(row=>row.version<=12):table==='tasks'?after.map(({parent_task_id,hierarchy_root,...row})=>{assert.equal(parent_task_id,null);assert.equal(hierarchy_root,true);return row;}):after,before[i],table);
    }
    assert.equal((await snapshot('task_parent_contexts')).length,2);
    assert.deepEqual((await f.app.inject({method:'POST',url,payload,headers:f.headers.worker})).json(),beforeReceipt.json());
  }finally{await f.close();}
});

test('PR22 hierarchy, company assignment, independent M08, sibling privacy and M10 under FORCE RLS', {skip:!process.env.TEST_DATABASE_URL},async t=>{
 const f=await taskFixture(),base=`/api/organizations/${f.organizations.a}`,project=`${base}/projects/${f.projects[0]}`;
 const get=(url:string,actor='manager')=>f.app.inject({url,headers:f.headers[actor]});
 const post=(url:string,payload:object,actor='manager')=>f.app.inject({method:'POST',url,payload,headers:f.headers[actor]});
 const rootResponse=await post(project+'/tasks',{title:'Rodzic',description:'TAJNY OPIS RODZICA',assigneeMembershipId:f.members.other}); assert.equal(rootResponse.statusCode,201,rootResponse.body);
 const root=rootResponse.json().task,path=(id:string)=>`${project}/tasks/${id}`; let own:any,sibling:any,backlog:any;
 try {
  await t.test('all three company management roles create children without project memberships; worker denied',async()=>{
   for(const [actor,title,assignee] of [['admin','Moje podzadanie',f.members.worker],['foreman','TAJNE RODZENSTWO',f.members.other],['manager','Backlog dziecka',null]]){
    const response=await post(path(root.id)+'/subtasks',{title,description:`Opis ${title}`,assigneeMembershipId:assignee},actor!); assert.equal(response.statusCode,201,response.body);
    const task=response.json().task; assert.deepEqual(task.parent,{id:root.id,title:'Rodzic'}); assert.equal(task.version,1); assert.equal(task.status,'planned');
    if(actor==='admin') own=task; else if(actor==='foreman') sibling=task; else backlog=task;
   }
   assert.equal((await f.owner.query('SELECT count(*) FROM project_memberships')).rows[0].count,'0');
   assert.equal((await post(path(root.id)+'/subtasks',{title:'Niedozwolone'},'worker')).statusCode,404);
   const depth=await post(path(own.id)+'/subtasks',{title:'Za głęboko'});assert.equal(depth.statusCode,409);assert.equal(depth.json().code,'SUBTASK_DEPTH_LIMIT');
   assert.equal((await post(path(root.id)+'/subtasks',{title:'Obcy wykonawca',assigneeMembershipId:f.members.foreign})).statusCode,400);
   assert.equal((await post(path(root.id)+'/subtasks',{title:'Podszycie',projectId:f.projects[1]})).statusCode,400);
  });
  await t.test('worker receives only assigned child and minimal parent; even parent assignee has no child list or counters',async()=>{
   const list=await get(base+'/tasks','worker'); assert.equal(list.statusCode,200); assert.deepEqual(list.json().tasks.map((task:any)=>task.id),[own.id]);
   const detail=await get(path(own.id),'worker'); assert.equal(detail.statusCode,200); assert.deepEqual(detail.json().task.parent,{id:root.id,title:'Rodzic'});
   for(const result of [list,detail]) {assert(!result.body.includes('TAJNY')); assert(!result.body.includes('TAJNE')); assert(!result.body.includes('subtaskProgress'));assert(!result.body.includes(sibling.id));}
   for(const id of [root.id,sibling.id,backlog.id]) for(const suffix of ['', '/progress-history','/subtasks']) assert.equal((await get(path(id)+suffix,'worker')).statusCode,404);
   assert.equal((await get(path(root.id)+'/subtasks','other')).statusCode,404);
   const parentOwn=(await get(path(root.id),'other')).json().task; assert(!Object.hasOwn(parentOwn,'subtaskProgress'));
   assert.equal((await get(`/api/organizations/${f.organizations.b}/projects/${f.projects[0]}/tasks/${own.id}`,'worker')).statusCode,404);
   assert.equal((await get(base+'/tasks','platform')).statusCode,403);
   assert.equal((await post(path(sibling.id)+'/assign',{assigneeMembershipId:f.members.worker,expectedVersion:1},'worker')).statusCode,404);
  });
  await t.test('shared account has independent child assignments in two companies; parent contexts cannot cross scopes',async()=>{
   const foreignProject=`/api/organizations/${f.organizations.b}/projects/${f.foreignProject}`;
   const foreignRoot=await post(foreignProject+'/tasks',{title:'Obcy rodzic',description:'OBCA TAJNA HISTORIA'},'foreign');assert.equal(foreignRoot.statusCode,201);
   const foreignChild=await post(`${foreignProject}/tasks/${foreignRoot.json().task.id}/subtasks`,{title:'Własne w firmie B',assigneeMembershipId:f.members.workerB},'foreign');assert.equal(foreignChild.statusCode,201);
   const childId=foreignChild.json().task.id;
   assert.equal((await get(`${foreignProject}/tasks/${childId}`,'worker')).statusCode,200);
   assert.equal((await get(`${foreignProject}/tasks/${childId}`,'manager')).statusCode,403);
   const snapshot=await get(foreignProject+'/snapshot','worker');assert.equal(snapshot.statusCode,200);await validateSnapshot(snapshot.json(),snapshot.json().scope);assert(!snapshot.body.includes('OBCA TAJNA'));assert(!snapshot.body.includes(own.id));
   assert(!(await get(base+'/tasks','worker')).body.includes(childId));
   await withOrganization(f.runtime,f.organizations.a,async client=>{await client.query("SELECT set_config('sitegrid.user_id',$1,true)",[f.users.worker]);assert((await client.query('SELECT task_id FROM task_parent_contexts')).rows.every(row=>row.task_id===root.id));});
  });
  await t.test('flat filters and paging count every node once; management sees complete aggregation',async()=>{
   const all=(await get(base+'/tasks')).json().tasks; assert.equal(all.length,4); assert.equal(new Set(all.map((task:any)=>task.id)).size,4);
   assert.deepEqual(all.find((task:any)=>task.id===root.id).subtaskProgress,{total:3,planned:3,inProgress:0,submitted:0});
   assert.equal((await get(base+'/tasks?view=backlog')).json().tasks[0].id,backlog.id);
   assert.equal((await get(base+'/tasks?q=Moje')).json().tasks[0].id,own.id);
   const first=(await get(base+'/tasks?limit=2')).json(),second=(await get(base+'/tasks?limit=2&offset=2')).json(); assert(first.hasMore);assert(!second.hasMore);assert.equal(new Set([...first.tasks,...second.tasks].map(task=>task.id)).size,4);
   for(const actor of ['admin','manager','foreman']) assert.equal((await get(path(root.id)+'/subtasks',actor)).json().tasks.length,3);
  });
  await t.test('planned assignment can change or clear, uses version and revokes minimal parent context',async()=>{
   for(const member of [f.members.worker,f.members.other,null,f.members.worker]){
    const result=await post(path(backlog.id)+'/assign',{assigneeMembershipId:member,expectedVersion:backlog.version},'admin'); assert.equal(result.statusCode,200,result.body); backlog=result.json().task;
   }
   assert.equal((await post(path(backlog.id)+'/assign',{assigneeMembershipId:null,expectedVersion:1})).statusCode,409);
   const result=await post(path(backlog.id)+'/assign',{assigneeMembershipId:null,expectedVersion:backlog.version}); assert.equal(result.statusCode,200);backlog=result.json().task;
   assert.equal((await get(path(backlog.id),'worker')).statusCode,404);
  });
  await t.test('child M08 receipts replay concurrently and after submit; stale versions and sibling operations are denied',async()=>{
   const start={operationId:randomUUID(),schemaVersion:1,action:'start',expectedVersion:1};
   const results=await Promise.all([post(path(own.id)+'/commands',start,'worker'),post(path(own.id)+'/commands',start,'worker')]); results.forEach(result=>assert.equal(result.statusCode,200,result.body));assert.deepEqual(results[0].json(),results[1].json());
   assert.equal((await post(path(own.id)+'/commands',{...start,operationId:randomUUID()},'worker')).json().code,'STALE_TASK_VERSION');
   assert.equal((await post(path(own.id)+'/commands',{...start,expectedVersion:2},'worker')).json().code,'OPERATION_ID_REUSED');
   assert.equal((await post(path(sibling.id)+'/commands',start,'worker')).statusCode,404);
   assert.equal((await post(path(own.id)+'/assign',{assigneeMembershipId:null,expectedVersion:2})).json().code,'TASK_ASSIGNMENT_LOCKED');
   const submit=await post(path(own.id)+'/commands',{operationId:randomUUID(),schemaVersion:1,action:'submit',expectedVersion:2},'worker');assert.equal(submit.statusCode,200,submit.body);
   assert.deepEqual((await post(path(own.id)+'/commands',start,'worker')).json(),results[0].json());
   assert.equal((await get(path(root.id))).json().task.status,'planned'); assert.equal((await get(path(root.id))).json().task.version,1);
   assert.deepEqual((await get(path(root.id))).json().task.subtaskProgress,{total:3,planned:2,inProgress:0,submitted:1});
   const history=(await get(path(own.id)+'/progress-history','worker')).json().history;assert.deepEqual(history.map((row:any)=>[row.status,row.version]),[['in_progress',2],['submitted',3]]);
   assert.equal((await f.owner.query('SELECT count(*) FROM task_progress_receipts WHERE task_id=$1',[own.id])).rows[0].count,'2');
  });
  await t.test('parent rename updates only minimal context, never child status/version/history',async()=>{
   assert.equal((await post(path(root.id)+'/update',{title:'Nowy tytuł',description:'TAJNY OPIS RODZICA',expectedVersion:1})).statusCode,200);
   const child=(await get(path(own.id),'worker')).json().task;assert.deepEqual(child.parent,{id:root.id,title:'Nowy tytuł'});assert.equal(child.version,3);
   const upper=`/api/organizations/${f.organizations.a.toUpperCase()}/projects/${f.projects[0].toUpperCase()}/tasks/`;assert.equal((await get(upper+root.id.toUpperCase())).json().task.subtaskProgress.total,3);assert.equal((await get(upper+own.id.toUpperCase()+'/progress-history','worker')).json().history.length,2);
  });
  await t.test('SQL enforces one level, cycles, company/project FK and immutable relation; projection and audit obey RLS',async()=>{
   const insert=async(projectId:string,parentId:string,org=f.organizations.a)=>{
    const client=await f.owner.connect();try {await client.query('BEGIN');await client.query("SELECT set_config('sitegrid.user_id',$1,true)",[f.users.manager]);await client.query('ALTER TABLE tasks DISABLE TRIGGER USER');
     await assert.rejects(client.query("INSERT INTO tasks(organization_id,project_id,parent_task_id,title,author_membership_id) VALUES ($1,$2,$3,'Illegal',$4)",[org,projectId,parentId,f.members.manager]),{code:'23503'});
    }finally{await client.query('ROLLBACK');client.release();}
   };
   const invalid=await f.owner.connect();try{await invalid.query('BEGIN');await invalid.query('ALTER TABLE tasks DISABLE TRIGGER USER');const id=randomUUID();await assert.rejects(invalid.query("INSERT INTO tasks(organization_id,project_id,id,parent_task_id,title,author_membership_id) VALUES ($1,$2,$3,$3,'Cycle',$4)",[f.organizations.a,f.projects[0],id,f.members.manager]),{code:'23514'});}finally{await invalid.query('ROLLBACK');invalid.release();}
   await insert(f.projects[0],own.id); await insert(f.projects[1],root.id); await insert(f.foreignProject,root.id,f.organizations.b);
   await withOrganization(f.runtime,f.organizations.a,async client=>{
    await client.query("SELECT set_config('sitegrid.user_id',$1,true),set_config('sitegrid.project_id',$2,true)",[f.users.worker,f.projects[0]]);
    assert.deepEqual((await client.query('SELECT id FROM tasks')).rows.map(row=>row.id),[own.id]);
    assert.deepEqual((await client.query('SELECT task_id,title FROM task_parent_contexts')).rows,[{task_id:root.id,title:'Nowy tytuł'}]);
    const audits=(await client.query("SELECT subject_id FROM organization_audit_events WHERE event LIKE 'task_%'")).rows;assert(audits.length>0 && audits.every(row=>row.subject_id===own.id));
   });
   for(const table of ['tasks','task_parent_contexts','task_progress_receipts']){const flags=(await f.owner.query('SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE relnamespace=$1::regnamespace AND relname=$2',[f.schema,table])).rows[0];assert(flags.relrowsecurity && flags.relforcerowsecurity);assert.deepEqual((await f.runtime.query(`SELECT * FROM ${table}`)).rows,[]);}
   await withOrganization(f.runtime,f.organizations.a,async client=>{
    await client.query("SELECT set_config('sitegrid.user_id',$1,true),set_config('sitegrid.project_id',$2,true)",[f.users.manager,f.projects[0]]);
    await assert.rejects(client.query('UPDATE tasks SET parent_task_id=$2,version=version+1 WHERE id=$1',[backlog.id,sibling.id]),{code:'23514'});
   });
  });
  await t.test('M10 own snapshots include child and only parent title, full snapshots validate hierarchy; legacy format remains readable',async()=>{
   for(const actor of ['manager','admin','foreman','worker','other']){
    const response=await get(project+'/snapshot',actor);assert.equal(response.statusCode,200,response.body);const body=response.json();await validateSnapshot(body,body.scope);
    assert.equal(body.integrity.records,1+body.tasks.length);
    if(actor==='worker'){assert.deepEqual(body.tasks.map((task:any)=>task.id),[own.id]);assert(!response.body.includes('TAJNY'));assert(!response.body.includes('TAJNE'));assert(!response.body.includes('subtaskProgress'));}
    if(actor==='manager'){
     assert.equal(body.tasks.length,4);
     const tampered=structuredClone(body);tampered.tasks.find((task:any)=>task.id===own.id).parent.description='Secret';const {integrity:_,...bad}=tampered;await assert.rejects(validateSnapshot(serializeSnapshot(bad),body.scope));
     const {integrity:__,...legacy}=body;legacy.tasks=legacy.tasks.map(({parent,subtaskProgress,...task}:any)=>task);await validateSnapshot(serializeSnapshot(legacy),body.scope);
    }
   }
  });
  await t.test('audit failure rolls back child creation/projection and progress receipt; access revocation denies replay',async()=>{
   await f.owner.query("CREATE FUNCTION reject_subtask_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Synthetic'; END $$"); await f.owner.query('CREATE TRIGGER reject_subtask_audit BEFORE INSERT ON organization_audit_events FOR EACH ROW EXECUTE FUNCTION reject_subtask_audit()');
   try{assert.equal((await post(path(root.id)+'/subtasks',{title:'Rollback child'})).statusCode,503);assert.equal((await post(path(sibling.id)+'/commands',{operationId:randomUUID(),schemaVersion:1,action:'start',expectedVersion:1},'other')).statusCode,503);assert.equal((await get(path(sibling.id),'other')).json().task.version,1);assert.equal((await f.owner.query("SELECT count(*) FROM tasks WHERE title='Rollback child'")).rows[0].count,'0');}
   finally{await f.owner.query('DROP TRIGGER reject_subtask_audit ON organization_audit_events');await f.owner.query('DROP FUNCTION reject_subtask_audit()');}
   const receipt=(await f.owner.query("SELECT operation_id,result FROM task_progress_receipts WHERE task_id=$1 AND result->'task'->>'version'='2' LIMIT 1",[own.id])).rows[0];
   await f.owner.query("UPDATE organization_memberships SET status='inactive' WHERE id=$1",[f.members.worker]);
   assert.equal((await get(path(own.id),'worker')).statusCode,403);assert.equal((await post(path(own.id)+'/commands',{operationId:receipt.operation_id,schemaVersion:1,action:'start',expectedVersion:1},'worker')).statusCode,403);
  });
 }finally{await f.close();}
});
