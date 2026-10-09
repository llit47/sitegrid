import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { readConfig } from '../apps/server/src/config.js';
import { createPool } from '../apps/server/src/db.js';
import { buildApp } from '../apps/server/src/app.js';
import { bootstrapAdmin } from '../apps/server/src/auth/bootstrap.js';
import { migrate } from '../apps/server/src/migrations.js';
import { invitationHash, deliverInvitation, lockInvitationCompany } from '../apps/server/src/invitations.js';
import { withTransaction, withOrganization } from '../apps/server/src/organization-context.js';

// A local SMTP protocol fixture exercises Nodemailer without sending external mail.
async function smtpFixture() {
  const messages: string[] = [], recipients: string[] = [];
  let reject = false;
  const server = createServer(socket => {
    socket.setEncoding('utf8'); socket.write('220 fixture ESMTP\r\n');
    let buffer = '', data = false, message = '';
    socket.on('data', chunk => {
      buffer += chunk;
      while (buffer.includes('\r\n')) {
        const end = buffer.indexOf('\r\n'), line = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        if (data) {
          if (line === '.') { messages.push(message); data = false; message = ''; socket.write('250 accepted\r\n'); }
          else message += line + '\r\n';
        } else if (line.startsWith('EHLO')) socket.write('250-fixture\r\n250 OK\r\n');
        else if (line === 'STARTTLS') socket.write('454 TLS unavailable\r\n');
        else if (line.startsWith('RCPT')) { recipients.push(line); socket.write(reject ? '550 unavailable\r\n' : '250 OK\r\n'); }
        else if (line === 'DATA') { data = true; socket.write('354 send message\r\n'); }
        else if (line === 'QUIT') { socket.end('221 bye\r\n'); }
        else socket.write('250 OK\r\n');
      }
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return { messages, recipients, port: (server.address() as { port: number }).port,
    reject: () => { reject = true; }, close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
}
const env = { NODE_ENV: 'test', DATABASE_URL: 'postgresql://localhost/test' };
test('SMTP config rejects insecure fallback and incomplete settings', () => {
  assert.throws(() => readConfig({ ...env, NODE_ENV: 'production', PUBLIC_ORIGIN: 'https://example.test', INVITATION_MANUAL_LINKS: 'true' }), /development-only/);
  for (const values of [{ SMTP_HOST: 'localhost' }, { SMTP_PORT: '25' }, { SMTP_HOST: 'localhost', SMTP_FROM: 'sender@example.test', SMTP_PORT: '0' },
    { SMTP_HOST: 'localhost', SMTP_FROM: 'sender@example.test', SMTP_USER: 'user' }, { SMTP_SECURE: 'invalid' }, { INVITATION_MANUAL_LINKS: 'invalid' }]) {
    assert.throws(() => readConfig({ ...env, ...values }));
  }
});
test('SMTP delivers a single fragment link and reports failure without a token; production requires STARTTLS', async () => {
  const smtp = await smtpFixture();
  const config = readConfig({ ...env, SMTP_HOST: '127.0.0.1', SMTP_PORT: String(smtp.port), SMTP_FROM: 'sender@example.test' });
  const token = randomBytes(32).toString('base64url');
  const created = { invitation: { email: 'invited@example.test', status: 'pending' }, token, organizationName: 'Company' };
  try {
    const sent = await deliverInvitation(config, created);
    assert.equal(sent.delivery, 'sent');
    assert(!JSON.stringify(sent).includes(token));
    const message = smtp.messages[0].replace(/=\r\n/g, '').replace(/=([0-9A-F]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
    assert(message.includes(`${config.origin}/invitations/accept#${token}`));
    assert.equal(message.split(token).length - 1, 1);
    assert.deepEqual(smtp.recipients, ['RCPT TO:<invited@example.test>']);
    const production = await deliverInvitation({ ...config, production: true }, created);
    assert.equal(production.delivery, 'failed', 'SMTP without STARTTLS must fail in production');
    smtp.reject();
    const failed = await deliverInvitation(config, created);
    assert.equal(failed.delivery, 'failed');
    assert(!JSON.stringify(failed).includes(token));
  } finally { await smtp.close(); }
});

test('email invitations and first administrator activation under runtime RLS', { skip: !process.env.TEST_DATABASE_URL }, async t => {
  assert(process.env.TEST_RUNTIME_DATABASE_URL, 'Invitation tests require a real unprivileged sitegrid login');
  const schema = `invitations_test_${randomBytes(6).toString('hex')}`;
  const admin = createPool(process.env.TEST_DATABASE_URL!);
  const ownerUrl = new URL(process.env.TEST_DATABASE_URL!); ownerUrl.searchParams.set('options', `-c search_path=${schema}`);
  const owner = createPool(ownerUrl.href);
  const runtimeUrl = new URL(process.env.TEST_RUNTIME_DATABASE_URL); runtimeUrl.searchParams.set('options', `-c search_path=${schema}`);
  const runtime = new pg.Pool({ connectionString: runtimeUrl.href, max: 5 });
  const config = readConfig({ NODE_ENV: 'test', DATABASE_URL: runtimeUrl.href, INVITATION_MANUAL_LINKS: 'true' });
  const app = await buildApp(config, runtime);
  const password = randomBytes(24).toString('base64url');
  type Headers = { cookie: string; origin: string; 'x-csrf-token': string };
  const anonymous = async (): Promise<Headers> => {
    const response = await app.inject('/api/auth/session');
    assert.equal(response.statusCode, 200);
    return { cookie: `${response.cookies[0].name}=${response.cookies[0].value}`, origin: config.origin, 'x-csrf-token': response.json().csrfToken };
  };
  const login = async (email: string): Promise<Headers> => {
    const response = await app.inject({ method: 'POST', url: '/api/auth/login', headers: await anonymous(), payload: { email, password } });
    assert.equal(response.statusCode, 200);
    const cookie = `${response.cookies[0].name}=${response.cookies[0].value}`;
    return { cookie, origin: config.origin, 'x-csrf-token': (await app.inject({ url: '/api/auth/session', headers: { cookie } })).json().csrfToken };
  };
  const post = (url: string, payload: unknown, headers: Record<string, string>) => app.inject({ method: 'POST', url, headers, payload });
  const get = (url: string, headers: Record<string, string>) => app.inject({ url, headers });
  const tokenOf = (result: { acceptanceLink: string }) => new URL(result.acceptanceLink).hash.slice(1);
  const inspect = async (token: string, headers: Headers) => (await post('/api/invitations/inspect', { token }, headers)).json();
  const accept = (token: string, headers: Headers, fields = {}) => post('/api/invitations/accept', { token, ...fields }, headers);
  const invitePath = (id: string, platform = false) => `/api/${platform ? 'admin/' : ''}organizations/${id}/invitations`;
  const invite = async (id: string, headers: Headers, email: string, role = 'worker', platform = false) => {
    const response = await post(invitePath(id, platform), { email, ...(platform ? {} : { role }) }, headers);
    assert.equal(response.statusCode, 201, response.body);
    return response.json();
  };
  await admin.query(`CREATE SCHEMA ${schema}`);
  try {
    await t.test('schema 5 upgrade preserves global and tenant records and is repeatable', async () => {
      const previous = await mkdtemp(join(tmpdir(), 'sitegrid-pr9-migrations-'));
      try {
        for (const name of ['001_installation.sql', '002_auth.sql', '003_organizations.sql', '004_memberships_roles.sql', '005_organization_access.sql']) {
          await copyFile(join('migrations', name), join(previous, name));
        }
        assert.equal(await migrate(owner, previous), 5);
        await bootstrapAdmin(owner, 'platform@example.test', password);
        for (const email of ['existing@example.test', 'wrong@example.test']) {
          const id = randomUUID();
          await owner.query('INSERT INTO users(id, email) VALUES ($1, $2)', [id, email]);
          await owner.query('INSERT INTO credentials(user_id, password_hash) SELECT $1, password_hash FROM credentials LIMIT 1', [id]);
        }
        const tables = ['users', 'credentials', 'platform_admins', 'organizations', 'organization_memberships', 'membership_roles', 'sessions'];
        const before = await Promise.all(tables.map(table => owner.query(`SELECT * FROM ${table} ORDER BY 1`)));
        assert.equal(await migrate(owner, 'migrations'), 6);
        assert.equal(await migrate(owner, 'migrations'), 6);
        for (const [i, table] of tables.entries()) assert.deepEqual((await owner.query(`SELECT * FROM ${table} ORDER BY 1`)).rows, before[i].rows);
      } finally { await rm(previous, { recursive: true, force: true }); }
    });
    // Mirror installer grants. Migration 006 alone must grant required account INSERTs.
    await owner.query(`GRANT USAGE ON SCHEMA ${schema} TO sitegrid`);
    await owner.query('GRANT SELECT ON installation, schema_migrations, users, credentials, platform_admins TO sitegrid');
    await owner.query('GRANT SELECT, INSERT, DELETE ON sessions TO sitegrid');
    await owner.query('GRANT SELECT, INSERT, UPDATE, DELETE ON auth_rate_limits TO sitegrid');
    const platform = await login('platform@example.test'), existing = await login('existing@example.test'), wrong = await login('wrong@example.test'), anon = await anonymous();
    let organizationA = '', organizationB = '', firstToken = '', firstInvitationId = '';
    await t.test('platform creates a company and hashed, pending first-admin invitation atomically', async () => {
      const response = await post('/api/admin/organizations', { name: 'Firma A', administratorEmail: '  FIRST@EXAMPLE.TEST ' }, platform);
      assert.equal(response.statusCode, 201, response.body);
      const created = response.json(); organizationA = created.organization.id; firstToken = tokenOf(created); firstInvitationId = created.invitation.id;
      assert.equal(created.delivery, 'manual'); assert.equal(created.invitation.status, 'pending');
      assert.equal(created.invitation.role, 'organization_admin');
      const stored = (await owner.query('SELECT * FROM organization_invitations WHERE id = $1', [firstInvitationId])).rows[0];
      assert.equal(stored.token_hash, createHash('sha256').update(firstToken).digest('hex'));
      assert(!JSON.stringify(stored).includes(firstToken));
      assert.equal(stored.expires_at.getTime() - stored.created_at.getTime(), 24 * 3600000);
      assert.equal((await owner.query('SELECT count(*) FROM organization_memberships')).rows[0].count, '0');
      const list = await get(invitePath(organizationA, true), platform);
      assert.equal(list.headers['cache-control'], 'no-store');
      assert(!list.body.includes(firstToken)); assert(!list.body.includes(stored.token_hash));
      assert.equal((await get('/api/me/organizations', platform)).json().organizations.length, 0);
      assert.equal((await get(invitePath(organizationA), platform)).statusCode, 403);
    });
    await t.test('GET and inspection do not consume links or disclose account existence', async () => {
      assert.equal((await app.inject(`/api/invitations/accept?token=${firstToken}`)).statusCode, 404);
      for (let i = 0; i < 2; i++) assert.deepEqual(await inspect(firstToken, anon), { status: 'pending', organizationName: 'Firma A' });
      assert.deepEqual(await inspect(randomBytes(32).toString('base64url'), anon), { status: 'unavailable' });
      assert.deepEqual(await inspect('bad-token', anon), { status: 'unavailable' });
    });
    await t.test('new-account activation enforces identity/password and assigns first-admin role', async () => {
      assert.equal((await accept(firstToken, anon, { email: 'other@example.test', password })).statusCode, 409);
      assert.equal((await accept(firstToken, anon, { email: 'first@example.test', password: 'short' })).statusCode, 400);
      assert.equal((await accept(firstToken, anon, { email: 'FIRST@example.test', password })).statusCode, 200);
      assert.deepEqual(await inspect(firstToken, anon), { status: 'accepted' });
      assert.equal((await accept(firstToken, anon, { email: 'first@example.test', password })).statusCode, 409);
      const membership = (await owner.query(`SELECT m.status, r.role FROM organization_memberships m JOIN membership_roles r
        ON (r.organization_id, r.membership_id) = (m.organization_id, m.id) WHERE m.organization_id = $1`, [organizationA])).rows;
      assert.deepEqual(membership, [{ status: 'active', role: 'organization_admin' }]);
      assert.equal((await owner.query("SELECT count(*) FROM platform_admins p JOIN users u ON p.user_id = u.id WHERE u.email = 'first@example.test'")).rows[0].count, '0');
    });
    const companyAdmin = await login('first@example.test');
    await t.test('first company administrator can invite; platform cannot create further company administrators', async () => {
      assert.equal((await get(invitePath(organizationA), companyAdmin)).statusCode, 200);
      assert.equal((await post(invitePath(organizationA, true), { email: 'extra@example.test' }, platform)).statusCode, 409);
      const response = await post('/api/admin/organizations', { name: 'Firma B' }, platform);
      organizationB = response.json().organization.id;
      const first = await invite(organizationB, platform, 'existing@example.test', 'organization_admin', true);
      assert.equal((await accept(tokenOf(first), existing)).statusCode, 200);
    });
    await t.test('existing account must log in to the invited email; password and other-company membership are preserved', async () => {
      const beforeCredentials = (await owner.query('SELECT * FROM credentials ORDER BY user_id')).rows;
      const beforeB = (await owner.query('SELECT * FROM organization_memberships WHERE organization_id = $1', [organizationB])).rows;
      const invitation = await invite(organizationA, companyAdmin, 'existing@example.test', 'foreman');
      const token = tokenOf(invitation);
      const unauthenticated = await accept(token, anon, { email: 'existing@example.test', password });
      const wrongAccount = await accept(token, wrong);
      assert.equal(unauthenticated.statusCode, 409); assert.equal(wrongAccount.statusCode, 409);
      assert.deepEqual(unauthenticated.json(), wrongAccount.json());
      assert.equal((await accept(token, existing, { password: 'ignored-existing-password' })).statusCode, 200);
      assert.deepEqual((await owner.query('SELECT * FROM credentials ORDER BY user_id')).rows, beforeCredentials);
      assert.deepEqual((await owner.query('SELECT * FROM organization_memberships WHERE organization_id = $1', [organizationB])).rows, beforeB);
      const organizations = (await get('/api/me/organizations', existing)).json().organizations;
      assert.deepEqual(organizations.map((o: { name: string; roles: string[] }) => ({ name: o.name, roles: o.roles })), [
        { name: 'Firma A', roles: ['foreman'] }, { name: 'Firma B', roles: ['organization_admin'] },
      ]);
      assert.equal((await get(`/api/organizations/${organizationA}/context`, existing)).statusCode, 200);
      assert.equal((await get(`/api/organizations/${organizationB}/context`, existing)).statusCode, 200);
      assert.equal((await get(invitePath(organizationA), existing)).statusCode, 403);
    });
    await t.test('existing target-company memberships and roles are never overwritten or reactivated', async () => {
      const before = (await owner.query('SELECT * FROM membership_roles WHERE organization_id = $1 ORDER BY membership_id, role', [organizationA])).rows;
      const redundant = await invite(organizationA, companyAdmin, 'existing@example.test', 'organization_admin');
      assert.equal((await accept(tokenOf(redundant), existing)).statusCode, 200);
      assert.deepEqual((await owner.query('SELECT * FROM membership_roles WHERE organization_id = $1 ORDER BY membership_id, role', [organizationA])).rows, before);
      await owner.query("UPDATE organization_memberships SET status = 'inactive' WHERE organization_id = $1 AND user_id = (SELECT id FROM users WHERE email = 'existing@example.test')", [organizationA]);
      const inactive = await invite(organizationA, companyAdmin, 'existing@example.test');
      assert.equal((await accept(tokenOf(inactive), existing)).statusCode, 409);
      assert.equal((await get(`/api/organizations/${organizationA}/context`, existing)).statusCode, 403);
      assert.equal((await get(`/api/organizations/${organizationB}/context`, existing)).statusCode, 200);
      await owner.query("UPDATE organization_memberships SET status = 'active' WHERE organization_id = $1 AND user_id = (SELECT id FROM users WHERE email = 'existing@example.test')", [organizationA]);
    });
    await t.test('cross-company IDs, forged roles and platform privileges are denied', async () => {
      for (const id of [organizationB, randomUUID()]) {
        assert.equal((await get(invitePath(id), companyAdmin)).statusCode, 403);
        assert.equal((await post(invitePath(id), { email: 'foreign@example.test', role: 'worker' }, companyAdmin)).statusCode, 403);
      }
      for (const role of ['platform_admin', 'unknown', 123]) {
        assert.equal((await post(invitePath(organizationA), { email: 'extra@example.test', role }, companyAdmin)).statusCode, 400);
      }
      assert.equal((await post(invitePath(organizationA, true), { email: 'extra@example.test' }, companyAdmin)).statusCode, 403);
      assert.equal((await get(invitePath(organizationA), anon)).statusCode, 401);
      const own = await invite(organizationB, existing, 'foreign@example.test');
      assert.equal((await post(`${invitePath(organizationA)}/${own.invitation.id}/revoke`, {}, companyAdmin)).statusCode, 409);
      assert.equal((await post(`${invitePath(organizationB)}/${own.invitation.id}/revoke`, {}, companyAdmin)).statusCode, 403);
      assert.equal((await post(`${invitePath(organizationB, true)}/${own.invitation.id}/revoke`, {}, platform)).statusCode, 409);
    });
    await t.test('revocation and replacement invalidate prior links including changed first-admin recipients', async () => {
      const revoked = await invite(organizationA, companyAdmin, 'revoked@example.test');
      assert.equal((await post(`${invitePath(organizationA)}/${revoked.invitation.id}/revoke`, {}, companyAdmin)).statusCode, 200);
      assert.deepEqual(await inspect(tokenOf(revoked), anon), { status: 'revoked' });
      assert.equal((await accept(tokenOf(revoked), anon, { email: 'revoked@example.test', password })).statusCode, 409);
      const old = await invite(organizationA, companyAdmin, 'replace@example.test');
      const replacement = await invite(organizationA, companyAdmin, 'replace@example.test', 'manager');
      assert.deepEqual(await inspect(tokenOf(old), anon), { status: 'revoked' });
      assert.equal((await accept(tokenOf(old), anon, { email: 'replace@example.test', password })).statusCode, 409);
      assert.equal((await accept(tokenOf(replacement), anon, { email: 'replace@example.test', password })).statusCode, 200);
      const company = (await post('/api/admin/organizations', { name: 'Firma C', administratorEmail: 'old-first@example.test' }, platform)).json();
      const newFirst = await invite(company.organization.id, platform, 'new-first@example.test', 'organization_admin', true);
      assert.deepEqual(await inspect(tokenOf(company), anon), { status: 'revoked' });
      assert.equal((await accept(tokenOf(newFirst), anon, { email: 'new-first@example.test', password })).statusCode, 200);
    });
    await t.test('expiry is checked at acceptance and creates no account', async () => {
      const expired = await invite(organizationA, companyAdmin, 'expired@example.test');
      await owner.query("UPDATE organization_invitations SET created_at = now() - interval '25 hours', expires_at = now() - interval '1 hour' WHERE id = $1", [expired.invitation.id]);
      assert.deepEqual(await inspect(tokenOf(expired), anon), { status: 'expired' });
      assert.equal((await accept(tokenOf(expired), anon, { email: 'expired@example.test', password })).statusCode, 409);
      assert.equal((await owner.query("SELECT count(*) FROM users WHERE email = 'expired@example.test'")).rows[0].count, '0');
      assert((await get(invitePath(organizationA), companyAdmin)).json().invitations.some((i: { id: string; status: string }) => i.id === expired.invitation.id && i.status === 'expired'));
    });
    await t.test('expiration during account creation rolls back every onboarding write', async () => {
      const invitation = await invite(organizationA, companyAdmin, 'expiring@example.test');
      // Delay the INSERT until after expiry, after Argon2 and the initial state check.
      await owner.query(`CREATE FUNCTION delay_invited_user() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.email = 'expiring@example.test' THEN PERFORM pg_sleep(0.3); END IF; RETURN NEW; END $$`);
      await owner.query('CREATE TRIGGER delay_invited_user BEFORE INSERT ON users FOR EACH ROW EXECUTE FUNCTION delay_invited_user()');
      try {
        await owner.query("UPDATE organization_invitations SET created_at = now() - interval '1 minute', expires_at = now() + interval '250 milliseconds' WHERE id = $1", [invitation.invitation.id]);
        assert.equal((await accept(tokenOf(invitation), anon, { email: 'expiring@example.test', password })).statusCode, 409);
        assert.equal((await owner.query("SELECT count(*) FROM users WHERE email = 'expiring@example.test'")).rows[0].count, '0');
        assert.deepEqual(await inspect(tokenOf(invitation), anon), { status: 'expired' });
      } finally {
        await owner.query('DROP TRIGGER delay_invited_user ON users'); await owner.query('DROP FUNCTION delay_invited_user()');
      }
    });
    await t.test('concurrent acceptance has exactly one winner for new and existing users', async () => {
      for (const [email, headers, fields] of [['concurrent@example.test', anon, { email: 'concurrent@example.test', password }], ['wrong@example.test', wrong, {}]] as const) {
        const invitation = await invite(organizationA, companyAdmin, email);
        const results = await Promise.all(Array.from({ length: 4 }, () => accept(tokenOf(invitation), headers, fields)));
        assert.deepEqual(results.map(result => result.statusCode).sort(), [200, 409, 409, 409]);
        assert.equal((await owner.query('SELECT count(*) FROM users WHERE email = $1', [email])).rows[0].count, '1');
        assert.equal((await owner.query(`SELECT count(*) FROM organization_memberships WHERE organization_id = $1 AND user_id = (SELECT id FROM users WHERE email = $2)`, [organizationA, email])).rows[0].count, '1');
      }
    });
    await t.test('concurrent first-admin acceptance creates one administrator; concurrent new identity across companies needs login for the second', async () => {
      const company = (await post('/api/admin/organizations', { name: 'Concurrent first', administratorEmail: 'concurrent-first@example.test' }, platform)).json();
      const firstResults = await Promise.all(Array.from({ length: 3 }, () => accept(tokenOf(company), anon, { email: 'concurrent-first@example.test', password })));
      assert.deepEqual(firstResults.map(result => result.statusCode).sort(), [200, 409, 409]);
      assert.equal((await owner.query("SELECT count(*) FROM membership_roles WHERE organization_id = $1 AND role = 'organization_admin'", [company.organization.id])).rows[0].count, '1');
      const invitedEmail = 'concurrent-global@example.test';
      const a = await invite(organizationA, companyAdmin, invitedEmail, 'worker');
      const b = await invite(organizationB, existing, invitedEmail, 'manager');
      const results = await Promise.all([accept(tokenOf(a), anon, { email: invitedEmail, password }), accept(tokenOf(b), anon, { email: invitedEmail, password })]);
      assert.deepEqual(results.map(result => result.statusCode).sort(), [200, 409]);
      assert.equal((await owner.query('SELECT count(*) FROM users WHERE email = $1', [invitedEmail])).rows[0].count, '1');
      const loggedIn = await login(invitedEmail);
      assert.equal((await accept(tokenOf(results[0].statusCode === 200 ? b : a), loggedIn)).statusCode, 200);
      const contexts = (await get('/api/me/organizations', loggedIn)).json().organizations;
      assert.deepEqual(contexts.map((o: { roles: string[] }) => o.roles), [['worker'], ['manager']]);
    });
    await t.test('acceptance and revocation racing for the same link cannot both succeed', async () => {
      const invitation = await invite(organizationA, companyAdmin, 'race-revoke@example.test');
      const [accepted, revoked] = await Promise.all([
        accept(tokenOf(invitation), anon, { email: 'race-revoke@example.test', password }),
        post(`${invitePath(organizationA)}/${invitation.invitation.id}/revoke`, {}, companyAdmin),
      ]);
      assert.deepEqual([accepted.statusCode, revoked.statusCode].sort(), [200, 409]);
      const final = await inspect(tokenOf(invitation), anon);
      assert.equal(final.status, accepted.statusCode === 200 ? 'accepted' : 'revoked');
      assert.equal((await owner.query("SELECT count(*) FROM users WHERE email = 'race-revoke@example.test'")).rows[0].count, accepted.statusCode === 200 ? '1' : '0');
    });
    await t.test('expiry is reevaluated after waiting for the company lock', async () => {
      const invitation = await invite(organizationA, companyAdmin, 'wait-expiry@example.test');
      const blocker = await owner.connect();
      try {
        await blocker.query('BEGIN'); await lockInvitationCompany(blocker, organizationA);
        await owner.query("UPDATE organization_invitations SET created_at = now() - interval '1 minute', expires_at = now() + interval '100 milliseconds' WHERE id = $1", [invitation.invitation.id]);
        const waiting = accept(tokenOf(invitation), anon, { email: 'wait-expiry@example.test', password });
        await blocker.query('SELECT pg_sleep(0.2)'); await blocker.query('COMMIT');
        assert.equal((await waiting).statusCode, 409);
        assert.equal((await owner.query("SELECT count(*) FROM users WHERE email = 'wait-expiry@example.test'")).rows[0].count, '0');
      } finally { await blocker.query('ROLLBACK'); blocker.release(); }
    });
    await t.test('issuer role revocation, account blocking and inactive companies invalidate pending grants', async () => {
      const invitation = await invite(organizationA, companyAdmin, 'issuer-revoked@example.test');
      await owner.query("DELETE FROM membership_roles WHERE organization_id = $1 AND role = 'organization_admin'", [organizationA]);
      assert.equal((await accept(tokenOf(invitation), anon, { email: 'issuer-revoked@example.test', password })).statusCode, 409);
      assert.equal((await get(invitePath(organizationA), companyAdmin)).statusCode, 403);
      await owner.query("INSERT INTO membership_roles(organization_id, membership_id, role) SELECT organization_id, id, 'organization_admin' FROM organization_memberships WHERE organization_id = $1 AND user_id = (SELECT id FROM users WHERE email = 'first@example.test')", [organizationA]);
      await owner.query("UPDATE users SET blocked_at = now() WHERE email = 'first@example.test'");
      assert.equal((await accept(tokenOf(invitation), anon, { email: 'issuer-revoked@example.test', password })).statusCode, 409);
      await owner.query("UPDATE users SET blocked_at = NULL WHERE email = 'first@example.test'");
      await owner.query("UPDATE organizations SET status = 'inactive' WHERE id = $1", [organizationA]);
      assert.equal((await accept(tokenOf(invitation), anon, { email: 'issuer-revoked@example.test', password })).statusCode, 409);
      await owner.query("UPDATE organizations SET status = 'active' WHERE id = $1", [organizationA]);
      const first = (await post('/api/admin/organizations', { name: 'Firma D', administratorEmail: 'platform-revoked@example.test' }, platform)).json();
      await owner.query('DELETE FROM platform_admins');
      assert.equal((await accept(tokenOf(first), anon, { email: 'platform-revoked@example.test', password })).statusCode, 409);
      await owner.query("INSERT INTO platform_admins(user_id) SELECT id FROM users WHERE email = 'platform@example.test'");
    });
    await t.test('CSRF and Origin protect all writes, token validation and company creation', async () => {
      const invitation = await invite(organizationA, companyAdmin, 'csrf@example.test');
      for (const denied of [{ cookie: anon.cookie, origin: config.origin }, { ...anon, origin: 'https://evil.test' }, { ...anon, 'x-csrf-token': 'x'.repeat(43) }]) {
        for (const path of ['/api/invitations/inspect', '/api/invitations/accept']) assert.equal((await post(path, { token: tokenOf(invitation) }, denied)).statusCode, 403);
      }
      for (const denied of [{ cookie: companyAdmin.cookie }, { ...companyAdmin, origin: 'https://evil.test' }]) {
        assert.equal((await post(invitePath(organizationA), { email: 'extra@example.test', role: 'worker' }, denied)).statusCode, 403);
        assert.equal((await post(`${invitePath(organizationA)}/${invitation.invitation.id}/revoke`, {}, denied)).statusCode, 403);
      }
      assert.equal((await post('/api/admin/organizations', { name: 'CSRF', administratorEmail: 'csrf@example.test' }, { cookie: platform.cookie })).statusCode, 403);
    });
    await t.test('invalid emails and client-supplied issuer/company/role overrides cannot issue invitations', async () => {
      const before = (await owner.query('SELECT count(*) FROM organization_invitations')).rows[0].count;
      for (const email of ['', 'invalid', 'two@example.test,other@example.test', 'a\n@example.test', 123, null]) {
        assert.equal((await post(invitePath(organizationA), { email, role: 'worker' }, companyAdmin)).statusCode, 400);
        assert.equal((await post('/api/admin/organizations', { name: 'Invalid email', administratorEmail: email }, platform)).statusCode, 400);
      }
      for (const extra of [{ issuerId: randomUUID() }, { organizationId: organizationB }, { roles: ['platform_admin'] }]) {
        assert.equal((await post(invitePath(organizationA), { email: 'invalid@example.test', role: 'worker', ...extra }, companyAdmin)).statusCode, 400);
      }
      assert.equal((await post('/api/invitations/accept', { token: firstToken, organizationId: organizationB }, anon)).statusCode, 400);
      assert.equal((await owner.query('SELECT count(*) FROM organization_invitations')).rows[0].count, before);
    });
    await t.test('RLS has no global invitation reads/writes and hash lookup cannot mutate; settings reset after all paths', async () => {
      const identity = (await runtime.query('SELECT current_user, session_user, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user')).rows[0];
      assert.deepEqual(identity, { current_user: 'sitegrid', session_user: 'sitegrid', rolsuper: false, rolbypassrls: false });
      const flags = (await runtime.query(`SELECT relrowsecurity, relforcerowsecurity, row_security_active(c.oid) AS active,
        pg_has_role(current_user, relowner, 'MEMBER') AS owns FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relname = 'organization_invitations'`, [schema])).rows[0];
      assert.deepEqual(flags, { relrowsecurity: true, relforcerowsecurity: true, active: true, owns: false });
      assert.deepEqual((await runtime.query('SELECT * FROM organization_invitations')).rows, []);
      await withTransaction(runtime, async client => {
        await client.query("SELECT set_config('sitegrid.invitation_hash', $1, true)", [invitationHash(firstToken)]);
        assert.equal((await client.query('SELECT id FROM organization_invitations')).rows.length, 1);
        assert.equal((await client.query('UPDATE organization_invitations SET revoked_at = now()')).rowCount, 0);
      });
      await assert.rejects(withOrganization(runtime, organizationA, client => client.query(`INSERT INTO organization_invitations
        (organization_id, email, role, issuer_id, token_hash) VALUES ($1, 'foreign@example.test', 'worker', $2, $3)`, [organizationB, randomUUID(), invitationHash('synthetic')])), { code: '42501' });
      const clients = await Promise.all(Array.from({ length: 5 }, () => runtime.connect()));
      try {
        for (const client of clients) assert.deepEqual((await client.query(`SELECT
          NULLIF(current_setting('sitegrid.organization_id', true), '') AS organization,
          NULLIF(current_setting('sitegrid.user_id', true), '') AS actor,
          NULLIF(current_setting('sitegrid.invitation_hash', true), '') AS invitation`)).rows[0], { organization: null, actor: null, invitation: null });
      } finally { clients.forEach(client => client.release()); }
    });
    await t.test('audit errors roll back account, credentials, membership and acceptance', async () => {
      const invitation = await invite(organizationA, companyAdmin, 'rollback@example.test');
      await owner.query("ALTER TABLE platform_audit_events ADD CONSTRAINT reject_accept CHECK (event <> 'invitation_accepted') NOT VALID");
      try {
        assert.equal((await accept(tokenOf(invitation), anon, { email: 'rollback@example.test', password })).statusCode, 503);
        assert.equal((await owner.query("SELECT count(*) FROM users WHERE email = 'rollback@example.test'")).rows[0].count, '0');
        assert.equal((await inspect(tokenOf(invitation), anon)).status, 'pending');
      } finally { await owner.query('ALTER TABLE platform_audit_events DROP CONSTRAINT reject_accept'); }
    });
    await t.test('issuance audit failure rolls back company creation and preserves the replaced pending link', async () => {
      const invitation = await invite(organizationA, companyAdmin, 'issue-rollback@example.test');
      const before = (await owner.query('SELECT count(*) FROM organizations')).rows[0].count;
      await owner.query("ALTER TABLE platform_audit_events ADD CONSTRAINT reject_issue CHECK (event <> 'invitation_created') NOT VALID");
      try {
        const replacement = await post(invitePath(organizationA), { email: 'issue-rollback@example.test', role: 'manager' }, companyAdmin);
        assert.equal(replacement.statusCode, 503);
        assert.equal((await inspect(tokenOf(invitation), anon)).status, 'pending');
        const company = await post('/api/admin/organizations', { name: 'Failed issuance', administratorEmail: 'issue-rollback@example.test' }, platform);
        assert.equal(company.statusCode, 503);
        assert.equal((await owner.query('SELECT count(*) FROM organizations')).rows[0].count, before);
        assert.equal((await owner.query("SELECT count(*) FROM organization_invitations WHERE email = 'issue-rollback@example.test'")).rows[0].count, '1');
      } finally { await owner.query('ALTER TABLE platform_audit_events DROP CONSTRAINT reject_issue'); }
    });
    await t.test('production cannot expose manual links and fails before writes without SMTP', async () => {
      const prodConfig = { ...config, production: true, manualInvitationLinks: true, origin: 'https://sitegrid.example.test' };
      const prodApp = await buildApp(prodConfig, runtime, { serveWeb: false });
      try {
        const initial = await prodApp.inject('/api/auth/session');
        const response = await prodApp.inject({ method: 'POST', url: '/api/auth/login', headers: {
          cookie: `${initial.cookies[0].name}=${initial.cookies[0].value}`, origin: prodConfig.origin, 'x-csrf-token': initial.json().csrfToken,
        }, payload: { email: 'platform@example.test', password } });
        const cookie = `${response.cookies[0].name}=${response.cookies[0].value}`;
        const session = await prodApp.inject({ url: '/api/auth/session', headers: { cookie } });
        const before = (await owner.query('SELECT count(*) FROM organizations')).rows[0].count;
        const created = await prodApp.inject({ method: 'POST', url: '/api/admin/organizations', headers: { cookie, origin: prodConfig.origin, 'x-csrf-token': session.json().csrfToken }, payload: { name: 'Missing SMTP', administratorEmail: 'prod@example.test' } });
        assert.equal(created.statusCode, 503); assert.deepEqual(Object.keys(created.json()), ['error']);
        assert.equal((await owner.query('SELECT count(*) FROM organizations')).rows[0].count, before);
      } finally { await prodApp.close(); }
    });
    await t.test('token endpoints have persistent rate limits', async () => {
      const responses = await Promise.all(Array.from({ length: 65 }, () => post('/api/invitations/inspect', { token: 'invalid' }, anon)));
      assert(responses.some(response => response.statusCode === 429));
      assert.equal((await post('/api/invitations/inspect', { token: 'invalid' }, anon)).statusCode, 429);
    });
  } finally {
    await app.close(); await runtime.end(); await owner.end();
    try { await admin.query(`DROP SCHEMA ${schema} CASCADE`); } finally { await admin.end(); }
  }
});
