// Disposable online M07 UI smoke, using the same real owner/runtime databases as CI.
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { buildApp } from '../apps/server/src/app.ts';
import { migrate } from '../apps/server/src/migrations.ts';
import { readConfig } from '../apps/server/src/config.ts';
import { hashPassword } from '../apps/server/src/auth/password.ts';
const { chromium } = await import(process.env.SITEGRID_PLAYWRIGHT_MODULE ? pathToFileURL(process.env.SITEGRID_PLAYWRIGHT_MODULE).href : 'playwright');
assert(process.env.TEST_DATABASE_URL && process.env.TEST_RUNTIME_DATABASE_URL);
const schema = `projects_browser_${randomBytes(6).toString('hex')}`;
const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
const ownerUrl = new URL(process.env.TEST_DATABASE_URL); ownerUrl.searchParams.set('options', `-c search_path=${schema}`);
const owner = new pg.Pool({ connectionString: ownerUrl.href });
const runtimeUrl = new URL(process.env.TEST_RUNTIME_DATABASE_URL); runtimeUrl.searchParams.set('options', `-c search_path=${schema}`);
const runtime = new pg.Pool({ connectionString: runtimeUrl.href });
const config = readConfig({ NODE_ENV: 'test', DATABASE_URL: runtimeUrl.href });
const companyA = randomUUID(), companyB = randomUUID(), password = randomBytes(24).toString('base64url');
const members = {}, users = {}, errors = [], cspErrors = [];
let app, browser;
await admin.query(`CREATE SCHEMA ${schema}`);
try {
  await migrate(owner, 'migrations');
  await owner.query(`GRANT USAGE ON SCHEMA ${schema} TO sitegrid`);
  await owner.query('GRANT SELECT ON installation, schema_migrations, users, credentials, platform_admins TO sitegrid');
  await owner.query('GRANT SELECT, INSERT, DELETE ON sessions TO sitegrid');
  await owner.query('GRANT SELECT, INSERT, UPDATE, DELETE ON auth_rate_limits TO sitegrid');
  for (const [id, name] of [[companyA, 'Firma A'], [companyB, 'Firma B']]) await owner.query('INSERT INTO organizations(id, name) VALUES ($1, $2)', [id, name]);
  const hash = await hashPassword(password);
  for (const [name, displayName, roles] of [['dual', 'Kierownik A', ['organization_admin', 'manager']], ['worker', 'Monter A', ['worker']], ['foreman', 'Brygadzista A', ['foreman']], ['adminOnly', 'Administrator A', ['organization_admin']]]) {
    users[name] = randomUUID(); members[name] = randomUUID();
    await owner.query('INSERT INTO users(id, email) VALUES ($1, $2)', [users[name], `${name.toLowerCase()}@example.test`]);
    await owner.query('INSERT INTO credentials(user_id, password_hash) VALUES ($1, $2)', [users[name], hash]);
    await owner.query("INSERT INTO organization_memberships(organization_id, id, user_id, status) VALUES ($1, $2, $3, 'active')", [companyA, members[name], users[name]]);
    await owner.query('INSERT INTO employee_profiles(organization_id, membership_id, display_name) VALUES ($1, $2, $3)', [companyA, members[name], displayName]);
    for (const role of roles) await owner.query('INSERT INTO membership_roles(organization_id, membership_id, role) VALUES ($1, $2, $3)', [companyA, members[name], role]);
  }
  const memberB = randomUUID();
  await owner.query("INSERT INTO organization_memberships(organization_id, id, user_id, status) VALUES ($1, $2, $3, 'active')", [companyB, memberB, users.dual]);
  await owner.query("INSERT INTO membership_roles(organization_id, membership_id, role) VALUES ($1, $2, 'worker')", [companyB, memberB]);
  const raw = randomBytes(32).toString('base64url'), csrf = randomBytes(32).toString('base64url');
  await owner.query("INSERT INTO sessions(token_hash, user_id, csrf_token, expires_at) VALUES ($1, $2, $3, now() + interval '1 hour')", [createHash('sha256').update(raw).digest('hex'), users.dual, csrf]);
  app = await buildApp(config, runtime, { serveWeb: true }); config.origin = await app.listen({ port: 0, host: '127.0.0.1' });
  const headers = { cookie: `sitegrid=${raw}`, origin: config.origin, 'x-csrf-token': csrf };
  const api = async (url, payload) => {
    const result = await app.inject({ url, headers, ...(payload ? { method: 'POST', payload } : {}) });
    assert(result.statusCode < 300, result.body); return result.json();
  };
  await api(`/api/organizations/${companyA}/projects`, { name: 'Projekt istniejący' });
  let releaseInitialList, initialListFetched, initialListFinished;
  const initialListGate = new Promise(resolve => { releaseInitialList = resolve; });
  const initialListSnapshot = new Promise(resolve => { initialListFetched = resolve; });
  const initialListDelivery = new Promise(resolve => { initialListFinished = resolve; });
  browser = await chromium.launch({ headless: true, ...(process.env.SITEGRID_CHROMIUM_PATH ? { executablePath: process.env.SITEGRID_CHROMIUM_PATH } : {}) });
  const login = async (actor, mobile = false) => {
    const context = await browser.newContext({ serviceWorkers: 'block', viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 } });
    const page = await context.newPage();
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', msg => { if (msg.text().includes('Content Security Policy')) cspErrors.push(msg.text()); });
    await page.goto(config.origin); await page.locator('#email').fill(`${actor.toLowerCase()}@example.test`); await page.locator('#password').fill(password);
    await page.getByRole('button', { name: 'Zaloguj się', exact: true }).click();
    if (actor === 'dual') await page.route(`${config.origin}/api/organizations/${companyA}/projects`, async route => {
      const response = await route.fetch();
      assert.deepEqual((await response.json()).projects.map(project => project.name), ['Projekt istniejący']);
      initialListFetched(); await initialListGate;
      await route.fulfill({ response }); initialListFinished();
    }, { times: 1 });
    await page.locator('#active-organization').selectOption(companyA); await page.locator('.projects').waitFor();
    return { context, page };
  };
  const { context, page } = await login('dual');
  const projects = page.locator('.projects'), details = projects.locator('.project-details');
  await initialListSnapshot;
  await projects.getByText('Ładowanie projektów…', { exact: true }).waitFor();
  const creation = projects.locator('.project-form').last();
  await creation.getByLabel('Nazwa projektu', { exact: true }).fill('Budowa A'); await creation.getByLabel('Opis projektu (opcjonalnie)').fill('Prace montażowe');
  await creation.getByRole('button', { name: 'Utwórz projekt', exact: true }).click();
  await details.getByRole('heading', { name: 'Budowa A', exact: true }).waitFor();
  const createdChoice = projects.getByRole('button', { name: 'Budowa A Aktywny', exact: true });
  assert.equal(await createdChoice.getAttribute('aria-pressed'), 'true');
  assert.equal(await projects.getByText('Ładowanie projektów…', { exact: true }).count(), 0);
  releaseInitialList(); await initialListDelivery;
  // Seeing the old snapshot's row proves the released GET has reached React state.
  await projects.getByRole('button', { name: 'Projekt istniejący Aktywny', exact: true }).waitFor();
  assert(await createdChoice.isVisible(), 'The stale initial GET must preserve the newly created project');
  assert.equal(await createdChoice.getAttribute('aria-pressed'), 'true', 'The created project must remain selected');
  assert.equal(await projects.locator('.project-choice').count(), 2);
  console.log('PASS regression: delayed initial project GET preserves creation, selection and existing projects');
  assert.equal(await details.locator('.task-form').count(), 0, 'Manager role alone must not grant project access');
  const projectA = (await api(`/api/organizations/${companyA}/projects`)).projects[0].id;
  const projectPath = `/api/organizations/${companyA}/projects/${projectA}`;
  for (const displayName of ['Kierownik A', 'Monter A', 'Brygadzista A']) {
    await details.getByRole('button', { name: `Przydziel: ${displayName}`, exact: true }).click();
    await details.getByRole('button', { name: `Odbierz przydział: ${displayName}`, exact: true }).waitFor();
  }
  const taskForm = details.locator('.task-form');
  await taskForm.getByLabel('Tytuł zadania', { exact: true }).fill('Drzwi pracownika');
  await taskForm.getByLabel('Opis zadania (opcjonalnie)').fill('Zamontuj drzwi'); await taskForm.getByLabel('Wykonawca', { exact: true }).selectOption(members.worker);
  await taskForm.getByRole('button', { name: 'Utwórz zadanie', exact: true }).click();
  await details.locator('.task-row').filter({ hasText: 'Drzwi pracownika' }).waitFor();
  await taskForm.getByLabel('Tytuł zadania', { exact: true }).fill('Własne kierownika'); await taskForm.getByLabel('Wykonawca', { exact: true }).selectOption(members.dual);
  await taskForm.getByRole('button', { name: 'Utwórz zadanie', exact: true }).click();
  await details.locator('.task-row').filter({ hasText: 'Własne kierownika' }).waitFor();
  assert.equal(await details.locator('.task-row').count(), 2);
  console.log('PASS desktop: project creation, explicit memberships, task creation and assignee selection');
  // Conflicts retain a draft until the user explicitly reloads.
  await details.locator('.task-row').filter({ hasText: 'Drzwi pracownika' }).getByRole('button', { name: 'Edytuj zadanie', exact: true }).click();
  await taskForm.getByLabel('Tytuł zadania', { exact: true }).fill('Lokalny szkic');
  const task = (await api(`${projectPath}/tasks`)).tasks.find(task => task.title === 'Drzwi pracownika');
  await api(`${projectPath}/tasks/${task.id}/update`, { title: 'Z innej karty', description: task.description, assigneeMembershipId: members.worker, expectedVersion: task.version });
  await taskForm.getByRole('button', { name: 'Zapisz zadanie', exact: true }).click();
  await details.getByRole('alert').filter({ hasText: 'Rekord zmienił się' }).waitFor();
  assert.equal(await taskForm.getByLabel('Tytuł zadania', { exact: true }).inputValue(), 'Lokalny szkic');
  await details.getByRole('button', { name: 'Wczytaj aktualne dane', exact: true }).click();
  await details.locator('.task-row').filter({ hasText: 'Z innej karty' }).waitFor();
  assert.equal(await taskForm.getByLabel('Tytuł zadania', { exact: true }).inputValue(), '');
  await details.locator('.task-row').filter({ hasText: 'Z innej karty' }).getByRole('button', { name: 'Edytuj zadanie', exact: true }).click();
  await taskForm.getByLabel('Wykonawca', { exact: true }).selectOption(members.dual); await taskForm.getByRole('button', { name: 'Zapisz zadanie', exact: true }).click();
  await page.waitForFunction(() => [...document.querySelectorAll('.task-row')].find(row => row.textContent.includes('Z innej karty'))?.textContent.includes('Kierownik A'));
  let changedTask = (await api(`${projectPath}/tasks`)).tasks.find(row => row.id === task.id);
  await api(`${projectPath}/tasks/${task.id}/update`, { title: 'Z innej karty', description: task.description, assigneeMembershipId: members.worker, expectedVersion: changedTask.version });
  await details.getByRole('button', { name: 'Wczytaj aktualne dane', exact: true }).click();
  await page.waitForFunction(() => [...document.querySelectorAll('.task-row')].find(row => row.textContent.includes('Z innej karty'))?.textContent.includes('Monter A'));
  console.log('PASS task editing/reassignment and optimistic conflict draft retention');
  // Add a second project and prove empty/error/loading views and late response isolation.
  const second = (await api(`/api/organizations/${companyA}/projects`, { name: 'Budowa druga' })).project;
  await projects.getByRole('button', { name: 'Odśwież projekty', exact: true }).click();
  await projects.getByRole('button', { name: 'Budowa druga Aktywny', exact: true }).waitFor();
  assert.equal(await projects.locator('.project-choice[aria-pressed="true"]').count(), 0, 'Manual refresh clears selection');
  assert.equal(await details.count(), 0);
  assert.equal(await projects.locator('.project-choice').count(), 3, 'Manual refresh reloads the full server list');
  await projects.getByRole('button', { name: 'Budowa druga Aktywny', exact: true }).click();
  await details.getByRole('heading', { name: 'Budowa druga', exact: true }).waitFor();
  await details.getByRole('button', { name: 'Przydziel: Kierownik A', exact: true }).click();
  await details.getByText('Brak zadań w Twoim zakresie.', { exact: true }).waitFor();
  const taskUrl = `${config.origin}${projectPath}/tasks`;
  await page.route(taskUrl, route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Testowy błąd połączenia.' }) }));
  await projects.getByRole('button', { name: 'Budowa A Aktywny', exact: true }).click();
  await details.getByRole('alert').filter({ hasText: 'Testowy błąd' }).waitFor(); assert.equal(await details.locator('.task-row').count(), 0);
  await page.unroute(taskUrl); await details.getByRole('button', { name: 'Wczytaj aktualne dane', exact: true }).click();
  await details.locator('.task-row').filter({ hasText: 'Z innej karty' }).waitFor();
  let release, started, settled;
  const finished = new Promise(resolve => { settled = resolve; });
  const gate = new Promise(resolve => { release = resolve; }), intercepted = new Promise(resolve => { started = resolve; });
  await page.route(taskUrl, async route => {
    const response = await route.fetch(); started(); await gate;
    try { await route.fulfill({ response }); }
    catch (error) { if (!error.message.includes('Route is already handled')) throw error; }
    finally { settled(); }
  });
  await details.getByRole('button', { name: 'Wczytaj aktualne dane', exact: true }).click(); await intercepted;
  await details.getByText('Ładowanie projektu i zadań…', { exact: true }).waitFor();
  await projects.getByRole('button', { name: 'Budowa druga Aktywny', exact: true }).click();
  await details.getByRole('heading', { name: 'Budowa druga', exact: true }).waitFor(); release(); await finished; await page.unroute(taskUrl);
  assert.equal(await details.locator('.task-row').count(), 0);
  await page.locator('#active-organization').selectOption(companyB);
  await projects.getByText('Brak dostępnych projektów.', { exact: false }).waitFor(); assert.equal(await projects.locator('.task-row').count(), 0); assert.equal(await projects.locator('.project-form').count(), 0);
  console.log('PASS loading/empty/error/retry and delayed responses across projects and companies');
  await context.close();
  const mobile = await login('worker', true);
  await mobile.page.locator('.projects').getByRole('button', { name: 'Budowa A Aktywny', exact: true }).click();
  await mobile.page.locator('.task-row').filter({ hasText: 'Z innej karty' }).waitFor();
  assert.equal(await mobile.page.locator('.task-row').count(), 1); assert.equal(await mobile.page.locator('.task-form').count(), 0);
  assert.equal(await mobile.page.locator('.project-roster').count(), 0); assert.equal(await mobile.page.getByRole('button', { name: 'Edytuj zadanie', exact: true }).count(), 0);
  assert(await mobile.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'Mobile must not overflow horizontally');
  await mobile.page.screenshot({ path: '/tmp/sitegrid-pr12-worker-mobile.png', fullPage: true }); await mobile.context.close();
  const foreman = await login('foreman'); await foreman.page.locator('.projects').getByRole('button', { name: 'Budowa A Aktywny', exact: true }).click();
  await foreman.page.locator('.task-row').filter({ hasText: 'Z innej karty' }).waitFor(); assert.equal(await foreman.page.locator('.task-row').count(), 2); assert.equal(await foreman.page.locator('.task-form').count(), 0); await foreman.context.close();
  const adminOnly = await login('adminOnly', true); await adminOnly.page.locator('.projects').getByRole('button', { name: 'Budowa A Aktywny', exact: true }).click();
  await adminOnly.page.locator('.project-details').getByText('Dostęp do zadań wymaga', { exact: false }).waitFor(); assert.equal(await adminOnly.page.locator('.task-row').count(), 0);
  assert(await adminOnly.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await adminOnly.page.screenshot({ path: '/tmp/sitegrid-pr12-admin-mobile.png', fullPage: true });
  const version = (await api(projectPath)).project.version;
  await adminOnly.page.getByRole('button', { name: 'Archiwizuj projekt', exact: true }).click();
  await adminOnly.page.getByText('Projekt archiwalny', { exact: false }).waitFor(); assert.equal((await api(projectPath)).project.version, version + 1);
  await adminOnly.context.close();
  console.log('PASS mobile worker scope, foreman read scope, admin metadata-only scope and archive');
  assert.deepEqual(errors, []); assert.deepEqual(cspErrors, []);
  console.log('PASS no browser runtime or CSP errors');
} finally {
  await browser?.close(); await app?.close(); await runtime.end(); await owner.end();
  try { await admin.query(`DROP SCHEMA ${schema} CASCADE`); } finally { await admin.end(); }
}
