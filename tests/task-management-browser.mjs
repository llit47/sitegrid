import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { installTaskListRegressionStorage, runTaskListRegressions } from './helpers/task-list-regressions.mjs';
import { taskFixture } from './helpers/task-management-fixture.ts';
import { selectCompany, navigateWorkspace, acceptDiscardDialogs } from './helpers/workspace-browser.mjs';
const { chromium } = await import(process.env.SITEGRID_PLAYWRIGHT_MODULE ? pathToFileURL(process.env.SITEGRID_PLAYWRIGHT_MODULE).href : 'playwright');
const f=await taskFixture({ serveWeb:true }), errors=[];
let browser;
try {
  await installTaskListRegressionStorage(f.app);
  f.config.origin=await f.app.listen({host:'127.0.0.1',port:0});
  browser=await chromium.launch({headless:true,...(process.env.SITEGRID_CHROMIUM_PATH?{executablePath:process.env.SITEGRID_CHROMIUM_PATH}:{})});
  await mkdir('/tmp/sitegrid-pr21-visuals',{recursive:true});
  const open=async(actor,width=1280)=>{
    const context=await browser.newContext({serviceWorkers:'block',viewport:{width,height:width===390?844:900}});
    await context.addCookies([{name:'sitegrid',value:f.tokens[actor],url:f.config.origin,httpOnly:true,sameSite:'Strict'}]);
    const page=await context.newPage(); acceptDiscardDialogs(page); page.on('pageerror',e=>errors.push(e.message));
    await page.goto(f.config.origin); await selectCompany(page,f.organizations.a,'Pulpit');
    await page.waitForFunction(()=>document.querySelector('.workspace-sidebar')?.classList.contains('is-open')===false);
    await page.getByRole('heading',{name:actor==='worker' || actor==='other' ? 'Moje zadania':'Zadania firmy',exact:true}).waitFor();
    return {page,context};
  };
  const workspace=page=>page.locator('.task-workspace');
  const card=(page,title)=>page.getByRole('article',{name:title,exact:true});
  const manager=await open('manager');
  for(let i=0;i<10;i++) {
    await workspace(manager.page).getByRole('button',{name:'Nowe zadanie',exact:true}).click();
    const form=manager.page.locator('.quick-task-form');
    await form.getByLabel('Projekt',{exact:true}).selectOption(f.projects[i%3]);
    await form.getByLabel('Tytuł zadania',{exact:true}).fill(`Praca ${i+1}`);
    await form.getByRole('button',{name:'Utwórz zadanie',exact:true}).click();
    await form.waitFor({state:'detached'}); await workspace(manager.page).getByText('Serwer potwierdził utworzenie zadania.',{exact:true}).waitFor();
    await card(manager.page,`Praca ${i+1}`).waitFor();
  }
  assert.equal(await manager.page.locator('.company-task').count(),10);
  await workspace(manager.page).getByRole('button',{name:'Backlog',exact:true}).click();
  await manager.page.waitForFunction(()=>document.querySelectorAll('.company-task').length===10);
  assert.equal((await f.owner.query('SELECT count(*) FROM project_memberships')).rows[0].count,'0');
  console.log('PASS manager without project membership creates ten backlog tasks across three projects on dashboard');
  for(let i=0;i<6;i++) {
    const task=card(manager.page,`Praca ${i+1}`);
    await task.getByRole('button',{name:'Przypisz',exact:true}).click();
    await task.getByLabel('Wykonawca',{exact:true}).selectOption(f.members[i%2?'other':'worker']);
    await task.getByRole('button',{name:'Zapisz przydział',exact:true}).click();
    await task.locator('.task-assignment').waitFor({state:'detached'});
    await workspace(manager.page).getByText('Serwer potwierdził zapis przydziału.',{exact:true}).waitFor();
  }
  await workspace(manager.page).getByRole('button',{name:'Wszystkie',exact:true}).click(); await manager.page.waitForFunction(()=>document.querySelectorAll('.company-task').length===10);
  const task=card(manager.page,'Praca 1');
  await task.getByRole('button',{name:'Zmień wykonawcę',exact:true}).click();
  await task.getByLabel('Wykonawca',{exact:true}).selectOption(f.members.other);
  await task.getByRole('button',{name:'Zapisz przydział',exact:true}).click(); await task.locator('.task-assignment').waitFor({state:'detached'});
  await task.getByRole('button',{name:'Zmień wykonawcę',exact:true}).click(); await task.getByLabel('Wykonawca',{exact:true}).selectOption('');
  await task.getByRole('button',{name:'Zapisz przydział',exact:true}).click(); await task.locator('.task-assignment').waitFor({state:'detached'});
  await workspace(manager.page).getByRole('button',{name:'Backlog',exact:true}).click(); await manager.page.waitForFunction(()=>document.querySelectorAll('.company-task').length===5);
  await navigateWorkspace(manager.page,'Zadania'); assert.equal(await workspace(manager.page).getByRole('button',{name:'Backlog',exact:true}).getAttribute('aria-pressed'),'true');
  await workspace(manager.page).getByRole('button',{name:'Wczytaj aktualne zadania',exact:true}).click();
  await manager.page.waitForFunction(()=>document.querySelectorAll('.company-task').length===5);
  await workspace(manager.page).getByRole('button',{name:'Wszystkie',exact:true}).click(); await manager.page.waitForFunction(()=>document.querySelectorAll('.company-task').length===10);
  await workspace(manager.page).getByLabel('Szukaj zadań',{exact:true}).fill('nieistniejące'); await workspace(manager.page).getByRole('button',{name:'Szukaj',exact:true}).click();
  await manager.page.getByText('Brak zadań dla wybranych filtrów.',{exact:true}).waitFor();
  await workspace(manager.page).getByLabel('Szukaj zadań',{exact:true}).fill(''); await workspace(manager.page).getByRole('button',{name:'Szukaj',exact:true}).click(); await card(manager.page,'Praca 1').waitFor();
  // A quick assignment remains reviewable after a concurrent change.
  await card(manager.page,'Praca 7').getByRole('button',{name:'Przypisz',exact:true}).click();
  await card(manager.page,'Praca 7').getByLabel('Wykonawca',{exact:true}).selectOption(f.members.worker);
  const stale=(await f.owner.query("SELECT id,project_id FROM tasks WHERE title='Praca 7'")).rows[0];
  const response=await f.app.inject({method:'POST',url:`/api/organizations/${f.organizations.a}/projects/${stale.project_id}/tasks/${stale.id}/assign`,headers:{...f.headers.manager,origin:f.config.origin},payload:{assigneeMembershipId:f.members.other,expectedVersion:1}}); assert.equal(response.statusCode,200);
  await card(manager.page,'Praca 7').getByRole('button',{name:'Zapisz przydział',exact:true}).click(); await workspace(manager.page).getByRole('alert').filter({hasText:'Rekord zmienił się'}).waitFor();
  assert.equal(await card(manager.page,'Praca 7').getByLabel('Wykonawca',{exact:true}).inputValue(),f.members.worker);
  await workspace(manager.page).getByRole('button',{name:'Wczytaj aktualne zadania',exact:true}).click(); await manager.page.locator('.task-assignment').waitFor({state:'detached'});
  // Form draft persists through dashboard/tasks navigation.
  await workspace(manager.page).getByRole('button',{name:'Nowe zadanie',exact:true}).click(); await manager.page.locator('.quick-task-form').getByLabel('Tytuł zadania').fill('Niezapisana propozycja');
  await navigateWorkspace(manager.page,'Pulpit'); assert.equal(await manager.page.locator('.quick-task-form').getByLabel('Tytuł zadania').inputValue(),'Niezapisana propozycja');
  await manager.page.locator('.quick-task-form').getByRole('button',{name:'Anuluj formularz zadania',exact:true}).click();
  console.log('PASS quick assign/reassign/unassign, search/empty state, server version conflict and retained draft across tasks/dashboard');
  for(const actor of ['admin','foreman']) {
    const user=await open(actor); await card(user.page,'Praca 10').waitFor(); assert.equal(await user.page.locator('.company-task').count(),10);
    await workspace(user.page).getByRole('button',{name:'Backlog',exact:true}).click(); await user.page.waitForFunction(()=>document.querySelectorAll('.company-task').length===4);
    assert(await card(user.page,'Praca 10').getByRole('button',{name:'Przypisz',exact:true}).isVisible());
    await user.page.screenshot({path:`/tmp/sitegrid-pr21-visuals/${actor}-desktop.png`,fullPage:true}); await user.context.close();
  }
  console.log('PASS company administrator without manager role and foreman manage company backlog without project assignment');
  const worker=await open('worker'); await card(worker.page,'Praca 3').waitFor(); assert.equal(await worker.page.locator('.company-task').count(),2);
  assert.equal(await workspace(worker.page).getByRole('button',{name:'Nowe zadanie',exact:true}).count(),0); assert.equal(await workspace(worker.page).getByRole('button',{name:'Backlog',exact:true}).count(),0);
  assert.equal(await workspace(worker.page).getByLabel('Wykonawca',{exact:true}).count(),0);
  await card(worker.page,'Praca 3').getByRole('button',{name:'Rozpocznij zadanie',exact:true}).click(); await workspace(worker.page).getByText('Serwer potwierdził rozpoczęcie zadania.',{exact:true}).waitFor();
  await card(worker.page,'Praca 3').getByRole('button',{name:'Zgłoś do odbioru',exact:true}).click(); await workspace(worker.page).getByText('Serwer potwierdził zgłoszenie do odbioru.',{exact:true}).waitFor();
  await worker.page.waitForFunction(()=>document.querySelectorAll('.company-task').length===2);
  await navigateWorkspace(worker.page,'Zadania'); assert.equal(await worker.page.locator('.company-task').count(),2);
  await worker.page.screenshot({path:'/tmp/sitegrid-pr21-visuals/worker-desktop.png',fullPage:true});
  await selectCompany(worker.page,f.organizations.b,'Pulpit'); await worker.page.getByText('Nie masz zadań dla wybranych filtrów.',{exact:true}).waitFor(); assert.equal(await worker.page.locator('.company-task').count(),0);
  await worker.context.close(); console.log('PASS worker sees only own multi-project work, runs M08 start/submit, and clears previous company on switching');
  for(const [actor,width] of [['manager',768],['foreman',390],['worker',390]]) {
    const user=await open(actor,width); await user.page.locator('.company-task').first().waitFor();
    assert(await user.page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'No viewport overflow');
    if(width===390) { const title=await user.page.locator('.company-task').first().getByRole('heading').boundingBox(); assert(title && title.y+title.height<user.page.viewportSize().height,'The task title is fully visible on the initial mobile screen'); await workspace(user.page).locator('summary').click(); assert(await workspace(user.page).getByLabel('Projekt',{exact:true}).isVisible()); await workspace(user.page).locator('summary').click(); }
    if(actor==='foreman' && width===390) { await workspace(user.page).getByRole('button',{name:'Do odbioru',exact:true}).click(); await user.page.waitForFunction(()=>document.querySelectorAll('.company-task').length===1); await card(user.page,'Praca 3').waitFor(); await workspace(user.page).getByRole('button',{name:'Wszystkie',exact:true}).click(); await user.page.waitForFunction(()=>document.querySelectorAll('.company-task').length===10); }
    for(const button of await workspace(user.page).getByRole('button').all()) { const box=await button.boundingBox(); if(box) assert(box.height>=44,'Touch controls at least 44px'); }
    await user.page.screenshot({path:`/tmp/sitegrid-pr21-visuals/${actor}-${width}.png`,fullPage:true}); await user.context.close();
  }
  await runTaskListRegressions(f,browser,manager.page);
  await manager.context.close();
  const rolelessContext=await browser.newContext({serviceWorkers:'block'}); await rolelessContext.addCookies([{name:'sitegrid',value:f.tokens.roleless,url:f.config.origin,httpOnly:true,sameSite:'Strict'}]);
  const roleless=await rolelessContext.newPage(); let deniedRequests=0; roleless.on('request',req=>{if(new URL(req.url()).pathname.endsWith('/tasks')) deniedRequests++;});
  await roleless.goto(f.config.origin); await roleless.getByText('Brak uprawnień do zadań w tej firmie.',{exact:true}).waitFor(); assert.equal(deniedRequests,0,'Missing work roles do not cause a repeated context refresh'); await rolelessContext.close(); assert.deepEqual(errors,[]);
  console.log('PASS tablet and mobile manager/foreman/worker task dashboards, touch targets and no browser errors');
} finally { await browser?.close(); await f.close(); }
