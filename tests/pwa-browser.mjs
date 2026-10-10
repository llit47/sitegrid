// Production PWA + real browser IndexedDB, with synthetic PostgreSQL/runtime RLS.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import pg from 'pg';
import { buildApp } from '../apps/server/src/app.ts';
import { readConfig } from '../apps/server/src/config.ts';
import { migrate } from '../apps/server/src/migrations.ts';
import { hashPassword } from '../apps/server/src/auth/password.ts';
import { createInvitation } from '../apps/server/src/invitations.ts';
const { chromium } = await import(process.env.SITEGRID_PLAYWRIGHT_MODULE ? pathToFileURL(process.env.SITEGRID_PLAYWRIGHT_MODULE).href : 'playwright');
assert(process.env.TEST_DATABASE_URL && process.env.TEST_RUNTIME_DATABASE_URL);
const schema = `pwa_browser_${randomBytes(6).toString('hex')}`;
const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
const ownerUrl = new URL(process.env.TEST_DATABASE_URL), runtimeUrl = new URL(process.env.TEST_RUNTIME_DATABASE_URL);
for (const url of [ownerUrl, runtimeUrl]) url.searchParams.set('options', `-c search_path=${schema}`);
const owner = new pg.Pool({ connectionString: ownerUrl.href }), runtime = new pg.Pool({ connectionString: runtimeUrl.href });
const config = readConfig({ NODE_ENV: 'test', DATABASE_URL: runtimeUrl.href });
const company = randomUUID(), companyB = randomUUID(), user = randomUUID(), secondUser = randomUUID(), project = randomUUID(), member = randomUUID();
const token = randomBytes(32).toString('base64url'), csrf = randomBytes(32).toString('base64url');
let app, browser, servedWorker;
const errors = [], shellCookies = [];

async function assertInvitationIsMemoryOnly(page, token) {
  const persisted = await page.evaluate(async secret => {
    const contains = value => JSON.stringify(value)?.includes(secret) ?? false;
    for (const storage of [localStorage, sessionStorage]) {
      for (let index = 0; index < storage.length; index++) {
        const key = storage.key(index);
        if (contains([key, storage.getItem(key)])) return true;
      }
    }
    for (const name of await caches.keys()) {
      if (contains(name)) return true;
      const cache = await caches.open(name);
      for (const request of await cache.keys()) {
        const response = await cache.match(request);
        if (contains([request.url, [...request.headers], [...response.headers], await response.text()])) return true;
      }
    }
    for (const { name } of await indexedDB.databases()) {
      if (contains(name)) return true;
      const database = await new Promise((resolve, reject) => {
        const request = indexedDB.open(name);
        request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
      });
      try {
        for (const storeName of database.objectStoreNames) {
          if (contains(storeName)) return true;
          const records = await new Promise((resolve, reject) => {
            const transaction = database.transaction(storeName, 'readonly');
            const store = transaction.objectStore(storeName), keys = store.getAllKeys(), values = store.getAll();
            transaction.oncomplete = () => resolve([keys.result, values.result]);
            transaction.onabort = () => reject(transaction.error);
          });
          if (contains(records)) return true;
        }
      } finally { database.close(); }
    }
    return false;
  }, token);
  assert.equal(persisted, false, 'Invitation bearer must never enter persistent browser storage or caches');
  assert((await page.context().cookies()).every(cookie => !cookie.value.includes(token)));
}

