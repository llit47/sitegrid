// M11: production PWA, real IndexedDB, real M08 receipts/audit and runtime RLS.
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { taskFixture } from './helpers/task-management-fixture.ts';
import { selectCompany, acceptDiscardDialogs } from './helpers/workspace-browser.mjs';
const { chromium } = await import(process.env.SITEGRID_PLAYWRIGHT_MODULE ? pathToFileURL(process.env.SITEGRID_PLAYWRIGHT_MODULE).href : 'playwright');
const f = await taskFixture({ serveWeb: true });
let browser;
try {
  const source = (await build({ stdin: { contents: "export * from './apps/web/src/storage/indexed-db.ts'; export * from './apps/web/src/storage/offline-access.ts'; export * from './apps/web/src/storage/progress-queue.ts'; export * from './apps/web/src/progress/sync.ts';", resolveDir: process.cwd() }, bundle: true, write: false, format: 'esm', target: 'es2023' })).outputFiles[0].text;
  f.app.get('/test-queue.js', (_request, reply) => reply.type('application/javascript').send(source));
  f.config.origin = await f.app.listen({ host: '127.0.0.1', port: 0 });
  const project = `/api/organizations/${f.organizations.a}/projects/${f.projects[0]}`;
  const api = async (path, payload, actor = 'manager') => {
    const response = await f.app.inject({ url: path, ...(payload ? { method: 'POST', payload } : {}), headers: { ...f.headers[actor], origin: f.config.origin } });
    assert(response.statusCode < 300, response.body); return response.json();
  };
  const companyBProject=`/api/organizations/${f.organizations.b}/projects/${f.foreignProject}`;
  const companyBTask=(await api(`${companyBProject}/tasks`,{title:'Firma B offline',assigneeMembershipId:f.members.workerB},'foreign')).task;
  const companyBSnapshot=await api(`${companyBProject}/snapshot`,undefined,'worker');
  const tasks = {};
  for (const title of ['Start offline','Submit offline','Quota','Abort','Duplicate','Lost response','HTTP 503','HTTP 429','Timeout','Ack failure','Conflict','HTTP 401','HTTP 403','Revocation','Expiry','Attention write failure'])
    tasks[title] = (await api(`${project}/tasks`, { title, assigneeMembershipId: f.members.worker })).task;
  await api(`${project}/tasks/${tasks['Submit offline'].id}/commands`, { operationId: crypto.randomUUID(), schemaVersion: 1, action: 'start', expectedVersion: 1 }, 'worker');
  browser = await chromium.launch({ headless: true, ...(process.env.SITEGRID_CHROMIUM_PATH ? { executablePath: process.env.SITEGRID_CHROMIUM_PATH } : {}) });
  const errors = [];
  const context = await browser.newContext();
  await context.addCookies([{ name: 'sitegrid', value: f.tokens.worker, url: f.config.origin, httpOnly: true, sameSite: 'Strict' }]);
  let page = await context.newPage();
  const watch = page => { acceptDiscardDialogs(page); page.on('pageerror', error => errors.push(error.message)); };
  watch(page); await page.goto(f.config.origin); await selectCompany(page, f.organizations.a, 'Projekty');
  await page.locator('.project-choice').filter({ hasText: 'Projekt 1' }).click();
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  await page.getByRole('button', { name: 'Przygotuj offline', exact: true }).click();
  await page.getByText('Projekt gotowy offline.', { exact: true }).waitFor();
  // Load the test module before disconnecting; production modules remain in the shell.
  const attach = page => page.evaluate(async () => { window.queueTest = await import('/test-queue.js'); });
  await attach(page);
  await page.evaluate(async snapshot=>{const access=await window.queueTest.readOfflineAccess();await window.queueTest.registerOfflineScope(snapshot.scope,access.generation);const handle=await window.queueTest.openProjectStorage(snapshot.scope);try{await handle.replace(snapshot,access.generation,Date.now());}finally{handle.close();}},companyBSnapshot);
  const eventually = async (predicate, input, {timeout=35000}={}) => {
    const deadline=Date.now()+timeout;
    while (!await page.evaluate(predicate,input)) {
      if(Date.now()>=deadline) throw new Error('Queue condition timed out');
      await new Promise(resolve=>setTimeout(resolve,100));
    }
  };
  const scope = { accountId: f.users.worker, organizationId: f.organizations.a, projectId: f.projects[0] };
  const rows = () => page.evaluate(scope => window.queueTest.queueRows(scope), scope);
  const row = title => page.locator('.offline-viewer .task-row').filter({ has: page.locator('strong', { hasText: title }) });
  const save = async title => {
    await page.locator('.offline-project').first().waitFor();
    const companySelect=page.getByLabel('Przygotowana firma',{exact:true});if(await companySelect.count())await companySelect.selectOption(f.organizations.a);
    await row(title).getByRole('button', { name: title === 'Submit offline' ? 'Zgłoś do odbioru' : 'Rozpocznij zadanie', exact: true }).click();
    await row(title).getByText('Zapisano na urządzeniu', { exact: true }).waitFor();
    await row(title).getByText('Oczekuje na synchronizację', { exact: true }).waitFor();
    assert(await row(title).getByRole('button').isDisabled());
    return (await rows()).find(item => item.taskId === tasks[title].id);
  };
  await context.setOffline(true);
  const companyBQueued=await page.evaluate(async ({scope,taskId})=>window.queueTest.queueProgress(scope,taskId,{operationId:crypto.randomUUID(),schemaVersion:1,action:'start',expectedVersion:1}),{scope:companyBSnapshot.scope,taskId:companyBTask.id});
  const isolated=await page.evaluate(async scope=>{const variants=[{...scope,accountId:crypto.randomUUID()},{...scope,organizationId:crypto.randomUUID()},{...scope,projectId:crypto.randomUUID()}];const results=[];for(const variant of variants)results.push(await window.queueTest.queueRows(variant));return results;},scope);
  assert.deepEqual(isolated,[[],[],[]]);
  const start = await save('Start offline'), submit = await save('Submit offline');
  assert.equal(start.command.expectedVersion, 1); assert.equal(submit.command.expectedVersion, 2); assert.equal(submit.command.action, 'submit');
  await page.reload(); await row('Start offline').getByText('Oczekuje na synchronizację', { exact: true }).waitFor();
  assert.equal(await row('Start offline').getByText('Zapisano na serwerze', { exact: true }).count(), 0);
  await page.close(); page = await context.newPage(); watch(page); await page.goto(f.config.origin);
  await row('Submit offline').getByText('Oczekuje na synchronizację', { exact: true }).waitFor();
  console.log('PASS offline start/submit survive reload and reopening; further progress is blocked');
  await page.evaluate(()=>{Object.defineProperty(document,'visibilityState',{configurable:true,get:()=> 'hidden'});document.dispatchEvent(new Event('visibilitychange'));});
  await context.setOffline(false); await attach(page);
  await page.waitForTimeout(500);assert.equal((await rows()).find(row=>row.taskId===start.taskId).attempts,0);
  await page.evaluate(()=>{Object.defineProperty(document,'visibilityState',{configurable:true,get:()=> 'visible'});document.dispatchEvent(new Event('visibilitychange'));});
  await eventually(async ({scope,id}) => (await window.queueTest.queueRows(scope)).find(row => row.taskId === id)?.state === 'confirmed', {scope,id:start.taskId});
  await eventually(async ({scope,id}) => (await window.queueTest.queueRows(scope)).find(row => row.taskId === id)?.state === 'confirmed', {scope,id:submit.taskId});
  assert.equal((await api(`${project}/tasks/${submit.taskId}`, undefined, 'worker')).task.status, 'submitted');
  assert.deepEqual((await rows()).find(row => row.taskId === start.taskId).command, start.command);
  await eventually(async ({scope,id})=>(await window.queueTest.queueRows(scope)).find(row=>row.taskId===id)?.state==='confirmed',{scope:companyBSnapshot.scope,id:companyBTask.id});
  assert.equal((await api(`${companyBProject}/tasks/${companyBTask.id}`,undefined,'worker')).task.status,'in_progress');
  assert.deepEqual(await page.evaluate(async ({scope,id})=>(await window.queueTest.queueRows(scope)).find(row=>row.taskId===id).command,{scope:companyBSnapshot.scope,id:companyBTask.id}),companyBQueued.command);
  console.log('PASS account/company/project queue partitions remain isolated and company B replays only its own payload');
  await context.setOffline(true);

  for (const [title, mode] of [['Quota','quota'],['Abort','abort']]) {
    await page.evaluate(mode => {
      window.originalQueuePut = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (...args) {
        if (this.name !== 'progress') return window.originalQueuePut.apply(this, args);
        if (mode === 'quota') throw new DOMException('Full', 'QuotaExceededError');
        const request = window.originalQueuePut.apply(this, args); this.transaction.abort(); return request;
      };
    }, mode);
    await row(title).getByRole('button', {name:'Rozpocznij zadanie',exact:true}).click();
    await row(title).getByRole('alert').filter({hasText:'Nie zapisano postępu'}).waitFor();
    assert.equal(await row(title).getByText('Zapisano na urządzeniu', {exact:true}).count(),0);
    await page.evaluate(() => { IDBObjectStore.prototype.put = window.originalQueuePut; });
    assert(!(await rows()).some(item => item.taskId === tasks[title].id));
  }
  console.log('PASS quota/transaction abort never display a saved confirmation or persist a partial command');

  // Two simultaneous producers, then two simultaneous replay claims.
  const second = await context.newPage(); watch(second); await second.goto(f.config.origin);
  await context.setOffline(false); await attach(second); await context.setOffline(true);
  const duplicateInput = {scope, taskId:tasks.Duplicate.id};
  const enqueue = page => page.evaluate(async ({scope,taskId}) => {
    try { return await window.queueTest.queueProgress(scope,taskId,{operationId:crypto.randomUUID(),schemaVersion:1,action:'start',expectedVersion:1}); }
    catch (error) { return {error:error.code}; }
  }, duplicateInput);
  const duplicate = await Promise.all([enqueue(page),enqueue(second)]);
  assert.equal(duplicate.filter(result => result.command).length,1); assert.equal(duplicate.filter(result => result.error === 'stale').length,1);
  const queued = duplicate.find(result => result.command);
  const claims = await Promise.all([page,second].map(page => page.evaluate(row => window.queueTest.claimProgress(row,crypto.randomUUID()),queued)));
  assert.equal(claims.filter(Boolean).length,1);
  await page.evaluate(({row,owner}) => window.queueTest.settleProgress(row,owner,'pending'),{row:queued,owner:claims.find(Boolean).lease.owner});
  await second.close(); console.log('PASS multi-tab enqueue and replay leases admit exactly one producer/sender');

  const lost = await save('Lost response'), seen = [];
  await page.route(`**/tasks/${lost.taskId}/commands`,async route => { seen.push(route.request().postDataJSON()); const response=await route.fetch(); if(seen.length===1) await route.abort('failed'); else await route.fulfill({response}); });
  await context.setOffline(false);
  await eventually(async ({scope,id}) => (await window.queueTest.queueRows(scope)).find(row=>row.taskId===id)?.state==='confirmed',{scope,id:lost.taskId}, {timeout:35000});
  assert(seen.length>=2); seen.forEach(payload=>assert.deepEqual(payload,lost.command));
  await page.unroute(`**/tasks/${lost.taskId}/commands`);
  const audit = await f.owner.query("SELECT count(*) FROM organization_audit_events WHERE subject_id=$1 AND event='task_started'",[lost.taskId]); assert.equal(audit.rows[0].count,'1');
  const receipt = await f.owner.query('SELECT count(*) FROM task_progress_receipts WHERE task_id=$1',[lost.taskId]); assert.equal(receipt.rows[0].count,'1');
  console.log('PASS lost response retries the identical payload and produces one M08 receipt/audit event');

  // Each transient failure survives restart; reopening retries the original ID.
  for (const [title,status] of [['HTTP 503',503],['HTTP 429',429],['Ack failure',200],['Timeout',0]]) {
    await context.setOffline(true); const queued=await save(title);
    const url=`**/tasks/${queued.taskId}/commands`;
    let observed; const sent=new Promise(resolve=>{observed=resolve;});
    await page.route(url,async route=>{
      assert.deepEqual(route.request().postDataJSON(),queued.command);
      if(title==='Ack failure') {
        const response=await route.fetch();
        await page.evaluate(()=>{window.originalQueuePut=IDBObjectStore.prototype.put; IDBObjectStore.prototype.put=function(...args){if(this.name==='progress'&&args[0]?.state==='confirmed')throw new DOMException('Full','QuotaExceededError');return window.originalQueuePut.apply(this,args);};});
        await route.fulfill({response});
      } else if(status) await route.fulfill({status,contentType:'application/json',body:JSON.stringify({error:'Transient'})});
      else await route.abort('timedout');
      observed();
    });
    await context.setOffline(false); await sent;
    await eventually(async ({scope,id}) => {const row=(await window.queueTest.queueRows(scope)).find(row=>row.taskId===id);return row?.state==='pending'&&!row.lease;},{scope,id:queued.taskId});
    await page.unroute(url); await page.reload(); await attach(page);
    await eventually(async ({scope,id})=>(await window.queueTest.queueRows(scope)).find(row=>row.taskId===id)?.state==='confirmed',{scope,id:queued.taskId},{timeout:35000});
    assert.deepEqual((await rows()).find(row=>row.taskId===queued.taskId).command,queued.command);
    assert.equal((await f.owner.query("SELECT count(*) FROM organization_audit_events WHERE subject_id=$1 AND event='task_started'",[queued.taskId])).rows[0].count,'1');
  }
  console.log('PASS 503/429/transport timeout/failed acknowledgement persist through restart and retry the original ID');

  await context.setOffline(true); const conflict=await save('Conflict');
  await api(`${project}/tasks/${conflict.taskId}/update`,{title:'Conflict',assigneeMembershipId:f.members.worker,expectedVersion:1});
  await context.setOffline(false);
  await page.getByRole('region',{name:'Kolejka postępu'}).getByText('Wymaga uwagi',{exact:true}).waitFor();
  assert.equal((await rows()).find(row=>row.taskId===conflict.taskId).reason,'conflict');
  assert.equal((await api(`${project}/tasks/${conflict.taskId}`,undefined,'worker')).task.status,'planned');
  await page.reload(); await attach(page);
  assert.equal((await rows()).find(row=>row.taskId===conflict.taskId).state,'attention');
  console.log('PASS real version conflict remains actionable after reload and never overwrites the task');

  // Permission loss stops automatic sends and survives snapshot invalidation.
  await context.setOffline(true); const denied=await save('HTTP 403'); let deniedSends=0;
  await page.route(`**/tasks/${denied.taskId}/commands`,route=>{deniedSends++;return route.fulfill({status:403,contentType:'application/json',body:'{"error":"Denied"}'});});
  await context.setOffline(false);
  await eventually(async ({scope,id})=>(await window.queueTest.queueRows(scope)).find(row=>row.taskId===id)?.state==='attention',{scope,id:denied.taskId});
  await page.reload(); await attach(page); assert.equal(deniedSends,1);
  assert.equal((await rows()).find(row=>row.taskId===denied.taskId).state,'attention');
  await page.unroute(`**/tasks/${denied.taskId}/commands`);
  await page.getByRole('region',{name:'Kolejka postępu'}).getByRole('button',{name:'Ponów tę samą operację',exact:true}).click();
  await eventually(async ({scope,id})=>(await window.queueTest.queueRows(scope)).find(row=>row.taskId===id)?.state==='confirmed',{scope,id:denied.taskId});
  console.log('PASS 403 stops retry, preserves the command after revocation/reload and allows an explicit retry of the same operation');

  const prepareAgain=async()=>{await selectCompany(page,f.organizations.a,'Projekty');await page.locator('.project-choice').filter({hasText:'Projekt 1'}).click();await page.getByRole('button',{name:/^(Przygotuj|Odśwież) offline$/,exact:true}).click();await page.getByText('Projekt gotowy offline.',{exact:true}).waitFor();};
  await prepareAgain();
  await context.setOffline(true); const revoked=await save('Revocation');
  await f.owner.query("DELETE FROM membership_roles WHERE organization_id=$1 AND membership_id=$2 AND role='worker'",[f.organizations.a,f.members.worker]);
  await context.setOffline(false);
  await eventually(async ({scope,id})=>(await window.queueTest.queueRows(scope)).find(row=>row.taskId===id)?.state==='attention',{scope,id:revoked.taskId});
  assert.equal((await f.owner.query('SELECT status,version FROM tasks WHERE id=$1',[revoked.taskId])).rows[0].version,1);
  await f.owner.query("INSERT INTO membership_roles(organization_id,membership_id,role) VALUES($1,$2,'worker')",[f.organizations.a,f.members.worker]);
  await page.reload(); await attach(page); await prepareAgain();
  console.log('PASS actual worker-role revocation retains the command and blocks server mutation');

  await context.setOffline(true); const unauthorized=await save('HTTP 401');let unauthorizedSends=0;
  await page.route(`**/tasks/${unauthorized.taskId}/commands`,route=>{unauthorizedSends++;return route.fulfill({status:401,contentType:'application/json',body:'{"error":"Expired session"}'});});
  await context.setOffline(false);
  await eventually(async ({scope,id})=>(await window.queueTest.queueRows(scope)).find(row=>row.taskId===id)?.reason==='session',{scope,id:unauthorized.taskId});
  await page.reload();await attach(page);assert.equal(unauthorizedSends,1);
  assert.equal((await rows()).find(row=>row.taskId===unauthorized.taskId).state,'attention');
  await page.unroute(`**/tasks/${unauthorized.taskId}/commands`);await prepareAgain();
  console.log('PASS 401 stops automatic retry, invalidates offline access and retains the operation after reauthentication');

  await context.setOffline(true);const blocked=await save('Attention write failure');let blockedSends=0;
  await page.evaluate(()=>{window.originalQueuePut=IDBObjectStore.prototype.put;IDBObjectStore.prototype.put=function(...args){if(this.name==='progress'&&args[0]?.state==='attention')throw new DOMException('Full','QuotaExceededError');return window.originalQueuePut.apply(this,args);};});
  await page.route(`**/tasks/${blocked.taskId}/commands`,route=>{blockedSends++;return route.fulfill({status:409,contentType:'application/json',body:'{"error":"Conflict"}'});});
  await context.setOffline(false);
  await eventually(()=>window.queueTest.offlineAccessDenied());
  assert.equal((await rows()).find(row=>row.taskId===blocked.taskId).state,'pending');
  await page.reload();await attach(page);
  await eventually(async ({scope,id})=>(await window.queueTest.queueRows(scope)).find(row=>row.taskId===id)?.state==='attention',{scope,id:blocked.taskId});
  assert.equal(blockedSends,1);await page.unroute(`**/tasks/${blocked.taskId}/commands`);await prepareAgain();
  console.log('PASS failed durable conflict marker retains the payload and fences automatic replay across restart');

  // Reprepare after revocation, then expire offline access without deleting queue.
  await selectCompany(page,f.organizations.a,'Projekty'); await page.locator('.project-choice').filter({hasText:'Projekt 1'}).click();
  await page.getByRole('button',{name:/^(Przygotuj|Odśwież) offline$/,exact:true}).click(); await page.getByText('Projekt gotowy offline.',{exact:true}).waitFor();
  await context.setOffline(true); const expired=await save('Expiry');
  await page.evaluate(async scope=>{
    const db=await new Promise((resolve,reject)=>{const request=indexedDB.open(window.queueTest.projectDatabaseName(scope));request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
    await new Promise((resolve,reject)=>{const tx=db.transaction(['confirmed','progress'],'readwrite');const s=tx.objectStore('confirmed'),r=s.get('snapshot');r.onsuccess=()=>s.put({...r.result,authorizedAt:Date.now()-86400001},'snapshot');const q=tx.objectStore('progress'),all=q.getAll();all.onsuccess=()=>{for(const row of all.result)if(row.state==='pending')q.put({...row,expiresAt:Date.now()-1},row.taskId);};tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);});db.close();
  },scope);
  await page.reload();await page.getByText('Brak pobranych projektów',{exact:false}).waitFor();assert.equal(await page.locator('.offline-project').count(),0);
  await context.setOffline(false); await attach(page);
  await eventually(async ({scope,id})=>(await window.queueTest.queueRows(scope)).find(row=>row.taskId===id)?.reason==='access',{scope,id:expired.taskId});
  console.log('PASS expiry hides snapshot data and retains the operation for attention');

  // Account B may not see or replay account A, even when sharing this device.
  await page.evaluate(async()=>{await window.queueTest.invalidateOfflineAccount();});
  await context.addCookies([{name:'sitegrid',value:f.tokens.other,url:f.config.origin,httpOnly:true,sameSite:'Strict'}]);
  await page.reload(); await attach(page);
  assert.equal(await page.getByRole('region',{name:'Kolejka postępu'}).count(),0);
  assert((await rows()).some(row=>row.command.operationId===expired.command.operationId));
  const bScope={...scope,accountId:f.users.other}; assert.deepEqual(await page.evaluate(scope=>window.queueTest.queueRows(scope),bScope),[]);
  await context.setOffline(true); await page.reload(); assert.equal(await page.locator('.offline-project').count(),0);
  console.log('PASS account A/B isolation, account switch denial and retained account A commands');
  assert.deepEqual(errors,[]); await context.close();
} finally { await browser?.close(); await f.close(); }
