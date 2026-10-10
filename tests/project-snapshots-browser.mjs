// M10 production PWA, authorized snapshots and real browser storage failures.
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { buildApp } from '../apps/server/src/app.ts';
import { readConfig } from '../apps/server/src/config.ts';
import { migrate } from '../apps/server/src/migrations.ts';
import { hashPassword } from '../apps/server/src/auth/password.ts';
const { chromium } = await import(process.env.SITEGRID_PLAYWRIGHT_MODULE ? pathToFileURL(process.env.SITEGRID_PLAYWRIGHT_MODULE).href : 'playwright');
assert(process.env.TEST_DATABASE_URL && process.env.TEST_RUNTIME_DATABASE_URL);
const schema = `snapshots_browser_${randomBytes(6).toString('hex')}`;
const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
const ownerUrl = new URL(process.env.TEST_DATABASE_URL), runtimeUrl = new URL(process.env.TEST_RUNTIME_DATABASE_URL);
for (const url of [ownerUrl, runtimeUrl]) url.searchParams.set('options', `-c search_path=${schema}`);
const owner = new pg.Pool({ connectionString: ownerUrl.href }), runtime = new pg.Pool({ connectionString: runtimeUrl.href });
const config = readConfig({ NODE_ENV: 'test', DATABASE_URL: runtimeUrl.href });
const companyA = randomUUID(), companyB = randomUUID(), password = 'Synthetic-password-16';
const users = {}, members = {}, cookies = {}, csrf = {}, errors = [], cspErrors = [];
let app, browser, servedWorker, snapshotMode = '', releaseDownload, downloadStarted;
const blockedDownload = () => new Promise(resolve => { releaseDownload = resolve; });
await admin.query(`CREATE SCHEMA ${schema}`);
try {
  await migrate(owner, 'migrations'); await owner.query(`GRANT USAGE ON SCHEMA ${schema} TO sitegrid`);
  await owner.query('GRANT SELECT ON installation, schema_migrations, users, credentials, platform_admins TO sitegrid');
  await owner.query('GRANT SELECT, INSERT, DELETE ON sessions TO sitegrid');
  await owner.query('GRANT SELECT, INSERT, UPDATE, DELETE ON auth_rate_limits TO sitegrid');
  for (const [id, name] of [[companyA, 'Firma A'], [companyB, 'Firma B']]) await owner.query('INSERT INTO organizations(id,name) VALUES ($1,$2)', [id, name]);
  const passwordHash = await hashPassword(password);
  for (const [name, roles] of [['administrator', ['organization_admin', 'manager']], ['administratorB', ['organization_admin']], ['worker', ['worker']], ['foreman', ['foreman']]]) {
    users[name] = randomUUID(); members[name] = randomUUID(); cookies[name] = randomBytes(32).toString('base64url'); csrf[name] = randomBytes(32).toString('base64url');
    await owner.query('INSERT INTO users(id,email) VALUES ($1,$2)', [users[name], `${name.toLowerCase()}@example.test`]);
    await owner.query('INSERT INTO credentials(user_id,password_hash) VALUES ($1,$2)', [users[name], passwordHash]);
    await owner.query("INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at) VALUES ($1,$2,$3,now()+interval '1 hour')", [createHash('sha256').update(cookies[name]).digest('hex'), users[name], csrf[name]]);
    const tenant = name === 'administratorB' ? companyB : companyA;
    await owner.query("INSERT INTO organization_memberships(organization_id,id,user_id,status) VALUES ($1,$2,$3,'active')", [tenant, members[name], users[name]]);
    for (const role of roles) await owner.query('INSERT INTO membership_roles(organization_id,membership_id,role) VALUES ($1,$2,$3)', [tenant, members[name], role]);
  }
  for (const name of ['administrator', 'worker']) {
    members[`${name}B`] = randomUUID();
    await owner.query("INSERT INTO organization_memberships(organization_id,id,user_id,status) VALUES ($1,$2,$3,'active')", [companyB, members[`${name}B`], users[name]]);
    await owner.query("INSERT INTO membership_roles(organization_id,membership_id,role) VALUES ($1,$2,'worker')", [companyB, members[`${name}B`]]);
  }
  app = await buildApp(config, runtime, { serveWeb: true });
  const storageSource = (await build({ stdin: { contents: "export * from './apps/web/src/storage/indexed-db.ts'; export * from './apps/web/src/storage/offline-access.ts'; export * from './apps/web/src/storage/snapshot.ts'; export * from './apps/web/src/offline/account.ts';", resolveDir: process.cwd() }, bundle: true, write: false, format: 'esm', target: 'es2023' })).outputFiles[0].text;
  app.get('/test-storage.js', (_request, reply) => reply.type('application/javascript').send(storageSource));
  servedWorker = await readFile('dist/web/sw.js', 'utf8');
  app.get('/sw.js', (_request, reply) => reply.header('Cache-Control','no-store').type('application/javascript').send(servedWorker));
  app.addHook('onRequest', async (request, reply) => {
    if (!request.url.endsWith('/snapshot')) return;
    if (snapshotMode === 'malformed') return reply.send({ format: 1, complete: false });
    if (snapshotMode === 'limit') return reply.code(413).send({ error: 'Projekt przekracza limit 500 zadań lub 2 MiB.', code: 'snapshot_limit' });
    if (snapshotMode === 'disconnect') { request.raw.socket.destroy(); return reply; }
    if (snapshotMode === 'hold') { const waiting = blockedDownload(); downloadStarted?.(); await waiting; }
  });
  config.origin = await app.listen({ host: '127.0.0.1', port: 0 });
  const api = async (url, payload, actor = 'administrator') => {
    const response = await app.inject({ url, headers: { cookie: `sitegrid=${cookies[actor]}`, origin: config.origin, 'x-csrf-token': csrf[actor] }, ...(payload ? { method: 'POST', payload } : {}) });
    assert(response.statusCode < 300, response.body); return response.json();
  };
  const directoryPath = `/api/organizations/${companyA}/contractors`, projectPath = `/api/organizations/${companyA}/projects`;
  const one = (await api(directoryPath, { name: 'Klient Alfa' })).contractor;
  const two = (await api(directoryPath, { name: 'Klient Beta' })).contractor;
  const hidden = (await api(directoryPath, { name: 'Poufny klient innego projektu' })).contractor;
  await api(directoryPath, { name: 'Poufny katalog bez projektów' });
  const foreign = (await api(`/api/organizations/${companyB}/contractors`, { name: 'Klient Alfa' }, 'administratorB')).contractor;
  const projectOne = (await api(projectPath, { name: 'Projekt Alfa', contractorId: one.id })).project;
  const projectTwo = (await api(projectPath, { name: 'Projekt Beta', contractorId: two.id })).project;
  await api(projectPath, { name: 'Projekt prywatny', contractorId: hidden.id });
  await api(projectPath, { name: 'Projekt wewnętrzny' });
  const projectB = (await api(`/api/organizations/${companyB}/projects`, { name: 'Projekt obcej firmy', contractorId: foreign.id }, 'administratorB')).project;
  for (const project of [projectOne, projectTwo]) {
    for (const actor of ['administrator', 'worker', 'foreman']) await api(`${projectPath}/${project.id}/members/${members[actor]}`, { status: 'active', expectedVersion: 0 });
    await api(`${projectPath}/${project.id}/tasks`, { title: `Własne zadanie ${project.name}`, assigneeMembershipId: members.worker });
    await api(`${projectPath}/${project.id}/tasks`, { title: 'Cudze zadanie kierownika', assigneeMembershipId: members.administrator });
  }
  await api(`/api/organizations/${companyB}/projects/${projectB.id}/members/${members.workerB}`, { status: 'active', expectedVersion: 0 }, 'administratorB');
  browser = await chromium.launch({ headless: true, ...(process.env.SITEGRID_CHROMIUM_PATH ? { executablePath: process.env.SITEGRID_CHROMIUM_PATH } : {}) });
  const open = async mobile => {
    const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 } });
    await context.addCookies([{ name: 'sitegrid', value: cookies.worker, url: config.origin, httpOnly: true, sameSite: 'Strict' }]);
    const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
    await page.goto(config.origin); await page.getByText('Powłoka aplikacji gotowa do otwarcia offline.', { exact: true }).waitFor();
    await page.waitForFunction(() => navigator.serviceWorker.controller); await page.locator('#active-organization').selectOption(companyA);
    await page.getByRole('button', { name: 'Projekt Alfa Aktywny Kontrahent: Klient Alfa', exact: true }).click();
    await page.getByRole('button', { name: 'Przygotuj offline', exact: true }).waitFor(); return { context, page };
  };
  const rawStorage = await open(false);
  const wire = await api(`${projectPath}/${projectTwo.id}/snapshot`, undefined, 'worker');
  const storageResults = await rawStorage.page.evaluate(async wire => {
    const { openProjectStorage, projectDatabaseName, readOfflineAccess, registerOfflineScope, validateSnapshot, invalidateOfflineAccount, confirmOfflineAccount, finishAccountVerification, offlineAccountGeneration, reconcilePreparedTasks } = await import('/test-storage.js');
    const scope = wire.scope, name = projectDatabaseName(scope), access = await readOfflineAccess();
    const raw = (name, version, upgrade) => new Promise((resolve, reject) => {
      const request = indexedDB.open(name, version); request.onupgradeneeded = () => upgrade?.(request.result);
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    const complete = tx => new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onabort = () => reject(tx.error); });
    const expectError = async (action, code) => { try { await action(); throw new Error('False success'); } catch (error) { if (error.code !== code) throw error; } };
    const legacy = await raw(name, 1, db => {
      db.createObjectStore('metadata').put({ format: 1, ...scope }, 'owner');
      db.createObjectStore('future_queue').put({ untouched: true }, 'command');
      db.createObjectStore('future_drafts').put({ untouched: true }, 'draft');
    }); legacy.close();
    let handle = await openProjectStorage(scope); await registerOfflineScope(scope, access.generation);
    if (await handle.read(access.generation) !== null) throw new Error('Empty migration claimed preparation');
    await handle.replace(wire, access.generation, Date.now());
    const previous = await handle.read(access.generation);
    await expectError(()=>handle.replace(wire,access.generation,Date.now()),'stale');
    const refreshed=await(await fetch(`/api/organizations/${scope.organizationId}/projects/${scope.projectId}/snapshot`,{credentials:'same-origin',cache:'no-store'})).json();
    const originalPut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function () { if (this.name === 'confirmed') throw new DOMException('Full','QuotaExceededError'); return originalPut.apply(this, arguments); };
    try { await expectError(() => handle.replace(refreshed, access.generation, Date.now()), 'quota'); } finally { IDBObjectStore.prototype.put = originalPut; }
    if (JSON.stringify(await handle.read(access.generation)) !== JSON.stringify(previous)) throw new Error('Quota destroyed complete snapshot');
    IDBObjectStore.prototype.put = function () { const request = originalPut.apply(this, arguments); if (this.name === 'confirmed') this.transaction.abort(); return request; };
    try { await expectError(() => handle.replace(refreshed, access.generation, Date.now()), 'aborted'); } finally { IDBObjectStore.prototype.put = originalPut; }
    if (JSON.stringify(await handle.read(access.generation)) !== JSON.stringify(previous)) throw new Error('Abort destroyed snapshot');
    const corrupt = structuredClone(wire); corrupt.project.name = 'Corrupted';
    await expectError(() => handle.replace(corrupt, access.generation, Date.now()), 'invalid');
    for (const key of ['accountId','organizationId','projectId']) {
      const wrong = { ...scope, [key]: crypto.randomUUID() }; let rejected = false;
      try { await validateSnapshot(wire, wrong); } catch { rejected = true; } if (!rejected) throw new Error(`Wrong ${key} accepted`);
    }
    if (await handle.read(crypto.randomUUID()) !== null) throw new Error('Previous identity generation exposed');
    handle.close();
    await expectError(() => handle.verify(), 'failed');
    // A rollback to schema-v1 code fails without modifying or deleting v2 data.
    try { (await raw(name,1)).close(); throw new Error('Downgraded local database'); } catch (error) { if (error.name !== 'VersionError') throw error; }
    const upgraded = await raw(name,2); const tx=upgraded.transaction(['metadata','future_queue','future_drafts']);
    const owner=tx.objectStore('metadata').get('owner'), queue=tx.objectStore('future_queue').get('command'), draft=tx.objectStore('future_drafts').get('draft');
    await complete(tx); if (owner.result.accountId !== scope.accountId || !queue.result.untouched || !draft.result.untouched) throw new Error('Upgrade destroyed ownership/future stores'); upgraded.close();
    handle=await openProjectStorage(scope); if (!(await handle.read(access.generation))) throw new Error('Rollback erased snapshot');
    await handle.clear(); handle.close();
    const check=await raw(name,2); const preserved=check.transaction('future_queue'); const queued=preserved.objectStore('future_queue').get('command'); await complete(preserved); if (!queued.result.untouched) throw new Error('Replacement/clear touched queue');
    const corruption=check.transaction('confirmed','readwrite');corruption.objectStore('confirmed').put({...previous,snapshot:corrupt},'snapshot');await complete(corruption);check.close();
    await expectError(()=>openProjectStorage(scope),'invalid');
    const retained=await raw(name,2);const inspect=retained.transaction('confirmed');const damaged=inspect.objectStore('confirmed').get('snapshot');await complete(inspect);if(damaged.result.snapshot.project.name!=='Corrupted')throw new Error('Corruption silently reset business data');retained.close();
    const expired=await raw(name,2);const expiredTx=expired.transaction('confirmed','readwrite');expiredTx.objectStore('confirmed').put({...previous,authorizedAt:Date.now()-24*60*60*1000-1},'snapshot');await complete(expiredTx);expired.close();
    await reconcilePreparedTasks(scope.organizationId,scope.projectId,wire.tasks.map(task=>task.id));
    if(!(await readOfflineAccess()))throw new Error('Expired snapshot incorrectly blocked fresh online preparation');
    handle=await openProjectStorage(scope);await expectError(()=>handle.read(access.generation),'expired');await handle.replace(refreshed,access.generation,Date.now());if(!(await handle.read(access.generation)))throw new Error('Fresh authorization could not refresh expired snapshot');handle.close();
    const newer = { ...scope, projectId: crypto.randomUUID() };
    (await raw(projectDatabaseName(newer),3, db=>db.createObjectStore('metadata'))).close(); await expectError(()=>openProjectStorage(newer),'invalid');
    const broken = { ...scope, projectId: crypto.randomUUID() };
    (await raw(projectDatabaseName(broken),1,db=>db.createObjectStore('metadata').put({format:1,...scope},'owner'))).close();
    await expectError(()=>openProjectStorage(broken),'aborted');
    const missing = { ...scope, projectId: crypto.randomUUID() }; const descriptor=Object.getOwnPropertyDescriptor(window,'indexedDB');
    Object.defineProperty(window,'indexedDB',{ configurable:true, get(){ throw new DOMException('Denied','SecurityError'); } });
    try { await expectError(()=>openProjectStorage(missing),'unavailable'); } finally { if (descriptor) Object.defineProperty(window,'indexedDB',descriptor); else delete window.indexedDB; }
    if(!(await finishAccountVerification(undefined,access.generation)).includes('zablokowany') || await readOfflineAccess()!==null || await offlineAccountGeneration()!==access.generation)throw new Error('Missing stable identity exposed or reset stored authorization');
    await invalidateOfflineAccount();await expectError(()=>confirmOfflineAccount(scope.accountId,access.generation),'aborted');
    if(await readOfflineAccess()!==null)throw new Error('Delayed pre-logout authorization restored old account');
    return { upgrade: true, isolation: true, atomic: true, rollback: true, failures: true, staleAuthorization: true };
  }, wire);
  assert(Object.values(storageResults).every(Boolean)); await rawStorage.context.close();
  console.log('PASS real IndexedDB v1→v2, retained owner/queue/draft stores, scope/generation isolation, malformed/quota/abort/unavailable failures, safe v1 rollback');
  for (const mobile of [false,true]) {
    const { context, page: initialPage } = await open(mobile); let page = initialPage;
    const suffix = mobile ? 'mobile' : 'desktop';
    const temporary = (await api(`${projectPath}/${projectOne.id}/tasks`, { title: `Zadanie do usunięcia ${suffix}`, assigneeMembershipId: members.worker })).task;
    await page.getByRole('button',{name:'Wczytaj aktualne dane',exact:true}).click(); await page.getByText(temporary.title,{exact:true}).waitFor();
    let downloads=0; page.on('request',request=>{if(request.url().endsWith('/snapshot')) downloads++;});
    await page.getByRole('button',{name:'Przygotuj offline',exact:true}).click();
    await page.getByText('Projekt gotowy offline — tylko odczyt.',{exact:true}).waitFor(); assert.equal(downloads,1);
    assert.equal(await page.getByText('Cudze zadanie kierownika',{exact:true}).count(),0);
    for (const mode of ['malformed','limit','disconnect']) {
      snapshotMode=mode; await page.getByRole('button',{name:'Odśwież offline',exact:true}).click();
      await page.getByText('Odświeżenie nie powiodło się.',{exact:false}).waitFor();
      if(mode==='limit') assert(await page.getByRole('alert').filter({hasText:'500 zadań lub 2 MiB'}).isVisible());
      await context.setOffline(true); await page.getByText(temporary.title,{exact:true}).waitFor(); await context.setOffline(false);
      await page.locator('#active-organization').selectOption(companyA); await page.getByRole('button',{name:'Projekt Alfa Aktywny Kontrahent: Klient Alfa',exact:true}).click();
      await page.getByRole('button',{name:'Odśwież offline',exact:true}).waitFor(); snapshotMode='';
    }
    await page.evaluate(()=>{
      window.originalSnapshotPut=IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put=function(){if(this.name==='confirmed') throw new DOMException('Full','QuotaExceededError');return window.originalSnapshotPut.apply(this,arguments);};
    });
    await page.getByRole('button',{name:'Odśwież offline',exact:true}).click(); await page.getByText('Odświeżenie nie powiodło się.',{exact:false}).waitFor();
    await page.evaluate(()=>{IDBObjectStore.prototype.put=window.originalSnapshotPut;});
    snapshotMode='hold'; const started=new Promise(resolve=>{downloadStarted=resolve;});
    await page.getByRole('button',{name:'Odśwież offline',exact:true}).click(); await started;
    await page.getByRole('button',{name:'Anuluj przygotowanie',exact:true}).click(); await page.getByText('Przygotowanie anulowane.',{exact:true}).waitFor(); releaseDownload(); snapshotMode='';
    await owner.query('DELETE FROM tasks WHERE id=$1',[temporary.id]);
    await page.getByRole('button',{name:'Odśwież offline',exact:true}).click(); await page.getByText('Projekt gotowy offline — tylko odczyt.',{exact:true}).waitFor();
    snapshotMode='hold';const delayed=new Promise(resolve=>{downloadStarted=resolve;});
    await page.getByRole('button',{name:'Odśwież offline',exact:true}).click();await delayed;
    await page.locator('#active-organization').selectOption(companyB);releaseDownload();snapshotMode='';
    await page.getByRole('button',{name:'Projekt obcej firmy Aktywny Kontrahent: Klient Alfa',exact:true}).click();
    await page.getByRole('button',{name:'Przygotuj offline',exact:true}).click(); await page.getByText('Projekt gotowy offline — tylko odczyt.',{exact:true}).waitFor();
    const access=await page.evaluate(async()=>await(await import('/test-storage.js')).readOfflineAccess()); assert.equal(access.scopes.length,2); assert.equal(access.accountId,users.worker);
    const authSecrets=[(await page.evaluate(async()=>(await(await fetch('/api/auth/session')).json()).csrfToken)),password,...(await context.cookies()).filter(cookie=>cookie.name==='sitegrid').map(cookie=>cookie.value)];
    await context.setOffline(true); await page.getByRole('heading',{name:'SiteGrid bez połączenia'}).waitFor();
    await page.getByRole('heading',{name:'Projekt Alfa',exact:true}).waitFor(); assert.equal(await page.getByText(temporary.title,{exact:true}).count(),0);
    assert.equal(await page.getByText('Projekt Beta',{exact:true}).count(),0); assert.equal(await page.getByText('Projekt obcej firmy',{exact:true}).count(),0);
    assert.equal(await page.getByRole('button').count(),0); assert.equal(await page.locator('form').count(),0);
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    await page.close(); page=await context.newPage(); page.on('pageerror',error=>errors.push(error.message)); await page.goto(config.origin);
    await page.getByRole('heading',{name:'Projekt Alfa',exact:true}).waitFor(); assert.equal(await page.getByText('Cudze zadanie kierownika',{exact:true}).count(),0);
    await page.getByLabel('Przygotowana firma',{exact:true}).selectOption(companyB); await page.getByRole('heading',{name:'Projekt obcej firmy',exact:true}).waitFor();
    assert.equal(await page.getByRole('heading',{name:'Projekt Alfa',exact:true}).count(),0);
    const secrets=[temporary.title,'Projekt Alfa','Klient Alfa',users.worker,cookies.worker,csrf.worker,password];
    const persisted=await page.evaluate(async secrets=>{
      if(localStorage.length||sessionStorage.length) return true;
      for(const name of await caches.keys()) {const cache=await caches.open(name);for(const request of await cache.keys()) {const response=await cache.match(request); const text=await response.text(); if(secrets.some(secret=>text.includes(secret))||new URL(request.url).pathname.startsWith('/api/'))return true;}}
      return false;
    },secrets); assert.equal(persisted,false);
    const storedSecret=await page.evaluate(async secrets=>{
      for(const {name} of await indexedDB.databases()){
        const db=await new Promise((resolve,reject)=>{const request=indexedDB.open(name);request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
        try {for(const store of db.objectStoreNames){const values=await new Promise((resolve,reject)=>{const tx=db.transaction(store);const request=tx.objectStore(store).getAll();tx.oncomplete=()=>resolve(request.result);tx.onabort=()=>reject(tx.error);});if(secrets.some(secret=>JSON.stringify(values).includes(secret)))return true;}}
        finally{db.close();}
      }return false;
    },authSecrets);assert.equal(storedSecret,false);
    // Expiry and a backward clock fail closed; online verification is required.
    await page.evaluate(()=>{window.originalClock=Date.now;Date.now=()=>window.originalClock()+24*60*60*1000+1000;});
    await page.getByText('Część danych wygasła',{exact:false}).waitFor(); assert.equal(await page.locator('.offline-project').count(),0);
    await page.evaluate(()=>{Date.now=window.originalClock;}); await page.reload(); await page.getByText('Brak pobranych projektów',{exact:false}).waitFor();
    await context.setOffline(false); await page.locator('#active-organization').selectOption(companyA);
    await page.getByRole('button',{name:'Projekt Alfa Aktywny Kontrahent: Klient Alfa',exact:true}).click(); await page.getByRole('button',{name:'Przygotuj offline',exact:true}).click();
    await page.getByText('Projekt gotowy offline — tylko odczyt.',{exact:true}).waitFor();
    const other=await context.newPage(); await other.goto(config.origin); await other.getByText('worker@example.test',{exact:true}).waitFor();
    await page.evaluate(()=>{Object.defineProperty(navigator,'onLine',{configurable:true,get:()=>false});window.dispatchEvent(new Event('offline'));}); await page.getByRole('heading',{name:'SiteGrid bez połączenia'}).waitFor();
    if(!mobile)await other.evaluate(()=>{
      window.originalAccessDelete=IDBObjectStore.prototype.delete;window.originalAccessPut=IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.delete=function(){if(this.name==='access')throw new DOMException('Denied','SecurityError');return window.originalAccessDelete.apply(this,arguments);};
      IDBObjectStore.prototype.put=function(){if(this.name==='access')throw new DOMException('Denied','SecurityError');return window.originalAccessPut.apply(this,arguments);};
    });
    await other.getByRole('button',{name:'Wyloguj się',exact:true}).click(); await other.getByRole('heading',{name:'Zaloguj się.'}).waitFor();
    await page.getByText('Brak pobranych projektów',{exact:false}).waitFor(); assert.equal(await page.locator('.offline-project').count(),0);
    if(!mobile){
      await other.getByText('Dostęp offline zablokowany:',{exact:false}).waitFor();assert((await context.cookies()).some(cookie=>cookie.name==='sitegrid-offline-denied'&&cookie.value==='1'));
      await context.setOffline(true);await page.reload();await page.getByText('Brak pobranych projektów',{exact:false}).waitFor();assert.equal(await page.locator('.offline-project').count(),0);
      await other.evaluate(()=>{IDBObjectStore.prototype.delete=window.originalAccessDelete;IDBObjectStore.prototype.put=window.originalAccessPut;});await context.setOffline(false);
    }
    await other.locator('#email').fill('administratorb@example.test');await other.locator('#password').fill(password);await other.getByRole('button',{name:'Zaloguj się',exact:true}).click();
    await other.getByText('administratorb@example.test',{exact:true}).waitFor();
    await other.locator('#active-organization').selectOption(companyB);await other.getByRole('button',{name:'Projekt obcej firmy Aktywny Kontrahent: Klient Alfa',exact:true}).click();
    await other.getByRole('button',{name:'Przygotuj offline',exact:true}).click();await other.getByText('Projekt gotowy offline — tylko odczyt.',{exact:true}).waitFor();
    await context.setOffline(true);await page.reload();await page.getByRole('heading',{name:'Projekt obcej firmy',exact:true}).waitFor();await page.getByText('Przygotowano wyłącznie metadane projektu.',{exact:false}).waitFor();
    assert.equal(await page.getByRole('heading',{name:'Projekt Alfa',exact:true}).count(),0);assert.equal(await page.locator('.task-row').count(),0);
    if(!mobile){
      await context.setOffline(false);await page.reload();await page.getByText('administratorb@example.test',{exact:true}).waitFor();
      const originalWorker=servedWorker, configMatch=JSON.parse(originalWorker.match(/const shell = (.*);/)[1]);
      servedWorker=originalWorker.replace(JSON.stringify(configMatch),JSON.stringify({...configMatch,version:'c'.repeat(64)}));
      await page.evaluate(async()=>{await(await navigator.serviceWorker.getRegistration('/')).update();});
      await page.getByText('Nowa wersja gotowa.',{exact:false}).waitFor();await other.close();await page.close();
      page=await context.newPage();await page.goto(config.origin);await page.waitForFunction(async()=>(await caches.keys()).includes('sitegrid-shell-v1-'+'c'.repeat(64)));
      await context.setOffline(true);await page.reload();await page.getByRole('heading',{name:'Projekt obcej firmy',exact:true}).waitFor();
      console.log('PASS failed cleanup denial persists through offline restart; metadata-only account has no prior account tasks; worker update/rollback preserves valid snapshots');
      await context.setOffline(false);servedWorker=originalWorker;await page.reload();await page.evaluate(async()=>{await(await navigator.serviceWorker.getRegistration('/')).update();});
      await page.getByText('Nowa wersja gotowa.',{exact:false}).waitFor();await page.close();page=await context.newPage();await page.goto(config.origin);
      await page.waitForFunction(async version=>(await caches.keys()).includes('sitegrid-shell-v1-'+version),configMatch.version);
      await context.setOffline(true);await page.reload();await page.getByRole('heading',{name:'Projekt obcej firmy',exact:true}).waitFor();
    }
    await context.close();
    await owner.query("INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at) VALUES ($1,$2,$3,now()+interval '1 hour')",[createHash('sha256').update(cookies.worker).digest('hex'),users.worker,csrf.worker]);
    console.log(`PASS ${suffix}: explicit preparation, older snapshot on failed/cancelled/quota refresh, whole replacement, offline close/reopen, authorized scopes, finite expiry/clock rollback, logout/account switch/multi-tab and no private cache`);
  }
  // Confirmed revocation invalidates the prepared project before another offline launch.
  const revoked=await open(false); await revoked.page.getByRole('button',{name:'Przygotuj offline',exact:true}).click(); await revoked.page.getByText('Projekt gotowy offline — tylko odczyt.',{exact:true}).waitFor();
  await owner.query("UPDATE project_memberships SET status='inactive',version=version+1 WHERE organization_id=$1 AND project_id=$2 AND membership_id=$3",[companyA,projectOne.id,members.worker]);
  await revoked.page.getByRole('button',{name:'Wczytaj aktualne dane',exact:true}).click(); await revoked.page.locator('.project-details').waitFor({state:'detached'});
  await revoked.context.setOffline(true); await revoked.page.reload(); await revoked.page.getByText('Brak pobranych projektów',{exact:false}).waitFor();assert.equal(await revoked.page.locator('.offline-project').count(),0);await revoked.context.close();
  await owner.query("UPDATE project_memberships SET status='active',version=version+1 WHERE organization_id=$1 AND project_id=$2 AND membership_id=$3",[companyA,projectOne.id,members.worker]);
  const legacy=await open(false);await legacy.page.getByRole('button',{name:'Przygotuj offline',exact:true}).click();await legacy.page.getByText('Projekt gotowy offline — tylko odczyt.',{exact:true}).waitFor();
  const legacyTab=await legacy.context.newPage();await legacyTab.goto(config.origin);
  await legacy.page.evaluate(()=>{Object.defineProperty(navigator,'onLine',{configurable:true,get:()=>false});window.dispatchEvent(new Event('offline'));});await legacy.page.getByRole('heading',{name:'Projekt Alfa',exact:true}).waitFor();
  await legacyTab.evaluate(()=>{const channel=new BroadcastChannel('sitegrid-account-change');channel.postMessage('changed');channel.close();});
  await legacy.page.getByText('Brak pobranych projektów',{exact:false}).waitFor();assert.equal(await legacy.page.locator('.offline-project').count(),0);await legacy.context.close();
  console.log('PASS legacy account-change signal invalidates M10 data across client versions');
  const role=await open(false);await role.page.getByRole('button',{name:'Przygotuj offline',exact:true}).click();await role.page.getByText('Projekt gotowy offline — tylko odczyt.',{exact:true}).waitFor();
  await owner.query('DELETE FROM membership_roles WHERE organization_id=$1 AND membership_id=$2',[companyA,members.worker]);
  await role.page.getByRole('button',{name:'Wczytaj aktualne dane',exact:true}).click();await role.page.getByText('Dostęp do zadań wymaga',{exact:false}).waitFor();
  assert.equal(await role.page.getByText('Gotowy offline.',{exact:false}).count(),0);
  await role.context.setOffline(true);await role.page.reload();await role.page.getByText('Brak pobranych projektów',{exact:false}).waitFor();assert.equal(await role.page.locator('.offline-project').count(),0);await role.context.close();
  await owner.query("INSERT INTO membership_roles(organization_id,membership_id,role) VALUES($1,$2,'worker')",[companyA,members.worker]);
  const missingShell=await open(false);let missingDownloads=0;missingShell.page.on('request',request=>{if(request.url().endsWith('/snapshot'))missingDownloads++;});
  await missingShell.page.evaluate(async()=>{for(const name of await caches.keys())if(name.startsWith('sitegrid-shell-v1-'))await caches.delete(name);});
  await missingShell.page.getByRole('button',{name:'Przygotuj offline',exact:true}).click();await missingShell.page.getByText('Powłoka offline jest niedostępna.',{exact:false}).waitFor();assert.equal(missingDownloads,0);
  assert.equal(await missingShell.page.getByText('Projekt gotowy offline — tylko odczyt.',{exact:true}).count(),0);await missingShell.context.close();
  console.log('PASS revoked task role and missing static shell never claim offline readiness');
  const expiredSession=await open(false);await expiredSession.page.getByRole('button',{name:'Przygotuj offline',exact:true}).click();await expiredSession.page.getByText('Projekt gotowy offline — tylko odczyt.',{exact:true}).waitFor();
  await owner.query('DELETE FROM sessions WHERE token_hash=$1',[createHash('sha256').update(cookies.worker).digest('hex')]);
  await expiredSession.page.getByRole('button',{name:'Rozpocznij zadanie',exact:true}).first().click();await expiredSession.page.locator('.project-details').waitFor({state:'detached'});
  await expiredSession.context.setOffline(true);await expiredSession.page.reload();await expiredSession.page.getByText('Brak pobranych projektów',{exact:false}).waitFor();assert.equal(await expiredSession.page.locator('.offline-project').count(),0);await expiredSession.context.close();
  console.log('PASS online command 401 invalidates the whole account offline eligibility');
  assert.deepEqual(errors,[]);assert.deepEqual(cspErrors,[]);console.log('PASS online revocation invalidates local project, no runtime/CSP errors');
} finally {
  await browser?.close(); await app?.close(); await runtime.end(); await owner.end();
  try { await admin.query(`DROP SCHEMA ${schema} CASCADE`); } finally { await admin.end(); }
}
