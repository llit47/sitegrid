// Owner-only operational lifecycle. Runtime HTTP never imports this module.
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {open,mkdir,lstat,readdir,readFile,rename,rm,statfs} from 'node:fs/promises';
import {join} from 'node:path';
import type {Pool,PoolClient} from 'pg';
import {directory,verifiedFile,syncDirectory,writeDurable} from './storage.js';
import {digest} from './images.js';
export type MediaRecord={id:string;original_bytes:number;thumbnail_bytes:number;original_sha256:string;thumbnail_sha256:string};
type Manifest={format:1;schema:{version:number;checksum:string}[];dumpSha256:string;media:MediaRecord[];createdAt:string};
const lock="SELECT pg_advisory_xact_lock(hashtextextended('sitegrid.media',0))";
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export async function hashFile(path:string){const hash=createHash('sha256');for await(const chunk of createReadStream(path))hash.update(chunk);return hash.digest('hex');}
export async function runPg(program:string,args:string[],url:string,io:{input?:string;output?:string}={}) {
  const connection=new URL(url),env={...process.env,PGHOST:connection.searchParams.get('host')??connection.hostname,PGPORT:connection.port||'5432',PGUSER:decodeURIComponent(connection.username),PGPASSWORD:decodeURIComponent(connection.password),PGDATABASE:decodeURIComponent(connection.pathname.slice(1)),PGOPTIONS:connection.searchParams.get('options')??'',PGSSLMODE:connection.searchParams.get('sslmode')??'prefer'};
  const input=io.input?await open(io.input,'r'):undefined,output=io.output?await open(io.output,'wx',0o600):undefined;
  try {
    await new Promise<void>((resolve,reject)=>{const child=spawn(program,args,{env,
      ...(process.env.SITEGRID_POSTGRES_UID?{uid:Number(process.env.SITEGRID_POSTGRES_UID),gid:Number(process.env.SITEGRID_POSTGRES_GID)}:{}),
      stdio:[input?.fd??'ignore',output?.fd??'ignore','pipe']});let detail='';
      child.stderr!.on('data',chunk=>{if(detail.length<2000)detail+=chunk.toString();});child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(new Error(`${program} failed (${code}): ${detail}`)));});
    await output?.sync();
  }finally{await input?.close();await output?.close();}
}

