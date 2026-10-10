import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import pg from 'pg';
import sharp from 'sharp';
import { buildApp } from '../apps/server/src/app.js';
import { readConfig } from '../apps/server/src/config.js';
import { createPool } from '../apps/server/src/db.js';
import { checkMigrations, migrate, migrationFiles } from '../apps/server/src/migrations.js';
import { withOrganization } from '../apps/server/src/organization-context.js';
import { lockInvitationCompany } from '../apps/server/src/invitations.js';

test('PR11 branding, migration and authorization under real PostgreSQL runtime FORCE RLS', { skip: !process.env.TEST_DATABASE_URL }, async t => {
  assert(process.env.TEST_RUNTIME_DATABASE_URL, 'Set the real unprivileged runtime URL');
  const schema = `branding_test_${randomBytes(6).toString('hex')}`;
  const admin = createPool(process.env.TEST_DATABASE_URL!);
  const ownerUrl = new URL(process.env.TEST_DATABASE_URL!); ownerUrl.searchParams.set('options', `-c search_path=${schema}`);
  const owner = createPool(ownerUrl.href);
  const runtimeUrl = new URL(process.env.TEST_RUNTIME_DATABASE_URL); runtimeUrl.searchParams.set('options', `-c search_path=${schema}`);
  const runtime = new pg.Pool({ connectionString: runtimeUrl.href, max: 6, application_name: schema });
  const config = readConfig({ NODE_ENV: 'test', DATABASE_URL: runtimeUrl.href });
  const app = await buildApp(config, runtime);
  const org = { a: randomUUID(), b: randomUUID(), disabled: randomUUID() };
  const users = Object.fromEntries(['adminA', 'adminB', 'shared', 'worker', 'manager', 'foreman', 'roleless', 'pending', 'inactive', 'platform'].map(name => [name, randomUUID()]));
  const memberships: Record<string, string> = {}, headers: Record<string, Record<string, string>> = {};
  const base = (id = org.a) => `/api/organizations/${id}/branding`;
  const get = (path: string, actor = 'adminA') => app.inject({ url: path, headers: headers[actor] });
  const post = (path: string, payload: unknown, actor = 'adminA', custom?: Record<string, string>) => app.inject({ method: 'POST', url: path, payload, headers: custom ?? headers[actor] });
  const brand = async (id = org.a, actor = 'adminA') => (await get(base(id), actor)).json().branding;
  const update = (version: number, name = 'Firma A zmieniona') => ({ name, accentColor: '#DeA123', expectedVersion: version });
  const image = async (format: 'png' | 'jpeg' | 'webp', background = '#ff0022', width = 32, height = 32) =>
    sharp({ create: { width, height, channels: 3, background } }).toFormat(format).toBuffer();
  const png = await image('png'), jpeg = await image('jpeg'), webp = await image('webp');
  const upload = (data: Buffer, mimeType: string, expectedVersion: number) => ({ data: data.toString('base64'), mimeType, expectedVersion });
  const snapshot = async (table: string) => (await owner.query(`SELECT * FROM ${table} ORDER BY to_jsonb(${table})::text`)).rows;
  const brandingTables = ['organizations', 'organization_settings', 'organization_logos', 'organization_audit_events'];
  const seedMember = async (organizationId: string, name: string, roles: string[], status = 'active') => {
    const id = randomUUID();
    await owner.query('INSERT INTO organization_memberships(organization_id, id, user_id, status) VALUES ($1, $2, $3, $4)', [organizationId, id, users[name], status]);
    for (const role of roles) await owner.query('INSERT INTO membership_roles(organization_id, membership_id, role) VALUES ($1, $2, $3)', [organizationId, id, role]);
    return id;
  };
  const asActor = <T>(id: string, actor: string, work: (client: pg.PoolClient) => Promise<T>) => withOrganization(runtime, id, async client => {
    await client.query("SELECT set_config('sitegrid.user_id', $1, true)", [users[actor]]); return work(client);
  });
  const waitForLock = async () => {
    for (let i = 0; i < 100; i++) {
      if (Number((await owner.query("SELECT count(*) FROM pg_stat_activity WHERE application_name = $1 AND wait_event = 'advisory'", [schema])).rows[0].count)) return;
      await owner.query('SELECT pg_sleep(0.01)');
    }
    assert.fail('Expected branding request waiting on company lock');
  };
  await admin.query(`CREATE SCHEMA ${schema}`);
  try {
    await t.test('schema 7 to 8 preserves all populated PR10 tables and migration history', async () => {
      const previous = await mkdtemp(join(tmpdir(), 'sitegrid-pr11-migrations-'));
      try {
        for (const file of (await migrationFiles('migrations')).filter(file => file.version <= 7)) await copyFile(join('migrations', file.name), join(previous, file.name));
        assert.equal(await migrate(owner, previous), 7);
        for (const [name, id] of Object.entries(users)) {
          await owner.query('INSERT INTO users(id, email) VALUES ($1, $2)', [id, `${name.toLowerCase()}@example.test`]);
          await owner.query("INSERT INTO credentials(user_id, password_hash) VALUES ($1, 'synthetic-preserved-hash')", [id]);
          const raw = randomBytes(32).toString('base64url'), csrf = randomBytes(32).toString('base64url');
          await owner.query("INSERT INTO sessions(token_hash, user_id, csrf_token, expires_at) VALUES ($1, $2, $3, now() + interval '1 hour')", [createHash('sha256').update(raw).digest('hex'), id, csrf]);
          headers[name] = { cookie: `sitegrid=${raw}`, origin: config.origin, 'x-csrf-token': csrf };
        }
        await owner.query('INSERT INTO platform_admins(user_id) VALUES ($1)', [users.platform]);
        for (const [name, id] of Object.entries(org)) await owner.query('INSERT INTO organizations(id, name, status) VALUES ($1, $2, $3)', [id, `Firma ${name}`, name === 'disabled' ? 'inactive' : 'active']);
        memberships.adminA = await seedMember(org.a, 'adminA', ['organization_admin']);
        memberships.adminB = await seedMember(org.b, 'adminB', ['organization_admin']);
        memberships.sharedA = await seedMember(org.a, 'shared', ['organization_admin']);
        memberships.sharedB = await seedMember(org.b, 'shared', ['worker']);
        for (const name of ['worker', 'manager', 'foreman', 'roleless', 'pending', 'inactive']) {
          memberships[name] = await seedMember(org.a, name, name === 'roleless' ? [] : [name === 'pending' || name === 'inactive' ? 'worker' : name], ['pending', 'inactive'].includes(name) ? name : 'active');
        }
        await seedMember(org.disabled, 'shared', ['organization_admin']);
        await owner.query("INSERT INTO employee_profiles(organization_id, membership_id, display_name, phone) VALUES ($1, $2, 'Jan Testowy', '123')", [org.a, memberships.worker]);
        await owner.query("INSERT INTO organization_audit_events(organization_id, actor_id, subject_id, event) VALUES ($1, $2, $3, 'employee_created')", [org.a, users.adminA, memberships.worker]);
        await owner.query("INSERT INTO organization_invitations(organization_id, email, role, issuer_id, token_hash) VALUES ($1, 'invited@example.test', 'worker', $2, $3)", [org.a, users.adminA, randomBytes(32).toString('hex')]);
        await owner.query("INSERT INTO platform_audit_events(actor_id, event, organization_id) VALUES ($1, 'organization_created', $2)", [users.platform, org.a]);
        await owner.query("INSERT INTO auth_rate_limits(key_hash, attempts, expires_at) VALUES ('preserved', 1, now() + interval '1 hour')");
        const tables = (await owner.query("SELECT tablename FROM pg_tables WHERE schemaname = $1 ORDER BY tablename", [schema])).rows.map(row => row.tablename as string);
        const before = await Promise.all(tables.map(snapshot));
        assert.equal(await migrate(owner, 'migrations'), 8); assert.equal(await migrate(owner, 'migrations'), 8);
        assert.equal(await checkMigrations(owner, 'migrations'), 8);
        for (const [i, table] of tables.entries()) assert.deepEqual(table === 'schema_migrations' ? (await snapshot(table)).filter(row => row.version <= 7) : await snapshot(table), before[i], table);
        await assert.rejects(checkMigrations(owner, previous), /does not match/);
      } finally { await rm(previous, { recursive: true, force: true }); }
    });
    await owner.query(`GRANT USAGE ON SCHEMA ${schema} TO sitegrid`);
    await owner.query('GRANT SELECT ON installation, schema_migrations, users, credentials, platform_admins TO sitegrid');
    await owner.query('GRANT SELECT, INSERT, DELETE ON sessions TO sitegrid');
    await owner.query('GRANT SELECT, INSERT, UPDATE, DELETE ON auth_rate_limits TO sitegrid');
    await t.test('defaults are readable by all active company members, with no platform inheritance', async () => {
      for (const actor of ['adminA', 'shared', 'worker', 'manager', 'foreman', 'roleless']) {
        const response = await get(base(), actor); assert.equal(response.statusCode, 200, response.body);
        assert.equal(response.headers['cache-control'], 'no-store');
        assert.deepEqual(response.json().branding, { organizationId: org.a, name: 'Firma a', accentColor: '#163638', version: 1, logo: null });
        assert.equal((await get(base() + '/logo', actor)).statusCode, 404);
      }
      for (const actor of ['pending', 'inactive', 'platform', 'adminB']) {
        assert.equal((await get(base(), actor)).statusCode, 403);
        assert.equal((await get(base() + '/logo', actor)).statusCode, 403);
      }
      assert.equal((await app.inject(base())).statusCode, 401);
      assert.equal((await get(base(org.disabled), 'shared')).statusCode, 403);
      assert.equal((await get('/api/organizations/invalid/branding')).statusCode, 400);
    });
    await t.test('two companies keep independent names, accents, logos and explicit shared-account roles', async () => {
      for (const [id, actor, name, color, data, mime] of [
        [org.a, 'shared', ' Żółć A ', '#Aa1200', png, 'image/png'], [org.b, 'adminB', 'Firma B', '#00aa22', webp, 'image/webp'],
      ] as [string, string, string, string, Buffer, string][]) {
        const response = await post(base(id), { name, accentColor: color, expectedVersion: 1 }, actor);
        assert.equal(response.statusCode, 200, response.body); assert.equal(response.json().branding.version, 2);
        assert.equal(response.json().branding.accentColor, color.toLowerCase());
        assert.equal((await post(base(id) + '/logo', upload(data, mime, 2), actor)).statusCode, 200);
        assert.equal((await brand(id, actor)).logo.version, 3);
      }
      assert.equal((await brand(org.a, 'shared')).name, 'Żółć A'); assert.equal((await brand(org.b, 'shared')).name, 'Firma B');
      const b = await snapshot('organization_logos');
      for (const suffix of ['', '/logo', '/logo/delete']) {
        assert.equal((await post(base(org.b) + suffix, suffix === '' ? update(3) : suffix === '/logo' ? upload(jpeg, 'image/jpeg', 3) : { expectedVersion: 3 }, 'shared')).statusCode, 403);
      }
      assert.deepEqual(await snapshot('organization_logos'), b);
      const organizations = (await get('/api/me/organizations', 'shared')).json().organizations;
      assert.deepEqual(organizations.map((o: { name: string }) => o.name).sort(), ['Firma B', 'Żółć A']);
      assert.equal((await get(`/api/organizations/${org.a}/context`, 'shared')).json().organization.name, 'Żółć A');
      for (const id of [org.a, org.b]) {
        const logo = await get(base(id) + '/logo?version=3', 'shared'); assert.equal(logo.statusCode, 200);
        assert.equal(logo.headers['cache-control'], 'no-store'); assert.equal(logo.headers['x-content-type-options'], 'nosniff');
        assert(logo.rawPayload.length > 0); assert.equal((await sharp(logo.rawPayload).metadata()).format, id === org.a ? 'png' : 'webp');
      }
    });
    await t.test('workers, managers, foremen, roleless, inactive and platform users cannot modify branding', async () => {
      const before = await Promise.all(brandingTables.map(snapshot));
      for (const actor of ['worker', 'manager', 'foreman', 'roleless', 'pending', 'inactive', 'platform', 'adminB']) {
        for (const [suffix, payload] of [['', update(3)], ['/logo', upload(png, 'image/png', 3)], ['/logo/delete', { expectedVersion: 3 }]] as [string, unknown][]) {
          assert.equal((await post(base() + suffix, payload, actor)).statusCode, 403);
        }
      }
      for (const id of [org.b, randomUUID()]) for (const suffix of ['', '/logo']) assert.equal((await get(base(id) + suffix)).statusCode, 403);
      for (const [i, table] of brandingTables.entries()) assert.deepEqual(await snapshot(table), before[i]);
    });
    await t.test('PNG, JPEG and WebP replacement, removal and re-upload use monotonic versions', async () => {
      let version = (await brand()).version;
      for (const [data, mimeType] of [[jpeg, 'image/jpeg'], [webp, 'image/webp']] as [Buffer, string][]) {
        const response = await post(base() + '/logo', upload(data, mimeType, version)); assert.equal(response.statusCode, 200, response.body);
        assert.equal(response.json().branding.version, ++version); assert.equal(response.json().branding.logo.version, version);
        assert.equal((await get(base() + '/logo')).headers['content-type'], mimeType);
        assert.equal((await get(base() + `/logo?version=${version - 1}`)).statusCode, 404);
      }
      const removed = await post(base() + '/logo/delete', { expectedVersion: version }); assert.equal(removed.statusCode, 200);
      assert.equal(removed.json().branding.version, ++version); assert.equal(removed.json().branding.logo, null);
      assert.equal((await get(base() + '/logo')).statusCode, 404);
      const appended = Buffer.concat([png, Buffer.from('<script>EXECUTABLE_TRAILER</script>')]);
      const uploaded = await post(base() + '/logo', upload(appended, 'image/png', version)); assert.equal(uploaded.statusCode, 200, uploaded.body);
      assert.equal(uploaded.json().branding.logo.version, ++version);
      const stored = (await owner.query('SELECT data FROM organization_logos WHERE organization_id = $1', [org.a])).rows[0].data as Buffer;
      assert(!stored.includes(Buffer.from('EXECUTABLE_TRAILER')));
    });
    await t.test('invalid, truncated, animated, oversized and MIME-mismatched content never changes data', async () => {
      const version = (await brand()).version;
      const before = await Promise.all(brandingTables.map(snapshot));
      const frames = Buffer.from([...[255, 0, 0, 255, 0, 0, 255, 0, 0, 255, 0, 0], ...[0, 0, 255, 0, 0, 255, 0, 0, 255, 0, 0, 255]]);
      const animation = await sharp(frames, { raw: { width: 2, height: 4, channels: 3, pageHeight: 2 } }).webp({ delay: [100, 100], loop: 0 }).toBuffer();
      assert.equal((await sharp(animation).metadata()).pages, 2);
      const invalid = [
        upload(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>'), 'image/png', version),
        upload(png, 'image/jpeg', version), upload(jpeg, 'image/webp', version), upload(webp, 'image/png', version),
        upload(png, 'image/svg+xml', version), upload(png, 'image/gif', version),
        upload(png.subarray(0, 36), 'image/png', version), upload(jpeg.subarray(0, 40), 'image/jpeg', version),
        upload(webp.subarray(0, 20), 'image/webp', version), upload(Buffer.from('not-an-image'), 'image/png', version),
        upload(await image('png', '#ff0000', 1025, 1), 'image/png', version),
        upload(await image('png', '#ff0000', 1024, 1025), 'image/png', version), upload(animation, 'image/webp', version),
        { ...upload(png, 'image/png', version), data: '!!!!' }, { ...upload(png, 'image/png', version), data: '' },
        { ...upload(png, 'image/png', version), data: 'data:image/png;base64,' + png.toString('base64') },
        { ...upload(png, 'image/png', version), organizationId: org.b },
      ];
      for (const payload of invalid) { const response = await post(base() + '/logo', payload); assert.equal(response.statusCode, 400, response.body); }
      for (const size of [262145, 300000]) assert.equal((await post(base() + '/logo', upload(Buffer.alloc(size), 'image/png', version))).statusCode, 413);
      for (const payload of [update('1' as unknown as number), update(0), update(1.2), update(Number.MAX_SAFE_INTEGER),
        { ...update(version), name: ' ' }, { ...update(version), name: 'X'.repeat(201) }, { ...update(version), name: 'Firma\nDruga' },
        { ...update(version), accentColor: 'red' }, { ...update(version), accentColor: '#fff' }, { ...update(version), status: 'inactive' },
        { ...update(version), organizationId: org.b }, null, [], {}]) assert.equal((await post(base(), payload)).statusCode, 400);
      assert.equal((await post(base() + '/logo/delete', { expectedVersion: String(version) })).statusCode, 400);
      assert.equal((await get(base() + '/logo?version=bad')).statusCode, 400);
      for (const [i, table] of brandingTables.entries()) assert.deepEqual(await snapshot(table), before[i], table);
      const valid = await post(base() + '/logo', upload(await image('png', '#ffffff', 1024, 1024), 'image/png', version));
      assert.equal(valid.statusCode, 200, valid.body);
    });
    await t.test('Origin and CSRF protect every write', async () => {
      const version = (await brand()).version, before = await Promise.all(brandingTables.map(snapshot));
      const denied = [{ cookie: headers.adminA.cookie }, { ...headers.adminA, origin: 'https://evil.test' },
        { ...headers.adminA, 'x-csrf-token': 'x'.repeat(43) }, { ...headers.adminA, 'x-csrf-token': 'invalid' }];
      for (const supplied of denied) for (const [suffix, payload] of [['', update(version)], ['/logo', upload(png, 'image/png', version)], ['/logo/delete', { expectedVersion: version }]] as [string, unknown][]) {
        assert.equal((await post(base() + suffix, payload, 'adminA', supplied)).statusCode, 403);
      }
      for (const [i, table] of brandingTables.entries()) assert.deepEqual(await snapshot(table), before[i]);
    });
    await t.test('concurrent name edits and logo edits have exactly one winner; stale versions return authorized current state', async () => {
      for (const mixed of [false, true]) {
        const version = (await brand()).version, audits = (await snapshot('organization_audit_events')).length;
        const responses = await Promise.all([post(base(), update(version, 'Wygrana A')),
          mixed ? post(base() + '/logo', upload(jpeg, 'image/jpeg', version)) : post(base(), update(version, 'Wygrana B'))]);
        assert.deepEqual(responses.map(r => r.statusCode).sort(), [200, 409]);
        assert.equal((await brand()).version, version + 1);
        assert.equal((await snapshot('organization_audit_events')).length, audits + 1);
        const conflict = responses.find(r => r.statusCode === 409)!;
        assert.equal(conflict.json().branding.version, version + 1);
        for (const [suffix, payload] of [['', update(version)], ['/logo', upload(png, 'image/png', version)], ['/logo/delete', { expectedVersion: version }]] as [string, unknown][]) {
          assert.equal((await post(base() + suffix, payload)).statusCode, 409);
        }
        assert.equal((await snapshot('organization_audit_events')).length, audits + 1);
      }
    });
    await t.test('transactional audit failure rolls back names, colors, logo bytes and versions', async () => {
      await owner.query(`CREATE FUNCTION reject_branding_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Synthetic audit failure'; END $$`);
      await owner.query('CREATE TRIGGER reject_branding_audit BEFORE INSERT ON organization_audit_events FOR EACH ROW EXECUTE FUNCTION reject_branding_audit()');
      const version = (await brand()).version, before = await Promise.all(brandingTables.map(snapshot));
      try {
        for (const [suffix, payload] of [['', update(version, 'Rolled back')], ['/logo', upload(webp, 'image/webp', version)], ['/logo/delete', { expectedVersion: version }]] as [string, unknown][]) {
          assert.equal((await post(base() + suffix, payload)).statusCode, 503);
          for (const [i, table] of brandingTables.entries()) assert.deepEqual(await snapshot(table), before[i], table);
        }
      } finally { await owner.query('DROP TRIGGER reject_branding_audit ON organization_audit_events'); await owner.query('DROP FUNCTION reject_branding_audit()'); }
      const audit = (await owner.query("SELECT * FROM organization_audit_events WHERE event IN ('branding_updated', 'logo_replaced', 'logo_removed')")).rows;
      assert(audit.some(row => row.event === 'logo_removed'));
      for (const row of audit) {
        assert.equal(row.subject_id, row.organization_id); assert(row.actor_id);
        assert.equal(row.details.afterVersion, row.details.beforeVersion + 1);
        assert(!JSON.stringify(row.details).includes(png.toString('base64')));
      }
    });
    await t.test('runtime RLS, tenant keys, size constraints and column grants provide a second barrier', async () => {
      assert.deepEqual((await runtime.query('SELECT current_user, session_user, rolsuper, rolbypassrls, rolcreaterole FROM pg_roles WHERE rolname = current_user')).rows[0],
        { current_user: 'sitegrid', session_user: 'sitegrid', rolsuper: false, rolbypassrls: false, rolcreaterole: false });
      const flags = (await runtime.query(`SELECT relname, relrowsecurity, relforcerowsecurity, row_security_active(c.oid) AS active,
        pg_has_role(current_user, relowner, 'MEMBER') AS owns, has_table_privilege(current_user, c.oid, 'TRUNCATE') AS truncate
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1
        AND relname IN ('organization_settings', 'organization_logos')`, [schema])).rows;
      assert.equal(flags.length, 2); for (const row of flags) { assert(row.relrowsecurity && row.relforcerowsecurity && row.active); assert(!row.owns && !row.truncate); }
      for (const table of ['organization_settings', 'organization_logos']) assert.deepEqual((await runtime.query(`SELECT * FROM ${table}`)).rows, []);
      await asActor(org.a, 'shared', async client => {
        assert.deepEqual((await client.query('SELECT * FROM organization_logos WHERE organization_id = $1', [org.b])).rows, []);
        assert.equal((await client.query('DELETE FROM organization_logos WHERE organization_id = $1', [org.b])).rowCount, 0);
        assert.equal((await client.query("UPDATE organization_settings SET accent_color = '#111111' WHERE organization_id = $1", [org.b])).rowCount, 0);
      });
      await assert.rejects(asActor(org.a, 'adminA', client => client.query('INSERT INTO organization_settings(organization_id) VALUES ($1)', [org.b])), { code: '42501' });
      await assert.rejects(asActor(org.a, 'adminA', client => client.query("UPDATE organizations SET name = 'Foreign' WHERE id = $1", [org.b])), { code: '42501' });
      await assert.rejects(asActor(org.a, 'adminA', client => client.query("UPDATE organizations SET status = 'inactive' WHERE id = $1", [org.a])), { code: '42501' });
      await asActor(org.a, 'worker', async client => {
        assert.equal((await client.query('SELECT * FROM organization_logos')).rows.length, 1);
        assert.equal((await client.query('DELETE FROM organization_logos')).rowCount, 0);
        assert.equal((await client.query("UPDATE organization_settings SET accent_color = '#111111'")).rowCount, 0);
      });
      await assert.rejects(asActor(org.a, 'worker', client => client.query("UPDATE organizations SET name = 'Forbidden' WHERE id = $1", [org.a])), { code: '42501' });
      await assert.rejects(asActor(org.a, 'adminA', client => client.query("UPDATE organization_logos SET data = $1", [Buffer.alloc(262145)])), { code: '23514' });
      await assert.rejects(owner.query('INSERT INTO organization_logos(organization_id, data, mime_type, version) VALUES ($1, $2, $3, 2)', [org.disabled, png, 'image/png']), { code: '23503' });
      assert.deepEqual((await runtime.query("SELECT NULLIF(current_setting('sitegrid.organization_id', true), '') AS tenant, NULLIF(current_setting('sitegrid.user_id', true), '') AS actor")).rows[0], { tenant: null, actor: null });
    });
    await t.test('revocations apply on the next request and after waiting for the company lock', async () => {
      const version = (await brand()).version;
      const blocker = await owner.connect();
      try {
        await blocker.query('BEGIN'); await lockInvitationCompany(blocker, org.a);
        const waiting = Promise.resolve(post(base(), update(version), 'shared'));
        await waitForLock();
        await blocker.query("DELETE FROM membership_roles WHERE organization_id = $1 AND membership_id = $2 AND role = 'organization_admin'", [org.a, memberships.sharedA]);
        await blocker.query('COMMIT'); assert.equal((await waiting).statusCode, 403);
      } finally { await blocker.query('ROLLBACK'); blocker.release(); }
      assert.equal((await get(base(), 'shared')).statusCode, 200);
      assert.equal((await post(base() + '/logo', upload(png, 'image/png', version), 'shared')).statusCode, 403);
      await owner.query("UPDATE organization_memberships SET status = 'inactive' WHERE organization_id = $1 AND id = $2", [org.a, memberships.sharedA]);
      assert.equal((await get(base(), 'shared')).statusCode, 403); assert.equal((await get(base() + '/logo', 'shared')).statusCode, 403);
      assert.equal((await get(base(org.b), 'shared')).statusCode, 200); assert.equal((await get(base(org.b) + '/logo', 'shared')).statusCode, 200);
      await owner.query('UPDATE users SET blocked_at = now() WHERE id = $1', [users.worker]);
      assert.equal((await get(base() + '/logo', 'worker')).statusCode, 401);
      await owner.query("UPDATE organizations SET status = 'inactive' WHERE id = $1", [org.a]);
      assert.equal((await get(base())).statusCode, 403); assert.equal((await get(base() + '/logo')).statusCode, 403);
    });
  } finally {
    await app.close(); await runtime.end(); await owner.end();
    try { await admin.query(`DROP SCHEMA ${schema} CASCADE`); } finally { await admin.end(); }
  }
});
