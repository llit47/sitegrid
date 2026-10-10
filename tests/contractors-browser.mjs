// Disposable M09C production UI, with actual PostgreSQL runtime authorization.
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { buildApp } from '../apps/server/src/app.ts';
import { readConfig } from '../apps/server/src/config.ts';
import { migrate } from '../apps/server/src/migrations.ts';
import { hashPassword } from '../apps/server/src/auth/password.ts';
const { chromium } = await import(process.env.SITEGRID_PLAYWRIGHT_MODULE ? pathToFileURL(process.env.SITEGRID_PLAYWRIGHT_MODULE).href : 'playwright');
assert(process.env.TEST_DATABASE_URL && process.env.TEST_RUNTIME_DATABASE_URL);
const schema = `contractors_browser_${randomBytes(6).toString('hex')}`;
const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
const ownerUrl = new URL(process.env.TEST_DATABASE_URL), runtimeUrl = new URL(process.env.TEST_RUNTIME_DATABASE_URL);
for (const url of [ownerUrl, runtimeUrl]) url.searchParams.set('options', `-c search_path=${schema}`);
const owner = new pg.Pool({ connectionString: ownerUrl.href }), runtime = new pg.Pool({ connectionString: runtimeUrl.href });
const config = readConfig({ NODE_ENV: 'test', DATABASE_URL: runtimeUrl.href });
const companyA = randomUUID(), companyB = randomUUID(), password = 'Synthetic-password-16';
const users = {}, members = {}, cookies = {}, csrf = {}, errors = [], cspErrors = [];
let app, browser;
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
  app = await buildApp(config, runtime, { serveWeb: true }); config.origin = await app.listen({ host: '127.0.0.1', port: 0 });
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
  const open = async (actor, mobile) => {
    // Online interception tests run separately from the real-worker PWA suite.
    const context = await browser.newContext({ serviceWorkers: 'block', viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 } });
    await context.addCookies([{ name: 'sitegrid', value: cookies[actor], url: config.origin, httpOnly: true, sameSite: 'Strict' }]);
    const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
    const directoryRequests = [];
    page.on('request', request => { if (new URL(request.url()).pathname.endsWith('/contractors')) directoryRequests.push(request.method()); });
    page.on('console', message => { if (message.text().includes('Content Security Policy')) cspErrors.push(message.text()); });
    await page.goto(config.origin); await page.locator('#active-organization').selectOption(companyA);
    await page.locator('.projects').waitFor(); return { context, page, directoryRequests };
  };
  for (const mobile of [false, true]) {
    const mode = mobile ? 'mobile' : 'desktop', { context, page } = await open('administrator', mobile);
    const projects = page.locator('.projects'), directory = page.getByRole('region', { name: 'Kontrahenci firmy' }), details = projects.locator('.project-details');
    await directory.getByRole('heading', { name: 'Klient Alfa', exact: true }).waitFor();
    const newName = `Nowy klient ${mode}`;
    const creation = directory.locator('.contractor-form').last();
    await creation.getByLabel('Nazwa nowego kontrahenta', { exact: true }).fill(newName);
    await creation.getByRole('button', { name: 'Utwórz kontrahenta', exact: true }).click();
    const row = name => directory.locator('.contractor-row').filter({ has: page.getByRole('heading', { name, exact: true }) });
    await row(newName).waitFor();
    let item = (await api(directoryPath)).contractors.find(item => item.name === newName);
    const updateUrl = `${config.origin}${directoryPath}/${item.id}/update`;
    await row(newName).getByLabel('Nazwa kontrahenta', { exact: true }).fill(`Szkic ${mode}`);
    await page.route(updateUrl, route => route.abort('failed'));
    await row(newName).getByRole('button', { name: 'Zapisz kontrahenta', exact: true }).click();
    await directory.getByRole('alert').filter({ hasText: 'Nie udało się połączyć z serwerem.' }).waitFor();
    assert.equal(await row(newName).getByLabel('Nazwa kontrahenta', { exact: true }).inputValue(), `Szkic ${mode}`);
    await page.unroute(updateUrl); await row(newName).getByRole('button', { name: 'Zapisz kontrahenta', exact: true }).click();
    await row(`Szkic ${mode}`).waitFor(); item = (await api(directoryPath)).contractors.find(candidate => candidate.id === item.id);
    const currentName = `Zmiana drugiej karty ${mode}`;
    await api(`${directoryPath}/${item.id}/update`, { name: currentName, status: 'active', expectedVersion: item.version });
    await row(`Szkic ${mode}`).getByLabel('Nazwa kontrahenta', { exact: true }).fill(`Lokalna propozycja ${mode}`);
    await row(`Szkic ${mode}`).getByRole('button', { name: 'Zapisz kontrahenta', exact: true }).click();
    await directory.getByRole('alert').filter({ hasText: 'Rekord zmienił się' }).waitFor();
    assert.equal(await row(`Szkic ${mode}`).getByLabel('Nazwa kontrahenta', { exact: true }).inputValue(), `Lokalna propozycja ${mode}`);
    await directory.getByRole('button', { name: 'Wczytaj kontrahentów ponownie', exact: true }).click(); await row(currentName).waitFor();
    const projectCreation = projects.locator('.project-form').last(), projectName = `Projekt testowy ${mode}`;
    await projectCreation.getByLabel('Nazwa projektu', { exact: true }).fill(projectName);
    await projectCreation.getByLabel('Kontrahent projektu', { exact: true }).selectOption(item.id);
    await projectCreation.getByRole('button', { name: 'Utwórz projekt', exact: true }).click(); await details.getByRole('heading', { name: projectName, exact: true }).waitFor();
    const createdProject = (await api(projectPath)).projects.find(project => project.name === projectName);
    await api(`${projectPath}/${createdProject.id}/update`, { name: projectName, contractorId: one.id, expectedVersion: 1 });
    await details.getByLabel('Nazwa projektu', { exact: true }).fill('Lokalny szkic projektu');
    await details.getByLabel('Kontrahent projektu', { exact: true }).selectOption(two.id);
    await details.getByRole('button', { name: 'Zapisz projekt', exact: true }).click();
    await details.getByRole('alert').filter({ hasText: 'Rekord zmienił się' }).waitFor();
    assert.equal(await details.getByLabel('Nazwa projektu', { exact: true }).inputValue(), 'Lokalny szkic projektu');
    assert.equal(await details.getByLabel('Kontrahent projektu', { exact: true }).inputValue(), two.id);
    await details.getByRole('button', { name: 'Wczytaj aktualne dane', exact: true }).click(); await details.getByText(/Wersja 2 ·/).waitFor();
    assert.equal(await details.getByLabel('Kontrahent projektu', { exact: true }).inputValue(), one.id);
    for (const [contractorId, version] of [[two.id, 3], ['', 4], [item.id, 5]]) {
      await details.getByLabel('Kontrahent projektu', { exact: true }).selectOption(contractorId);
      await details.getByRole('button', { name: 'Zapisz projekt', exact: true }).click();
      await details.getByText(new RegExp(`Wersja ${version} ·`)).waitFor();
    }
    await row(currentName).getByRole('button', { name: 'Dezaktywuj kontrahenta', exact: true }).click();
    await row(currentName).getByText('Nieaktywny kontrahent', { exact: false }).waitFor();
    await details.getByText(`Kontrahent: ${currentName} (nieaktywny)`, { exact: true }).waitFor();
    assert.equal(await projectCreation.getByLabel('Kontrahent projektu', { exact: true }).locator(`option[value="${item.id}"]`).count(), 0);
    assert.equal(await details.getByLabel('Kontrahent projektu', { exact: true }).locator(`option[value="${item.id}"]`).evaluate(option => option.disabled), true);
    await details.getByLabel('Nazwa projektu', { exact: true }).fill(`${projectName} z historią`);
    await details.getByRole('button', { name: 'Zapisz projekt', exact: true }).click(); await details.getByText(/Wersja 6 ·/).waitFor();
    await details.getByText(`Kontrahent: ${currentName} (nieaktywny)`, { exact: true }).waitFor();
    await projects.getByLabel('Filtruj projekty po kontrahencie', { exact: true }).selectOption(item.id);
    assert.equal(await projects.locator('.project-choice').count(), 1); assert.equal(await details.count(), 0);
    await projects.getByLabel('Filtruj projekty po kontrahencie', { exact: true }).selectOption('none');
    await projects.getByRole('button', { name: 'Projekt wewnętrzny Aktywny', exact: true }).waitFor(); assert.equal(await projects.locator('.project-choice').count(), 1);
    await projects.getByLabel('Filtruj projekty po kontrahencie', { exact: true }).selectOption('');
    await row(currentName).getByRole('button', { name: 'Aktywuj kontrahenta', exact: true }).click(); await row(currentName).getByText(/^Aktywny kontrahent · Wersja/).waitFor();
    assert.equal(await projectCreation.getByLabel('Kontrahent projektu', { exact: true }).locator(`option[value="${item.id}"]`).count(), 1);
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    // A late directory read and an already committed write cannot enter company B.
    for (const mutation of [false, true]) {
      let release, started, finished;
      const gate = new Promise(resolve => { release = resolve; }), intercepted = new Promise(resolve => { started = resolve; }), delivered = new Promise(resolve => { finished = resolve; });
      const url = mutation ? updateUrl : `${config.origin}${directoryPath}`;
      await page.route(url, async route => {
        const response = await route.fetch(); started(); await gate;
        try { await route.fulfill({ response }); } catch (error) { if (!error.message.includes('Route is already handled')) throw error; }
        finally { finished(); }
      }, { times: 1 });
      if (mutation) {
        await row(currentName).getByLabel('Nazwa kontrahenta', { exact: true }).fill(`Spóźniona nazwa ${mode}`);
        await row(currentName).getByRole('button', { name: 'Zapisz kontrahenta', exact: true }).click();
      } else await directory.getByRole('button', { name: 'Wczytaj kontrahentów ponownie', exact: true }).click();
      await intercepted; await page.locator('#active-organization').selectOption(companyB);
      await page.getByText('Brak dostępnych projektów.', { exact: false }).waitFor(); release(); await delivered; await page.unroute(url);
      assert.equal(await page.locator('.contractors').count(), 0); assert.equal(await page.getByText(`Spóźniona nazwa ${mode}`, { exact: true }).count(), 0);
      if (!mutation) { await page.locator('#active-organization').selectOption(companyA); await row(currentName).waitFor(); }
    }
    await context.close();
    const worker = await open('worker', mobile);
    await worker.page.getByRole('button', { name: /Projekt Alfa Aktywny Kontrahent: Klient Alfa/ }).waitFor();
    assert.equal(await worker.page.locator('.contractors, .project-form').count(), 0);
    assert.equal(await worker.page.getByText('Poufny klient innego projektu', { exact: true }).count(), 0);
    assert.equal(await worker.page.getByText('Poufny katalog bez projektów', { exact: true }).count(), 0);
    assert.equal(await worker.page.locator('.project-choice').count(), 2);
    await worker.page.getByLabel('Filtruj projekty po kontrahencie', { exact: true }).selectOption(one.id); assert.equal(await worker.page.locator('.project-choice').count(), 1);
    await worker.page.getByRole('button', { name: /Projekt Alfa Aktywny Kontrahent: Klient Alfa/ }).click();
    await worker.page.getByText('Własne zadanie Projekt Alfa', { exact: true }).waitFor(); assert.equal(await worker.page.locator('.task-row').count(), 1);
    await worker.page.getByRole('button', { name: mobile ? 'Zgłoś do odbioru' : 'Rozpocznij zadanie', exact: true }).click();
    await worker.page.getByText(mobile ? 'Serwer potwierdził zgłoszenie do odbioru.' : 'Serwer potwierdził rozpoczęcie zadania.', { exact: true }).waitFor();
    await worker.page.getByLabel('Filtruj projekty po kontrahencie', { exact: true }).selectOption(two.id);
    await worker.page.getByRole('button', { name: /Projekt Beta Aktywny Kontrahent: Klient Beta/ }).click(); await worker.page.getByText('Własne zadanie Projekt Beta', { exact: true }).waitFor();
    assert.equal(await worker.page.locator('.task-row').count(), 1);
    await worker.page.locator('#active-organization').selectOption(companyB); await worker.page.getByRole('button', { name: /Projekt obcej firmy Aktywny Kontrahent: Klient Alfa/ }).waitFor();
    assert.equal(await worker.page.getByText('Własne zadanie Projekt Beta', { exact: true }).count(), 0); assert.equal(worker.directoryRequests.length, 0);
    assert(await worker.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await worker.context.close();
    const foreman = await open('foreman', mobile);
    await foreman.page.getByRole('button', { name: /Projekt Alfa Aktywny Kontrahent: Klient Alfa/ }).click(); await foreman.page.locator('.task-row').filter({ hasText: 'Cudze zadanie kierownika' }).waitFor();
    assert.equal(await foreman.page.locator('.task-row').count(), 2); assert.equal(await foreman.page.locator('.contractors, .project-form, .task-form').count(), 0);
    await foreman.context.close();
    console.log(`PASS ${mode}: contractor create/edit, recoverable error/conflict draft, activation/history, project link/change/unlink/filter, delayed directory/write across organizations, worker multi-project progress and foreman metadata, no directory access or overflow`);
  }
  assert.deepEqual(errors, []); assert.deepEqual(cspErrors, []); console.log('PASS contractor browser runtime/CSP regressions');
} finally {
  await browser?.close(); await app?.close(); await runtime.end(); await owner.end();
  try { await admin.query(`DROP SCHEMA ${schema} CASCADE`); } finally { await admin.end(); }
}
