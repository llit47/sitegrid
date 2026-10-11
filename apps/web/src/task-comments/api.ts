export type Photo={id:string;width:number;height:number};
export type Comment={id:string;text:string;authorMembershipId:string;authorName:string;createdAt:string;photos:Photo[]};
export function sendComment(path:string,csrf:string,text:string,files:readonly File[],id:string,progress:(percent:number)=>void,signal:AbortSignal) {
  return new Promise<{comment:Comment}>((resolve,reject)=>{
    const xhr=new XMLHttpRequest(),form=new FormData();form.append('commentId',id);form.append('text',text);for(const file of files)form.append('photos',file);
    xhr.open('POST',path+'/comments');xhr.setRequestHeader('X-CSRF-Token',csrf);xhr.timeout=65000;
    xhr.upload.onprogress=event=>{if(event.lengthComputable)progress(Math.round(event.loaded/event.total*100));};
    const abort=()=>xhr.abort();signal.addEventListener('abort',abort,{once:true});
    const failed=(status=0,message='Nie otrzymano potwierdzenia. Ponów ten sam komentarz po odzyskaniu połączenia.')=>reject(Object.assign(new Error(message),{status}));
    xhr.onerror=()=>failed();xhr.ontimeout=()=>failed();xhr.onabort=()=>failed();
    xhr.onload=()=>{let data;try{data=JSON.parse(xhr.responseText);}catch{return failed(xhr.status);}if(xhr.status>=200 && xhr.status<300)resolve(data);else failed(xhr.status,data.error);};
    xhr.onloadend=()=>signal.removeEventListener('abort',abort);
    xhr.send(form);
  });
}
