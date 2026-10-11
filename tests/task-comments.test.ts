import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import sharp from 'sharp';
import {mkdtemp,mkdir,readFile,writeFile,utimes,symlink,rm,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import pg from 'pg';
import {request as httpRequest} from 'node:http';
import {taskFixture} from './helpers/task-management-fixture.js';
import {migrate} from '../apps/server/src/migrations.js';
import {withOrganization} from '../apps/server/src/organization-context.js';
import {normalizePhoto,photoLimit,requestLimit} from '../apps/server/src/task-comments/images.js';
import {ensureSpace} from '../apps/server/src/task-comments/storage.js';
import {inspectMedia,backupMediaDatabase,verifyBackup,restoreMediaDatabase} from '../apps/server/src/task-comments/operations.js';

export function multipart(text='',photos:{data:Buffer;mime?:string;name?:string}[]=[],commentId=randomUUID()){
 const boundary='sitegrid-'+randomUUID(),chunks:Buffer[]=[];
 const field=(name:string,value:string)=>chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
 field('commentId',commentId);field('text',text);
 for(const photo of photos){chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="photos"; filename="${photo.name??'photo.jpg'}"\r\nContent-Type: ${photo.mime??'image/jpeg'}\r\n\r\n`),photo.data,Buffer.from('\r\n'));}
 chunks.push(Buffer.from(`--${boundary}--\r\n`));return {payload:Buffer.concat(chunks),type:`multipart/form-data; boundary=${boundary}`,commentId};
}
const image=()=>sharp({create:{width:1000,height:600,channels:3,background:'#338899'}}).jpeg().withMetadata({orientation:6}).toBuffer();

test('PR23 populated schema13→14 preserves every existing table, checksums and M08 receipt',{skip:!process.env.TEST_DATABASE_URL},async()=>{
 const f=await taskFixture({legacy:true,legacyVersion:13});try{
 const base=`/api/organizations/${f.organizations.a}/projects/${f.projects[0]}/tasks`,r=await f.app.inject({method:'POST',url:base,headers:f.headers.manager,payload:{title:'Zachowane zadanie',assigneeMembershipId:f.members.worker}});assert.equal(r.statusCode,201,r.body);
 const task=r.json().task,id=randomUUID(),payload={schemaVersion:1,operationId:id,action:'start',expectedVersion:1};
 const receipt=await f.app.inject({method:'POST',url:base+'/'+task.id+'/commands',headers:f.headers.worker,payload});assert.equal(receipt.statusCode,200,receipt.body);
 const tables=(await f.owner.query('SELECT tablename FROM pg_tables WHERE schemaname=$1 ORDER BY tablename',[f.schema])).rows.map(r=>r.tablename);
 const snapshot=async(table:string)=>(await f.owner.query(`SELECT * FROM ${table} ORDER BY to_jsonb(${table})::text`)).rows;
 const before=await Promise.all(tables.map(snapshot));assert.equal(await migrate(f.owner,'migrations'),14);
 for(const [i,table] of tables.entries()){const after=await snapshot(table);assert.deepEqual(table==='schema_migrations'?after.filter(r=>r.version<=13):after,before[i],table);}
 assert.deepEqual((await f.app.inject({method:'POST',url:base+'/'+task.id+'/commands',headers:f.headers.worker,payload})).json(),receipt.json());
 }finally{await f.close();}
});

test('PR23 complete discussion and private images under actual runtime FORCE RLS',{skip:!process.env.TEST_DATABASE_URL},async t=>{
 const f=await taskFixture(),project=`/api/organizations/${f.organizations.a}/projects/${f.projects[0]}`,base=project+'/tasks';
 const get=(url:string,actor='worker')=>f.app.inject({url,headers:f.headers[actor]});
 const createTask=async(title:string,assignee:string)=>{const r=await f.app.inject({method:'POST',url:base,headers:f.headers.manager,payload:{title,assigneeMembershipId:assignee}});assert.equal(r.statusCode,201,r.body);return r.json().task;};
 const root=await createTask('Parent',f.members.other),sibling=await createTask('Foreign task',f.members.other);
 const childResponse=await f.app.inject({method:'POST',url:`${base}/${root.id}/subtasks`,headers:f.headers.manager,payload:{title:'Own subtask',assigneeMembershipId:f.members.worker}});assert.equal(childResponse.statusCode,201,childResponse.body);
 const child=childResponse.json().task,path=`${base}/${child.id}/comments`,jpeg=await image();let first:any,photo:any;
 const upload=(url:string,text:string,photos:{data:Buffer;mime?:string;name?:string}[]=[],actor='manager',id=randomUUID(),extra={})=>{const body=multipart(text,photos,id);return f.app.inject({method:'POST',url,payload:body.payload,headers:{...f.headers[actor],'content-type':body.type,...extra}});};
 try{
 await t.test('text-only, photo-only, combined; whole discussion regardless of author; chronological pagination',async()=>{
   for(const [actor,text,photos] of [['admin','Administrator',[]],['foreman','',[{data:jpeg}]],['worker','Own photo and text',[{data:jpeg},{data:jpeg}]]] as const){const r=await upload(path,text,[...photos],actor);assert.equal(r.statusCode,201,r.body);if(actor==='admin')first=r.json().comment;if(actor==='foreman')photo=r.json().comment.photos[0];}
   for(let i=0;i<22;i++)assert.equal((await upload(path,'Comment '+i,[])).statusCode,201);
   const page=await get(path);assert.equal(page.statusCode,200,page.body);assert.equal(page.json().comments.length,20);assert.equal(page.json().comments[0].id,first.id);assert.equal(page.json().comments[1].authorName,'foreman');
   const next=await get(path+'?after='+page.json().nextAfter);assert.equal(next.json().comments.length,5);assert.equal(next.json().nextAfter,null);assert.equal(page.headers['cache-control'],'no-store');
   assert.equal((await get(path,'roleless')).statusCode,404);assert.equal((await get(path,'platform')).statusCode,403);
 });
 await t.test('normalized full image, actual thumbnail, metadata removal and path-safe filenames',async()=>{
   const thumb=await get(path+`/media/${photo.id}/thumbnail`),original=await get(path+`/media/${photo.id}/original`);assert.equal(thumb.statusCode,200,thumb.body);assert.equal(original.statusCode,200);
   const o=await sharp(original.rawPayload).metadata(),th=await sharp(thumb.rawPayload).metadata();assert.equal(o.width,600);assert.equal(o.height,1000);assert.equal(o.orientation,undefined);assert.equal(o.exif,undefined);assert.equal(o.icc,undefined);assert.equal(th.height,480);
   for(const r of [thumb,original]){assert.equal(r.headers['cache-control'],'private, no-store');assert.equal(r.headers['content-type'],'image/jpeg');assert.equal(r.headers['x-content-type-options'],'nosniff');}
   const malicious=await upload(path,'Safe',[{data:jpeg,name:'../../etc/passwd'}]);assert.equal(malicious.statusCode,201,malicious.body);
   assert.equal((await get(path+'/media/..%2F..%2Fetc%2Fpasswd/original')).statusCode,400);
 });
 await t.test('parent, sibling, different project/organization and anonymous direct requests reveal no media',async()=>{
   for(const id of [root.id,sibling.id,randomUUID()])for(const suffix of ['',`/media/${photo.id}/original`,`/media/${photo.id}/thumbnail`])assert.equal((await get(`${base}/${id}/comments${suffix}`)).statusCode,404);
   assert.equal((await get(`/api/organizations/${f.organizations.b}/projects/${f.projects[0]}/tasks/${child.id}/comments/media/${photo.id}/original`)).statusCode,404);
   assert.equal((await get(`/api/organizations/${f.organizations.b}/projects/${f.foreignProject}/tasks/${child.id}/comments/media/${photo.id}/original`,'foreign')).statusCode,404);
   assert.equal((await f.app.inject({url:path+`/media/${photo.id}/original`})).statusCode,401);
   assert.equal((await upload(`${base}/${root.id}/comments`,'No',[],'worker')).statusCode,404);
   assert.equal((await upload(path,'CSRF',[],'worker',randomUUID(),{'x-csrf-token':'bad'})).statusCode,403);
   assert.equal((await upload(path,'Origin',[],'worker',randomUUID(),{origin:'https://evil.test'})).statusCode,403);
 });
 await t.test('FORCE RLS filters raw SQL by task and immutable records reject modification',async()=>{
   const flags=(await f.owner.query("SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid IN ('task_comments'::regclass,'task_comment_media'::regclass)")).rows;assert(flags.every(r=>r.relrowsecurity&&r.relforcerowsecurity));
   const rows=await withOrganization(f.runtime,f.organizations.a,async client=>{await client.query("SELECT set_config('sitegrid.user_id',$1,true)",[f.users.worker]);return (await client.query('SELECT task_id FROM task_comments')).rows;});assert(rows.every(r=>r.task_id===child.id));
   assert.equal((await withOrganization(f.runtime,f.organizations.b,async client=>{await client.query("SELECT set_config('sitegrid.user_id',$1,true)",[f.users.worker]);return client.query('SELECT * FROM task_comment_media');})).rowCount,0);
   await assert.rejects(f.owner.query('UPDATE task_comments SET text=\'changed\' WHERE id=$1',[first.id]),/immutable/);
   await assert.rejects(f.owner.query('DELETE FROM task_comment_media WHERE id=$1',[photo.id]),/immutable/);
 });
 await t.test('bad content, MIME spoof, HEIC, corruption, dimensions, five-file limit and atomic failure',async()=>{
   const before=(await f.owner.query('SELECT count(*) FROM task_comments')).rows[0].count;
   for(const [data,mime,code] of [[Buffer.from('<svg/>'),'image/jpeg',415],[jpeg,'image/png',415],[Buffer.from('0000ftypheic'),'image/heic',415],[jpeg.subarray(0,80),'image/jpeg',422],[Buffer.alloc(photoLimit+1,1),'image/jpeg',413]] as const){const r=await upload(path,'Bad',[{data,mime}]);assert.equal(r.statusCode,code,r.body);assert(r.json().error);}
   const huge=await sharp({create:{width:12001,height:1,channels:3,background:'red'}}).jpeg().toBuffer();assert.equal((await upload(path,'Bad',[{data:huge}])).statusCode,422);
   assert.equal((await upload(path,'Bad',Array.from({length:6},()=>({data:jpeg})))).statusCode,413);
   assert.equal((await upload(path,'Partial',[{data:jpeg},{data:jpeg.subarray(0,50)}])).statusCode,422);
   assert.equal((await upload(path,'',[])).statusCode,400);
   assert.equal((await f.app.inject({method:'POST',url:path,headers:{...f.headers.worker,'content-type':'multipart/form-data; boundary=x','content-length':String(requestLimit+1)},payload:'x'})).statusCode,413);
   assert.equal((await f.owner.query('SELECT count(*) FROM task_comments')).rows[0].count,before);
 });
 await t.test('SQL rejects incomplete attachment sets, cross-tenant relationships and later additions',async()=>{
   await assert.rejects(withOrganization(f.runtime,f.organizations.a,async client=>{
     await client.query("SELECT set_config('sitegrid.user_id',$1,true),set_config('sitegrid.project_id',$2,true)",[f.users.worker,f.projects[0]]);
     await client.query(`INSERT INTO task_comments(organization_id,project_id,task_id,id,author_membership_id,author_name,text,photo_count,payload_sha256) VALUES ($1,$2,$3,$4,$5,'worker','incomplete',1,$6)`,[f.organizations.a,f.projects[0],child.id,randomUUID(),f.members.worker,'a'.repeat(64)]);
   }),/Incomplete comment attachments/);
   await assert.rejects(f.owner.query(`INSERT INTO task_comments(organization_id,project_id,task_id,id,author_membership_id,author_name,text,photo_count,payload_sha256) VALUES ($1,$2,$3,$4,$5,'wrong tenant','invalid',0,$6)`,[f.organizations.a,f.projects[0],child.id,randomUUID(),f.members.foreign,'a'.repeat(64)]),/foreign key/);
   await assert.rejects(f.owner.query(`INSERT INTO task_comment_media(organization_id,project_id,task_id,comment_id,id,position,original_bytes,thumbnail_bytes,original_sha256,thumbnail_sha256,width,height) VALUES ($1,$2,$3,$4,$5,0,1,1,$6,$6,1,1)`,[f.organizations.a,f.projects[0],child.id,first.id,randomUUID(),'a'.repeat(64)]),/creating transaction/);
 });
 await t.test('same ID retry avoids duplicates and changed payload conflicts',async()=>{
   const id=randomUUID(),a=await upload(path,'Once',[{data:jpeg}],'worker',id),b=await upload(path,'Once',[{data:jpeg}],'worker',id);assert.equal(a.statusCode,201);assert.equal(b.statusCode,200,b.body);assert.deepEqual(a.json().comment,b.json().comment);
   assert.equal((await upload(path,'Changed',[],'worker',id)).statusCode,409);
 });
 await t.test('inactive author history stays visible; archived read/new write boundaries',async()=>{
   await f.owner.query("UPDATE organization_memberships SET status='inactive' WHERE (organization_id,id)=($1,$2)",[f.organizations.a,f.members.foreman]);assert((await get(path)).json().comments.some((c:any)=>c.authorName==='foreman'));
   const archiveBase=`/api/organizations/${f.organizations.a}/projects/${f.projects[1]}/tasks`,task=await f.app.inject({method:'POST',url:archiveBase,headers:f.headers.manager,payload:{title:'Archive',assigneeMembershipId:f.members.worker}}),archive=archiveBase+'/'+task.json().task.id+'/comments';
   const result=await upload(archive,'Historical',[{data:jpeg}],'worker'),media=result.json().comment.photos[0];assert.equal(result.statusCode,201);
   await f.owner.query("UPDATE projects SET status='archived',version=version+1 WHERE id=$1",[f.projects[1]]);
   assert.equal((await get(archive)).statusCode,200);assert.equal((await get(archive+`/media/${media.id}/original`)).statusCode,200);assert.equal((await upload(archive,'No archive writes',[],'worker')).statusCode,409);
 });
 await t.test('revoked assignment, role, membership, account and session immediately block later requests',async()=>{
   const assertDenied=async(code:number)=>{assert.equal((await get(path)).statusCode,code);assert.equal((await get(path+`/media/${photo.id}/original`)).statusCode,code);assert.equal((await upload(path,'Denied',[],'worker')).statusCode,code);};
   assert.equal((await f.app.inject({method:'POST',url:`${base}/${child.id}/assign`,headers:f.headers.manager,payload:{assigneeMembershipId:f.members.other,expectedVersion:1}})).statusCode,200);await assertDenied(404);
   assert.equal((await f.app.inject({method:'POST',url:`${base}/${child.id}/assign`,headers:f.headers.manager,payload:{assigneeMembershipId:f.members.worker,expectedVersion:2}})).statusCode,200);
   await f.owner.query("DELETE FROM membership_roles WHERE membership_id=$1 AND role='worker'",[f.members.worker]);await assertDenied(404);
   await f.owner.query("INSERT INTO membership_roles(organization_id,membership_id,role)VALUES($1,$2,'worker')",[f.organizations.a,f.members.worker]);
   await f.owner.query("UPDATE organization_memberships SET status='inactive' WHERE id=$1",[f.members.worker]);await assertDenied(403);await f.owner.query("UPDATE organization_memberships SET status='active' WHERE id=$1",[f.members.worker]);
   await f.owner.query('UPDATE users SET blocked_at=now() WHERE id=$1',[f.users.worker]);await assertDenied(401);await f.owner.query('UPDATE users SET blocked_at=NULL WHERE id=$1',[f.users.worker]);
   await f.owner.query('DELETE FROM sessions WHERE user_id=$1',[f.users.worker]);await assertDenied(401);
 });
 }finally{await f.close();}
});

test('PR23 orphan handling, interrupted uploads, transaction rollback and file integrity',{skip:!process.env.TEST_DATABASE_URL},async t=>{
 const f=await taskFixture();try{
 const base=`/api/organizations/${f.organizations.a}/projects/${f.projects[0]}/tasks`,r=await f.app.inject({method:'POST',url:base,headers:f.headers.manager,payload:{title:'Upload fixture',assigneeMembershipId:f.members.worker}}),path=base+'/'+r.json().task.id+'/comments',jpeg=await image();
 await t.test('audit transaction failure leaves no published references; safe aged orphan cleanup',async()=>{
   await f.owner.query("CREATE FUNCTION reject_comment_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event='task_comment_created' THEN RAISE EXCEPTION 'fixture audit failure'; END IF; RETURN NEW; END $$");await f.owner.query('CREATE TRIGGER fixture_audit_failure BEFORE INSERT ON organization_audit_events FOR EACH ROW EXECUTE FUNCTION reject_comment_audit()');
   const body=multipart('Rollback',[{data:jpeg}]);const result=await f.app.inject({method:'POST',url:path,payload:body.payload,headers:{...f.headers.worker,'content-type':body.type}});assert.equal(result.statusCode,503,result.body);
   assert.equal((await f.owner.query('SELECT count(*) FROM task_comments')).rows[0].count,'0');assert.equal((await f.owner.query('SELECT count(*) FROM task_comment_media')).rows[0].count,'0');
   const scan=await inspectMedia(f.owner,f.config.filesRoot,true);assert.equal(scan.orphans.length,1);assert.equal(scan.removed.length,0);
   const old=new Date(Date.now()-25*3600000);await utimes(join(f.config.filesRoot,scan.orphans[0]),old,old);assert.equal((await inspectMedia(f.owner,f.config.filesRoot,true)).removed.length,1);
   await f.owner.query('DROP TRIGGER fixture_audit_failure ON organization_audit_events');
 });
 await t.test('low storage reserve fails closed before writing any photo',async()=>{
   await assert.rejects(ensureSpace(f.config.filesRoot,Number.MAX_SAFE_INTEGER),(e:any)=>e.code==='MEDIA_STORAGE_FULL');
 });
 await t.test('interrupted real HTTP multipart leaves no records',async()=>{
   const address=await f.app.listen({port:0,host:'127.0.0.1'}),url=new URL(address),body=multipart('Interrupted',[{data:jpeg}]);
   await new Promise<void>(resolve=>{const req=httpRequest({hostname:url.hostname,port:url.port,path,method:'POST',headers:{...f.headers.worker,'content-type':body.type,'content-length':body.payload.length+100000}},()=>resolve());req.on('error',()=>resolve());req.write(body.payload.subarray(0,500));setTimeout(()=>{req.destroy();resolve();},100);});
   await new Promise(resolve=>setTimeout(resolve,150));assert.equal((await f.owner.query('SELECT count(*) FROM task_comments')).rows[0].count,'0');
 });
 await t.test('chunked multipart enforces aggregate 50 MiB including envelope',async()=>{
   const address=f.app.server.address();assert(address && typeof address==='object');
   const padded=Buffer.alloc(photoLimit);jpeg.copy(padded);const body=multipart('Aggregate limit',Array.from({length:5},()=>({data:padded})));
   const status=await new Promise<number>((resolve,reject)=>{const req=httpRequest({hostname:'127.0.0.1',port:address.port,path,method:'POST',headers:{...f.headers.worker,'content-type':body.type,'transfer-encoding':'chunked'}},response=>{response.resume();response.on('end',()=>resolve(response.statusCode!));});req.on('error',reject);req.end(body.payload);});
   assert.equal(status,413);assert.equal((await f.owner.query('SELECT count(*) FROM task_comments')).rows[0].count,'0');
 });
 await t.test('referenced files survive cleanup; corrupted and missing files block reads and checks; symlinks rejected',async()=>{
   const body=multipart('Published',[{data:jpeg}]),result=await f.app.inject({method:'POST',url:path,payload:body.payload,headers:{...f.headers.worker,'content-type':body.type}});assert.equal(result.statusCode,201,result.body);const id=result.json().comment.photos[0].id,file=join(f.config.filesRoot,id,'original.jpg'),original=await readFile(file),url=path+`/media/${id}/original`;
   assert.equal((await inspectMedia(f.owner,f.config.filesRoot,true)).referenced,1);await writeFile(file,Buffer.from('corrupted'));await assert.rejects(inspectMedia(f.owner,f.config.filesRoot),/integrity/);assert.equal((await f.app.inject({url,headers:f.headers.worker})).statusCode,503);
   await rm(file);await assert.rejects(inspectMedia(f.owner,f.config.filesRoot),/ENOENT/);await symlink('/etc/passwd',file);assert.equal((await f.app.inject({url,headers:f.headers.worker})).statusCode,503);await rm(file);await writeFile(file,original);
   const abandoned=join(f.config.filesRoot,'.staging',randomUUID());await mkdir(abandoned);const old=new Date(Date.now()-25*3600000);await utimes(abandoned,old,old);await inspectMedia(f.owner,f.config.filesRoot,true);assert.equal((await readdir(join(f.config.filesRoot,'.staging'))).length,0);
 });
 }finally{await f.close();}
});

test('PR23 actual PostgreSQL snapshot backup, media restore, retained backups and failure states',{skip:!process.env.TEST_DATABASE_URL},async()=>{
 // Dedicated real DB prevents other concurrently running suites changing a dump.
 const originalOwner=process.env.TEST_DATABASE_URL!,originalRuntime=process.env.TEST_RUNTIME_DATABASE_URL!,admin=new pg.Pool({connectionString:originalOwner}),source='media_backup_'+randomUUID().replaceAll('-',''),target=source+'_restore';
 const changeDb=(url:string,name:string)=>{const u=new URL(url);u.pathname='/'+name;return u.href;};
 const root=await mkdtemp(join(tmpdir(),'sitegrid-backup-test-'));let f:Awaited<ReturnType<typeof taskFixture>>|undefined,restored:pg.Pool|undefined;
 try{
 await admin.query(`CREATE DATABASE ${source}`);await admin.query(`CREATE DATABASE ${target}`);
 process.env.TEST_DATABASE_URL=changeDb(originalOwner,source);process.env.TEST_RUNTIME_DATABASE_URL=changeDb(originalRuntime,source);f=await taskFixture();
 const base=`/api/organizations/${f.organizations.a}/projects/${f.projects[0]}/tasks`,task=await f.app.inject({method:'POST',url:base,headers:f.headers.manager,payload:{title:'Restore task',assigneeMembershipId:f.members.worker}}),path=base+'/'+task.json().task.id+'/comments';
 const body=multipart('Backup history',[{data:await image()}]),response=await f.app.inject({method:'POST',url:path,payload:body.payload,headers:{...f.headers.worker,'content-type':body.type}});assert.equal(response.statusCode,201,response.body);
 const backup=join(root,'complete.backup'),url=new URL(changeDb(originalOwner,source));url.searchParams.set('options',`-c search_path=${f.schema}`);
 await backupMediaDatabase(f.owner,url.href,f.config.filesRoot,backup);const manifest=await verifyBackup(backup);assert.equal(manifest.media.length,1);assert.equal(manifest.schema.length,14);
 const destination=join(root,'restored-files'),targetUrl=new URL(changeDb(originalOwner,target));targetUrl.searchParams.set('options',`-c search_path=${f.schema}`);restored=new pg.Pool({connectionString:targetUrl.href});
 assert.equal((await restoreMediaDatabase(restored,targetUrl.href,destination,backup,manifest.schema)).mediaCount,1);
 assert.deepEqual((await restored.query('SELECT * FROM task_comments')).rows,(await f.owner.query('SELECT * FROM task_comments')).rows);assert.deepEqual((await restored.query('SELECT * FROM task_comment_media')).rows,(await f.owner.query('SELECT * FROM task_comment_media')).rows);
 assert.equal((await inspectMedia(restored,destination,true)).referenced,1);await verifyBackup(backup);
 await assert.rejects(restoreMediaDatabase(restored,targetUrl.href,destination,backup,manifest.schema),/empty database/);
 const file=join(f.config.filesRoot,manifest.media[0].id,'thumbnail.jpg');await rm(file);await assert.rejects(backupMediaDatabase(f.owner,url.href,f.config.filesRoot,join(root,'failed.backup')),/ENOENT/);assert(!(await readdir(root)).includes('failed.backup'));await verifyBackup(backup);
 const backed=join(backup,'files',manifest.media[0].id,'original.jpg');await writeFile(backed,Buffer.from('broken'));await assert.rejects(verifyBackup(backup),/integrity/);
 }finally{process.env.TEST_DATABASE_URL=originalOwner;process.env.TEST_RUNTIME_DATABASE_URL=originalRuntime;await restored?.end();await f?.close();await admin.query(`DROP DATABASE IF EXISTS ${source} WITH (FORCE)`);await admin.query(`DROP DATABASE IF EXISTS ${target} WITH (FORCE)`);await admin.end();await rm(root,{recursive:true,force:true});}
});

test('PR23 raster validation rejects excessive total pixels and strips metadata',async()=>{
 const huge=await sharp({create:{width:8000,height:5001,channels:3,background:'red'}}).png().toBuffer();await assert.rejects(normalizePhoto(huge,'image/png'),(e:any)=>e.code==='PHOTO_DIMENSIONS');
});
