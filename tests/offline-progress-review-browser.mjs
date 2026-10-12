// PR26 review regressions: optional storage, per-project failure isolation, shared reads.
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { taskFixture } from './helpers/task-management-fixture.ts';
import { selectCompany, acceptDiscardDialogs } from './helpers/workspace-browser.mjs';
const { chromium } = await import(process.env.SITEGRID_PLAYWRIGHT_MODULE ? pathToFileURL(process.env.SITEGRID_PLAYWRIGHT_MODULE).href : 'playwright');
const f = await taskFixture({ serveWeb:true });
let browser;
try {
  const source = (await build({ stdin:{contents:"export * from './apps/web/src/storage/indexed-db.ts'; export * from './apps/web/src/storage/offline-access.ts'; export * from './apps/web/src/storage/progress-queue.ts'; export * from './apps/web/src/progress/sync.ts';",resolveDir:process.cwd()},bundle:true,write:false,format:'esm',target:'es2023' })).outputFiles[0].text;
  f.app.get('/test-queue.js',(_request,reply)=>reply.type('application/javascript').send(source));
  f.config.origin = await f.app.listen({host:'127.0.0.1',port:0});
  const project = id => `/api/organizations/${f.organizations.a}/projects/${id}`;
  const api = async (path,payload,actor='manager') => {
    const response = await f.app.inject({url:path,...(payload?{method:'POST',payload}:{}),headers:{...f.headers[actor],origin:f.config.origin}});
    assert(response.statusCode<300,response.body);return response.json();
  };
  const tasks=[];
  for(let i=0;i<24;i++)tasks.push((await api(`${project(f.projects[0])}/tasks`,{title:`Review card ${String(i+1).padStart(2,'0')}`,assigneeMembershipId:f.members.worker})).task);
  const healthy=(await api(`${project(f.projects[1])}/tasks`,{title:'Healthy project B',assigneeMembershipId:f.members.worker})).task;
  browser=await chromium.launch({headless:true,...(process.env.SITEGRID_CHROMIUM_PATH?{executablePath:process.env.SITEGRID_CHROMIUM_PATH}:{})});
  const errors=[];
  const open = async unavailable => {
    const context=await browser.newContext({serviceWorkers:'block'});
    await context.addCookies([{name:'sitegrid',value:f.tokens.worker,url:f.config.origin,httpOnly:true,sameSite:'Strict'}]);
    if(unavailable)await context.addInitScript(()=>Object.defineProperty(window,'indexedDB',{get(){throw new DOMException('Denied','SecurityError');}}));
    const page=await context.newPage();acceptDiscardDialogs(page);page.on('pageerror',error=>errors.push(error.message));
    await page.goto(f.config.origin);await selectCompany(page,f.organizations.a,'Zadania');
    await page.getByRole('article',{name:tasks[0].title,exact:true}).waitFor();return {page,context};
  };
  const unavailable=await open(true), page=unavailable.page;
  const card=page.getByRole('article',{name:tasks[0].title,exact:true}), path=`${project(f.projects[0])}/tasks/${tasks[0].id}`;
  await card.getByText(/Nie można sprawdzić wcześniejszych operacji/).waitFor();
  const payloads=[];let preflights=0;
  page.on('request',request=>{if(new URL(request.url()).pathname===path&&request.method()==='GET')preflights++;});
  await page.route(`**${path}/commands`,async route=>{payloads.push(route.request().postDataJSON());const response=await route.fetch();if(payloads.length===1)await route.abort('failed');else await route.fulfill({response});});
  await card.getByRole('button',{name:'Rozpocznij zadanie',exact:true}).click();
  await card.getByRole('button',{name:'Ponów operację',exact:true}).waitFor();
  await card.getByRole('button',{name:'Ponów operację',exact:true}).click();await card.locator('.status-badge').filter({hasText:'W toku'}).waitFor();
  assert.deepEqual(payloads[0],payloads[1]);assert.equal(preflights,1,'An ambiguous retry replays its receipt instead of rejecting its advanced server version');
  await card.getByRole('button',{name:'Zgłoś do odbioru',exact:true}).click();await card.locator('.status-badge').filter({hasText:'Do odbioru'}).waitFor();
  assert.equal(await page.getByText('Zapisano na urządzeniu',{exact:true}).count(),0);
  assert.equal((await f.owner.query("SELECT count(*) FROM organization_audit_events WHERE subject_id=$1 AND event='task_started'",[tasks[0].id])).rows[0].count,'1');
  // A hidden earlier operation changes the server after the visible list was read.
  const stale=page.getByRole('article',{name:tasks[1].title,exact:true}), stalePath=`${project(f.projects[0])}/tasks/${tasks[1].id}`;
  await api(`${stalePath}/commands`,{operationId:crypto.randomUUID(),schemaVersion:1,action:'start',expectedVersion:1},'worker');
  let posts=0;page.on('request',request=>{if(new URL(request.url()).pathname===`${stalePath}/commands`)posts++;});
  const noticeBefore=await page.locator('.task-workspace > p[role="status"]').allTextContents();
  await stale.getByRole('button',{name:'Rozpocznij zadanie',exact:true}).click();
  await stale.getByRole('alert').filter({hasText:'Zadanie zmieniło się na serwerze'}).waitFor();assert.equal(posts,0);assert.deepEqual(await page.locator('.task-workspace > p[role="status"]').allTextContents(),noticeBefore);
  await unavailable.context.close();
  console.log('PASS unavailable IndexedDB: online start/submit work, lost response reuses operationId, fresh server checks fence unseen prior progress, no false local-save confirmation');

  const normal=await open(false), p=normal.page;
  await p.evaluate(async()=>{window.queueTest=await import('/test-queue.js');});
  const snapshots=await Promise.all([f.projects[0],f.projects[1]].map(id=>api(`${project(id)}/snapshot`,undefined,'worker')));
  await p.evaluate(async snapshots=>{const access=await window.queueTest.readOfflineAccess();for(const snapshot of snapshots){await window.queueTest.registerOfflineScope(snapshot.scope,access.generation);const handle=await window.queueTest.openProjectStorage(snapshot.scope);try{await handle.replace(snapshot,access.generation,Date.now());}finally{handle.close();}}},snapshots);
  await normal.context.setOffline(true);
  const queued=await p.evaluate(async ({snapshots,ids})=>{const rows=[];for(let i=0;i<2;i++)rows.push(await window.queueTest.queueProgress(snapshots[i].scope,ids[i],{operationId:crypto.randomUUID(),schemaVersion:1,action:'start',expectedVersion:1}));window.queueTest.notifyProgress();return rows;},{snapshots,ids:[tasks[2].id,healthy.id]});
  await p.waitForFunction(id=>document.querySelector(`article[data-task-id="${id}"] .task-progress button`)?.disabled,queued[0].taskId);
  // Preserve the malformed bytes; no reset/delete is used to recover another scope.
  await p.evaluate(async row=>{const handle=await window.queueTest.openProgressStorage(row.scope);try{await handle.progressTransaction((tx,result)=>{tx.objectStore('progress').put({...row,format:99},row.taskId);result();},'readwrite',false);}finally{handle.close();}},queued[0]);
  await normal.context.setOffline(false);
  const eventually=async(predicate,input)=>{const deadline=Date.now()+35000;while(!await p.evaluate(predicate,input)){if(Date.now()>deadline)throw new Error('Queue condition timed out');await new Promise(resolve=>setTimeout(resolve,100));}};
  await eventually(async row=>(await window.queueTest.queueRows(row.scope)).find(current=>current.taskId===row.taskId)?.state==='confirmed',queued[1]);
  await p.getByRole('alert').filter({hasText:/kolejek projektów|kolejek urządzenia/}).first().waitFor();
  await p.evaluate(async row=>{const handle=await window.queueTest.openProgressStorage(row.scope);try{const value=await handle.progressTransaction((tx,result)=>{const request=tx.objectStore('progress').get(row.taskId);request.onsuccess=()=>result(request.result);},'readonly',false);if(value.format!==99||value.command.operationId!==row.command.operationId)throw new Error('Corrupt data was discarded');}finally{handle.close();}},queued[0]);
  assert.equal((await api(`${project(f.projects[1])}/tasks/${healthy.id}`,undefined,'worker')).task.status,'in_progress');
  assert(await p.getByRole('article',{name:tasks[2].title,exact:true}).getByRole('button',{name:'Rozpocznij zadanie',exact:true}).isDisabled(),'Known pending commands remain blocked when their storage fails');
  console.log('PASS broken project A stays intact with an actionable warning while project B synchronizes its original operation');

  // Measure real project DB opens for one vs many mounted task cards. Notifications
  // and snapshot hashes are independent of subscriber count.
  await p.evaluate(()=>{window.queueReads={opens:0,snapshots:0};const open=IDBFactory.prototype.open,get=IDBObjectStore.prototype.get;IDBFactory.prototype.open=function(...args){if(args[0].startsWith('sitegrid-project-'))window.queueReads.opens++;return open.apply(this,args);};IDBObjectStore.prototype.get=function(...args){if(this.name==='confirmed')window.queueReads.snapshots++;return get.apply(this,args);};});
  await selectCompany(p,f.organizations.a,'Zadania');
  const search=p.getByLabel('Szukaj zadań',{exact:true});
  await search.fill(tasks[3].title);await p.getByRole('button',{name:'Szukaj',exact:true}).click();
  await p.waitForFunction(()=>document.querySelectorAll('.company-task').length===1);
  const measure=async()=>{await p.waitForTimeout(200);await p.evaluate(()=>{window.queueReads={opens:0,snapshots:0};window.queueTest.notifyProgress();});await eventually(()=>window.queueReads.opens>=4);await p.waitForTimeout(200);return p.evaluate(()=>window.queueReads);};
  const single=await measure();await search.fill('');await p.getByRole('button',{name:'Szukaj',exact:true}).click();
  await p.waitForFunction(()=>document.querySelectorAll('.company-task').length>=20);const many=await measure();
  assert.equal(single.snapshots,0);assert.equal(many.snapshots,0);assert(many.opens<=single.opens+2,`Project reads grew with task cards: ${JSON.stringify({single,many})}`);
  console.log(`PASS shared queue reads for 1 vs ${await p.locator('.company-task').count()} cards: ${single.opens}/${many.opens} opens, no snapshot reads`);
  await p.getByRole('article',{name:tasks[3].title,exact:true}).getByRole('button',{name:'Rozpocznij zadanie',exact:true}).click();
  await p.getByRole('article',{name:tasks[3].title,exact:true}).locator('.status-badge').filter({hasText:'W toku'}).waitFor();
  // Cross-tab event still refreshes a known task immediately after repair.
  const other=await normal.context.newPage();await other.goto(f.config.origin);await other.evaluate(async()=>{window.queueTest=await import('/test-queue.js');});
  await other.evaluate(async row=>{const handle=await window.queueTest.openProgressStorage(row.scope);try{await handle.progressTransaction((tx,result)=>{tx.objectStore('progress').put(row,row.taskId);result();},'readwrite',false);}finally{handle.close();}window.queueTest.notifyProgress();},queued[0]);
  await eventually(async row=>(await window.queueTest.queueRows(row.scope)).find(current=>current.taskId===row.taskId)?.state==='confirmed',queued[0]);
  await p.getByRole('article',{name:tasks[2].title,exact:true}).locator('.status-badge').filter({hasText:'W toku'}).waitFor();
  console.log('PASS shared state receives multi-tab repair notifications and resumes the original operation');
  const warning=p.getByRole('alert').filter({hasText:'Wymaga uwagi'});
  await warning.first().waitFor({state:'hidden'});
  console.log('PASS failure → repair → confirmed sync removes the stale warning without reloading');
  await other.close();await p.bringToFront();

  const warningTasks=[];
  for(let i=0;i<3;i++)warningTasks.push((await api(`${project(f.projects[i])}/tasks`,{title:`Warning recovery ${i}`,assigneeMembershipId:f.members.worker})).task);
  const warningSnapshots=await Promise.all(f.projects.map(id=>api(`${project(id)}/snapshot`,undefined,'worker')));
  await p.evaluate(async snapshots=>{const access=await window.queueTest.readOfflineAccess();for(const snapshot of snapshots){await window.queueTest.registerOfflineScope(snapshot.scope,access.generation);const handle=await window.queueTest.openProjectStorage(snapshot.scope);try{await handle.replace(snapshot,access.generation,Date.now());}finally{handle.close();}}},warningSnapshots);
  await normal.context.setOffline(true);
  const warningRows=await p.evaluate(async ({snapshots,ids})=>{const rows=[];for(let i=0;i<3;i++)rows.push(await window.queueTest.queueProgress(snapshots[i].scope,ids[i],{operationId:crypto.randomUUID(),schemaVersion:1,action:'start',expectedVersion:1}));window.queueTest.notifyProgress();return rows;},{snapshots:warningSnapshots,ids:warningTasks.map(task=>task.id)});
  const storeRow=async(row,corrupt=false)=>p.evaluate(async ({row,corrupt})=>{const handle=await window.queueTest.openProgressStorage(row.scope);try{await handle.progressTransaction((tx,result)=>{tx.objectStore('progress').put({...row,format:corrupt?99:1},row.taskId);result();},'readwrite',false);}finally{handle.close();}window.queueTest.notifyProgress();},{row,corrupt});
  await storeRow(warningRows[1],true);await storeRow(warningRows[2],true);
  const retryPath=`${project(f.projects[0])}/tasks/${warningRows[0].taskId}/commands`,sent=[];
  p.on('request',request=>{if(new URL(request.url()).pathname===retryPath)sent.push(request.postDataJSON());});
  await p.route(`**${retryPath}`,route=>route.fulfill({status:403,contentType:'application/json',body:'{"error":"Temporary permission failure"}'}));
  await normal.context.setOffline(false);
  await eventually(async row=>(await window.queueTest.queueRows(row.scope)).find(current=>current.taskId===row.taskId)?.state==='attention',warningRows[0]);
  await warning.first().waitFor();
  await p.evaluate(()=>window.queueTest.notifyProgress());await p.waitForTimeout(200);
  assert(await warning.first().isVisible(),'Unresolved permission/partition failures retain a warning');
  await p.unroute(`**${retryPath}`);
  await p.getByRole('region',{name:'Kolejka postępu'}).getByRole('button',{name:'Ponów tę samą operację',exact:true}).click();
  await eventually(async row=>(await window.queueTest.queueRows(row.scope)).find(current=>current.taskId===row.taskId)?.state==='confirmed',warningRows[0]);
  assert(await warning.first().isVisible(),'A successful retry cannot hide another broken partition');
  assert.deepEqual(sent,[warningRows[0].command,warningRows[0].command]);
  await storeRow(warningRows[1]);
  await eventually(async row=>(await window.queueTest.queueRows(row.scope)).find(current=>current.taskId===row.taskId)?.state==='confirmed',warningRows[1]);
  assert(await warning.first().isVisible(),'Recovery in project B leaves the warning for project C');
  console.log('PASS unresolved failure stays visible; retry/recovery in one project cannot hide another broken queue');
  await storeRow(warningRows[2]);
  await eventually(async row=>(await window.queueTest.queueRows(row.scope)).find(current=>current.taskId===row.taskId)?.state==='confirmed',warningRows[2]);
  await warning.first().waitFor({state:'hidden'});await p.getByText('Zapisano na serwerze',{exact:true}).first().waitFor();
  console.log('PASS the warning disappears after every partition recovers and every operation confirms');
  await normal.context.close();assert.deepEqual(errors,[]);
} finally {await browser?.close();await f.close();}
