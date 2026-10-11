import multipart from '@fastify/multipart';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance,FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import type { Config } from '../config.js';
import { readSession, type Session } from '../auth/session.js';
import { projectAccess,identifier,uuid,type Params,failure } from '../task-management/access.js';
import { writeOrganizationAudit } from '../common/audit.js';
import { normalizePhoto,photoLimit,requestLimit,digest,mediaFailure } from './images.js';
import { publishPhoto,stageMedia,verifiedFile } from './storage.js';
import { requireTask,readComment,commentColumns } from './persistence.js';

export async function registerTaskCommentRoutes(app:FastifyInstance,pool:Pool,config:Config,
  checkCsrf:(request:FastifyRequest,session?:Session)=>boolean) {
  await app.register(multipart,{limits:{fileSize:photoLimit,files:5,fields:2,fieldSize:16000,fieldNameSize:32,parts:7,headerPairs:32}});
  const {params,scope,project,writable}=projectAccess(pool,config,checkCsrf);
  const base='/api/organizations/:id/projects/:projectId/tasks/:taskId/comments';
  let activeUploads=0;
  app.get<{Params:Params;Querystring:{after?:string}}>(base,{schema:{...params('projectId','taskId'),querystring:{type:'object',additionalProperties:false,properties:{after:uuid}}}},request=>scope(request,false,false,async client=>{
    await project(client,request,['organization_admin','manager','foreman','worker']); await requireTask(client,request.params);
    const p=request.params;
    if(request.query.after && !(await readComment(client,p,request.query.after)))throw failure(404);
    const rows=(await client.query(`SELECT ${commentColumns} FROM task_comments c
      WHERE (c.organization_id,c.project_id,c.task_id)=($1,$2,$3) AND ($4::uuid IS NULL OR (c.created_at,c.id)>(
        SELECT cursor.created_at,cursor.id FROM task_comments cursor WHERE (cursor.organization_id,cursor.project_id,cursor.task_id,cursor.id)=($1,$2,$3,$4)))
      ORDER BY c.created_at,c.id LIMIT 21`,[p.id,p.projectId,p.taskId,request.query.after??null])).rows;
    return {comments:rows.slice(0,20),nextAfter:rows.length>20?rows[19].id:null};
  }));
  app.post<{Params:Params}>(base,{schema:params('projectId','taskId'),
    preParsing:async(request,_reply,payload)=>{
      if(Number(request.headers['content-length']??0)>requestLimit) throw mediaFailure(413,'REQUEST_TOO_LARGE','Żądanie przekracza 50 MiB.');
      return payload;
    }},async(request,reply)=>{
    if(activeUploads>=2) return reply.header('Retry-After','5').code(429).send({code:'UPLOAD_BUSY',error:'Trwa przetwarzanie zdjęć. Spróbuj za chwilę.'});
    activeUploads++;
    let received=0;
    const count=(chunk:Buffer)=>{received+=chunk.length;if(received>requestLimit)request.raw.emit('error',mediaFailure(413,'REQUEST_TOO_LARGE','Żądanie przekracza 50 MiB.'));};
    let staging:Awaited<ReturnType<typeof stageMedia>>|undefined;
    const timer=setTimeout(()=>request.raw.destroy(),60_000); timer.unref();
    try {
      const result=await scope(request,true,false,async(client,actor)=>{
        const current=await project(client,request,['organization_admin','manager','foreman','worker']); await requireTask(client,request.params);
        // Same maintenance lock covers staging, publication and commit; cleanup cannot race uploads.
        await client.query("SELECT pg_advisory_xact_lock_shared(hashtextextended('sitegrid.media',0))");
        if(!request.isMultipart()) throw mediaFailure(415,'UPLOAD_MULTIPART_REQUIRED','Wyślij komentarz jako formularz ze zdjęciami.');
        const values:Record<string,string>={},photos:({id:string}&Awaited<ReturnType<typeof normalizePhoto>>)[]=[];
        const parts=request.parts();
        request.raw.on('data',count);
        for await(const part of parts) {
          if(part.type==='field') {
            if(!['text','commentId'].includes(part.fieldname) || Object.hasOwn(values,part.fieldname) || typeof part.value!=='string' || part.valueTruncated) throw failure(400);
            values[part.fieldname]=part.value;
          } else {
            if(part.fieldname!=='photos') {part.file.resume();throw failure(400);}
            const input=await part.toBuffer(); if(part.file.truncated) throw mediaFailure(413,'PHOTO_TOO_LARGE','Zdjęcie przekracza 10 MiB.');
            photos.push({id:randomUUID(),...await normalizePhoto(input,part.mimetype)});
          }
        }
        const commentId=identifier(values.commentId),text=(values.text??'').trim();
        if([...text].length>4000 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text) || (!text && !photos.length)) throw mediaFailure(400,'COMMENT_EMPTY','Dodaj tekst lub przynajmniej jedno zdjęcie (maksymalnie 4000 znaków).');
        const hash=digest(JSON.stringify({text,photos:photos.map(p=>p.original_sha256)}));
        // Recheck credentials after reading the upload, including idempotent retry.
        const session=await readSession(client,request,config); if(!session?.user_id) throw failure(401);
        if(!checkCsrf(request,session)) throw failure(403); await requireTask(client,request.params);
        const existing=(await client.query(`SELECT author_membership_id,payload_sha256 FROM task_comments WHERE (organization_id,project_id,task_id,id)=($1,$2,$3,$4)`,[request.params.id,request.params.projectId,request.params.taskId,commentId])).rows[0];
        if(existing){if(existing.author_membership_id!==actor.membershipId || existing.payload_sha256!==hash)throw mediaFailure(409,'COMMENT_ID_CONFLICT','Identyfikator komentarza został już użyty.');return {comment:await readComment(client,request.params,commentId),replayed:true};}
        writable(current);
        const author=(await client.query(`SELECT COALESCE(NULLIF(e.display_name,''),u.email) AS name FROM organization_memberships m JOIN users u ON u.id=m.user_id
          LEFT JOIN employee_profiles e ON (e.organization_id,e.membership_id)=(m.organization_id,m.id) WHERE (m.organization_id,m.id)=($1,$2)`,[request.params.id,actor.membershipId])).rows[0];
        if(photos.length){staging=await stageMedia(config.filesRoot);
          for(const photo of photos) await publishPhoto(config.filesRoot,staging.path,photo.id,photo.original,photo.thumbnail);}
        const p=request.params;
        await client.query(`INSERT INTO task_comments(organization_id,project_id,task_id,id,author_membership_id,author_name,text,photo_count,payload_sha256) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[p.id,p.projectId,p.taskId,commentId,actor.membershipId,author.name,text,photos.length,hash]);
        for(const [position,photo] of photos.entries()) {
          await client.query(`INSERT INTO task_comment_media(organization_id,project_id,task_id,comment_id,id,position,original_bytes,thumbnail_bytes,original_sha256,thumbnail_sha256,width,height)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,[p.id,p.projectId,p.taskId,commentId,photo.id,position,photo.original_bytes,photo.thumbnail_bytes,photo.original_sha256,photo.thumbnail_sha256,photo.width,photo.height]);
          await writeOrganizationAudit(client,p.id,actor.userId,p.taskId,'task_media_attached',{projectId:p.projectId,commentId,mediaId:photo.id,position,sha256:photo.original_sha256});
        }
        await writeOrganizationAudit(client,p.id,actor.userId,p.taskId,'task_comment_created',{projectId:p.projectId,commentId,photoCount:photos.length});
        return {comment:await readComment(client,p,commentId),replayed:false};
      });
      return reply.code(result.replayed?200:201).send(result);
    } catch(e) {
      if(received>requestLimit)throw mediaFailure(413,'REQUEST_TOO_LARGE','Żądanie przekracza 50 MiB.');
      if(/FST_(?:REQ_FILE_TOO_LARGE|FILES_LIMIT|FIELDS_LIMIT|PARTS_LIMIT)/.test((e as {code?:string}).code??'')) throw mediaFailure(413,'UPLOAD_LIMIT','Maksymalnie 5 zdjęć po 10 MiB, 50 MiB na żądanie.');
      throw e;
    } finally {request.raw.removeListener('data',count);clearTimeout(timer);activeUploads--;await staging?.clean();}
  });
  for(const variant of ['thumbnail','original'] as const) app.get<{Params:Params & {mediaId:string}}>(`${base}/media/:mediaId/${variant}`,{schema:params('projectId','taskId','mediaId')},async(request,reply)=>{
    const data=await scope(request,false,false,async client=>{
      await project(client,request,['organization_admin','manager','foreman','worker']);await requireTask(client,request.params);
      const p=request.params,m=(await client.query(`SELECT * FROM task_comment_media WHERE (organization_id,project_id,task_id,id)=($1,$2,$3,$4)`,[p.id,p.projectId,p.taskId,p.mediaId])).rows[0];
      if(!m)throw failure(404);
      return verifiedFile(config.filesRoot,m.id,variant,m[`${variant}_bytes`],m[`${variant}_sha256`]);
    });
    return reply.header('Cache-Control','private, no-store').header('Cross-Origin-Resource-Policy','same-origin').header('Content-Disposition',`inline; filename="photo-${variant}.jpg"`).type('image/jpeg').send(data);
  });
}
