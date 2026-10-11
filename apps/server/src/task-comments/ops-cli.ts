import pg from 'pg';
import {readFile,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {backupMediaDatabase,restoreMediaDatabase,inspectMedia,verifyBackup} from './operations.js';
import {digest} from './images.js';
const [action,target]=process.argv.slice(2),url=process.env.MIGRATION_DATABASE_URL??process.env.DATABASE_URL;
if(!url)throw new Error('Owner PostgreSQL URL required');
const files=process.env.FILES_ROOT??'/srv/sitegrid/files',pool=new pg.Pool({connectionString:url,max:1});
try {
  // Dedicated root CLI opens a peer-authenticated owner connection as postgres,
  // then regains root to read private files. The one established connection is reused.
  if(process.geteuid?.()===0 && process.env.SITEGRID_POSTGRES_UID){
    process.setegid!(Number(process.env.SITEGRID_POSTGRES_GID));process.seteuid!(Number(process.env.SITEGRID_POSTGRES_UID));
    try{const client=await pool.connect();client.release();}finally{process.seteuid!(0);process.setegid!(0);}
  }
  let result;
  if(action==='backup'&&target)result=await backupMediaDatabase(pool,url,files,target);
  else if(action==='restore'&&target){const root=process.env.MIGRATIONS_ROOT??'migrations';const schema=[];
    for(const name of (await readdir(root)).filter(name=>/^\d{3}_.*\.sql$/.test(name)).sort())schema.push({version:Number(name.slice(0,3)),checksum:digest(await readFile(join(root,name)))});
    result=await restoreMediaDatabase(pool,url,files,target,schema);
  }else if(action==='verify-backup'&&target){const manifest=await verifyBackup(target);result={verified:true,mediaCount:manifest.media.length};}
  else if(action==='check'||action==='cleanup')result=await inspectMedia(pool,files,action==='cleanup');
  else throw new Error('Usage: ops-cli.js backup|restore|verify-backup PATH | check | cleanup');
  process.stdout.write(JSON.stringify(result)+'\n');
}finally{await pool.end();}
