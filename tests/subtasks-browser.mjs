import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { taskFixture } from './helpers/task-management-fixture.ts';
import { selectCompany, navigateWorkspace, acceptDiscardDialogs } from './helpers/workspace-browser.mjs';
const {chromium}=await import(process.env.SITEGRID_PLAYWRIGHT_MODULE?pathToFileURL(process.env.SITEGRID_PLAYWRIGHT_MODULE).href:'playwright');
const f=await taskFixture({serveWeb:true}),errors=[];let browser;
try {
 const project=`/api/organizations/${f.organizations.a}/projects/${f.projects[0]}`;
 const rootResponse=await f.app.inject({method:'POST',url:project+'/tasks',headers:f.headers.manager,payload:{title:'Praca główna',description:'POUFNY OPIS RODZICA',assigneeMembershipId:f.members.other}});assert.equal(rootResponse.statusCode,201,rootResponse.body);const root=rootResponse.json().task;
 f.config.origin=await f.app.listen({host:'127.0.0.1',port:0});
 browser=await chromium.launch({headless:true,...(process.env.SITEGRID_CHROMIUM_PATH?{executablePath:process.env.SITEGRID_CHROMIUM_PATH}:{})});await mkdir('/tmp/sitegrid-pr22-visuals',{recursive:true});
 const open=async(actor,width)=>{
  const context=await browser.newContext({serviceWorkers:'block',viewport:{width,height:width===390?844:900}});await context.addCookies([{name:'sitegrid',value:f.tokens[actor],url:f.config.origin,httpOnly:true,sameSite:'Strict'}]);
  const page=await context.newPage();acceptDiscardDialogs(page);page.on('pageerror',e=>errors.push(e.message));await page.goto(f.config.origin);await selectCompany(page,f.organizations.a,'Zadania');return {page,context};
 };
 const top=(page,title)=>page.locator('.company-task').filter({has:page.getByRole('heading',{name:title,exact:true})});
 const expand=async page=>{await top(page,'Praca główna').getByRole('button',{name:'Pokaż podzadania',exact:true}).click();await page.locator('.subtasks').getByRole('button',{name:'Dodaj podzadanie',exact:true}).waitFor();};
 for(const width of [1280,768,390]) {
  const manager=await open('manager',width);await top(manager.page,'Praca główna').waitFor();await expand(manager.page);
  await manager.page.locator('.subtasks').getByRole('button',{name:'Dodaj podzadanie',exact:true}).click();const form=manager.page.locator('.subtask-form');
  const title=`Podzadanie ${width}`;await form.getByLabel('Tytuł podzadania',{exact:true}).fill(title);await form.getByLabel('Opis podzadania',{exact:true}).fill(`Opis pracy ${width}`);await form.getByRole('button',{name:'Utwórz podzadanie',exact:true}).click();await top(manager.page,title).waitFor();
  await expand(manager.page);const child=manager.page.locator('.subtask-row').filter({has:manager.page.getByRole('heading',{name:title,exact:true})});
  await child.getByRole('button',{name:'Przypisz podzadanie',exact:true}).click();await child.getByLabel('Wykonawca',{exact:true}).selectOption(f.members.worker);await child.getByRole('button',{name:'Zapisz przydział',exact:true}).click();await top(manager.page,title).waitFor();
  await expand(manager.page);await child.waitFor();assert.equal(await manager.page.getByRole('article',{name:title,exact:true}).count(),1,'child is displayed once when hierarchy is open');
  assert(await child.evaluate(element=>element.getBoundingClientRect().right<=innerWidth),'nested child remains inside viewport');
  await manager.page.screenshot({path:`/tmp/sitegrid-pr22-visuals/manager-${width}.png`,fullPage:true});
  const worker=await open('worker',width);const own=top(worker.page,title);await own.waitFor();assert.equal(await worker.page.locator('.subtasks').count(),0);assert.equal(await worker.page.getByText('POUFNY OPIS RODZICA',{exact:true}).count(),0);assert.equal(await worker.page.locator('.subtask-summary').count(),0);assert(await own.getByText('Podzadanie · Praca główna',{exact:true}).isVisible());
  await own.getByRole('button',{name:'Rozpocznij zadanie',exact:true}).click();await own.getByRole('button',{name:'Zgłoś do odbioru',exact:true}).waitFor();await own.getByRole('button',{name:'Zgłoś do odbioru',exact:true}).click();await own.getByText('Zgłoszone do odbioru · Wersja 4',{exact:true}).waitFor();
  await own.getByRole('button',{name:'Historia postępu',exact:true}).click();await own.locator('.progress-history li').first().waitFor();assert.equal(await own.locator('.progress-history li').count(),2);
  await worker.page.screenshot({path:`/tmp/sitegrid-pr22-visuals/worker-${width}.png`,fullPage:true});
  for(const page of [worker.page,manager.page]) assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await top(manager.page,'Praca główna').getByRole('button',{name:'Zwiń podzadania',exact:true}).click();await manager.page.locator('.task-workspace').getByRole('button',{name:'Wczytaj aktualne zadania',exact:true}).click();await top(manager.page,'Praca główna').getByText(`Do odbioru: ${width===1280?1:width===768?2:3}`,{exact:false}).waitFor();
  assert.equal((await f.app.inject({url:project+'/tasks/'+root.id,headers:f.headers.manager})).json().task.status,'planned');
  await navigateWorkspace(manager.page,'Projekty');await manager.page.getByRole('button',{name:/Projekt 1 Aktywny/}).click();await manager.page.locator('.project-details').getByRole('button',{name:'Pokaż podzadania',exact:true}).click();await manager.page.locator('.project-details .subtask-row').filter({has:manager.page.getByRole('heading',{name:title,exact:true})}).waitFor();
  console.log(`PASS ${width}px: create backlog child, assign, one hierarchy row, own progress/history, parent privacy and independent status, project integration`);
  await worker.context.close();await manager.context.close();
 }
 // A confirmed sibling must preserve the unresolved command and allow its exact retry.
 const commandChildren=[];
 for(const title of ['Komenda oczekująca','Komenda równoległa']){
  const response=await f.app.inject({method:'POST',url:`${project}/tasks/${root.id}/subtasks`,headers:{...f.headers.manager,origin:f.config.origin},payload:{title,assigneeMembershipId:f.members.manager}});assert.equal(response.statusCode,201);commandChildren.push(response.json().task);
 }
 const parallel=await open('manager',1280);await expand(parallel.page);
 const nested=title=>parallel.page.locator('.subtask-row').filter({has:parallel.page.getByRole('heading',{name:title,exact:true})});
 const commands=[];let interrupted=false;
 await parallel.page.route(`**/tasks/${commandChildren[0].id}/commands`,async route=>{
  commands.push(route.request().postDataJSON());
  if(!interrupted){interrupted=true;const response=await route.fetch();assert.equal(response.status(),200);await route.abort('failed');}
  else await route.continue();
 });
 await nested('Komenda oczekująca').getByRole('button',{name:'Rozpocznij zadanie',exact:true}).click();await nested('Komenda oczekująca').getByRole('button',{name:'Ponów operację',exact:true}).waitFor();
 await nested('Komenda równoległa').getByRole('button',{name:'Rozpocznij zadanie',exact:true}).click();await nested('Komenda równoległa').getByRole('button',{name:'Zgłoś do odbioru',exact:true}).waitFor();
 assert(await nested('Komenda oczekująca').getByRole('button',{name:'Ponów operację',exact:true}).isEnabled());
 await nested('Komenda oczekująca').getByRole('button',{name:'Ponów operację',exact:true}).click();await top(parallel.page,'Komenda oczekująca').getByRole('button',{name:'Zgłoś do odbioru',exact:true}).waitFor();assert.deepEqual(commands[0],commands[1]);
 assert.equal((await f.owner.query('SELECT count(*) FROM task_progress_receipts WHERE task_id=$1',[commandChildren[0].id])).rows[0].count,'1');
 await parallel.context.close();console.log('PASS concurrent child confirmation preserves operationId and exact M08 retry after a lost HTTP response');
 assert.deepEqual(errors,[]);console.log('PASS no browser runtime errors');
}finally{await browser?.close();await f.close();}
