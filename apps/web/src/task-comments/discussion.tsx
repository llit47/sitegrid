import {useEffect,useRef,useState} from 'react';
import {request} from '../project-api.js';
import {observeAccessFailure} from '../offline/account.js';
import {guardWorkspaceChange,usePendingOperation} from '../workspace/navigation-safety.js';
import {useDiscussionDraft} from './drafts.js';
import {sendComment,type Comment} from './api.js';
import {PhotoView} from './photo.js';
import './discussion.css';
function Preview({file,remove,disabled}:{file:File;remove:()=>void;disabled:boolean}){
  const [url,setUrl]=useState('');useEffect(()=>{const value=URL.createObjectURL(file);setUrl(value);return()=>URL.revokeObjectURL(value);},[file]);
  return <li><img src={url} alt={`Podgląd: ${file.name}`} /><span>{file.name}</span><button type="button" className="secondary" disabled={disabled} onClick={remove} aria-label={`Usuń zdjęcie: ${file.name}`}>Usuń</button></li>;
}
export function Discussion({path,title,csrfToken,writable,onAccessChanged}:{path:string;title:string;csrfToken:string;writable:boolean;onAccessChanged:()=>void}) {
  const {draft,store}=useDiscussionDraft(path),root=useRef<HTMLElement>(null),lifetime=useRef<AbortController|null>(null);
  const {text,files,uncertain,busy,progress,notice}=draft;
  const [open,setOpen]=useState(false),[comments,setComments]=useState<Comment[]|null>(null),[after,setAfter]=useState<string|null>(null);
  const [online,setOnline]=useState(navigator.onLine);
  const [loading,setLoading]=useState(false),[error,setError]=useState(''),[revision,setRevision]=useState(0);
  const message=error||draft.error;
  usePendingOperation(busy||uncertain);
  useEffect(()=>{const controller=new AbortController();lifetime.current=controller;const changed=()=>{setOnline(navigator.onLine);setComments(null);setAfter(null);};window.addEventListener('online',changed);window.addEventListener('offline',changed);return()=>{controller.abort();window.removeEventListener('online',changed);window.removeEventListener('offline',changed);};},[]);
  const denied=()=>{setComments(null);setAfter(null);onAccessChanged();};
  const failed=async(e:{message:string;status?:number})=>{setError(e.message);if([401,403,404].includes(e.status??0)){await observeAccessFailure(path,e.status!);denied();}};
  useEffect(()=>{if(!open||!online)return;const controller=new AbortController();setComments(null);setError('');setLoading(true);
    void request<{comments:Comment[];nextAfter:string|null}>(path+'/comments',controller.signal).then(data=>{if(!controller.signal.aborted){setComments(data.comments);setAfter(data.nextAfter);}}).catch(e=>{if(!controller.signal.aborted)void failed(e);}).finally(()=>{if(!controller.signal.aborted)setLoading(false);});return()=>controller.abort();
  },[path,open,online,revision,draft.revision]);
  const select=(selected:FileList|null)=>{if(!selected)return;const current=store.getSnapshot();if(current.busy||current.uncertain)return;const items=Array.from(selected);setError('');store.reportError('');
    if(current.files.length+items.length>5){store.reportError('Maksymalnie 5 zdjęć na komentarz.');return;}
    if(items.some(file=>file.size>10*1024**2)){store.reportError('Każde zdjęcie może mieć maksymalnie 10 MiB.');return;}
    if(items.some(file=>/\.(heic|heif)$/i.test(file.name)||/hei[cf]/i.test(file.type))){store.reportError('HEIC/HEIF nie jest obsługiwany. Wybierz zdjęcie w formacie JPEG, PNG lub WebP.');return;}
    if(items.some(file=>!['image/jpeg','image/png','image/webp'].includes(file.type))){store.reportError('Wybierz zdjęcia JPEG, PNG lub WebP.');return;}store.addFiles(items);
  };
  const send=async()=>{
    const signal=lifetime.current?.signal;if(!signal||signal.aborted||!online||(!writable&&!store.getSnapshot().uncertain))return;
    const attempt=store.begin();if(!attempt)return;setError('');
    const payload=attempt.payload;
    try{await sendComment(path,csrfToken,payload.text,payload.files,payload.id,value=>store.progress(attempt,value),signal);store.succeed(attempt);}
    catch(e){const failure=e as {message:string;status?:number};const current=store.fail(attempt,failure);
      if(current&&!signal.aborted&&[401,403,404].includes(failure.status??0)){await observeAccessFailure(path,failure.status!);denied();}
    }
  };
  const more=async()=>{if(loading||!after)return;setLoading(true);setError('');try{const data=await request<{comments:Comment[];nextAfter:string|null}>(path+'/comments?after='+after,lifetime.current!.signal);setComments(current=>[...(current??[]),...data.comments.filter(item=>!current?.some(old=>old.id===item.id))]);setAfter(data.nextAfter);}catch(e){await failed(e as Error);}finally{if(!lifetime.current!.signal.aborted)setLoading(false);}};
  return <section className="discussion" ref={root} aria-label={`Dyskusja: ${title}`}><button type="button" className="secondary" aria-expanded={open} disabled={busy} onClick={()=>{if(!open||guardWorkspaceChange(root.current!))setOpen(!open);}}>{open?'Zwiń dyskusję':'Komentarze i zdjęcia'}</button>
    {open && <><p className="hint">Dyskusja i zdjęcia wymagają połączenia z internetem.</p>{!online?<p role="status">Brak połączenia. Szkic pozostaje w tym widoku; odzyskaj połączenie, aby czytać i wysyłać.</p>:<>
      {loading && <p role="status">Ładowanie dyskusji…</p>}{comments?.length===0 && <p>Brak komentarzy. Rozpocznij dyskusję.</p>}
      <ol className="comment-list">{comments?.map(comment=><li key={comment.id}><article><header><strong>{comment.authorName}</strong><time dateTime={comment.createdAt}>{new Date(comment.createdAt).toLocaleString('pl-PL')}</time></header>{comment.text && <p className="comment-text">{comment.text}</p>}<div className="comment-photos">{comment.photos.map(photo=><PhotoView key={photo.id} path={path} id={photo.id} onDenied={denied}/>)}</div></article></li>)}</ol>
      {after && <button type="button" className="secondary" disabled={loading} onClick={()=>void more()}>Pokaż kolejne komentarze</button>}
      {!comments && error && <button type="button" className="secondary" disabled={loading} onClick={()=>setRevision(value=>value+1)}>Ponów wczytanie dyskusji</button>}
    </>}
    {message && <p className="error" role="alert">{message}</p>}{notice && <p role="status">{notice}</p>}
    {(writable||uncertain)?<form className="comment-form" data-unsaved-draft={!!text || files.length>0 ? 'true' : undefined} onSubmit={event=>{event.preventDefault();void send();}}><label>Treść komentarza<textarea aria-label="Treść komentarza" value={text} maxLength={4000} disabled={busy||uncertain} onChange={event=>store.changeText(event.target.value)} placeholder="Dodaj opis lub same zdjęcia…" /></label>
      <div className="photo-inputs"><label>Zdjęcia z galerii<input aria-label="Zdjęcia z galerii" type="file" accept="image/jpeg,image/png,image/webp" multiple disabled={busy||uncertain} onChange={event=>{select(event.target.files);event.target.value='';}} /></label><label>Zdjęcie z aparatu<input aria-label="Zdjęcie z aparatu" type="file" accept="image/jpeg,image/png,image/webp" capture="environment" disabled={busy||uncertain} onChange={event=>{select(event.target.files);event.target.value='';}} /></label></div>
      <p className="hint">Do 5 zdjęć · 10 MiB/zdjęcie · JPEG, PNG, WebP. Komentarzy nie można edytować ani usuwać.</p><ul className="photo-previews">{files.map((file,i)=><Preview key={`${i}-${file.name}`} file={file} disabled={busy||uncertain} remove={()=>store.removeFile(file)} />)}</ul>
      {busy && <div role="status"><progress max={100} value={progress} />{progress<100?`Wysyłanie: ${progress}%`:'Przetwarzanie zdjęć i oczekiwanie na potwierdzenie…'}</div>}
      {uncertain&&!busy && <p role="status">Wynik wysyłki jest nieznany. Ponowienie zachowa ten sam identyfikator i nie doda drugiego komentarza.</p>}
      <button type="submit" disabled={busy||!online||(!text.trim()&&!files.length)}>{busy?'Wysyłanie…':uncertain?'Ponów komentarz':'Wyślij komentarz'}</button>
    </form>:<p>Projekt archiwalny — dyskusja jest dostępna do odczytu.</p>}</>}
  </section>;
}
