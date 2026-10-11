import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {mkdir} from 'node:fs/promises';
import sharp from 'sharp';
import {taskFixture} from './helpers/task-management-fixture.ts';
import {selectCompany,navigateWorkspace,acceptDiscardDialogs} from './helpers/workspace-browser.mjs';
const {chromium}=await import(process.env.SITEGRID_PLAYWRIGHT_MODULE?pathToFileURL(process.env.SITEGRID_PLAYWRIGHT_MODULE).href:'playwright');
const f=await taskFixture({serveWeb:true}),errors=[];let browser;
try{
 const project=`/api/organizations/${f.organizations.a}/projects/${f.projects[0]}`;
 const create=async(title,assignee)=>{const response=await f.app.inject({method:'POST',url:project+'/tasks',headers:f.headers.manager,payload:{title,assigneeMembershipId:assignee}});assert.equal(response.statusCode,201,response.body);return response.json().task;};
 const parent=await create('Dyskusja rodzica',f.members.other),own=await create('Dokumentacja prac',f.members.worker);
 const response=await f.app.inject({method:'POST',url:`${project}/tasks/${parent.id}/subtasks`,headers:f.headers.manager,payload:{title:'Dyskusja podzadania',assigneeMembershipId:f.members.worker}});assert.equal(response.statusCode,201);const child=response.json().task;
 f.config.origin=await f.app.listen({host:'127.0.0.1',port:0});
 const png=await sharp({create:{width:900,height:650,channels:3,background:'#8c6b36'}}).png().toBuffer();
 browser=await chromium.launch({headless:true,...(process.env.SITEGRID_CHROMIUM_PATH?{executablePath:process.env.SITEGRID_CHROMIUM_PATH}:{})});await mkdir('/tmp/sitegrid-pr23-visuals',{recursive:true});
 const open=async(actor,width)=>{const context=await browser.newContext({serviceWorkers:'block',viewport:{width,height:width===390?844:900}});await context.addCookies([{name:'sitegrid',value:f.tokens[actor],url:f.config.origin,httpOnly:true,sameSite:'Strict'}]);const page=await context.newPage();acceptDiscardDialogs(page);page.on('pageerror',e=>errors.push(e.message));await page.goto(f.config.origin);await selectCompany(page,f.organizations.a,'Zadania');return {context,page};};
 const card=(page,title)=>page.locator('.company-task-list > article').filter({has:page.getByRole('heading',{name:title,exact:true})});
 for(const width of [1280,768,390]){
  const {page,context}=await open('worker',width),row=card(page,own.title),discussion=row.getByRole('region',{name:`Dyskusja: ${own.title}`,exact:true});
  assert.equal(await card(page,parent.title).count(),0);
  await discussion.getByRole('button',{name:'Komentarze i zdjęcia',exact:true}).click();await discussion.locator('.comment-form').waitFor();
  await discussion.getByLabel('Treść komentarza',{exact:true}).fill(`Opis pracy ${width}`);
  const selected=[{name:'gallery.png',mimeType:'image/png',buffer:png},{name:'gallery-two.png',mimeType:'image/png',buffer:png}];
  await discussion.getByLabel('Zdjęcia z galerii',{exact:true}).setInputFiles(selected);assert.equal(await discussion.locator('.photo-previews img').count(),2);
  assert.equal(await discussion.getByLabel('Zdjęcie z aparatu',{exact:true}).getAttribute('capture'),'environment');
  await discussion.getByRole('button',{name:'Wyślij komentarz',exact:true}).click();await discussion.getByText('Serwer potwierdził dodanie komentarza.',{exact:true}).waitFor();
  const comment=discussion.locator('.comment-list > li').filter({hasText:`Opis pracy ${width}`});await comment.getByRole('button',{name:'Powiększ zdjęcie'}).nth(1).waitFor();assert.equal(await comment.locator('img').count(),2);
  await comment.getByRole('button',{name:'Powiększ zdjęcie'}).first().click();await page.getByRole('dialog',{name:'Powiększone zdjęcie'}).waitFor();await page.getByRole('button',{name:'Zamknij zdjęcie',exact:true}).click();
  // Explicit HEIC feedback preserves the text draft.
  await discussion.getByLabel('Treść komentarza',{exact:true}).fill('Szkic do poprawienia');await discussion.getByLabel('Zdjęcia z galerii',{exact:true}).setInputFiles({name:'camera.heic',mimeType:'image/heic',buffer:Buffer.from('ftypheic')});await discussion.getByText(/HEIC\/HEIF nie jest obsługiwany/).waitFor();assert.equal(await discussion.getByLabel('Treść komentarza',{exact:true}).inputValue(),'Szkic do poprawienia');
  await discussion.getByLabel('Zdjęcia z galerii',{exact:true}).setInputFiles({name:'broken.jpg',mimeType:'image/jpeg',buffer:Buffer.from([255,216,255,0])});await discussion.getByRole('button',{name:'Wyślij komentarz',exact:true}).click();await discussion.getByText(/Plik jest uszkodzony/).waitFor();assert.equal(await discussion.getByLabel('Treść komentarza',{exact:true}).inputValue(),'Szkic do poprawienia');assert.equal(await discussion.locator('.photo-previews img').count(),1);
  await discussion.getByRole('button',{name:'Usuń zdjęcie: broken.jpg',exact:true}).click();await discussion.getByLabel('Treść komentarza',{exact:true}).fill('');
  // Photo-only comment, including camera input.
  await discussion.getByLabel('Zdjęcie z aparatu',{exact:true}).setInputFiles({name:'camera.png',mimeType:'image/png',buffer:png});await discussion.getByRole('button',{name:'Wyślij komentarz',exact:true}).click();await discussion.getByText('Serwer potwierdził dodanie komentarza.',{exact:true}).waitFor();
  // Lost response: retain exact FormData/ID and prohibit editing until replay confirms.
  const path=`${project}/tasks/${own.id}/comments`;let lost=false;const requests=[];
  await page.route('**/tasks/'+own.id+'/comments',async route=>{if(route.request().method()!=='POST')return route.continue();requests.push(route.request().postDataBuffer());if(!lost){lost=true;const result=await route.fetch();assert.equal(result.status(),201);await route.abort('failed');}else await route.continue();});
  await discussion.getByLabel('Treść komentarza',{exact:true}).fill(`Potwierdzenie ${width}`);await discussion.getByRole('button',{name:'Wyślij komentarz',exact:true}).click();await discussion.getByRole('button',{name:'Ponów komentarz',exact:true}).waitFor();assert(await discussion.getByLabel('Treść komentarza',{exact:true}).isDisabled());
  await discussion.getByRole('button',{name:'Ponów komentarz',exact:true}).click();await discussion.getByText('Serwer potwierdził dodanie komentarza.',{exact:true}).waitFor();
  const commentId=buffer=>buffer.toString().match(/name="commentId"\r\n\r\n([^\r]+)/)[1];assert.equal(commentId(requests[0]),commentId(requests[1]));assert.equal((await f.owner.query('SELECT count(*) FROM task_comments WHERE id=$1',[commentId(requests[0])])).rows[0].count,'1');await page.unroute('**/tasks/'+own.id+'/comments');
  // Online-only discussions disappear offline; in-memory draft survives reconnect.
  await discussion.getByLabel('Treść komentarza',{exact:true}).fill('Szkic połączenia');await context.setOffline(true);await page.getByText('Brak połączenia. Odczyt tylko wcześniej przygotowanych projektów z ważnym dostępem.',{exact:true}).waitFor();assert.equal(await page.locator('.comment-list img').count(),0);await context.setOffline(false);await selectCompany(page,f.organizations.a,'Zadania');await discussion.getByRole('button',{name:'Komentarze i zdjęcia',exact:true}).click();await discussion.locator('.comment-list').waitFor();assert.equal(await discussion.getByLabel('Treść komentarza',{exact:true}).inputValue(),'Szkic połączenia');
  await page.screenshot({path:`/tmp/sitegrid-pr23-visuals/discussion-${width}.png`,fullPage:true});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await discussion.getByLabel('Treść komentarza',{exact:true}).fill('');
  const childDiscussion=card(page,child.title).getByRole('region',{name:`Dyskusja: ${child.title}`,exact:true});await childDiscussion.getByRole('button',{name:'Komentarze i zdjęcia',exact:true}).click();await childDiscussion.getByLabel('Treść komentarza',{exact:true}).fill(`Podzadanie ${width}`);await childDiscussion.getByRole('button',{name:'Wyślij komentarz',exact:true}).click();await childDiscussion.getByText('Serwer potwierdził dodanie komentarza.',{exact:true}).waitFor();
  await navigateWorkspace(page,'Projekty');await page.getByRole('button',{name:/Projekt 1 Aktywny/}).click();const details=page.locator('.project-details');await details.getByRole('region',{name:`Dyskusja: ${own.title}`,exact:true}).getByRole('button',{name:'Komentarze i zdjęcia',exact:true}).click();await details.getByText(`Opis pracy ${width}`,{exact:true}).waitFor();
  await context.close();console.log(`PASS ${width}px comments + multiple gallery photos + camera + preview + full-size + corrupted/HEIC drafts + lost-response replay + offline + project/subtask integration`);
 }
 const manager=await open('manager',1280),hierarchy=card(manager.page,parent.title).getByRole('region',{name:`Podzadania: ${parent.title}`,exact:true});await hierarchy.getByRole('button',{name:'Pokaż podzadania',exact:true}).click();const nested=hierarchy.getByRole('region',{name:`Dyskusja: ${child.title}`,exact:true});await nested.getByRole('button',{name:'Komentarze i zdjęcia',exact:true}).click();await nested.getByText('Podzadanie 390',{exact:true}).waitFor();
 await f.owner.query("UPDATE projects SET status='archived',version=version+1 WHERE id=$1",[f.projects[0]]);await manager.page.locator('.task-workspace').getByLabel('Projekty',{exact:true}).selectOption('archived');const archived=card(manager.page,own.title).getByRole('region',{name:`Dyskusja: ${own.title}`,exact:true});await archived.getByRole('button',{name:'Komentarze i zdjęcia',exact:true}).click();await archived.getByText(/Projekt archiwalny/).waitFor();assert.equal(await archived.getByRole('button',{name:'Wyślij komentarz',exact:true}).count(),0);await manager.context.close();
 assert.deepEqual(errors,[]);console.log('PASS manager nested discussion and archived read-only UI; no browser errors');
}finally{await browser?.close();await f.close();}