async function invitationRegression(mobile, offlineLaunch, issuer) {
  const email = offlineLaunch ? `invited-${mobile ? 'mobile' : 'desktop'}@example.test` : 'second@example.test';
  const seed = await owner.connect();
  let created;
  try {
    await seed.query('BEGIN');
    created = await createInvitation(seed, company, issuer, email, 'worker', false);
    await seed.query('COMMIT');
  } finally { seed.release(); }
  const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 } });
  try {
    await context.addInitScript(() => {
      if (location.pathname !== '/invitations/accept') return;
      history.replaceState({ invitationRegression: true }, '');
      // Observe the first React view, including the offline view where App never mounts.
      const observer = new MutationObserver(() => {
        if (!document.getElementById('root')?.childElementCount) return;
        window.invitationScrubbedBeforeRender = location.hash === '';
        observer.disconnect();
      });
      observer.observe(document, { childList: true, subtree: true });
    });
    const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
    await page.goto(config.origin);
    await page.getByText('Powłoka aplikacji gotowa do otwarcia offline.', { exact: true }).waitFor();
    await page.waitForFunction(() => navigator.serviceWorker.controller);
    if (offlineLaunch) await context.setOffline(true);
    const sanitizedUrl = `${config.origin}/invitations/accept?source=email&next=%2F`;
    await page.goto(`${sanitizedUrl}#${created.token}`);
    const checkSanitized = async () => {
      assert.equal(page.url(), sanitizedUrl);
      assert.equal(await page.evaluate(() => window.invitationScrubbedBeforeRender), true);
      assert.deepEqual(await page.evaluate(() => history.state), { invitationRegression: true });
    };
    if (offlineLaunch) {
      await page.getByRole('heading', { name: 'SiteGrid bez połączenia' }).waitFor();
      await checkSanitized();
      assert.equal(await page.getByRole('heading', { name: 'Aktywacja zaproszenia' }).count(), 0);
      await assertInvitationIsMemoryOnly(page, created.token);
      await context.setOffline(false);
    }
    await page.getByText('Oczekujące — Firma A', { exact: true }).waitFor();
    await checkSanitized();
    // Both an offline launch and an already sanitized online page survive remounts.
    await context.setOffline(true);
    await page.getByRole('heading', { name: 'SiteGrid bez połączenia' }).waitFor();
    await checkSanitized();
    await context.setOffline(false);
    await page.getByText('Oczekujące — Firma A', { exact: true }).waitFor();
    await checkSanitized();
    await assertInvitationIsMemoryOnly(page, created.token);
    if (offlineLaunch) {
      await page.getByLabel('Email z zaproszenia', { exact: true }).fill(email);
      await page.getByLabel('Nowe hasło', { exact: true }).fill('Synthetic-password-15');
      await page.getByLabel('Powtórz hasło', { exact: true }).fill('Synthetic-password-15');
      await page.getByRole('button', { name: 'Utwórz konto i zaakceptuj', exact: true }).click();
      await page.getByText('Zaproszenie zostało przyjęte.', { exact: false }).waitFor();
    }
    await page.locator('#email').fill(email); await page.locator('#password').fill('Synthetic-password-15');
    await page.getByRole('button', { name: 'Zaloguj się', exact: true }).click();
    await page.locator('.account').getByText(email, { exact: true }).waitFor();
    if (!offlineLaunch) {
      await page.getByRole('button', { name: 'Akceptuj zaproszenie', exact: true }).click();
      await page.getByText('Zaproszenie zostało przyjęte.', { exact: false }).waitFor();
    }
    const accepted = (await owner.query(`SELECT u.email FROM organization_invitations i
      JOIN users u ON u.id = i.accepted_by WHERE i.id = $1 AND i.accepted_at IS NOT NULL`, [created.invitation.id])).rows;
    assert.deepEqual(accepted, [{ email }]);
    await assertInvitationIsMemoryOnly(page, created.token);
    await page.getByRole('button', { name: 'Wyloguj się', exact: true }).click();
    await page.getByRole('heading', { name: 'Zaloguj się.' }).waitFor();
    await checkSanitized();
    await assertInvitationIsMemoryOnly(page, created.token);
    await page.reload();
    await page.getByText('Niedostępne', { exact: true }).waitFor(); // a new page cannot recover the scrubbed bearer
    assert.equal(page.url(), sanitizedUrl);
    console.log(`PASS ${mobile ? 'mobile' : 'desktop'} invitation ${offlineLaunch ? 'offline launch/new account' : 'online launch/existing account'}: scrub before first render, URL/history preservation, reconnect/remount retention, acceptance/login/logout, memory-only bearer`);
  } finally { await context.close(); }
}

