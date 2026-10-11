import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { selectCompany } from './workspace-browser.mjs';

export async function installTaskListRegressionStorage(app) {
  const source = (await build({ stdin: { contents: "export * from './apps/web/src/storage/indexed-db.ts'; export * from './apps/web/src/storage/offline-access.ts';", resolveDir: process.cwd() }, bundle: true, write: false, format: 'esm', target: 'es2023' })).outputFiles[0].text;
  app.get('/test-task-storage.js', (_request, reply) => reply.type('application/javascript').send(source));
}

export async function runTaskListRegressions(f, browser, page) {
  const base = `/api/organizations/${f.organizations.a}`, prefix = 'Regresja listy';
  const workspace = page => page.locator('.task-workspace');
  const card = (page, title) => page.getByRole('article', { name: title, exact: true });
  const api = async (path, payload) => {
    const result = await f.app.inject({ url: `${base}${path}`, headers: { ...f.headers.manager, origin: f.config.origin }, ...(payload ? { method: 'POST', payload } : {}) });
    assert.equal(result.statusCode, payload ? 201 : 200, result.body); return result.json();
  };
  const waitCount = (page, count) => page.waitForFunction(count => document.querySelectorAll('.company-task').length === count, count);
  const choose = async (name, count) => { await workspace(page).getByRole('button', { name, exact: true }).click(); await waitCount(page, count); };
  const assign = async (title, membershipId) => {
    const task = card(page, title);
    await task.getByRole('button', { name: /^(Przypisz|Zmień wykonawcę)$/ }).click();
    await task.getByLabel('Wykonawca', { exact: true }).selectOption(membershipId ?? '');
    const loaded = page.waitForResponse(response => new URL(response.url()).pathname === `${base}/tasks` && response.status() === 200);
    await task.getByRole('button', { name: 'Zapisz przydział', exact: true }).click(); await (await loaded).finished();
    await page.waitForFunction(() => !document.querySelector('.task-workspace')?.textContent.includes('Ładowanie zadań…'));
  };
  const titles = () => page.locator('.company-task h3').allTextContents();
  const snapshots = () => page.evaluate(async ({ organizationId, projects }) => {
    const storage = await import('/test-task-storage.js'), access = await storage.readOfflineAccess();
    if (!access) return null;
    const records = {};
    for (const projectId of projects) {
      const scope = { accountId: access.accountId, organizationId, projectId }, handle = await storage.openProjectStorage(scope);
      try { records[projectId] = await handle.read(access.generation); } finally { handle.close(); }
    }
    return { scopes: access.scopes.filter(scope => scope.organizationId === organizationId).map(scope => scope.projectId).sort(), records };
  }, { organizationId: f.organizations.a, projects: f.projects });
  const prepare = () => page.evaluate(async ({ organizationId, projects }) => {
    const storage = await import('/test-task-storage.js'), access = await storage.readOfflineAccess();
    if (!access) throw new Error('No verified account');
    for (const projectId of projects) {
      const response = await fetch(`/api/organizations/${organizationId}/projects/${projectId}/snapshot`, { credentials: 'same-origin' });
      if (!response.ok) throw new Error('Snapshot denied');
      const wire = await response.json(), handle = await storage.openProjectStorage(wire.scope);
      try { await storage.registerOfflineScope(wire.scope, access.generation); await handle.replace(wire, access.generation, Date.now()); } finally { handle.close(); }
    }
  }, { organizationId: f.organizations.a, projects: f.projects });

  for (let i = 0; i < 150; i++) await api(`/projects/${f.projects[i % 3]}/tasks`, { title: `${prefix} ${i + 1}` });
  await workspace(page).getByLabel('Szukaj zadań', { exact: true }).fill(prefix);
  await workspace(page).getByRole('button', { name: 'Szukaj', exact: true }).click(); await waitCount(page, 100);
  await choose('Backlog', 100);
  const expected = [...(await api(`/tasks?view=backlog&q=${encodeURIComponent(prefix)}`)).tasks, ...(await api(`/tasks?view=backlog&q=${encodeURIComponent(prefix)}&offset=100`)).tasks];
  await workspace(page).getByRole('button', { name: 'Pokaż więcej zadań', exact: true }).click(); await waitCount(page, 150);
  assert.deepEqual(await titles(), expected.map(task => task.title));
  await prepare(); const beforeRefresh = await snapshots();
  const refreshed = page.waitForResponse(response => new URL(response.url()).pathname === `${base}/tasks`);
  await workspace(page).getByRole('button', { name: 'Wczytaj aktualne zadania', exact: true }).click(); await (await refreshed).finished(); await waitCount(page, 100);
  assert.deepEqual(await snapshots(), beforeRefresh, 'Normal refresh preserves every prepared snapshot');
  await workspace(page).getByRole('button', { name: 'Pokaż więcej zadań', exact: true }).click(); await waitCount(page, 150);
  const changed = expected[0]; await assign(changed.title, f.members.worker); await waitCount(page, 100);
  assert.equal(await card(page, changed.title).count(), 0, 'Assignment removes the active backlog record');
  assert.equal(await workspace(page).getByRole('button', { name: 'Backlog', exact: true }).getAttribute('aria-pressed'), 'true');
  assert.equal(await workspace(page).getByLabel('Szukaj zadań', { exact: true }).inputValue(), prefix);
  const afterAssignment = await snapshots();
  assert.equal(afterAssignment.records[changed.projectId], null, 'Assignment clears its prepared project');
  assert.deepEqual(afterAssignment.scopes, f.projects.filter(id => id !== changed.projectId).sort());
  for (const id of f.projects.filter(id => id !== changed.projectId)) assert.deepEqual(afterAssignment.records[id], beforeRefresh.records[id], 'Other projects retain their exact snapshots');
  await workspace(page).getByRole('button', { name: 'Pokaż więcej zadań', exact: true }).click(); await waitCount(page, 149);
  assert.deepEqual(await titles(), expected.slice(1).map(task => task.title), 'Reset pagination neither skips nor duplicates any of the 149 remaining tasks');
  assert.equal(new Set(await titles()).size, 149);
  assert.equal(await workspace(page).getByRole('button', { name: 'Pokaż więcej zadań', exact: true }).count(), 0);
  console.log('PASS assignment removes backlog task, resets 150-record pagination, preserves query and invalidates only its prepared project; ordinary refresh preserves snapshots');

  await choose('Do zrobienia', 1); await assign(changed.title, null); await waitCount(page, 0);
  await choose('Backlog', 100); await card(page, changed.title).waitFor();
  await assign(changed.title, f.members.worker); await waitCount(page, 100);
  await choose('Wszystkie', 100);
  await workspace(page).getByLabel('Wykonawca', { exact: true }).selectOption(f.members.worker); await waitCount(page, 1);
  await assign(changed.title, f.members.other); await waitCount(page, 0);
  assert.equal(await workspace(page).getByLabel('Wykonawca', { exact: true }).inputValue(), f.members.worker);
  await workspace(page).getByLabel('Wykonawca', { exact: true }).selectOption(f.members.other); await waitCount(page, 1);
  await assign(changed.title, f.members.manager); await waitCount(page, 0);
  await workspace(page).getByLabel('Wykonawca', { exact: true }).selectOption(''); await waitCount(page, 100);
  await choose('Moje', 1); await assign(changed.title, f.members.worker); await waitCount(page, 0);
  await choose('Do zrobienia', 1); await assign(changed.title, f.members.manager); await waitCount(page, 1);
  await workspace(page).getByLabel('Wykonawca', { exact: true }).selectOption(f.members.manager); await waitCount(page, 1);
  await workspace(page).getByLabel('Projekt', { exact: true }).selectOption(changed.projectId); await waitCount(page, 1);
  await prepare(); const beforeStatus = await snapshots();
  await assign(changed.title, f.members.manager); await waitCount(page, 1);
  assert.deepEqual(await snapshots(), beforeStatus, 'No-op assignment preserves prepared snapshots');
  await card(page, changed.title).getByRole('button', { name: 'Rozpocznij zadanie', exact: true }).click(); await waitCount(page, 0);
  assert.deepEqual(await snapshots(), beforeStatus, 'Status refresh preserves prepared snapshots');
  await choose('W toku', 1);
  await card(page, changed.title).getByRole('button', { name: 'Zgłoś do odbioru', exact: true }).click(); await waitCount(page, 0);
  await choose('Do odbioru', 1); await card(page, changed.title).getByText('Do odbioru', { exact: true }).waitFor();
  assert.equal(await workspace(page).getByLabel('Szukaj zadań', { exact: true }).inputValue(), prefix);
  assert.equal(await workspace(page).getByLabel('Wykonawca', { exact: true }).inputValue(), f.members.manager);
  assert.equal(await workspace(page).getByLabel('Projekt', { exact: true }).inputValue(), changed.projectId);
  assert.deepEqual(await snapshots(), beforeStatus);
  console.log('PASS unassignment leaves todo and returns to backlog, assignee/mine filters update after reassignment, and M08 start/submit refresh status filters without clearing snapshots');

  let release, started, finished;
  const held = new Promise(resolve => { release = resolve; }), requested = new Promise(resolve => { started = resolve; }), delivered = new Promise(resolve => { finished = resolve; });
  const delayed = async route => {
    if (new URL(route.request().url()).searchParams.get('view') !== 'backlog') return route.continue();
    const response = await route.fetch(); started(); await held; await route.fulfill({ response }).catch(() => {}).finally(finished);
  };
  await page.route(`${f.config.origin}${base}/tasks?*`, delayed);
  await workspace(page).getByRole('button', { name: 'Backlog', exact: true }).click(); await requested;
  await choose('Do odbioru', 1); release(); await delivered; await page.unroute(`${f.config.origin}${base}/tasks?*`, delayed);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.deepEqual(await titles(), [changed.title], 'Late response of an obsolete empty query cannot overwrite the current submitted task');

  // An ambiguous command in another card must retain its original operation ID.
  const pendingTitles = ['Regresja M08 pierwsze', 'Regresja M08 drugie'];
  for (const title of pendingTitles) await api(`/projects/${f.projects[0]}/tasks`, { title, assigneeMembershipId: f.members.manager });
  const context = await browser.newContext({ serviceWorkers: 'block' });
  await context.addCookies([{ name: 'sitegrid', value: f.tokens.manager, url: f.config.origin, httpOnly: true, sameSite: 'Strict' }]);
  const pendingPage = await context.newPage(), dialogs = [], commands = [], pendingErrors = [];
  pendingPage.on('pageerror', error => pendingErrors.push(error.message));
  pendingPage.on('dialog', dialog => { dialogs.push(dialog.type()); return dialog.accept(); });
  await pendingPage.clock.install(); await pendingPage.clock.pauseAt(new Date(Date.now() + 60_000));
  await pendingPage.goto(f.config.origin); await selectCompany(pendingPage, f.organizations.a, 'Zadania');
  await workspace(pendingPage).getByLabel('Szukaj zadań', { exact: true }).fill('Regresja M08');
  await workspace(pendingPage).getByRole('button', { name: 'Szukaj', exact: true }).click(); await waitCount(pendingPage, 2);
  const firstId = (await api('/tasks?q=Regresja%20M08')).tasks.find(task => task.title === pendingTitles[0]).id;
  let dropped = false, listReads = 0;
  pendingPage.on('request', request => { if (new URL(request.url()).pathname === `${base}/tasks`) listReads++; });
  await pendingPage.route('**/commands', async route => {
    if (!route.request().url().includes(firstId)) return route.continue();
    commands.push(route.request().postDataJSON());
    if (!dropped) { dropped = true; const response = await route.fetch(); assert.equal(response.status(), 200); return route.abort('failed'); }
    return route.continue();
  });
  await card(pendingPage, pendingTitles[0]).getByRole('button', { name: 'Rozpocznij zadanie', exact: true }).click();
  await card(pendingPage, pendingTitles[0]).getByRole('button', { name: 'Ponów operację', exact: true }).waitFor();
  await card(pendingPage, pendingTitles[1]).getByRole('button', { name: 'Rozpocznij zadanie', exact: true }).click();
  await workspace(pendingPage).getByText('Serwer potwierdził rozpoczęcie zadania.', { exact: true }).first().waitFor();
  assert.equal(listReads, 0, 'Confirmed other card defers list replacement while an M08 result remains ambiguous');
  const background = pendingPage.waitForResponse(response => new URL(response.url()).pathname === `${base}/tasks`);
  await pendingPage.clock.runFor(15_000); await (await background).finished();
  assert.equal(listReads, 1, 'Polling continues while reconciliation preserves the unresolved M08 component');
  assert(await card(pendingPage, pendingTitles[0]).getByRole('button', { name: 'Ponów operację', exact: true }).isVisible());
  await workspace(pendingPage).getByRole('button', { name: 'Wczytaj aktualne zadania', exact: true }).click();
  assert.deepEqual(dialogs, ['alert']); assert.equal(listReads, 1);
  const reconciled = pendingPage.waitForResponse(response => new URL(response.url()).pathname === `${base}/tasks`);
  await card(pendingPage, pendingTitles[0]).getByRole('button', { name: 'Ponów operację', exact: true }).click();
  await (await reconciled).finished();
  await pendingPage.waitForFunction(() => document.querySelectorAll('.company-task .task-progress .status-badge').length === 2 && [...document.querySelectorAll('.company-task .task-progress .status-badge')].every(item => item.textContent.includes('W toku')));
  assert.deepEqual(commands[0], commands[1], 'Retry preserves the exact M08 command and operation ID'); assert.equal(listReads, 2);
  assert.deepEqual(pendingErrors, []); await context.close();
  console.log('PASS obsolete query response rejected and simultaneous M08 confirmation preserves an ambiguous command until exact receipt replay');

  // A real SQL-backed permission revocation must still deny company offline data.
  await prepare();
  await f.owner.query("DELETE FROM membership_roles WHERE organization_id=$1 AND membership_id=$2 AND role='manager'", [f.organizations.a, f.members.manager]);
  const denied = page.waitForResponse(response => new URL(response.url()).pathname === `${base}/tasks` && response.status() === 403);
  await workspace(page).getByRole('button', { name: 'Wczytaj aktualne zadania', exact: true }).click(); await (await denied).finished();
  await page.waitForFunction(async organizationId => { const access = await (await import('/test-task-storage.js')).readOfflineAccess(); return !access || !access.scopes.some(scope => scope.organizationId === organizationId); }, f.organizations.a);
  const afterDenial = await snapshots(); assert(!afterDenial || afterDenial.scopes.length === 0);
  if (afterDenial) for (const record of Object.values(afterDenial.records)) assert.equal(record, null);
  assert.equal(await page.locator('.company-task').count(), 0);
  console.log('PASS real 403 after permission revocation blocks prepared offline data and removes online tasks');
}
