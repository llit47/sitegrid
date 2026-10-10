/* Built by pwaBuild: immutable allowlist and byte digests, never runtime API data. */
const shell = __SITEGRID_SHELL__;
const prefix = 'sitegrid-shell-v1-';
const cacheName = prefix + shell.version;
const allowed = new Set(shell.assets.map(asset => new URL(asset.url, self.location.origin).href));
const owned = name => new RegExp('^' + prefix + '[a-f0-9]{64}$').test(name);

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    try {
      const cache = await caches.open(cacheName);
      for (const asset of shell.assets) {
        const url = new URL(asset.url, self.location.origin).href;
        const response = await fetch(url, { credentials: 'omit', cache: 'reload', redirect: 'error' });
        if (!response.ok || response.type !== 'basic' || response.url !== url || response.headers.has('set-cookie') ||
            /cookie|authorization/i.test(response.headers.get('vary') || '')) throw new Error('Unsafe shell response');
        const bytes = await response.clone().arrayBuffer();
        const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
        if (digest !== asset.sha256) throw new Error('Shell release mismatch');
        await cache.put(url, response);
      }
    } catch (error) {
      await caches.delete(cacheName);
      throw error;
    }
    // No skipWaiting: an update waits until ALL existing clients close.
  })());
});
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) if (owned(name) && name !== cacheName) await caches.delete(name);
    await self.clients.claim();
  })());
});
self.addEventListener('message', event => {
  if (event.data?.type !== 'SHELL_STATUS' || !event.ports[0]) return;
  event.waitUntil((async () => {
    const cache = await caches.open(cacheName);
    const ready = (await Promise.all(shell.assets.map(asset => cache.match(asset.url)))).every(Boolean);
    event.ports[0].postMessage({ version: shell.version, ready });
  })());
});
self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  // No respondWith for API, health, credentials, queries or unlisted resources.
  if (request.method !== 'GET' || url.origin !== self.location.origin ||
      url.pathname === '/api' || url.pathname.startsWith('/api/') || url.pathname.startsWith('/health/') ||
      request.headers.has('authorization') || request.headers.has('range')) return;
  if (!url.search && allowed.has(url.href)) {
    event.respondWith((async () => (await (await caches.open(cacheName)).match(url.href)) || fetch(request))());
    return;
  }
  // The only app navigation routes today. Never cache their network responses.
  if (request.mode === 'navigate' && (url.pathname === '/' || url.pathname === '/invitations/accept')) {
    event.respondWith((async () => {
      try { return await fetch(request); }
      catch {
        return (await (await caches.open(cacheName)).match(shell.shell)) ||
          new Response('Brak połączenia. Otwórz SiteGrid po odzyskaniu sieci.', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
      }
    })());
  }
});