await admin.query(`CREATE SCHEMA ${schema}`);
try {
  await migrate(owner, 'migrations');
  await owner.query(`GRANT USAGE ON SCHEMA ${schema} TO sitegrid`);
  await owner.query('GRANT SELECT ON installation, schema_migrations, users, credentials, platform_admins TO sitegrid');
  await owner.query('GRANT SELECT, INSERT, DELETE ON sessions TO sitegrid');
  await owner.query('GRANT SELECT, INSERT, UPDATE, DELETE ON auth_rate_limits TO sitegrid');
  for (const [id, name] of [[company, 'Firma A'], [companyB, 'Firma B']]) await owner.query('INSERT INTO organizations(id,name) VALUES ($1,$2)', [id, name]);
  const passwordHash = await hashPassword('Synthetic-password-15');
  for (const [id, email] of [[user, 'first@example.test'], [secondUser, 'second@example.test']]) {
    await owner.query('INSERT INTO users(id,email) VALUES ($1,$2)', [id, email]);
    await owner.query('INSERT INTO credentials(user_id,password_hash) VALUES ($1,$2)', [id, passwordHash]);
  }
  for (const [organization, id] of [[company, member], [companyB, randomUUID()]]) {
    await owner.query("INSERT INTO organization_memberships(organization_id,id,user_id,status) VALUES ($1,$2,$3,'active')", [organization, id, user]);
    await owner.query("INSERT INTO membership_roles(organization_id,membership_id,role) VALUES ($1,$2,'worker')", [organization, id]);
  }
  const issuer = randomUUID(), issuerMember = randomUUID();
  await owner.query('INSERT INTO users(id,email) VALUES ($1,$2)', [issuer, 'issuer@example.test']);
  await owner.query("INSERT INTO organization_memberships(organization_id,id,user_id,status) VALUES ($1,$2,$3,'active')", [company, issuerMember, issuer]);
  await owner.query("INSERT INTO membership_roles(organization_id,membership_id,role) VALUES ($1,$2,'organization_admin')", [company, issuerMember]);
  const contractor = randomUUID();
  await owner.query('INSERT INTO contractors(organization_id,id,name) VALUES ($1,$2,$3)', [company, contractor, 'Poufny kontrahent A']);
  await owner.query('INSERT INTO contractors(organization_id,name) VALUES ($1,$2)', [company, 'Niewidoczny katalog kontrahentów A']);
  await owner.query('INSERT INTO projects(organization_id,id,name,contractor_id) VALUES ($1,$2,$3,$4)', [company, project, 'Poufny projekt A', contractor]);
  await owner.query('INSERT INTO project_memberships(organization_id,project_id,membership_id) VALUES ($1,$2,$3)', [company, project, member]);
  const seed = await owner.connect();
  try {
    await seed.query('BEGIN');
    await seed.query("SELECT set_config('sitegrid.user_id', $1, true)", [user]);
    await seed.query('INSERT INTO tasks(organization_id,project_id,title,assignee_membership_id,author_membership_id) VALUES ($1,$2,$3,$4,$4)', [company, project, 'Poufne zadanie A', member]);
    await seed.query('COMMIT');
  } finally { seed.release(); }
  await owner.query("INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at) VALUES ($1,$2,$3,now()+interval '1 hour')", [createHash('sha256').update(token).digest('hex'), user, csrf]);
  app = await buildApp(config, runtime, { serveWeb: true });
  // Test-only endpoints for the real browser's storage module and version upgrade.
  const storageSource = (await build({ entryPoints: ['apps/web/src/storage/indexed-db.ts'], bundle: true, write: false, format: 'esm', target: 'es2023' })).outputFiles[0].text;
  app.get('/test-storage.js', (_request, reply) => reply.type('application/javascript').send(storageSource));
  servedWorker = await readFile('dist/web/sw.js', 'utf8');
  app.get('/sw.js', (_request, reply) => reply.header('Cache-Control', 'no-store').type('application/javascript').send(servedWorker));
  app.addHook('onRequest', async request => { if (request.headers['sec-fetch-dest'] === 'empty' && /^\/(assets|pwa)\//.test(request.url)) shellCookies.push(request.headers.cookie); });
  config.origin = await app.listen({ host: '127.0.0.1', port: 0 });
  browser = await chromium.launch({ headless: true, ...(process.env.SITEGRID_CHROMIUM_PATH ? { executablePath: process.env.SITEGRID_CHROMIUM_PATH } : {}) });
  const initialConfig = JSON.parse(servedWorker.match(/const shell = (.*);/)[1]);
  for (const mobile of [false, true]) {
    const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 } });
    await context.addCookies([{ name: 'sitegrid', value: token, url: config.origin, httpOnly: true, sameSite: 'Strict' }]);
    let page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
    let ownSessionReads = 0;
    page.on('request', request => { if (new URL(request.url()).pathname === '/api/auth/session') ownSessionReads++; });
    await page.goto(config.origin);
    await page.getByText('Powłoka aplikacji gotowa do otwarcia offline.', { exact: true }).waitFor();
    await page.waitForFunction(() => navigator.serviceWorker.controller);
    await page.locator('#active-organization').selectOption(company);
    await page.getByRole('button', { name: 'Poufny projekt A Aktywny Kontrahent: Poufny kontrahent A', exact: true }).click();
    await page.getByText('Poufne zadanie A', { exact: true }).waitFor();
    await page.getByRole('button', { name: mobile ? 'Zgłoś do odbioru' : 'Rozpocznij zadanie', exact: true }).click();
    await page.getByText(mobile ? 'Serwer potwierdził zgłoszenie do odbioru.' : 'Serwer potwierdził rozpoczęcie zadania.', { exact: true }).waitFor();
    await page.locator('#active-organization').selectOption(companyB);
    await page.getByText('Brak dostępnych projektów.', { exact: false }).waitFor();
    await page.locator('#active-organization').selectOption(company);
    await page.getByRole('button', { name: 'Poufny projekt A Aktywny Kontrahent: Poufny kontrahent A', exact: true }).click();
    await page.getByText('Poufne zadanie A', { exact: true }).waitFor();
    assert.equal(await page.locator('.project-details').getByText('Kontrahent: Poufny kontrahent A', { exact: true }).count(), 1);
    assert.equal(await page.getByText('Niewidoczny katalog kontrahentów A', { exact: true }).count(), 0);
    await page.getByText('Zainstaluj SiteGrid', { exact: true }).click();
    assert(await page.getByText('iPhone/iPad:', { exact: false }).isVisible());
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.evaluate(async company => {
      await fetch('/api/auth/session'); await fetch('/api/organizations/foreign/branding/logo');
      await fetch(`/api/organizations/${company}/projects`); await fetch(`/api/organizations/${company}/contractors`);
      await fetch('/health/ready'); await fetch('/test-storage.js');
    }, company);
    const cached = await page.evaluate(async () => {
      const names = await caches.keys();
      return (await Promise.all(names.map(async name => (await (await caches.open(name)).keys()).map(request => new URL(request.url).pathname)))).flat();
    });
    assert.deepEqual(cached.sort(), initialConfig.assets.map(asset => asset.url).sort());
    assert(!cached.some(path => path.startsWith('/api/') || path.includes('test-storage')));
    assert.equal(await page.evaluate(async () => {
      for (const name of await caches.keys()) {
        const cache = await caches.open(name);
        for (const request of await cache.keys()) if ((await (await cache.match(request)).text()).includes('Poufny kontrahent A')) return true;
      }
      return false;
    }), false);
    await context.setOffline(true);
    await page.getByRole('heading', { name: 'SiteGrid bez połączenia' }).waitFor();
    assert.equal(await page.getByText('Poufne zadanie A', { exact: true }).count(), 0);
    assert.equal(await page.getByText('Kontrahent: Poufny kontrahent A', { exact: true }).count(), 0);
    assert.equal(await page.locator('.account').count(), 0);
    await page.reload(); await page.getByRole('heading', { name: 'SiteGrid bez połączenia' }).waitFor();
    await page.getByText('Powłoka aplikacji gotowa do otwarcia offline.', { exact: true }).waitFor();
    assert.equal(await page.locator('#email').count(), 0);
    await page.screenshot({ path: `/tmp/sitegrid-pr15-${mobile ? 'mobile' : 'desktop'}-offline.png`, fullPage: true });
    await context.setOffline(false); await page.getByText('first@example.test', { exact: true }).waitFor();
    assert.equal(await page.locator('.task-row').count(), 0); // fresh authorized context after reconnect
    const otherTab = await context.newPage();
    await otherTab.goto(config.origin); await otherTab.getByText('first@example.test', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Wyloguj się', exact: true }).click();
    await otherTab.getByRole('heading', { name: 'Zaloguj się.' }).waitFor();
    await page.getByRole('heading', { name: 'Zaloguj się.' }).waitFor();
    const beforeLoginReads = ownSessionReads;
    await page.locator('#email').fill('second@example.test'); await page.locator('#password').fill('Synthetic-password-15');
    await page.getByRole('button', { name: 'Zaloguj się', exact: true }).click();
    await page.getByText('second@example.test', { exact: true }).waitFor();
    await otherTab.getByText('second@example.test', { exact: true }).waitFor();
    assert.equal(ownSessionReads - beforeLoginReads, 1, 'Account notifications must not remount the initiating tab');
    assert.equal(await otherTab.getByText('first@example.test', { exact: true }).count(), 0);
    await otherTab.close();
    assert.equal(await page.getByText('Poufny projekt A', { exact: true }).count(), 0);
    assert.equal(await page.getByText('first@example.test', { exact: true }).count(), 0);
    console.log(`PASS ${mobile ? 'mobile' : 'desktop'} registration, API exclusion, task progress, organization switch, offline reload/reconnect, logout and real login as another account`);
    await invitationRegression(mobile, true, issuer);
    await invitationRegression(mobile, false, issuer);
    if (!mobile) {
      const storage = await page.evaluate(async ({ user, company, project }) => {
        const { openProjectStorage, checkLocalStorage, projectDatabaseName } = await import('/test-storage.js');
        const scope = { accountId: user, organizationId: company, projectId: project };
        const expectFailure = async (operation, expected) => { try { await operation(); throw new Error('False success'); } catch (error) { if (error.code !== expected) throw error; } };
        const handle = await openProjectStorage(scope); await handle.verify(); handle.close();
        await expectFailure(() => handle.verify(), 'failed'); // discarded handles cannot be reused
        const variants = [scope, { ...scope, accountId: crypto.randomUUID() }, { ...scope, organizationId: crypto.randomUUID() }, { ...scope, projectId: crypto.randomUUID() }];
        for (const variant of variants) (await openProjectStorage(variant)).close();
        const names = (await indexedDB.databases()).map(db => db.name);
        if (new Set(variants.map(projectDatabaseName)).size !== 4) throw new Error('Mixed partitions');
        const openRaw = (name, version, upgrade) => new Promise((resolve, reject) => {
          const request = indexedDB.open(name, version); request.onupgradeneeded = () => upgrade?.(request.result);
          request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
        });
        const name = projectDatabaseName(scope);
        const raw = await openRaw(name, 2);
        const originalPut = IDBObjectStore.prototype.put;
        IDBObjectStore.prototype.put = function () { throw new DOMException('Full', 'QuotaExceededError'); };
        try { await expectFailure(checkLocalStorage, 'quota'); } finally { IDBObjectStore.prototype.put = originalPut; }
        const originalDelete = IDBObjectStore.prototype.delete;
        IDBObjectStore.prototype.delete = function () { const request = originalDelete.apply(this, arguments); this.transaction.abort(); return request; };
        try { await expectFailure(checkLocalStorage, 'aborted'); } finally { IDBObjectStore.prototype.delete = originalDelete; }
        await checkLocalStorage();
        const corrupt = raw.transaction('metadata', 'readwrite'); corrupt.objectStore('metadata').put({ format: 1, ...scope, accountId: 'other' }, 'owner');
        await new Promise((resolve, reject) => { corrupt.oncomplete = resolve; corrupt.onabort = reject; }); raw.close();
        await expectFailure(() => openProjectStorage(scope), 'invalid');
        const unknownScope = { ...scope, projectId: crypto.randomUUID() };
        (await openRaw(projectDatabaseName(unknownScope), 1, db => db.createObjectStore('unexpected'))).close();
        await expectFailure(() => openProjectStorage(unknownScope), 'invalid');
        const newerScope = { ...scope, projectId: crypto.randomUUID() };
        (await openRaw(projectDatabaseName(newerScope), 3, db => db.createObjectStore('metadata'))).close();
        await expectFailure(() => openProjectStorage(newerScope), 'invalid');
        // A deleted v1 database blocks reinitialization until an old tab releases it.
        const blocked = { ...scope, projectId: crypto.randomUUID() };
        const holding = await openRaw(projectDatabaseName(blocked), 1, db => db.createObjectStore('metadata'));
        const removal = indexedDB.deleteDatabase(projectDatabaseName(blocked));
        await new Promise(resolve => { removal.onblocked = resolve; });
        const pending = openProjectStorage(blocked);
        await expectFailure(() => pending, 'blocked'); holding.close();
        await new Promise(resolve => { removal.onsuccess = resolve; });
        // Our handles close themselves for versionchange; an upgrade can complete safely.
        const upgradeScope = { ...scope, projectId: crypto.randomUUID() };
        const upgraded = await openProjectStorage(upgradeScope);
        (await openRaw(projectDatabaseName(upgradeScope), 3)).close();
        await expectFailure(() => upgraded.verify(), 'failed');
        return { partitions: names.filter(name => name.startsWith('sitegrid-project-')).length };
      }, { user, company, project });
      assert.equal(storage.partitions, 4);
      console.log('PASS real IndexedDB v0→v2 initialization, 4 isolated partitions, discarded handles, blocked upgrades, v3 rejection, corrupt ownership/schema, quota and aborted transaction failures');
      // Worker update never replaces a live tab or removes its working shell.
      const updateTab = await context.newPage(); await updateTab.goto(config.origin);
      await updateTab.getByText('second@example.test', { exact: true }).waitFor();
      await page.evaluate(async () => { await caches.open('unrelated-app-cache'); });
      const nextConfig = { ...initialConfig, version: 'b'.repeat(64) };
      servedWorker = servedWorker.replace(JSON.stringify(initialConfig), JSON.stringify(nextConfig));
      await page.evaluate(async () => { await (await navigator.serviceWorker.getRegistration()).update(); });
      await page.getByText('Nowa wersja gotowa.', { exact: false }).waitFor();
      assert(await page.evaluate(async () => (await caches.keys()).filter(name => name.startsWith('sitegrid-shell-v1-')).length === 2));
      await page.close();
      assert.equal(await updateTab.evaluate(async () => (await caches.keys()).filter(name => name.startsWith('sitegrid-shell-v1-')).length), 2);
      assert(await updateTab.getByText('second@example.test', { exact: true }).isVisible());
      await updateTab.close();
      page = await context.newPage(); page.on('pageerror', error => errors.push(error.message)); await page.goto(config.origin);
      await page.waitForFunction(async () => (await navigator.serviceWorker.getRegistration()).active?.state === 'activated' &&
        (await caches.keys()).includes('sitegrid-shell-v1-' + 'b'.repeat(64)) && (await caches.keys()).filter(name => name.startsWith('sitegrid-shell-v1-')).length === 1);
      assert(await page.evaluate(async () => (await caches.keys()).includes('unrelated-app-cache')));
      console.log('PASS real worker update waits for tab closure, activates new version and retains unrelated cache');
      servedWorker = await readFile('dist/web/sw.js', 'utf8');
    }
    await context.close();
    // Cookie fixture was invalidated by the logout above; issue a new synthetic session.
    await owner.query("INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at) VALUES ($1,$2,$3,now()+interval '1 hour')", [createHash('sha256').update(token).digest('hex'), user, csrf]);
  }
  const unavailable = await browser.newContext();
  await unavailable.addInitScript(() => { Object.defineProperty(window, 'BroadcastChannel', { value: class { constructor() { throw new DOMException('Denied', 'SecurityError'); } } }); Object.defineProperty(window, 'indexedDB', { get() { throw new DOMException('Denied', 'SecurityError'); } }); delete Object.getPrototypeOf(navigator).serviceWorker; });
  const page = await unavailable.newPage(); page.on('pageerror', error => errors.push(error.message)); await page.goto(config.origin);
  await page.getByText('Pamięć lokalna niedostępna', { exact: false }).waitFor();
  await page.getByText('Powłoka offline niedostępna.', { exact: false }).waitFor();
  await page.locator('#email').fill('second@example.test'); await page.locator('#password').fill('Synthetic-password-15');
  await page.getByRole('button', { name: 'Zaloguj się', exact: true }).click(); await page.getByText('second@example.test', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Wyloguj się', exact: true }).click(); await page.getByRole('heading', { name: 'Zaloguj się.' }).waitFor();
  await unavailable.close();
  const unprepared = await browser.newContext(); await unprepared.setOffline(true);
  const cold = await unprepared.newPage(); await assert.rejects(cold.goto(config.origin)); await unprepared.close();
  assert(shellCookies.length >= initialConfig.assets.length); assert(shellCookies.every(cookie => cookie === undefined)); assert.deepEqual(errors, []);
  console.log('PASS unavailable storage/PWA preserve browser login, unprepared offline launch fails honestly, no runtime errors');
} finally {
  await browser?.close(); await app?.close(); await runtime.end(); await owner.end();
  try { await admin.query(`DROP SCHEMA ${schema} CASCADE`); } finally { await admin.end(); }
}
