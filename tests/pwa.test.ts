import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash, webcrypto } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import sharp from 'sharp';
import { buildApp } from '../apps/server/src/app.js';
import { readConfig } from '../apps/server/src/config.js';
import { createPool } from '../apps/server/src/db.js';
import { checkLocalStorage, openProjectStorage, projectDatabaseName, LocalStorageError } from '../apps/web/src/storage/indexed-db.js';

const worker = await readFile('dist/web/sw.js', 'utf8');
const shell = JSON.parse(worker.match(/const shell = (.*);/)![1]) as { version: string; shell: string; assets: { url: string; sha256: string }[] };
const origin = 'https://sitegrid.example';
const bytes = new Map(await Promise.all(shell.assets.map(async asset => [asset.url, await readFile(`dist/web${asset.url}`)] as const)));

test('production manifest, icons, shell and every asset match the release allowlist', async () => {
  assert.match(shell.version, /^[a-f0-9]{64}$/);
  const manifestPath = shell.assets.find(asset => asset.url.endsWith('.webmanifest'))!.url;
  const manifest = JSON.parse(bytes.get(manifestPath)!.toString());
  assert.deepEqual([manifest.id, manifest.name, manifest.short_name, manifest.start_url, manifest.scope, manifest.display], ['/', 'SiteGrid', 'SiteGrid', '/', '/', 'standalone']);
  for (const color of [manifest.theme_color, manifest.background_color]) assert.match(color, /^#[a-f0-9]{6}$/);
  for (const icon of manifest.icons) {
    const image = await sharp(bytes.get(icon.src)).metadata();
    assert.equal(`${image.width}x${image.height}`, icon.sizes); assert.equal(image.format, 'png'); assert.equal(icon.purpose, 'any maskable');
  }
  const html = await readFile('dist/web/index.html', 'utf8');
  assert.equal(html, bytes.get(shell.shell)!.toString());
  const references = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map(match => match[1]);
  for (const reference of references) assert(bytes.has(reference), reference);
  for (const asset of shell.assets) {
    assert.match(asset.url, /^\/(?:assets\/[^/]+-[\w-]+\.(?:js|css)|pwa\/[a-f0-9]{64}\/[^/]+)$/);
    assert.equal(createHash('sha256').update(bytes.get(asset.url)!).digest('hex'), asset.sha256);
  }
  assert(!shell.assets.some(asset => /api|session|invitation|logo/.test(asset.url)));
});

function workerHarness(config = shell, existing = new Map<string, Map<string, Response>>(), unsafe?: string) {
  const events = new Map<string, (event: any) => void>();
  const fetched: { url: string; options: RequestInit }[] = [];
  let skip = 0, claims = 0, offline = false;
  const caches = {
    open: async (name: string) => {
      if (!existing.has(name)) existing.set(name, new Map());
      const entries = existing.get(name)!;
      return { put: async (url: string, response: Response) => { entries.set(url, response); },
        match: async (url: string) => entries.get(new URL(url, origin).href)?.clone() };
    }, keys: async () => [...existing.keys()], delete: async (name: string) => existing.delete(name),
  };
  const fetch = async (input: string | Request, options: RequestInit = {}) => {
    if (offline) throw new TypeError('Offline');
    const url = typeof input === 'string' ? input : input.url;
    fetched.push({ url, options });
    const response = new Response(unsafe === 'digest' ? 'private authenticated response' : bytes.get(new URL(url).pathname) ?? 'private online data', {
      headers: unsafe === 'cookie' ? { 'set-cookie': 'secret' } : unsafe === 'vary' ? { vary: 'Cookie' } : {},
    });
    Object.defineProperties(response, { type: { value: unsafe === 'opaque' ? 'opaque' : 'basic' }, url: { value: unsafe === 'redirect' ? origin + '/api/private' : url } });
    return response;
  };
  runInNewContext(worker.replace(JSON.stringify(shell), JSON.stringify(config)), {
    self: { location: { origin }, addEventListener: (name: string, handler: (event: any) => void) => events.set(name, handler),
      clients: { claim: async () => { claims++; } }, skipWaiting: () => { skip++; } }, caches, fetch,
    crypto: webcrypto, URL, Response, Uint8Array, Set,
  });
  const run = async (name: string, request?: any) => {
    let waiting: Promise<unknown> | undefined, response: Promise<Response> | undefined;
    events.get(name)!({ request, waitUntil: (promise: Promise<unknown>) => { waiting = promise; }, respondWith: (promise: Promise<Response>) => { response = promise; } });
    await waiting; return response ? await response : undefined;
  };
  return { run, existing, fetched, goOffline: () => { offline = true; }, skipped: () => skip, claimed: () => claims };
}
const request = (path: string, mode = 'cors', method = 'GET', headers: Record<string, string> = {}) => ({ url: new URL(path, origin).href, method, mode, headers: new Headers(headers) });

test('install omits credentials; offline reload serves only the validated shell and assets', async () => {
  const harness = workerHarness(); await harness.run('install'); await harness.run('activate');
  assert.equal(harness.skipped(), 0); assert.equal(harness.claimed(), 1);
  assert.equal(harness.fetched.length, shell.assets.length);
  assert(harness.fetched.every(item => item.options.credentials === 'omit' && item.options.redirect === 'error'));
  await harness.run('fetch', request('/', 'navigate'));
  assert.equal([...harness.existing.values()][0].size, shell.assets.length);
  harness.goOffline();
  assert.equal(await (await harness.run('fetch', request('/', 'navigate')))!.text(), bytes.get(shell.shell)!.toString());
  assert.equal(await (await harness.run('fetch', request('/invitations/accept#secret', 'navigate')))!.text(), bytes.get(shell.shell)!.toString());
  for (const asset of shell.assets) assert.equal((await harness.run('fetch', request(asset.url)))!.status, 200);
});
test('API, health, authenticated requests, queries and arbitrary GETs always bypass the worker cache', async () => {
  const harness = workerHarness(); await harness.run('install'); harness.goOffline();
  for (const path of ['/api', '/api/auth/session', '/api/organizations/a/branding/logo', '/api/invitations/x', '/api/projects/x', '/health/ready', '/private', '/sw.js', '/other.html', shell.assets[0].url + '?user=1', 'https://other.example/']) {
    assert.equal(await harness.run('fetch', request(path)), undefined, path);
    assert.equal(await harness.run('fetch', request(path, 'navigate')), undefined, path);
  }
  assert.equal(await harness.run('fetch', request(shell.assets[0].url, 'cors', 'POST')), undefined);
  assert.equal(await harness.run('fetch', request(shell.assets[0].url, 'cors', 'GET', { authorization: 'Bearer secret' })), undefined);
  assert.equal([...harness.existing.values()][0].size, shell.assets.length);
});
for (const unsafe of ['cookie', 'vary', 'opaque', 'redirect', 'digest']) test(`installation rejects ${unsafe} responses without publishing a partial cache`, async () => {
  const harness = workerHarness(shell, new Map(), unsafe);
  await assert.rejects(harness.run('install')); assert.equal(harness.existing.size, 0);
});
test('new version preserves active cache until activation, then deletes only owned old caches; rollback installs again', async () => {
  const old = workerHarness(); await old.run('install');
  old.existing.set('unrelated-cache', new Map()); old.existing.set('sitegrid-shell-v1-not-owned', new Map());
  const newer = { ...shell, version: 'b'.repeat(64) };
  const next = workerHarness(newer, old.existing); await next.run('install');
  assert(old.existing.has('sitegrid-shell-v1-' + shell.version)); assert.equal(next.skipped(), 0);
  await next.run('activate'); assert(!old.existing.has('sitegrid-shell-v1-' + shell.version));
  assert(old.existing.has('unrelated-cache')); assert(old.existing.has('sitegrid-shell-v1-not-owned'));
  const rollback = workerHarness(shell, old.existing); await rollback.run('install'); await rollback.run('activate');
  assert(!old.existing.has('sitegrid-shell-v1-' + newer.version)); assert(old.existing.has('sitegrid-shell-v1-' + shell.version));
});
test('storage names isolate every scope dimension and reject invalid owner IDs; missing IDB fails explicitly', async () => {
  const scope = { accountId: '11111111-1111-4111-8111-111111111111', organizationId: '22222222-2222-4222-8222-222222222222', projectId: '33333333-3333-4333-8333-333333333333' };
  const names = ['accountId', 'organizationId', 'projectId'].map(key => projectDatabaseName({ ...scope, [key]: '44444444-4444-4444-8444-444444444444' }));
  assert.equal(new Set([projectDatabaseName(scope), ...names]).size, 4);
  assert.equal(projectDatabaseName(scope), projectDatabaseName({ ...scope, projectId: scope.projectId.toUpperCase() }));
  assert.throws(() => projectDatabaseName({ ...scope, accountId: '../another-account' }), LocalStorageError);
  await assert.rejects(checkLocalStorage(), error => error instanceof LocalStorageError && error.code === 'unavailable');
  await assert.rejects(openProjectStorage(scope), error => error instanceof LocalStorageError && error.code === 'unavailable');
});
test('production static headers and missing assets preserve API/no-store and never masquerade as a shell', async () => {
  const config = readConfig({ NODE_ENV: 'test', DATABASE_URL: 'postgresql://127.0.0.1:1/missing' });
  const pool = createPool(config.databaseUrl); const app = await buildApp(config, pool, { serveWeb: true });
  try {
    for (const path of ['/sw.js', '/', '/invitations/accept']) assert.equal((await app.inject(path)).headers['cache-control'], 'no-store');
    for (const asset of shell.assets) {
      const response = await app.inject(asset.url); assert.equal(response.statusCode, 200); assert.match(String(response.headers['cache-control']), /immutable/); assert(!response.headers['set-cookie']);
    }
    for (const path of ['/assets/missing.js', '/pwa/missing/shell.html', '/api/missing']) assert.equal((await app.inject(path)).statusCode, 404);
    assert.equal((await app.inject('/api/missing')).headers['cache-control'], 'no-store');
  } finally { await app.close(); await pool.end(); }
});
