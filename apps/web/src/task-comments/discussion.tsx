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
  const draft=useDiscussionDraft(path),root=useRef<HTMLElement>(null),sending=useRef(false),lifetime=useRef<AbortController|null>(null);
  const [open,setOpen]=useState(false),[comments,setComments]=useState<Comment[]|null>(null),[after,setAfter]=useState<string|null>(null);
  const [online,setOnline]=useState(navigator.onLine),[text,setText]=useState(draft.text),[files,setFiles]=useState(draft.files),[uncertain,setUncertain]=useState(draft.uncertain);
  const [busy,setBusy]=useState(false),[loading,setLoading]=useState(false),[progress,setProgress]=useState(0),[error,setError]=useState(''),[notice,setNotice]=useState(''),[revision,setRevision]=useState(0);
  usePendingOperation(busy||uncertain);
  useEffect(()=>{const controller=new AbortController();lifetime.current=controller;const changed=()=>{setOnline(navigator.onLine);setComments(null);setAfter(null);};window.addEventListener('online',changed);window.addEventListener('offline',changed);return()=>{controller.abort();window.removeEventListener('online',changed);window.removeEventListener('offline',changed);};},[]);
  const denied=()=>{setComments(null);setAfter(null);onAccessChanged();};
  const failed=async(e:{message:string;status?:number})=>{setError(e.message);if([401,403,404].includes(e.status??0)){await observeAccessFailure(path,e.status!);denied();}};
  useEffect(()=>{if(!open||!online)return;const controller=new AbortController();setComments(null);setError('');setLoading(true);
    void request<{comments:Comment[];nextAfter:string|null}>(path+'/comments',controller.signal).then(data=>{if(!controller.signal.aborted){setComments(data.comments);setAfter(data.nextAfter);}}).catch(e=>{if(!controller.signal.aborted)void failed(e);}).finally(()=>{if(!controller.signal.aborted)setLoading(false);});return()=>controller.abort();
  },[path,open,online,revision]);
  const changeText=(value:string)=>{draft.text=value;draft.id=crypto.randomUUID();setText(value);};
  const changeFiles=(value:File[])=>{draft.files=value;draft.id=crypto.randomUUID();setFiles(value);};
  const select=(selected:FileList|null)=>{if(!selected)return;const items=Array.from(selected);setError('');
    if(files.length+items.length>5){setError('Maksymalnie 5 zdjęć na komentarz.');return;}
    if(items.some(file=>file.size>10*1024**2)){setError('Każde zdjęcie może mieć maksymalnie 10 MiB.');return;}
    if(items.some(file=>/\.(heic|heif)$/i.test(file.name)||/hei[cf]/i.test(file.type))){setError('HEIC/HEIF nie jest obsługiwany. Wybierz zdjęcie w formacie JPEG, PNG lub WebP.');return;}
    if(items.some(file=>!['image/jpeg','image/png','image/webp'].includes(file.type))){setError('Wybierz zdjęcia JPEG, PNG lub WebP.');return;}changeFiles([...files,...items]);
  };
  const send=async()=>{if(sending.current||!online||(!writable&&!uncertain))return;sending.current=true;setBusy(true);setError('');setNotice('');setProgress(0);draft.uncertain=true;setUncertain(true);
    try{await sendComment(path,csrfToken,draft.text,draft.files,draft.id,setProgress,lifetime.current!.signal);if(lifetime.current!.signal.aborted)return;draft.text='';draft.files=[];draft.id=crypto.randomUUID();draft.uncertain=false;setUncertain(false);setText('');setFiles([]);setNotice('Serwer potwierdził dodanie komentarza.');setRevision(value=>value+1);}
    catch(e){if(!lifetime.current!.signal.aborted){const status=(e as {status:number}).status;if(status>=400&&status<500){draft.uncertain=false;setUncertain(false);}await failed(e as Error);}}
    finally{if(!lifetime.current!.signal.aborted){sending.current=false;setBusy(false);}}
  };
  const more=async()=>{if(loading||!after)return;setLoading(true);setError('');try{const data=await request<{comments:Comment[];nextAfter:string|null}>(path+'/comments?after='+after,lifetime.current!.signal);setComments(current=>[...(current??[]),...data.comments.filter(item=>!current?.some(old=>old.id===item.id))]);setAfter(data.nextAfter);}catch(e){await failed(e as Error);}finally{if(!lifetime.current!.signal.aborted)setLoading(false);}};
  return <section className="discussion" ref={root} aria-label={`Dyskusja: ${title}`}><button type="button" className="secondary" aria-expanded={open} disabled={busy} onClick={()=>{if(!open||guardWorkspaceChange(root.current!))setOpen(!open);}}>{open?'Zwiń dyskusję':'Komentarze i zdjęcia'}</button>
    {open && <><p className="hint">Dyskusja i zdjęcia wymagają połączenia z internetem.</p>{!online?<p role="status">Brak połączenia. Szkic pozostaje w tym widoku; odzyskaj połączenie, aby czytać i wysyłać.</p>:<>
      {loading && <p role="status">Ładowanie dyskusji…</p>}{comments?.length===0 && <p>Brak komentarzy. Rozpocznij dyskusję.</p>}
      <ol className="comment-list">{comments?.map(comment=><li key={comment.id}><article><header><strong>{comment.authorName}</strong><time dateTime={comment.createdAt}>{new Date(comment.createdAt).toLocaleString('pl-PL')}</time></header>{comment.text && <p className="comment-text">{comment.text}</p>}<div className="comment-photos">{comment.photos.map(photo=><PhotoView key={photo.id} path={path} id={photo.id} onDenied={denied}/>)}</div></article></li>)}</ol>
      {after && <button type="button" className="secondary" disabled={loading} onClick={()=>void more()}>Pokaż kolejne komentarze</button>}
      {!comments && error && <button type="button" className="secondary" disabled={loading} onClick={()=>setRevision(value=>value+1)}>Ponów wczytanie dyskusji</button>}
    </>}
    {error && <p className="error" role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    {(writable||uncertain)?<form className="comment-form" data-unsaved-draft={!!text || files.length>0 ? 'true' : undefined} onSubmit={event=>{event.preventDefault();void send();}}><label>Treść komentarza<textarea aria-label="Treść komentarza" value={text} maxLength={4000} disabled={busy||uncertain} onChange={event=>changeText(event.target.value)} placeholder="Dodaj opis lub same zdjęcia…" /></label>
      <div className="photo-inputs"><label>Zdjęcia z galerii<input aria-label="Zdjęcia z galerii" type="file" accept="image/jpeg,image/png,image/webp" multiple disabled={busy||uncertain} onChange={event=>{select(event.target.files);event.target.value='';}} /></label><label>Zdjęcie z aparatu<input aria-label="Zdjęcie z aparatu" type="file" accept="image/jpeg,image/png,image/webp" capture="environment" disabled={busy||uncertain} onChange={event=>{select(event.target.files);event.target.value='';}} /></label></div>
      <p className="hint">Do 5 zdjęć · 10 MiB/zdjęcie · JPEG, PNG, WebP. Komentarzy nie można edytować ani usuwać.</p><ul className="photo-previews">{files.map((file,i)=><Preview key={`${i}-${file.name}`} file={file} disabled={busy||uncertain} remove={()=>changeFiles(files.filter((_,index)=>index!==i))} />)}</ul>
      {busy && <div role="status"><progress max={100} value={progress} />{progress<100?`Wysyłanie: ${progress}%`:'Przetwarzanie zdjęć i oczekiwanie na potwierdzenie…'}</div>}
      {uncertain&&!busy && <p role="status">Wynik wysyłki jest nieznany. Ponowienie zachowa ten sam identyfikator i nie doda drugiego komentarza.</p>}
      <button type="submit" disabled={busy||!online||(!text.trim()&&!files.length)}>{busy?'Wysyłanie…':uncertain?'Ponów komentarz':'Wyślij komentarz'}</button>
    </form>:<p>Projekt archiwalny — dyskusja jest dostępna do odczytu.</p>}</>}
  </section>;
}