async function inventory(client:PoolClient){
  // row_security=off fails closed if an operator accidentally uses a restricted role.
  await client.query('SET LOCAL row_security=off');
  const exists=(await client.query("SELECT to_regclass('task_comment_media') IS NOT NULL AS exists")).rows[0].exists;
  return exists?(await client.query<MediaRecord>('SELECT id,original_bytes,thumbnail_bytes,original_sha256,thumbnail_sha256 FROM task_comment_media ORDER BY id')).rows:[];
}
async function verifyRecords(root:string,records:MediaRecord[]){
  const seen=new Set<string>();for(const record of records){
    if(!uuid.test(record.id)||seen.has(record.id))throw new Error('Invalid media inventory');seen.add(record.id);
    for(const variant of ['original','thumbnail'] as const) await verifiedFile(root,record.id,variant,record[`${variant}_bytes`],record[`${variant}_sha256`]);
  }
}
async function space(root:string,bytes:number){const disk=await statfs(root);if(disk.bavail*disk.bsize<bytes+256*1024**2)throw new Error('Insufficient storage space');}
async function copyMedia(source:string,target:string,records:MediaRecord[]){
  await directory(target,true);
  for(const record of records){const path=join(target,record.id);await mkdir(path,{mode:0o700});
    for(const variant of ['original','thumbnail'] as const)await writeDurable(join(path,`${variant}.jpg`),await verifiedFile(source,record.id,variant,record[`${variant}_bytes`],record[`${variant}_sha256`]));
    await syncDirectory(path);
  }await syncDirectory(target);
}
export async function backupMediaDatabase(pool:Pool,url:string,files:string,destination:string,pgDump='pg_dump') {
  const client=await pool.connect(),incoming=destination+'.incoming';
  try{
    await mkdir(incoming,{mode:0o700});await mkdir(join(incoming,'files'),{mode:0o700});
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');await client.query(lock);
    const records=await inventory(client),schema=(await client.query('SELECT version,checksum FROM schema_migrations ORDER BY version')).rows;
    const size=Number((await client.query('SELECT pg_database_size(current_database()) AS bytes')).rows[0].bytes);
    await space(incoming,size*2+records.reduce((sum,row)=>sum+row.original_bytes+row.thumbnail_bytes,0));
    await verifyRecords(files,records);
    const snapshot=(await client.query('SELECT pg_export_snapshot() AS snapshot')).rows[0].snapshot;
    const dump=join(incoming,'database.dump');await runPg(pgDump,['--format=custom','--snapshot='+snapshot],url,{output:dump});
    await runPg(pgDump.replace(/pg_dump$/,'pg_restore'),['--list'],url,{input:dump});
    await copyMedia(files,join(incoming,'files'),records);
    const manifest:Manifest={format:1,schema,dumpSha256:await hashFile(dump),media:records,createdAt:new Date().toISOString()};
    await writeDurable(join(incoming,'manifest.json'),Buffer.from(JSON.stringify(manifest,null,2)+'\n'));await syncDirectory(incoming);
    await client.query('COMMIT');await rename(incoming,destination);await syncDirectory(join(destination,'..'));
    return {path:destination,sha256:digest(JSON.stringify(manifest)),mediaCount:records.length};
  }catch(e){await client.query('ROLLBACK').catch(()=>{});throw e;}finally{client.release();}
}
export async function verifyBackup(backup:string){
  await directory(backup);const path=join(backup,'manifest.json');if((await lstat(path)).size>64*1024**2)throw new Error('Backup inventory too large');
  const manifest=JSON.parse(await readFile(path,'utf8')) as Manifest;
  if(manifest.format!==1||!Array.isArray(manifest.media)||!Array.isArray(manifest.schema)||!/^[a-f0-9]{64}$/.test(manifest.dumpSha256))throw new Error('Invalid backup manifest');
  if(await hashFile(join(backup,'database.dump'))!==manifest.dumpSha256)throw new Error('Corrupted database dump');
  await verifyRecords(join(backup,'files'),manifest.media);return manifest;
}
export async function restoreMediaDatabase(pool:Pool,url:string,files:string,backup:string,expectedSchema:{version:number;checksum:string}[],pgRestore='pg_restore') {
  const manifest=await verifyBackup(backup);
  if(JSON.stringify(manifest.schema)!==JSON.stringify(expectedSchema))throw new Error('Backup schema is incompatible with selected release');
  const client=await pool.connect();
  try{
    await client.query('BEGIN');await client.query(lock);
    if((await client.query("SELECT count(*) FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema')")).rows[0].count!=='0')throw new Error('Restore requires a new empty database; preserve the existing database first');
    await directory(files,true);if((await readdir(files)).length)throw new Error('Restore requires an empty media directory');
    await space(files,manifest.media.reduce((n,m)=>n+m.original_bytes+m.thumbnail_bytes,0));
    // Media is durable first. A failed DB restore leaves recoverable files, never reports success.
    await copyMedia(join(backup,'files'),files,manifest.media);
    await runPg(pgRestore,['--exit-on-error','--single-transaction','--dbname='+new URL(url).pathname.slice(1)],url,{input:join(backup,'database.dump')});
    const restored=await inventory(client);if(JSON.stringify(restored)!==JSON.stringify(manifest.media))throw new Error('Restored relationships differ from backup');
    await verifyRecords(files,restored);await client.query('COMMIT');return {restored:true,mediaCount:restored.length};
  }catch(e){await client.query('ROLLBACK').catch(()=>{});throw e;}finally{client.release();}
}
export async function inspectMedia(pool:Pool,files:string,cleanup=false,now=Date.now()) {
  const client=await pool.connect();try{
    await client.query('BEGIN');await client.query(lock);const records=await inventory(client);await verifyRecords(files,records);
    await directory(files,true);const referenced=new Set(records.map(row=>row.id)),orphans:string[]=[],removed:string[]=[];
    for(const name of await readdir(files)) {
      if(name==='.staging')continue;
      if(!uuid.test(name))throw new Error('Unexpected entry in media storage');if(referenced.has(name))continue;
      const path=join(files,name);await directory(path);orphans.push(name);
      if(cleanup && now-(await lstat(path)).mtimeMs>=24*60*60*1000){await rm(path,{recursive:true});removed.push(name);}
    }
    const staging=join(files,'.staging');let pending:string[]=[];
    try{await directory(staging);pending=await readdir(staging);for(const name of pending){if(!uuid.test(name))throw new Error('Unexpected staging entry');const path=join(staging,name);await directory(path);
      if(cleanup&&now-(await lstat(path)).mtimeMs>=24*60*60*1000)await rm(path,{recursive:true});}}
    catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
    await syncDirectory(files);await client.query('COMMIT');const disk=await statfs(files);return {referenced:records.length,freeBytes:disk.bavail*disk.bsize,orphans,staging:pending,removed};
  }catch(e){await client.query('ROLLBACK').catch(()=>{});throw e;}finally{client.release();}
}
// Independent retained backups contain copies, never hard links. Cleanup touches only live unreferenced files.
