// PR18 workspace navigation and draft safety, using disposable PostgreSQL + runtime RLS.
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { buildApp } from '../apps/server/src/app.ts';
import { migrate } from '../apps/server/src/migrations.ts';
import { readConfig } from '../apps/server/src/config.ts';
import { navigateWorkspace, selectCompany, assertMainLandmark } from './helpers/workspace-browser.mjs';
const { chromium } = await import(process.env.SITEGRID_PLAYWRIGHT_MODULE ? pathToFileURL(process.env.SITEGRID_PLAYWRIGHT_MODULE).href : 'playwright');
assert(process.env.TEST_DATABASE_URL && process.env.TEST_RUNTIME_DATABASE_URL);
const schema = `workspace_browser_${randomBytes(6).toString('hex')}`;
const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
const ownerUrl = new URL(process.env.TEST_DATABASE_URL), runtimeUrl = new URL(process.env.TEST_RUNTIME_DATABASE_URL);
for (const url of [ownerUrl, runtimeUrl]) url.searchParams.set('options', `-c search_path=${schema}`);
const owner = new pg.Pool({ connectionString: ownerUrl.href }), runtime = new pg.Pool({ connectionString: runtimeUrl.href });
const config = readConfig({ NODE_ENV: 'test', DATABASE_URL: runtimeUrl.href });
const companyA = randomUUID(), companyB = randomUUID(), actors = {}, errors = [], cspErrors = [];
let app, browser;
await admin.query(`CREATE SCHEMA ${schema}`);
try {
  await migrate(owner, 'migrations'); await owner.query(`GRANT USAGE ON SCHEMA ${schema} TO sitegrid`);
  await owner.query('GRANT SELECT ON installation, schema_migrations, users, credentials, platform_admins TO sitegrid');
  await owner.query('GRANT SELECT, INSERT, DELETE ON sessions TO sitegrid');
  await owner.query('GRANT SELECT, INSERT, UPDATE, DELETE ON auth_rate_limits TO sitegrid');
  for (const [id, name] of [[companyA, 'Nordbud · Realizacja'], [companyB, 'Nordbud · Serwis']]) await owner.query('INSERT INTO organizations(id,name) VALUES($1,$2)', [id,name]);
  for (const [name, roles, platform] of [['admin', ['organization_admin','manager'], false], ['worker', ['worker'], false], ['platform', [], true], ['both', ['organization_admin'], true]]) {
    const actor = actors[name] = { id: randomUUID(), membership: randomUUID(), token: randomBytes(32).toString('base64url'), csrf: randomBytes(32).toString('base64url') };
    await owner.query('INSERT INTO users(id,email) VALUES($1,$2)', [actor.id, `${name}@example.test`]);
    await owner.query("INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')", [createHash('sha256').update(actor.token).digest('hex'),actor.id,actor.csrf]);
    if (platform) await owner.query('INSERT INTO platform_admins(user_id) VALUES($1)', [actor.id]);
    if (roles.length) {
      await owner.query("INSERT INTO organization_memberships(organization_id,id,user_id,status) VALUES($1,$2,$3,'active')", [companyA,actor.membership,actor.id]);
      for (const role of roles) await owner.query('INSERT INTO membership_roles(organization_id,membership_id,role) VALUES($1,$2,$3)', [companyA,actor.membership,role]);
      await owner.query('INSERT INTO employee_profiles(organization_id,membership_id,display_name) VALUES($1,$2,$3)', [companyA,actor.membership,name === 'worker' ? 'Piotr Nowak' : 'Anna Kowalska']);
    }
  }
  const secondMembership = randomUUID();
  await owner.query("INSERT INTO organization_memberships(organization_id,id,user_id,status) VALUES($1,$2,$3,'active')", [companyB,secondMembership,actors.admin.id]);
  await owner.query("INSERT INTO membership_roles(organization_id,membership_id,role) VALUES($1,$2,'worker')", [companyB,secondMembership]);
  app = await buildApp(config, runtime, { serveWeb: true }); config.origin = await app.listen({ port: 0, host: '127.0.0.1' });
  const api = async (url, payload) => {
    const actor = actors.admin;
    const response = await app.inject({ url, method: 'POST', payload, headers: { cookie: `sitegrid=${actor.token}`, origin: config.origin, 'x-csrf-token': actor.csrf } });
    assert.equal(response.statusCode, 201, response.body); return response.json();
  };
  const path = `/api/organizations/${companyA}`;
  const contractor = (await api(`${path}/contractors`, { name: 'Mostostal Partner' })).contractor;
  const project = (await api(`${path}/projects`, { name: 'Hala produkcyjna · Etap II', description: 'Montaż konstrukcji i przygotowanie instalacji.', contractorId: contractor.id })).project;
  await api(`${path}/projects`, { name: 'Modernizacja biurowca' });
  for (const actor of [actors.admin, actors.worker]) {
    const response = await app.inject({ url: `${path}/projects/${project.id}/members/${actor.membership}`, method: 'POST', payload: { status: 'active', expectedVersion: 0 }, headers: { cookie: `sitegrid=${actors.admin.token}`, origin: config.origin, 'x-csrf-token': actors.admin.csrf } });
    assert.equal(response.statusCode, 200, response.body);
  }
  await api(`${path}/projects/${project.id}/tasks`, { title: 'Montaż drzwi technicznych', description: 'Sprawdź wymiary i zamontuj drzwi w strefie B.', assigneeMembershipId: actors.worker.membership });
  browser = await chromium.launch({ headless: true, ...(process.env.SITEGRID_CHROMIUM_PATH ? { executablePath: process.env.SITEGRID_CHROMIUM_PATH } : {}) });
  await mkdir('/tmp/sitegrid-pr18-visuals', { recursive: true });
  const open = async (name, width) => {
    const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width, height: 900 } });
    await context.addCookies([{ name: 'sitegrid', value: actors[name].token, url: config.origin, httpOnly: true, sameSite: 'Strict' }]);
    const page = await context.newPage(), requests = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.text().includes('Content Security Policy')) cspErrors.push(message.text()); });
    page.on('request', request => requests.push(new URL(request.url()).pathname));
    await page.goto(config.origin); await page.locator('.workspace').waitFor();
    return { page, context, requests };
  };
  const noOverflow = async page => assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Workspace must fit viewport');
  for (const width of [1280, 768, 390]) {
    const { page, context, requests } = await open('admin', width);
    await page.locator('#active-organization').waitFor({ state: 'attached' });
    assert.equal(await page.locator('#active-organization').inputValue(), '', 'Multiple companies need an explicit choice');
    assert.equal(await page.locator('select#active-organization').count(), 1);
    await selectCompany(page, companyA, 'Pulpit');
    await page.locator('.work-dashboard [data-summary-total]').filter({hasText:'1'}).waitFor();
    assert.equal(await page.locator('.task-workspace').count(), 0);
    await assertMainLandmark(page, 'Pulpit');
    await noOverflow(page);
    assert.equal(await page.getByRole('navigation', { includeHidden: true }).getByRole('button', { name: 'Pulpit', exact: true, includeHidden: true }).getAttribute('aria-current'), 'page');
    if (width < 901) {
      const toggle = page.getByRole('button', { name: 'Otwórz nawigację', exact: true });
      await toggle.focus(); await page.keyboard.press('Enter');
      assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
      await page.locator('#active-organization').focus(); await page.keyboard.press('Escape');
      assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
      assert(await toggle.evaluate(element => element === document.activeElement));
    } else {
      const projectsButton = page.getByRole('navigation').getByRole('button', { name: 'Projekty', exact: true });
      await projectsButton.focus(); await page.keyboard.press('Enter');
      await page.waitForFunction(() => document.activeElement === document.querySelector('#workspace-content h1'));
      await navigateWorkspace(page, 'Pulpit');
    }
    if (width !== 768) await page.screenshot({ path: `/tmp/sitegrid-pr18-visuals/dashboard-${width}.png`, fullPage: true });
    await navigateWorkspace(page, 'Projekty');
    assert.equal(await page.locator('.project-form, .task-form').count(), 0, 'Forms open only on request');
    assert.equal(await page.locator('.contractors').count(), 0, 'Directory has its own section');
    await page.getByRole('button', { name: 'Nowy projekt', exact: true }).click();
    await page.getByLabel('Nazwa projektu', { exact: true }).fill('Niezapisana budowa');
    await navigateWorkspace(page, 'Kontrahenci'); await page.locator('.contractors').waitFor();
    assert(!await page.locator('.projects').isVisible());
    assert.equal(requests.filter(url => url === `${path}/contractors`).length, 1, 'Projects and contractors share one hook request');
    await navigateWorkspace(page, 'Pracownicy'); await page.getByRole('heading', { name: 'Profile pracowników bez konta', exact: true }).waitFor();
    assert(await page.getByText('Nie tworzy konta logowania.', { exact: false }).isVisible());
    await navigateWorkspace(page, 'Projekty');
    assert.equal(await page.getByLabel('Nazwa projektu', { exact: true }).inputValue(), 'Niezapisana budowa');
    const choice = page.locator('.project-choice').filter({ hasText: project.name });
    page.once('dialog', async dialog => { assert.equal(dialog.type(), 'confirm'); await dialog.dismiss(); });
    await choice.click(); assert.equal(await page.locator('.project-details').count(), 0, 'Cancelled navigation preserves draft');
    page.once('dialog', async dialog => { assert.equal(dialog.type(), 'confirm'); await dialog.dismiss(); });
    await selectCompany(page, companyB);
    assert.equal(await page.locator('#active-organization').inputValue(), companyA, 'Cancelled company switch retains context');
    assert.equal(await page.getByLabel('Nazwa projektu', { exact: true }).inputValue(), 'Niezapisana budowa');
    page.once('dialog', async dialog => { assert.equal(dialog.type(), 'confirm'); await dialog.dismiss(); });
    await page.getByRole('button', { name: 'Wyloguj się', exact: true }).click();
    assert(await page.locator('.workspace').isVisible(), 'Cancelled logout retains the session and draft');
    page.once('dialog', async dialog => { assert.equal(dialog.type(), 'confirm'); await dialog.accept(); });
    await choice.click(); await page.locator('.task-row').waitFor();
    const createForm = page.locator('.projects > .project-form');
    assert.equal(await createForm.count(), 0, 'Accepted project navigation closes the discarded create form');
    await page.getByRole('button', { name: 'Edytuj projekt', exact: true }).click();
    await page.getByLabel('Nazwa projektu', { exact: true }).fill('Szkic edycji projektu');
    page.once('dialog', async dialog => { assert.equal(dialog.type(), 'confirm'); await dialog.dismiss(); });
    await page.getByRole('button', { name: 'Nowy projekt', exact: true }).click();
    assert.equal(await createForm.count(), 0, 'Cancelled create navigation preserves the edit form');
    assert.equal(await page.getByLabel('Nazwa projektu', { exact: true }).inputValue(), 'Szkic edycji projektu');
    page.once('dialog', async dialog => { assert.equal(dialog.type(), 'confirm'); await dialog.accept(); });
    await page.getByRole('button', { name: 'Nowy projekt', exact: true }).click();
    assert.equal(await page.locator('.project-details').count(), 0, 'Create and edit contexts cannot remain open together');
    const assertFreshCreate = async () => {
      assert.equal(await createForm.count(), 1);
      assert.equal(await createForm.getByLabel('Nazwa projektu', { exact: true }).inputValue(), '');
      assert.equal(await createForm.getByLabel('Opis projektu (opcjonalnie)').inputValue(), '');
      assert.equal(await createForm.getByLabel('Kontrahent projektu', { exact: true }).inputValue(), '');
    };
    await assertFreshCreate();
    const filter = page.getByLabel('Filtruj projekty po kontrahencie', { exact: true });
    for (const [name, navigate] of [
      ['filter', () => filter.selectOption('none')],
      ['refresh', () => page.getByRole('button', { name: 'Odśwież projekty', exact: true }).click()],
      ['project', () => choice.click()],
    ]) {
      await createForm.getByLabel('Nazwa projektu', { exact: true }).fill(`Draft ${name}`);
      await createForm.getByLabel('Opis projektu (opcjonalnie)').fill('Zachowany opis');
      await createForm.getByLabel('Kontrahent projektu', { exact: true }).selectOption(contractor.id);
      page.once('dialog', async dialog => { assert.equal(dialog.type(), 'confirm'); await dialog.dismiss(); });
      await navigate();
      assert.equal(await createForm.getByLabel('Nazwa projektu', { exact: true }).inputValue(), `Draft ${name}`);
      assert.equal(await createForm.getByLabel('Opis projektu (opcjonalnie)').inputValue(), 'Zachowany opis');
      assert.equal(await createForm.getByLabel('Kontrahent projektu', { exact: true }).inputValue(), contractor.id);
      assert.equal(await filter.inputValue(), '', 'Cancelled navigation keeps the filter');
      assert.equal(await page.locator('.project-details').count(), 0);
      page.once('dialog', async dialog => { assert.equal(dialog.type(), 'confirm'); await dialog.accept(); });
      await navigate();
      assert.equal(await createForm.count(), 0, `Accepted ${name} navigation closes the discarded create form`);
      if (name === 'filter') { assert.equal(await filter.inputValue(), 'none'); await filter.selectOption(''); }
      if (name === 'project') await page.locator('.task-row').waitFor();
      await choice.waitFor();
      await page.getByRole('button', { name: 'Nowy projekt', exact: true }).click();
      await assertFreshCreate();
    }
    await page.getByRole('button', { name: 'Anuluj formularz projektu', exact: true }).click();
    await choice.click(); await page.locator('.task-row').waitFor();
    assert.equal(await page.locator('.task-form').count(), 0);
    await page.getByRole('button', { name: 'Nowe zadanie', exact: true }).click();
    await page.getByLabel('Tytuł zadania', { exact: true }).fill('Zachowany szkic zadania');
    await navigateWorkspace(page, 'Pulpit'); await navigateWorkspace(page, 'Projekty');
    assert.equal(await page.getByLabel('Tytuł zadania', { exact: true }).inputValue(), 'Zachowany szkic zadania');
    page.once('dialog', async dialog => { assert.equal(dialog.type(), 'confirm'); await dialog.dismiss(); });
    await page.getByRole('button', { name: 'Edytuj projekt', exact: true }).click();
    assert.equal(await page.locator('.project-details .project-form').count(), 0, 'Opening another form cannot discard the task draft without approval');
    assert.equal(await page.getByLabel('Tytuł zadania', { exact: true }).inputValue(), 'Zachowany szkic zadania');
    page.once('dialog', async dialog => { assert.equal(dialog.type(), 'confirm'); await dialog.accept(); });
    await page.getByRole('button', { name: 'Anuluj formularz zadania', exact: true }).click();
    await navigateWorkspace(page, 'Ustawienia firmy');
    await page.getByLabel('Nazwa firmy', { exact: true }).fill('Szkic brandingu');
    await page.getByLabel('Logo firmy', { exact: true }).setInputFiles({ name: 'draft.png', mimeType: 'image/png', buffer: Buffer.from('draft') });
    await navigateWorkspace(page, 'Zaproszenia'); await navigateWorkspace(page, 'Ustawienia firmy');
    assert.equal(await page.getByLabel('Nazwa firmy', { exact: true }).inputValue(), 'Szkic brandingu');
    assert.equal(await page.getByLabel('Logo firmy', { exact: true }).evaluate(input => input.files.length), 1);
    page.once('dialog', async dialog => { assert.equal(dialog.type(), 'confirm'); await dialog.accept(); });
    await selectCompany(page, companyB);
    await page.getByText('Brak dostępnych projektów.', { exact: false }).waitFor();
    assert.equal(await page.locator('.company-branding, .company-members, .task-row').count(), 0, 'Company switch clears previous company state and admin sections');
    await noOverflow(page); await context.close();
    console.log(`PASS ${width}px navigation, dashboard, shared contractor request, worker directory, project/task/branding drafts, accepted/cancelled create draft navigation, exclusive create/edit forms, main landmark and company switching`);
  }
  for (const width of [1280, 390]) {
    const { page, context, requests } = await open('worker', width);
    await page.locator('.company-header h3').getByText('Nordbud · Realizacja', { exact: true }).waitFor();
    assert.equal(await page.locator('#active-organization').inputValue(), companyA, 'One company selects automatically');
    await navigateWorkspace(page, 'Projekty'); await page.locator('.project-choice').waitFor();
    assert.equal(await page.locator('.project-choice').count(), 1, 'Worker sees only assigned projects');
    assert.equal(await page.getByRole('navigation', { includeHidden: true }).getByRole('button', { includeHidden: true }).count(), 3, 'Worker sees dashboard/tasks/projects');
    assert.equal(requests.filter(url => url.endsWith('/contractors')).length, 0);
    await page.locator('.project-choice').click(); await page.locator('.task-row').waitFor();
    await noOverflow(page); await page.screenshot({ path: `/tmp/sitegrid-pr18-visuals/worker-${width}.png`, fullPage: true });
    await context.close();
  }
  const platform = await open('platform', 1280);
  await platform.page.locator('#workspace-content h1').getByText('Administracja platformy', { exact: true }).waitFor();
  await platform.page.getByRole('heading', { name: 'Firmy', exact: true }).waitFor();
  assert.equal(await platform.page.getByRole('navigation').getByRole('button', { name: 'Projekty', exact: true }).count(), 0);
  assert(!platform.requests.some(url => url.endsWith('/projects') || url.endsWith('/contractors')));
  await noOverflow(platform.page); await platform.context.close();
  const both = await open('both', 1280);
  await both.page.locator('#active-organization').waitFor({ state: 'attached' });
  await navigateWorkspace(both.page, 'Pulpit');
  await both.page.getByRole('heading',{name:'Podsumowanie pracy',exact:true}).waitFor();
  await navigateWorkspace(both.page, 'Administracja platformy'); await both.page.getByRole('heading', { name: 'Firmy', exact: true }).waitFor();
  await both.context.close();
  assert.deepEqual(errors, []); assert.deepEqual(cspErrors, []);
  console.log('PASS one-company auto-selection, multi-company explicit selection, worker/project scope, platform-only and combined platform/company roles, no runtime/CSP errors');
} finally {
  await browser?.close(); await app?.close(); await runtime.end(); await owner.end();
  try { await admin.query(`DROP SCHEMA ${schema} CASCADE`); } finally { await admin.end(); }
}
