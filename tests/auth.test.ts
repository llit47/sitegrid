import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { readConfig } from '../apps/server/src/config.js';
import { createPool } from '../apps/server/src/db.js';
import { buildApp } from '../apps/server/src/app.js';
import { migrate } from '../apps/server/src/migrations.js';
import { bootstrapAdmin } from '../apps/server/src/auth/bootstrap.js';
import { hashPassword } from '../apps/server/src/auth/password.js';

test('password hashing rejects weak input and uses Argon2id', async () => {
  assert.throws(() => hashPassword('short'));
  const hash = await hashPassword(randomBytes(24).toString('base64url'));
  assert.match(hash, /^\$argon2id\$v=19\$/);
  assert.deepEqual(new Set(hash.split('$')[3].split(',')), new Set(['m=65536', 't=3', 'p=1']));
});

test('real authentication, CSRF, revocation, persistence and one-time bootstrap', { skip: !process.env.TEST_DATABASE_URL }, async t => {
  // Own PostgreSQL schema keeps tests isolated without modifying another suite's tables.
  const schema = `auth_test_${randomBytes(6).toString('hex')}`;
  const adminPool = createPool(process.env.TEST_DATABASE_URL!);
  await adminPool.query(`CREATE SCHEMA ${schema}`);
  const url = new URL(process.env.TEST_DATABASE_URL!);
  url.searchParams.set('options', `-c search_path=${schema}`);
  const config = readConfig({ NODE_ENV: 'test', DATABASE_URL: url.href });
  const pool = createPool(config.databaseUrl);
  const password = randomBytes(24).toString('base64url');
  let app = await buildApp(config, pool);
  let poolClosed = false;
  try {
    await migrate(pool, config.migrationsRoot);
    const outcomes = await Promise.allSettled([bootstrapAdmin(pool, 'admin@example.test', password), bootstrapAdmin(pool, 'other@example.test', password)]);
    assert.equal(outcomes.filter(r => r.status === 'fulfilled').length, 1);
    const account = (await pool.query('SELECT id, email FROM users')).rows[0];
    await assert.rejects(bootstrapAdmin(pool, 'again@example.test', password), /already completed/);
    await t.test('unauthenticated access and public registration rejected', async () => {
      assert.equal((await app.inject('/api/admin/overview')).statusCode, 401);
      assert.equal((await app.inject({ method: 'POST', url: '/api/auth/register', payload: {} })).statusCode, 404);
    });
    const initial = await app.inject('/api/auth/session');
    let csrf = initial.json().csrfToken;
    let cookie = initial.cookies[0].name + '=' + initial.cookies[0].value;
    const oldCookie = cookie;
    const headers = () => ({ cookie, origin: config.origin, 'x-csrf-token': csrf });
    const login = (pass = password) => app.inject({ method: 'POST', url: '/api/auth/login', headers: headers(), payload: { email: account.email, password: pass } });
    await t.test('missing/wrong CSRF and foreign origin rejected', async () => {
      for (const invalidHeaders of [{ cookie, origin: config.origin }, { ...headers(), origin: 'https://evil.test' }, { ...headers(), 'x-csrf-token': 'x'.repeat(43) }]) {
        assert.equal((await app.inject({ method: 'POST', url: '/api/auth/login', headers: invalidHeaders, payload: { email: account.email, password } })).statusCode, 403);
      }
    });
    await t.test('wrong password and unknown identity use same error', async () => {
      const wrong = await login(randomBytes(24).toString('base64url'));
      const unknown = await app.inject({ method: 'POST', url: '/api/auth/login', headers: headers(), payload: { email: 'missing@example.test', password } });
      assert.equal(wrong.statusCode, 401);
      assert.deepEqual(wrong.json(), unknown.json());
    });
    await t.test('valid login rotates session; only hashes stored; protected panel works', async () => {
      const response = await login();
      assert.equal(response.statusCode, 200);
      cookie = response.cookies[0].name + '=' + response.cookies[0].value;
      assert.notEqual(cookie, oldCookie);
      assert.match(String(response.headers['set-cookie']), /HttpOnly/);
      assert.match(String(response.headers['set-cookie']), /SameSite=Strict/);
      assert.equal((await app.inject({ url: '/api/admin/overview', headers: { cookie: oldCookie } })).statusCode, 401);
      assert.equal((await app.inject({ url: '/api/admin/overview', headers: { cookie } })).statusCode, 200);
      assert.equal((await pool.query('SELECT token_hash FROM sessions WHERE user_id = $1', [account.id])).rows[0].token_hash, createHash('sha256').update(response.cookies[0].value).digest('hex'));
      csrf = (await app.inject({ url: '/api/auth/session', headers: { cookie } })).json().csrfToken;
    });
    await t.test('server and connection pool restart preserve account/session/limiter', async () => {
      await app.close(); await pool.end(); poolClosed = true;
      const restartedPool = createPool(config.databaseUrl);
      app = await buildApp(config, restartedPool);
      app.addHook('onClose', async () => restartedPool.end());
      assert.equal((await app.inject({ url: '/api/admin/overview', headers: { cookie } })).statusCode, 200);
      assert.equal((await restartedPool.query('SELECT count(*) FROM users')).rows[0].count, '1');
    });
    await t.test('compiled API survives two actual process starts with existing session', async () => {
      const socket = createServer();
      socket.listen(0, '127.0.0.1'); await once(socket, 'listening');
      const port = (socket.address() as { port: number }).port;
      await new Promise<void>(resolve => socket.close(() => resolve()));
      for (let run = 0; run < 2; run++) {
        const child = spawn(process.execPath, ['dist/server/main.js'], { env: { ...process.env, NODE_ENV: 'test', DATABASE_URL: config.databaseUrl, PORT: String(port), PUBLIC_ORIGIN: config.origin }, stdio: 'ignore' });
        const exited = once(child, 'exit');
        try {
          let ready = false;
          for (let attempt = 0; attempt < 100; attempt++) {
            try { ready = (await fetch(`http://127.0.0.1:${port}/health/ready`)).ok; } catch { /* startup */ }
            if (ready || child.exitCode !== null) break;
            await delay(50);
          }
          assert(ready, 'Compiled API did not become ready');
          assert.equal((await fetch(`http://127.0.0.1:${port}/api/admin/overview`, { headers: { cookie } })).status, 200);
        } finally { child.kill('SIGTERM'); await exited; }
      }
    });
    await t.test('logout requires CSRF and invalidates persistent session', async () => {
      assert.equal((await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie } })).statusCode, 403);
      assert.equal((await app.inject({ method: 'POST', url: '/api/auth/logout', headers: headers() })).statusCode, 200);
      assert.equal((await app.inject({ url: '/api/admin/overview', headers: { cookie } })).statusCode, 401);
    });
    await t.test('HTTPS production cookies carry Secure and __Host prefix', async () => {
      const productionPool = createPool(config.databaseUrl);
      const prodApp = await buildApp({ ...config, production: true, origin: 'https://sitegrid.example.test' }, productionPool, { serveWeb: false });
      try {
        const response = await prodApp.inject('/api/auth/session');
        assert.equal(response.cookies[0].name, '__Host-sitegrid');
        assert.match(String(response.headers['set-cookie']), /Secure/);
        assert.match(String(response.headers['set-cookie']), /HttpOnly/);
        assert.match(String(response.headers['set-cookie']), /SameSite=Strict/);
      } finally { await prodApp.close(); await productionPool.end(); }
    });
    await t.test('login limits are persistent and atomic', async () => {
      const start = await app.inject('/api/auth/session');
      cookie = start.cookies[0].name + '=' + start.cookies[0].value; csrf = start.json().csrfToken;
      const attempts = await Promise.all(Array.from({ length: 12 }, () => login(randomBytes(24).toString('base64url'))));
      assert(attempts.some(r => r.statusCode === 429));
      assert.equal((await login()).statusCode, 429);
    });
  } finally {
    await app.close(); if (!poolClosed) await pool.end();
    await adminPool.query(`DROP SCHEMA ${schema} CASCADE`); await adminPool.end();
  }
});
