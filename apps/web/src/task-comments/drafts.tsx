import {createContext,useContext,useRef,useCallback,useEffect,type ReactNode} from 'react';
import {useDraftGuard} from '../workspace/navigation-safety.js';
export type Draft={text:string;files:File[];id:string;uncertain:boolean};
type Memory={scope:string|null;drafts:Map<string,Draft>};
const memories=new Set<Memory>();
export function clearDiscussionDraftMemory(){for(const memory of memories){memory.scope=null;memory.drafts.clear();}}
const PageMemory=createContext<Memory|null>(null),Drafts=createContext<Map<string,Draft>|null>(null);
// Page memory survives the existing reconnect remount. No history, disk queue or IDB writes.
export function DiscussionDraftMemory({children}:{children:ReactNode}) {
  const memory=useRef<Memory>({scope:null,drafts:new Map()});
  useEffect(()=>{memories.add(memory.current);return()=>{memories.delete(memory.current);};},[]);
  useEffect(()=>{
    if(!('BroadcastChannel' in window))return;
    try {
      const channel=new BroadcastChannel('sitegrid-account-change');
      channel.onmessage=event=>{if(event.data==='changed'){memory.current.scope=null;memory.current.drafts.clear();}};
      return()=>channel.close();
    } catch { /* Account scope still clears on the next authorized workspace mount. */ }
  },[]);
  useDraftGuard(useCallback(()=>[...memory.current.drafts.values()].some(draft=>!!draft.text||draft.files.length>0||draft.uncertain),[]));
  return <PageMemory.Provider value={memory.current}>{children}</PageMemory.Provider>;
}
export function DiscussionDrafts({scope,children}:{scope:string;children:ReactNode}) {
  const page=useContext(PageMemory),fallback=useRef<Memory>({scope:null,drafts:new Map()}),memory=page??fallback.current;
  if(memory.scope!==scope){memory.scope=scope;memory.drafts.clear();}
  return <Drafts.Provider value={memory.drafts}>{children}</Drafts.Provider>;
}
export function useDiscussionDraft(path:string) {
  const store=useContext(Drafts),fallback=useRef(new Map<string,Draft>()),drafts=store??fallback.current;
  if(!drafts.has(path))drafts.set(path,{text:'',files:[],id:crypto.randomUUID(),uncertain:false});
  return drafts.get(path)!;
}
