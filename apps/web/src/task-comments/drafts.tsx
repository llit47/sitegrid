import {createContext,useContext,useRef,useCallback,useEffect,useSyncExternalStore,type ReactNode} from 'react';
import {useDraftGuard} from '../workspace/navigation-safety.js';

type Payload=Readonly<{text:string;files:readonly File[];id:string}>;
type Draft=Payload & Readonly<{uncertain:boolean;busy:boolean;progress:number;revision:number;notice:string;error:string}>;
type Submission=Readonly<{payload:Payload}>;
const emptyDraft=():Draft=>Object.freeze({text:'',files:Object.freeze([] as File[]),id:crypto.randomUUID(),uncertain:false,busy:false,progress:0,revision:0,notice:'',error:''});

function createDraftStore() {
  let draft=emptyDraft(),active=true,submission:Submission|null=null,frozen:Payload|null=null;
  const listeners=new Set<()=>void>();
  const publish=(next:Draft)=>{draft=Object.freeze(next);for(const listener of listeners)listener();};
  const editable=()=>active&&!draft.busy&&!draft.uncertain;
  const edit=(text:string,files:readonly File[])=>{
    if(editable())publish({...draft,text,files:Object.freeze([...files]),id:crypto.randomUUID(),notice:'',error:''});
  };
  return {
    subscribe:(listener:()=>void)=>{listeners.add(listener);return()=>{listeners.delete(listener);};},
    getSnapshot:()=>draft,
    changeText:(text:string)=>edit(text,draft.files),
    addFiles:(files:readonly File[])=>edit(draft.text,[...draft.files,...files]),
    removeFile:(file:File)=>edit(draft.text,draft.files.filter(item=>item!==file)),
    reportError:(error:string)=>{if(editable())publish({...draft,error});},
    begin:():Submission|null=>{
      if(!active||draft.busy||(!draft.text.trim()&&!draft.files.length))return null;
      // Keep the exact payload across ambiguous results, including another view or reconnect.
      frozen??=Object.freeze({text:draft.text,files:draft.files,id:draft.id});
      submission=Object.freeze({payload:frozen});
      publish({...draft,busy:true,uncertain:true,progress:0,notice:'',error:''});
      return submission;
    },
    progress:(attempt:Submission,progress:number)=>{if(active&&submission===attempt)publish({...draft,progress});},
    succeed:(attempt:Submission)=>{
      if(!active||submission!==attempt)return;
      submission=null;frozen=null;
      publish({...emptyDraft(),revision:draft.revision+1,notice:'Serwer potwierdził dodanie komentarza.'});
    },
    fail:(attempt:Submission,error:{message:string;status?:number})=>{
      if(!active||submission!==attempt)return false;
      const rejected=(error.status??0)>=400&&(error.status??0)<500;
      submission=null;if(rejected)frozen=null;
      publish({...draft,busy:false,uncertain:!rejected,error:error.message});
      return true;
    },
    invalidate:(notify:boolean)=>{
      active=false;submission=null;frozen=null;
      const next=emptyDraft();if(notify)publish(next);else draft=next;
    }
  };
}
type DraftStore=ReturnType<typeof createDraftStore>;
type Memory={scope:string|null;drafts:Map<string,DraftStore>};
const memories=new Set<Memory>();
function resetMemory(memory:Memory,notify=true){
  for(const store of memory.drafts.values())store.invalidate(notify);
  memory.scope=null;memory.drafts=new Map();
}
export function clearDiscussionDraftMemory(){for(const memory of memories)resetMemory(memory);}
const PageMemory=createContext<Memory|null>(null),Drafts=createContext<Map<string,DraftStore>|null>(null);
// Page memory survives the existing reconnect remount. No history, disk queue or IDB writes.
export function DiscussionDraftMemory({children}:{children:ReactNode}) {
  const memory=useRef<Memory>({scope:null,drafts:new Map()});
  useEffect(()=>{memories.add(memory.current);return()=>{memories.delete(memory.current);};},[]);
  useEffect(()=>{
    if(!('BroadcastChannel' in window))return;
    try {
      const channel=new BroadcastChannel('sitegrid-account-change');
      channel.onmessage=event=>{if(event.data==='changed')resetMemory(memory.current);};
      return()=>channel.close();
    } catch { /* Account scope still clears on the next authorized workspace mount. */ }
  },[]);
  useDraftGuard(useCallback(()=>[...memory.current.drafts.values()].some(store=>{const draft=store.getSnapshot();return !!draft.text||draft.files.length>0||draft.uncertain;}),[]));
  return <PageMemory.Provider value={memory.current}>{children}</PageMemory.Provider>;
}
export function DiscussionDrafts({scope,children}:{scope:string;children:ReactNode}) {
  const page=useContext(PageMemory),fallback=useRef<Memory>({scope:null,drafts:new Map()}),memory=page??fallback.current;
  // A new context map rerenders every consumer; retire old attempts without notifying in render.
  if(memory.scope!==scope){resetMemory(memory,false);memory.scope=scope;}
  return <Drafts.Provider value={memory.drafts}>{children}</Drafts.Provider>;
}
export function useDiscussionDraft(path:string) {
  const context=useContext(Drafts),fallback=useRef(new Map<string,DraftStore>()),drafts=context??fallback.current;
  if(!drafts.has(path))drafts.set(path,createDraftStore());
  const store=drafts.get(path)!;
  const draft=useSyncExternalStore(store.subscribe,store.getSnapshot);
  return {draft,store};
}
