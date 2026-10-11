import {useEffect,useRef,useState} from 'react';
import {observeAccessFailure} from '../offline/account.js';
export function PhotoView({path,id,onDenied}:{path:string;id:string;onDenied:()=>void}) {
  const [thumbnail,setThumbnail]=useState(''),[original,setOriginal]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const modal=useRef<HTMLDialogElement>(null),lifetime=useRef<AbortController|null>(null);
  useEffect(()=>{const controller=new AbortController();lifetime.current=controller;let url='';
    void load('thumbnail',controller.signal).then(blob=>{if(!controller.signal.aborted){url=URL.createObjectURL(blob);setThumbnail(url);}}).catch(e=>{if(!controller.signal.aborted)setError(e.message);});
    return ()=>{controller.abort();if(url)URL.revokeObjectURL(url);};
  },[path,id]);
  useEffect(()=>()=>{if(original)URL.revokeObjectURL(original);},[original]);
  async function load(variant:string,signal:AbortSignal){
    const response=await fetch(`${path}/comments/media/${id}/${variant}`,{signal,cache:'no-store',credentials:'same-origin'});
    if(!response.ok){await observeAccessFailure(path,response.status);if([401,403,404].includes(response.status))onDenied();throw new Error('Nie udało się pobrać zdjęcia. Sprawdź połączenie i dostęp do zadania.');}return response.blob();
  }
  const expand=async()=>{if(busy)return;setBusy(true);setError('');
    try{const blob=await load('original',lifetime.current!.signal);if(lifetime.current!.signal.aborted)return;setOriginal(URL.createObjectURL(blob));modal.current?.showModal();}
    catch(e){if(!lifetime.current?.signal.aborted)setError((e as Error).message);}finally{if(!lifetime.current?.signal.aborted)setBusy(false);}
  };
  return <div className="discussion-photo">{thumbnail?<button type="button" className="photo-button" onClick={()=>void expand()} disabled={busy} aria-label="Powiększ zdjęcie"><img src={thumbnail} alt="Zdjęcie do komentarza" /></button>:!error && <span role="status">Ładowanie zdjęcia…</span>}
    {busy && <span role="status">Pobieranie oryginału…</span>}{error && <p className="error" role="alert">{error}<button type="button" className="secondary" onClick={()=>void expand()}>Ponów pobieranie zdjęcia</button></p>}
    <dialog ref={modal} className="photo-dialog" aria-label="Powiększone zdjęcie" onClose={()=>setOriginal('')}><button type="button" onClick={()=>modal.current?.close()}>Zamknij zdjęcie</button>{original && <img src={original} alt="Pełne zdjęcie do komentarza" />}</dialog>
  </div>;
}
