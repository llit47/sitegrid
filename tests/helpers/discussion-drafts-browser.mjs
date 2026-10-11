import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import sharp from 'sharp';
import {navigateWorkspace,selectCompany} from './workspace-browser.mjs';

// Exercise the real, simultaneously mounted task-list and project-details editors.
export async function sharedDiscussionDrafts({page,f,task,project,width,png}) {
  const name=`Dyskusja: ${task.title}`;
  const taskView=page.locator('.company-task-list > article').filter({has:page.getByRole('heading',{name:task.title,exact:true,includeHidden:true})}).locator('.discussion');
  const projectView=page.locator('.project-details').getByRole('region',{name,exact:true,includeHidden:true});
  const views=[taskView,projectView];
  for(const view of views)assert.equal(await view.locator('.comment-form').count(),1);
  const confirmation='Serwer potwierdził dodanie komentarza.';
  const pattern='**/tasks/'+task.id+'/comments';
  const url=`${project}/tasks/${task.id}/comments`;
  const photo=async(name,color)=>({name,mimeType:'image/png',buffer:await sharp({create:{width:160,height:120,channels:3,background:color}}).png().toBuffer()});
  const camera=await photo('shared-camera.png','#672796'),gallery=await photo('shared-gallery.png','#2567af');
  const assertDraft=async(text,files,instances=views)=>{
    const expected=[];
    for(const file of files){const {data,info}=await sharp(file.buffer).ensureAlpha().raw().toBuffer({resolveWithObject:true});expected.push({width:info.width,height:info.height,hash:createHash('sha256').update(data).digest('hex')});}
    for(const view of instances){
      assert.equal(await view.locator('textarea').inputValue(),text);
      assert.deepEqual(await view.locator('.photo-previews li > span').allTextContents(),files.map(file=>file.name));
      assert.deepEqual(await view.locator('.photo-previews img').evaluateAll(images=>images.map(image=>image.alt)),files.map(file=>`Podgląd: ${file.name}`));
      // Object URL effects and image decoding can finish after the form has rerendered.
      const previews=await page.waitForFunction(async({section,expected})=>{
        try{
          const actual=await Promise.all([...section.querySelectorAll('.photo-previews img')].map(async image=>{
            await image.decode();const canvas=document.createElement('canvas');canvas.width=image.naturalWidth;canvas.height=image.naturalHeight;
            const context=canvas.getContext('2d');context.drawImage(image,0,0);
            const pixels=context.getImageData(0,0,canvas.width,canvas.height).data;
            const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',pixels)),byte=>byte.toString(16).padStart(2,'0')).join('');
            return {width:canvas.width,height:canvas.height,hash};
          }));
          return JSON.stringify(actual)===JSON.stringify(expected)?actual:false;
        }catch{return false;}
      },{section:await view.elementHandle(),expected});
      assert.deepEqual(await previews.jsonValue(),expected,'Both views display the exact selected image pixels');
      await previews.dispose();
    }
  };
  const assertLocked=async(busy,instances=views)=>{
    for(const view of instances){
      for(const input of await view.locator('textarea,input, .photo-previews button').all())assert(await input.isDisabled());
      assert.equal(await view.locator('button[type=submit]').isDisabled(),busy);
    }
  };
  const assertSaved=async(text,files,id)=>{
    const records=(await f.owner.query('SELECT id,text,photo_count FROM task_comments WHERE task_id=$1 AND text=$2',[task.id,text])).rows;
    assert.equal(records.length,1,'The displayed draft produces exactly one comment');
    assert.equal(records[0].text,text);assert.equal(records[0].photo_count,files.length);
    if(id)assert.equal(records[0].id,id);
    const hashes=[];
    for(const file of files)hashes.push(createHash('sha256').update(await sharp(file.buffer).jpeg({quality:90}).toBuffer()).digest('hex'));
    const media=(await f.owner.query('SELECT original_sha256 FROM task_comment_media WHERE comment_id=$1 ORDER BY position',[records[0].id])).rows;
    assert.deepEqual(media.map(item=>item.original_sha256),hashes,'Persist the exact displayed photos, in order, without removed files');
    for(const view of views){
      await view.locator('.comment-text').filter({hasText:text}).waitFor({state:'attached'});
      assert.equal(await view.locator('p[role=status]').filter({hasText:confirmation}).count(),1);
    }
    await assertDraft('',[]);
  };

  // Edit both ways, including camera/gallery additions and removals in both views.
  await projectView.locator('textarea').fill(`Projekt ${width}`);
  const keep={name:'keep.png',mimeType:'image/png',buffer:png},remove={name:'remove.png',mimeType:'image/png',buffer:png};
  await projectView.getByLabel('Zdjęcia z galerii',{exact:true}).setInputFiles([keep,remove]);
  await assertDraft(`Projekt ${width}`,[keep,remove]);
  await navigateWorkspace(page,'Zadania');
  await taskView.locator('textarea').fill(`Lista ${width}`);
  await taskView.getByRole('button',{name:'Usuń zdjęcie: remove.png',exact:true}).click();
  await taskView.getByLabel('Zdjęcie z aparatu',{exact:true}).setInputFiles(camera);
  await assertDraft(`Lista ${width}`,[keep,camera]);
  await navigateWorkspace(page,'Projekty');
  const text=`Z obu widoków ${width}`,files=[camera,gallery];
  await projectView.locator('textarea').fill(text);
  await projectView.getByRole('button',{name:'Usuń zdjęcie: keep.png',exact:true}).click();
  await projectView.getByLabel('Zdjęcia z galerii',{exact:true}).setInputFiles(gallery);
  await assertDraft(text,files);
  await navigateWorkspace(page,'Zadania');

  // Dispatch in both forms in the same JS turn, bypassing disabled buttons to test the lock.
  let release;const held=new Promise(resolve=>{release=resolve;}),posts=[];
  await page.route(pattern,async route=>{
    if(route.request().method()!=='POST')return route.continue();
    posts.push(route.request());await held;await route.continue();
  });
  try{
    const started=page.waitForRequest(request=>request.method()==='POST'&&request.url().endsWith(url));
    await page.evaluate(name=>{
      const forms=[...document.querySelectorAll('section.discussion')].filter(section=>section.getAttribute('aria-label')===name).map(section=>section.querySelector('form'));
      if(forms.length!==2||forms.some(form=>!form))throw new Error('Both discussion forms must be mounted');
      for(const form of forms)form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));
    },name);
    await started;await assertDraft(text,files);await assertLocked(true);
    assert.equal(await taskView.locator('progress').getAttribute('value'),await projectView.locator('progress').getAttribute('value'));
    release();await taskView.getByText(confirmation,{exact:true}).waitFor();
    assert.equal(posts.length,1,'One shared draft must issue only one concurrent upload');
    await assertSaved(text,files);
  }finally{release();await page.unroute(pattern);}

  // Lose a successful response, then retry from the other mounted view with identical bytes/ID.
  const retryText=`Wspólne potwierdzenie ${width}`,retryFiles=[gallery,camera],requests=[];
  await navigateWorkspace(page,'Projekty');
  await projectView.locator('textarea').fill(retryText);
  await projectView.getByLabel('Zdjęcia z galerii',{exact:true}).setInputFiles(retryFiles);
  await assertDraft(retryText,retryFiles);
  await page.route(pattern,async route=>{
    const request=route.request();if(request.method()!=='POST')return route.continue();
    requests.push({body:request.postDataBuffer(),type:request.headers()['content-type']});
    if(requests.length===1){const response=await route.fetch();assert.equal(response.status(),201);await route.abort('failed');}
    else{const response=await route.fetch();assert.equal(response.status(),200);await route.fulfill({response});}
  });
  try{
    await projectView.getByRole('button',{name:'Wyślij komentarz',exact:true}).click();
    await projectView.getByRole('button',{name:'Ponów komentarz',exact:true}).waitFor();
    await assertDraft(retryText,retryFiles);await assertLocked(false);
    for(const view of views)assert.equal(await view.locator('button[type=submit]').textContent(),'Ponów komentarz');
    // Reconnect remounts the workspace; the uncertain payload stays in page memory.
    await page.context().setOffline(true);
    await page.getByText('Brak połączenia. Odczyt tylko wcześniej przygotowanych projektów z ważnym dostępem.',{exact:true}).waitFor();
    assert.equal(await page.locator('.comment-form').count(),0);
    await page.context().setOffline(false);await selectCompany(page,f.organizations.a,'Zadania');
    await taskView.getByRole('button',{name:'Komentarze i zdjęcia',exact:true}).click();
    // The existing pending-operation guard blocks opening another project until replay.
    await assertDraft(retryText,retryFiles,[taskView]);await assertLocked(false,[taskView]);
    await taskView.getByRole('button',{name:'Ponów komentarz',exact:true}).click();
    await taskView.getByText(confirmation,{exact:true}).waitFor();
    assert.equal(requests.length,2);
    const payloads=[];
    for(const request of requests){
      const form=await new Response(request.body,{headers:{'Content-Type':request.type}}).formData();
      payloads.push({id:form.get('commentId'),text:form.get('text'),photos:await Promise.all(form.getAll('photos').map(async file=>({name:file.name,bytes:Buffer.from(await file.arrayBuffer())})))});
    }
    assert.deepEqual(payloads[1],payloads[0],'Retry freezes ID, text, photo names, order and bytes across views');
    assert.equal(payloads[0].text,retryText);
    assert.deepEqual(payloads[0].photos,retryFiles.map(file=>({name:file.name,bytes:file.buffer})));
    await navigateWorkspace(page,'Projekty');await page.getByRole('button',{name:/Projekt 1 Aktywny/}).click();
    await projectView.getByRole('button',{name:'Komentarze i zdjęcia',exact:true}).click();
    await assertSaved(retryText,retryFiles,payloads[0].id);
  }finally{await page.unroute(pattern);}
  // Leaving the organization discards its in-memory draft after the existing guard.
  await navigateWorkspace(page,'Zadania');
  await taskView.locator('textarea').fill(`Zakres firmy ${width}`);
  await taskView.getByLabel('Zdjęcia z galerii',{exact:true}).setInputFiles(camera);
  await assertDraft(`Zakres firmy ${width}`,[camera]);
  await selectCompany(page,f.organizations.b,'Zadania');
  await selectCompany(page,f.organizations.a,'Zadania');
  await taskView.getByRole('button',{name:'Komentarze i zdjęcia',exact:true}).click();
  await navigateWorkspace(page,'Projekty');await page.getByRole('button',{name:/Projekt 1 Aktywny/}).click();
  await projectView.getByRole('button',{name:'Komentarze i zdjęcia',exact:true}).click();
  await assertDraft('',[]);
  for(const view of views)assert.equal(await view.locator('textarea').isDisabled(),false);
  console.log(`PASS ${width}px reactive shared draft, bidirectional text/photos/removals, simultaneous submission lock, exact DB/photo hashes, cross-view lost-response replay/reconnect, organization scope cleanup`);
}
