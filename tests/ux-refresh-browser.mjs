import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { mkdir } from 'node:fs/promises';
import sharp from 'sharp';
import { taskFixture } from './helpers/task-management-fixture.ts';
import { selectCompany, navigateWorkspace } from './helpers/workspace-browser.mjs';
const { chromium } = await import(process.env.SITEGRID_PLAYWRIGHT_MODULE ? pathToFileURL(process.env.SITEGRID_PLAYWRIGHT_MODULE).href : 'playwright');
const f = await taskFixture({ serveWeb: true });
let browser;
try {
  f.config.origin = await f.app.listen({ host: '127.0.0.1', port: 0 });
  const base = `/api/organizations/${f.organizations.a}`, project = `${base}/projects/${f.projects[0]}`;
  const post = async (path, payload, actor = 'manager') => {
    const response = await f.app.inject({ method: 'POST', url: path, payload, headers: { ...f.headers[actor], origin: f.config.origin } });
    assert(response.statusCode < 300, response.body); return response.json();
  };
  const task = (await post(`${project}/tasks`, { title: 'Aktualizowane zadanie', assigneeMembershipId: f.members.worker })).task;
  const parent = (await post(`${project}/tasks`, { title: 'Rodzic ze szkicem' })).task;
  const child = (await post(`${project}/tasks/${parent.id}/subtasks`, { title: 'Aktualizowane podzadanie', assigneeMembershipId: f.members.worker })).task;
  browser = await chromium.launch({ headless: true, ...(process.env.SITEGRID_CHROMIUM_PATH ? { executablePath: process.env.SITEGRID_CHROMIUM_PATH } : {}) });
  const errors = [], dialogs = [];
  const open = async (actor, controlled = false) => {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    await context.addCookies([{ name: 'sitegrid', value: f.tokens[actor], url: f.config.origin, httpOnly: true, sameSite: 'Strict' }]);
    const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', dialog => { dialogs.push(dialog.message()); return dialog.dismiss(); });
    if (controlled) { await page.clock.install(); await page.clock.pauseAt(new Date(Date.now() + 60_000)); }
    await page.goto(f.config.origin); await selectCompany(page, f.organizations.a, 'Zadania');
    await page.locator('.company-task').first().waitFor(); return { page, context };
  };
  const manager = await open('manager', true), worker = await open('worker'), page = manager.page;
  const card = title => page.getByRole('article', { name: title, exact: true });
  const updated = card(task.title), hierarchy = card(parent.title).locator('.subtasks');
  await page.getByRole('button', { name: 'Nowe zadanie', exact: true }).click();
  await page.locator('.quick-task-form').getByLabel('Tytuł zadania').fill('Szkic formularza');
  await updated.getByRole('button', { name: 'Komentarze i zdjęcia', exact: true }).click();
  await updated.getByLabel('Treść komentarza', { exact: true }).fill('Szkic dyskusji');
  const png = await sharp({ create: { width: 20, height: 20, channels: 3, background: '#be6819' } }).png().toBuffer();
  await updated.getByLabel('Zdjęcia z galerii', { exact: true }).setInputFiles({ name: 'draft.png', mimeType: 'image/png', buffer: png });
  await hierarchy.getByRole('button', { name: 'Pokaż podzadania', exact: true }).click();
  await hierarchy.getByRole('article', { name: child.title, exact: true }).waitFor();
  await hierarchy.getByRole('button', { name: 'Dodaj podzadanie', exact: true }).click();
  await hierarchy.getByLabel('Tytuł podzadania', { exact: true }).fill('Szkic podzadania');
  const original = await updated.elementHandle();
  let reads = 0, navigations = 0;
  page.on('request', request => { if (new URL(request.url()).pathname === `${base}/tasks`) reads++; });
  page.on('framenavigated', () => navigations++);
  const assertDrafts = async () => {
    assert.equal(await page.locator('.quick-task-form').getByLabel('Tytuł zadania').inputValue(), 'Szkic formularza');
    assert.equal(await hierarchy.getByLabel('Tytuł podzadania', { exact: true }).inputValue(), 'Szkic podzadania');
    assert.equal(await updated.getByLabel('Treść komentarza', { exact: true }).inputValue(), 'Szkic dyskusji');
    assert.equal(await updated.locator('.photo-previews li > span').textContent(), 'draft.png');
    assert(await original.evaluate(element => element.isConnected), 'The same task card remains mounted');
  };
  await worker.page.getByRole('article', { name: task.title, exact: true }).getByRole('button', { name: 'Rozpocznij zadanie', exact: true }).click();
  await worker.page.getByRole('article', { name: task.title, exact: true }).locator('.status-badge').filter({hasText:'W toku'}).waitFor();
  await page.clock.runFor(14_999); assert.equal(reads, 0);
  await page.clock.runFor(1); await updated.locator('.status-badge').filter({ hasText: 'W toku' }).waitFor();
  assert.equal(reads, 1); await assertDrafts();
  await post(`${project}/tasks/${child.id}/commands`, { operationId: crypto.randomUUID(), schemaVersion: 1, action: 'start', expectedVersion: 1 }, 'worker');
  await page.clock.runFor(15_000); await hierarchy.locator('.subtask-row .status-badge').filter({ hasText: 'W toku' }).waitFor();
  await assertDrafts();
  console.log('PASS 15-second updates across accounts preserve card, expanded subtasks, task/subtask forms, discussion text and selected photo');

  // A held response must not overlap another poll or overwrite a later query.
  let release, started;
  const held = new Promise(resolve => { release = resolve; }), requested = new Promise(resolve => { started = resolve; });
  const delayed = async route => { const response = await route.fetch(); started(); await held; await route.fulfill({ response }).catch(() => {}); };
  await page.route(`**${base}/tasks?*`, delayed);
  await page.clock.runFor(15_000); await requested;
  const before = reads; await page.clock.runFor(45_000); assert.equal(reads, before, 'A slow request prevents overlapping polls');
  // Reconnect cancels the obsolete response and reads current authorized data.
  await manager.context.setOffline(true); await page.getByRole('heading', { name: 'SiteGrid bez połączenia', exact: true }).waitFor();
  await page.clock.runFor(30_000); assert.equal(reads, before);
  await post(`${project}/tasks/${task.id}/commands`, { operationId: crypto.randomUUID(), schemaVersion: 1, action: 'submit', expectedVersion: 2 }, 'worker');
  await page.unroute(`**${base}/tasks?*`, delayed); await manager.context.setOffline(false);
  await updated.locator('.status-badge').filter({ hasText: 'Do odbioru' }).waitFor();
  release(); await assertDrafts(); assert.equal(navigations, 0);
  assert.equal(await page.getByRole('button', { name: 'Czytaj przygotowane dane lokalnie', exact: true }).count(), 0);
  console.log('PASS no duplicate slow reads, immediate reconnect, automatic read-only offline viewer, no navigation or draft loss');

  // Visibility gating and immediate resume use the real event handler.
  await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }); document.dispatchEvent(new Event('visibilitychange')); });
  const hiddenReads = reads; await page.clock.runFor(45_000); assert.equal(reads, hiddenReads);
  await post(`${project}/tasks`, { title: 'Nowe zadanie innego konta' }, 'foreman');
  await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' }); document.dispatchEvent(new Event('visibilitychange')); });
  await card('Nowe zadanie innego konta').waitFor(); assert.equal(reads, hiddenReads + 1); await assertDrafts();
  assert.equal(await updated.locator('.task-progress').getByText(/Wersja/).count(), 0);

  // Distinct dashboard, accurate counters and preserved hidden task editors.
  await navigateWorkspace(page, 'Pulpit'); await page.locator('[data-summary-total]').filter({ hasText: '4' }).waitFor();
  assert.equal(await page.locator('.task-workspace').isVisible(), false);
  assert.equal(await page.locator('[data-status-count="backlog"]').textContent(), '2');
  await navigateWorkspace(page, 'Zadania'); await assertDrafts();
  console.log('PASS visible-tab resume, automatic creation updates and separate accurate dashboard with retained task editors');

  await mkdir('/tmp/sitegrid-pr25-visuals', { recursive: true });
  const contrast = async locator => locator.evaluate(element => {
    const colors = getComputedStyle(element);
    const luminance = css => { const values = css.match(/\d+/g).slice(0,3).map(Number).map(x => { x /= 255; return x <= .04045 ? x / 12.92 : ((x + .055) / 1.055) ** 2.4; }); return .2126 * values[0] + .7152 * values[1] + .0722 * values[2]; };
    const a = luminance(colors.color), b = luminance(colors.backgroundColor); return (Math.max(a,b) + .05) / (Math.min(a,b) + .05);
  });
  let lightSurface;
  for (const scheme of ['light','dark','light']) {
    await page.emulateMedia({ colorScheme: scheme });
    const surface = await updated.evaluate(element => getComputedStyle(element).backgroundColor);
    if (scheme === 'light') { if (lightSurface) assert.equal(surface, lightSurface); lightSurface = surface; }
    else assert.notEqual(surface, lightSurface);
    assert(await contrast(updated.locator('.status-badge').first()) >= 4.5, 'Badge contrast meets WCAG AA');
    assert(await contrast(page.locator('.quick-task-form input').first()) >= 4.5, 'Form contrast meets WCAG AA');
    for (const width of [1280,768,390]) {
      await page.setViewportSize({ width, height: 900 });
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${scheme} ${width}px fits viewport`);
      for (const button of await page.locator('.task-workspace button:visible').all()) assert((await button.boundingBox()).height >= 44);
      await page.screenshot({ path: `/tmp/sitegrid-pr25-visuals/${scheme}-${width}.png`, fullPage: true });
    }
    await assertDrafts();
  }
  // A long upload stays mounted through multiple automatic reads.
  let releaseUpload, uploadStarted;
  const uploadHeld = new Promise(resolve => { releaseUpload = resolve; });
  const uploadRequested = new Promise(resolve => { uploadStarted = resolve; });
  const uploadPath = `**/tasks/${task.id}/comments`;
  await page.route(uploadPath, async route => {
    if (route.request().method() !== 'POST') return route.continue();
    const response = await route.fetch(); uploadStarted(); await uploadHeld; await route.fulfill({response});
  });
  await updated.getByRole('button', {name:'Wyślij komentarz',exact:true}).click(); await uploadRequested;
  const uploadReads = reads; await page.clock.runFor(30_000);
  assert(reads > uploadReads); await assertDrafts();
  assert(await updated.getByRole('button',{name:'Wysyłanie…',exact:true}).isDisabled());
  releaseUpload(); await updated.getByText('Serwer potwierdził dodanie komentarza.',{exact:true}).waitFor();
  await page.unroute(uploadPath);
  await updated.getByRole('button',{name:'Powiększ zdjęcie',exact:true}).click();
  const photo = updated.getByRole('dialog',{name:'Powiększone zdjęcie',exact:true});
  await photo.waitFor(); let lightDialog;
  for (const scheme of ['light','dark']) {
    await page.emulateMedia({colorScheme:scheme});
    const background = await photo.evaluate(element => getComputedStyle(element).backgroundColor);
    if (scheme === 'light') lightDialog = background; else assert.notEqual(background,lightDialog);
    assert(await contrast(photo.getByRole('button',{name:'Zamknij zdjęcie',exact:true})) >= 4.5);
  }
  await photo.getByRole('button',{name:'Zamknij zdjęcie',exact:true}).click();
  console.log('PASS polling preserves an in-flight photo upload and the photo dialog follows the system theme');
  assert.deepEqual(dialogs, []); assert.deepEqual(errors, []);
  console.log('PASS automatic live light/dark/light changes, accessible badge/form contrast and 1280/768/390px layouts');
  // A status change outside the current filter still preserves its authorized editor.
  const filteredTask = (await post(`${project}/tasks`, {title:'Szkic poza filtrem',assigneeMembershipId:f.members.worker})).task;
  const filtered = await open('manager', true);
  await filtered.page.getByRole('button',{name:'Do zrobienia',exact:true}).click();
  const retained = filtered.page.getByRole('article',{name:filteredTask.title,exact:true});
  await retained.getByRole('button',{name:'Komentarze i zdjęcia',exact:true}).click();
  await retained.getByLabel('Treść komentarza',{exact:true}).fill('Zachowaj mimo zmiany statusu');
  await post(`${project}/tasks/${filteredTask.id}/commands`, {operationId:crypto.randomUUID(),schemaVersion:1,action:'start',expectedVersion:1}, 'worker');
  await filtered.page.clock.runFor(15_000);
  await retained.getByText('Zachowano otwarty widok. Zadanie jest poza bieżącą listą.',{exact:true}).waitFor();
  assert.equal(await retained.getByLabel('Treść komentarza',{exact:true}).inputValue(),'Zachowaj mimo zmiany statusu');
  assert.equal(await retained.locator('.status-badge').textContent(),'W toku');
  console.log('PASS a reauthorized card falling outside its status filter preserves the open discussion draft');
  await filtered.context.close();

  // A live card must not silently advance the version of an unsaved editor.
  const assignmentTask = (await post(`${project}/tasks`, {title:'Szkic przydziału',assigneeMembershipId:f.members.worker})).task;
  const assignmentChild = (await post(`${project}/tasks/${parent.id}/subtasks`, {title:'Szkic przydziału podzadania',assigneeMembershipId:f.members.worker})).task;
  const editor = await open('admin', true), editPage = editor.page;
  const staleSave = async (path, button, checkDraft) => {
    const pending = editPage.waitForResponse(response => new URL(response.url()).pathname === path && response.request().method() === 'POST');
    await button.click(); const response = await pending;
    assert.equal(response.status(), 409, 'Concurrent edits retain the original optimistic version');
    assert.equal(response.request().postDataJSON().expectedVersion, 1);
    await checkDraft();
  };
  const checkAssignment = async (item, row) => {
    const taskPath = `${project}/tasks/${item.id}`;
    await row.getByRole('button', {name:item.parent ? 'Zmień wykonawcę podzadania' : 'Zmień wykonawcę',exact:true}).click();
    const select = row.locator('.task-assignment select'); await select.selectOption(f.members.other);
    await post(`${taskPath}/assign`, {assigneeMembershipId:null,expectedVersion:1});
    await editPage.clock.runFor(15_000); await row.locator('.status-badge').filter({hasText:'Backlog'}).waitFor();
    await staleSave(`${taskPath}/assign`, row.getByRole('button',{name:'Zapisz przydział',exact:true}), async () => {
      assert.equal(await select.inputValue(), f.members.other);
      const current = await f.app.inject({url:taskPath,headers:f.headers.admin});
      assert.equal(current.json().task.assigneeMembershipId,null);
    });
    await select.selectOption(f.members.worker);
    await row.getByRole('button',{name:'Anuluj przydział',exact:true}).click();
  };
  await checkAssignment(assignmentTask, editPage.getByRole('article',{name:assignmentTask.title,exact:true}));
  const children = editPage.getByRole('article',{name:parent.title,exact:true}).locator('.subtasks');
  await children.getByRole('button',{name:'Pokaż podzadania',exact:true}).click();
  await checkAssignment({...assignmentChild,parent:true}, children.getByRole('article',{name:assignmentChild.title,exact:true}));
  await navigateWorkspace(editPage,'Projekty');
  await editPage.locator('.project-choice').filter({hasText:'Projekt 1'}).click();
  await editPage.getByRole('button',{name:'Edytuj projekt',exact:true}).click();
  const name = editPage.getByLabel('Nazwa projektu',{exact:true}); await name.fill('Zachowany szkic projektu');
  await post(`${project}/update`, {name:'Zmiana innego administratora',description:'Nowy opis',expectedVersion:1},'admin');
  await editPage.clock.runFor(15_000);
  await editPage.locator('.project-details > h4').getByText('Zmiana innego administratora',{exact:true}).waitFor();
  await staleSave(`${project}/update`, editPage.getByRole('button',{name:'Zapisz projekt',exact:true}), async () => {
    assert.equal(await name.inputValue(),'Zachowany szkic projektu');
    const current = await f.app.inject({url:project,headers:f.headers.admin});
    assert.equal(current.json().project.name,'Zmiana innego administratora');
  });
  console.log('PASS task/subtask assignment and project drafts preserve their original versions and reject concurrent overwrites');
  assert.deepEqual(dialogs, []); assert.deepEqual(errors, []);
  await editor.context.close();
  await manager.context.close(); await worker.context.close();
} finally { await browser?.close(); await f.close(); }
