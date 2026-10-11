import { constants } from 'node:fs';
import { mkdir, lstat, open, statfs, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { digest, mediaFailure, requestLimit } from './images.js';
const keyPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export async function directory(path:string, create=false) {
  if(create) await mkdir(path,{recursive:true,mode:0o700});
  const info=await lstat(path);
  if(!info.isDirectory() || info.isSymbolicLink()) throw new Error('Unsafe media directory');
}
export async function syncDirectory(path:string) { const file=await open(path,constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); try{await file.sync();}finally{await file.close();} }
export async function ensureSpace(root:string, bytes=requestLimit*3) {
  await directory(root,true);
  const space=await statfs(root);
  if(space.bavail*space.bsize<bytes+256*1024**2) throw mediaFailure(507,'MEDIA_STORAGE_FULL','Brak miejsca na zdjęcia. Skontaktuj się z administratorem.');
}
export async function stageMedia(root:string) {
  await ensureSpace(root); const staging=join(root,'.staging'); await directory(staging,true);
  const path=join(staging,randomUUID()); await mkdir(path,{mode:0o700});
  return {path,clean:()=>rm(path,{recursive:true,force:true})};
}
export async function writeDurable(path:string,data:Buffer) {
  const file=await open(path,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);
  try{await file.writeFile(data);await file.sync();}finally{await file.close();}
}
export async function publishPhoto(root:string,staging:string,id:string,original:Buffer,thumbnail:Buffer) {
  if(!keyPattern.test(id)) throw new Error('Invalid storage key');
  await ensureSpace(root); const path=join(staging,id); await mkdir(path,{mode:0o700});
  await writeDurable(join(path,'original.jpg'),original); await writeDurable(join(path,'thumbnail.jpg'),thumbnail);
  await syncDirectory(path); await rename(path,join(root,id)); await syncDirectory(root);
}
export async function verifiedFile(root:string,id:string,variant:'original'|'thumbnail',bytes:number,hash:string) {
  if(!keyPattern.test(id)) throw new Error('Invalid storage key');
  await directory(root); await directory(join(root,id));
  const file=await open(join(root,id,`${variant}.jpg`),constants.O_RDONLY|constants.O_NOFOLLOW);
  try {
    const info=await file.stat();
    if(!info.isFile() || info.size!==bytes || bytes>10*1024**2) throw new Error('Media integrity failure');
    const data=await file.readFile(); if(digest(data)!==hash) throw new Error('Media integrity failure');
    await file.close(); return data;
  }catch(e){await file.close();throw e;}
}
