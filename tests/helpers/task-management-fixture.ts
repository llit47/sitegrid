import pg from 'pg';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { buildApp } from '../../apps/server/src/app.js';
import { readConfig } from '../../apps/server/src/config.js';
import { migrate, migrationFiles } from '../../apps/server/src/migrations.js';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export async function taskFixture({ legacy = false, legacyVersion = 11, serveWeb = false } = {}) {
  if (!process.env.TEST_DATABASE_URL || !process.env.TEST_RUNTIME_DATABASE_URL) throw new Error('Real owner and unprivileged runtime PostgreSQL URLs required');
  const schema = `tasks_v2_${randomBytes(6).toString('hex')}`, admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const ownerUrl = new URL(process.env.TEST_DATABASE_URL), runtimeUrl = new URL(process.env.TEST_RUNTIME_DATABASE_URL);
  for (const url of [ownerUrl,runtimeUrl]) url.searchParams.set('options', `-c search_path=${schema}`);
  const owner = new pg.Pool({ connectionString: ownerUrl.href }), runtime = new pg.Pool({ connectionString: runtimeUrl.href, application_name:schema });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const config = readConfig({ NODE_ENV:'test',DATABASE_URL:runtimeUrl.href });
  const app = await buildApp(config,runtime,{ serveWeb });
  const organizations = { a:randomUUID(), b:randomUUID() }, users: Record<string,string> = {}, members: Record<string,string> = {};
  const tokens: Record<string,string> = {}, headers: Record<string,Record<string,string>> = {}, projects: string[] = [];
  const close = async () => { await app.close(); await runtime.end(); await owner.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); };
  try {
    if (legacy) {
      const directory = await mkdtemp(join(tmpdir(),'tasks-schema11-'));
      try { for (const file of (await migrationFiles('migrations')).filter(file => file.version<=legacyVersion)) await copyFile(join('migrations',file.name),join(directory,file.name)); await migrate(owner,directory); }
      finally { await rm(directory,{ recursive:true,force:true }); }
    } else await migrate(owner,'migrations');
    await owner.query(`GRANT USAGE ON SCHEMA ${schema} TO sitegrid`);
    await owner.query('GRANT SELECT ON installation,schema_migrations,users,credentials,platform_admins TO sitegrid');
    await owner.query('GRANT SELECT,INSERT,DELETE ON sessions TO sitegrid');
    await owner.query('GRANT SELECT,INSERT,UPDATE,DELETE ON auth_rate_limits TO sitegrid');
    for (const [id,name] of [[organizations.a,'Firma A'],[organizations.b,'Firma B']]) await owner.query('INSERT INTO organizations(id,name) VALUES ($1,$2)',[id,name]);
    for (const [name,role,tenant] of [['admin','organization_admin',organizations.a],['manager','manager',organizations.a],['foreman','foreman',organizations.a],['worker','worker',organizations.a],['other','worker',organizations.a],['roleless',null,organizations.a],['foreign','organization_admin',organizations.b],['platform',null,null]]) {
      users[name!] = randomUUID(); tokens[name!] = randomBytes(32).toString('base64url');
      const csrf = randomBytes(32).toString('base64url');
      await owner.query('INSERT INTO users(id,email) VALUES ($1,$2)',[users[name!],`${name}@example.test`]);
      await owner.query("INSERT INTO credentials(user_id,password_hash) VALUES ($1,'preserved-hash')",[users[name!]]);
      if (tenant) {
        members[name!] = randomUUID();
        await owner.query("INSERT INTO organization_memberships(organization_id,id,user_id,status) VALUES ($1,$2,$3,'active')",[tenant,members[name!],users[name!]]);
        if (role) await owner.query('INSERT INTO membership_roles(organization_id,membership_id,role) VALUES ($1,$2,$3)',[tenant,members[name!],role]);
        await owner.query('INSERT INTO employee_profiles(organization_id,membership_id,display_name,phone) VALUES ($1,$2,$3,$4)',[tenant,members[name!],name,'private-phone']);
      }
      await owner.query("INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at) VALUES ($1,$2,$3,now()+interval '1 hour')",[createHash('sha256').update(tokens[name!]).digest('hex'),users[name!],csrf]);
      headers[name!] = { cookie:`sitegrid=${tokens[name!]}`,origin:config.origin,'x-csrf-token':csrf };
    }
    await owner.query('INSERT INTO platform_admins(user_id) VALUES ($1)',[users.platform]);
    members.workerB=randomUUID();
    await owner.query("INSERT INTO organization_memberships(organization_id,id,user_id,status) VALUES ($1,$2,$3,'active')",[organizations.b,members.workerB,users.worker]);
    await owner.query("INSERT INTO membership_roles(organization_id,membership_id,role) VALUES ($1,$2,'worker')",[organizations.b,members.workerB]);
    for (let i=0;i<3;i++) projects.push((await owner.query('INSERT INTO projects(organization_id,name) VALUES ($1,$2) RETURNING id',[organizations.a,`Projekt ${i+1}`])).rows[0].id);
    const foreignProject=(await owner.query("INSERT INTO projects(organization_id,name) VALUES ($1,'Obcy projekt') RETURNING id",[organizations.b])).rows[0].id;
    return { schema,owner,runtime,config,app,organizations,users,members,tokens,headers,projects,foreignProject,close };
  } catch (e) { await close(); throw e; }
}
