// Disposable local UI smoke using the same owner/runtime URLs as integration tests.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import sharp from 'sharp';
import { buildApp } from '../apps/server/src/app.ts';
import { migrate } from '../apps/server/src/migrations.ts';
import { readConfig } from '../apps/server/src/config.ts';
import { hashPassword } from '../apps/server/src/auth/password.ts';
const { chromium } = await import(process.env.SITEGRID_PLAYWRIGHT_MODULE ? pathToFileURL(process.env.SITEGRID_PLAYWRIGHT_MODULE).href : 'playwright');
assert(process.env.TEST_DATABASE_URL && process.env.TEST_RUNTIME_DATABASE_URL);
const schema = `branding_browser_${randomBytes(6).toString('hex')}`;
const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
const ownerUrl = new URL(process.env.TEST_DATABASE_URL); ownerUrl.searchParams.set('options', `-c search_path=${schema}`);
const owner = new pg.Pool({ connectionString: ownerUrl.href });
const runtimeUrl = new URL(process.env.TEST_RUNTIME_DATABASE_URL); runtimeUrl.searchParams.set('options', `-c search_path=${schema}`);
const runtime = new pg.Pool({ connectionString: runtimeUrl.href });
const config = readConfig({ NODE_ENV: 'test', DATABASE_URL: runtimeUrl.href, INVITATION_MANUAL_LINKS: 'true' });
const companyA = randomUUID(), companyB = randomUUID(), user = randomUUID();
const password = randomBytes(24).toString('base64url');
const png = await sharp({ create: { width: 32, height: 32, channels: 3, background: '#ff0000' } }).png().toBuffer();
const jpeg = await sharp({ create: { width: 32, height: 32, channels: 3, background: '#00ff00' } }).jpeg().toBuffer();
const blue = await sharp({ create: { width: 32, height: 32, channels: 3, background: '#0000ff' } }).webp().toBuffer();
let app, browser;
await admin.query(`CREATE SCHEMA ${schema}`);
try {
  await migrate(owner, 'migrations');
  await owner.query(`GRANT USAGE ON SCHEMA ${schema} TO sitegrid`);
  await owner.query('GRANT SELECT ON installation, schema_migrations, users, credentials, platform_admins TO sitegrid');
  await owner.query('GRANT SELECT, INSERT, DELETE ON sessions TO sitegrid');
  await owner.query('GRANT SELECT, INSERT, UPDATE, DELETE ON auth_rate_limits TO sitegrid');
  await owner.query('INSERT INTO users(id, email) VALUES ($1, $2)', [user, 'shared@example.test']);
  await owner.query('INSERT INTO credentials(user_id, password_hash) VALUES ($1, $2)', [user, await hashPassword(password)]);
  for (const [id, name, role] of [[companyA, 'Firma Browser A', 'organization_admin'], [companyB, 'Firma Browser B', 'worker']]) {
    await owner.query('INSERT INTO organizations(id, name) VALUES ($1, $2)', [id, name]);
    const membership = randomUUID();
    await owner.query("INSERT INTO organization_memberships(organization_id, id, user_id, status) VALUES ($1, $2, $3, 'active')", [id, membership, user]);
    await owner.query('INSERT INTO membership_roles(organization_id, membership_id, role) VALUES ($1, $2, $3)', [id, membership, role]);
  }
  await owner.query("INSERT INTO organization_settings(organization_id, accent_color, version) VALUES ($1, '#0000ff', 2)", [companyB]);
  await owner.query("INSERT INTO organization_logos(organization_id, data, mime_type, version) VALUES ($1, $2, 'image/webp', 2)", [companyB, blue]);
  app = await buildApp(config, runtime, { serveWeb: true });
  config.origin = await app.listen({ port: 0, host: '127.0.0.1' });
  browser = await chromium.launch({ headless: true, ...(process.env.SITEGRID_CHROMIUM_PATH ? { executablePath: process.env.SITEGRID_CHROMIUM_PATH } : {}) });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage(), errors = [], cspErrors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', msg => { if (msg.text().includes('Content Security Policy')) cspErrors.push(msg.text()); });
  // Hold the initial list's A branding snapshot while the selected company is saved.
  let releaseInitial, initialStarted, initialHeld = false;
  const initialGate = new Promise(resolve => { releaseInitial = resolve; });
  const initialFetched = new Promise(resolve => { initialStarted = resolve; });
  const initialPath = `${config.origin}/api/organizations/${companyA}/branding`;
  await page.route(initialPath, async route => {
    if (initialHeld || route.request().method() !== 'GET') return route.continue();
    initialHeld = true;
    const response = await route.fetch(); initialStarted(); await initialGate;
    await route.fulfill({ response });
  });
  await page.goto(config.origin);
  await page.locator('#email').fill('shared@example.test'); await page.locator('#password').fill(password);
  await page.getByRole('button', { name: 'Zaloguj się', exact: true }).click();
  await initialFetched;
  await page.locator('#active-organization').selectOption(companyA);
  const settings = page.locator('.company-branding'), header = page.locator('.company-header');
  await settings.getByRole('heading', { name: 'Ustawienia firmy' }).waitFor();
  assert.equal(await header.locator('img').count(), 0);
  await settings.getByLabel('Nazwa firmy', { exact: true }).fill('Żółć Browser A');
  await settings.getByLabel('Kolor firmowy', { exact: true }).fill('#ffaa11');
  await settings.getByRole('button', { name: 'Zapisz ustawienia', exact: true }).click();
  await header.getByRole('heading', { name: 'Żółć Browser A', exact: true }).waitFor();
  assert.equal(await page.locator(`#active-organization option[value="${companyA}"]`).textContent(), 'Żółć Browser A');
  assert.equal(await header.locator('canvas').getAttribute('aria-label'), 'Kolor firmowy: #ffaa11');
  for (const [buffer, name, mimeType] of [[png, 'logo.png', 'image/png'], [jpeg, 'logo.jpg', 'image/jpeg']]) {
    await settings.getByLabel('Logo firmy', { exact: true }).setInputFiles({ name, mimeType, buffer });
    await settings.getByRole('button', { name: name === 'logo.png' ? 'Dodaj logo' : 'Zastąp logo', exact: true }).click();
    await page.waitForFunction(mime => document.querySelector('.company-header img')?.naturalWidth > 0 && document.querySelector('.company-branding input[type=file]')?.value === '' && mime,
      mimeType);
    assert.equal((await owner.query('SELECT mime_type FROM organization_logos WHERE organization_id = $1', [companyA])).rows[0].mime_type, mimeType);
    if (name === 'logo.png') {
      const savedLogo = await header.locator('img').getAttribute('src');
      releaseInitial();
      // B's logo appears only after the initial batch has merged into the switcher.
      await page.waitForFunction(id => document.querySelector(`.company-choice img[src*="${id}"]`)?.naturalWidth > 0, companyB);
      const selectedChoice = page.locator('.company-choice[aria-pressed="true"]');
      assert.equal(await selectedChoice.locator('span').last().textContent(), 'Żółć Browser A', 'Delayed initial branding must retain the saved name');
      assert.equal(await selectedChoice.locator('img').getAttribute('src'), savedLogo, 'Delayed initial branding must retain the saved logo version');
      assert.equal(await header.locator('h3').textContent(), 'Żółć Browser A');
      await page.unroute(initialPath);
      console.log('PASS regression: delayed initial branding cannot replace a newer saved name/logo');
    }
  }
  await settings.getByRole('button', { name: 'Usuń logo', exact: true }).click();
  await settings.getByRole('button', { name: 'Dodaj logo', exact: true }).waitFor();
  assert.equal(await header.locator('img').count(), 0);
  await settings.getByLabel('Logo firmy', { exact: true }).setInputFiles({ name: 'oversize.png', mimeType: 'image/png', buffer: Buffer.alloc(262145) });
  await settings.getByRole('button', { name: 'Dodaj logo', exact: true }).click();
  await settings.getByRole('alert').filter({ hasText: '256 KiB' }).waitFor();
  await settings.getByLabel('Logo firmy', { exact: true }).setInputFiles({ name: 'logo.png', mimeType: 'image/png', buffer: png });
  await settings.getByRole('button', { name: 'Dodaj logo', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.company-header img')?.naturalWidth > 0);
  await settings.getByLabel('Logo firmy', { exact: true }).setInputFiles({ name: 'retained.jpg', mimeType: 'image/jpeg', buffer: jpeg });
  // A second tab/API changes the server version while the visible form retains a draft.
  const external = await page.evaluate(async id => {
    const session = await (await fetch('/api/auth/session')).json();
    const brand = await (await fetch(`/api/organizations/${id}/branding`)).json();
    const response = await fetch(`/api/organizations/${id}/branding`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken },
      body: JSON.stringify({ name: 'Zmiana z innej karty', accentColor: '#aabbcc', expectedVersion: brand.branding.version }) });
    return response.status;
  }, companyA);
  assert.equal(external, 200);
  await settings.getByLabel('Nazwa firmy', { exact: true }).fill('Lokalna propozycja');
  await settings.getByRole('button', { name: 'Zapisz ustawienia', exact: true }).click();
  await settings.getByRole('alert').filter({ hasText: 'Dane firmy zmieniły się' }).waitFor();
  assert.equal(await settings.getByLabel('Nazwa firmy', { exact: true }).inputValue(), 'Lokalna propozycja');
  assert(await settings.getByRole('button', { name: 'Zapisz ustawienia', exact: true }).isDisabled());
  assert.equal(await settings.getByLabel('Logo firmy', { exact: true }).evaluate(input => input.files.length), 1);
  await settings.getByRole('button', { name: 'Odśwież ustawienia', exact: true }).click();
  await header.getByRole('heading', { name: 'Zmiana z innej karty', exact: true }).waitFor();
  assert.equal(await settings.getByLabel('Nazwa firmy', { exact: true }).inputValue(), 'Zmiana z innej karty');
  const fileInput = settings.getByLabel('Logo firmy', { exact: true });
  assert.equal(await fileInput.inputValue(), '');
  assert.equal(await fileInput.evaluate(input => input.files.length), 0);
  assert(await settings.getByRole('button', { name: 'Zastąp logo', exact: true }).isDisabled(), 'Refresh must discard retained File state along with the empty file input');
  // Choosing a new file after refresh must upload that file, using the refreshed version.
  await fileInput.setInputFiles({ name: 'fresh.png', mimeType: 'image/png', buffer: png });
  const freshUpload = page.waitForRequest(request => request.method() === 'POST' && request.url() === `${config.origin}/api/organizations/${companyA}/branding/logo`);
  await settings.getByRole('button', { name: 'Zastąp logo', exact: true }).click();
  assert.equal((await freshUpload).postDataJSON().data, png.toString('base64'));
  await page.waitForFunction(() => document.querySelector('.company-branding input[type=file]')?.value === '' && !document.querySelector('.company-branding button')?.disabled);
  assert(await settings.getByRole('button', { name: 'Zastąp logo', exact: true }).isDisabled());
  console.log('PASS regression: conflict → refresh clears the invisible retained file and requires a fresh selection');
  await page.locator('#active-organization').selectOption(companyB);
  await header.getByRole('heading', { name: 'Firma Browser B', exact: true }).waitFor();
  assert.equal(await settings.count(), 0);
  await page.waitForFunction(() => document.querySelector('.company-header img')?.naturalWidth > 0);
  assert((await header.locator('img').getAttribute('src')).includes(companyB));
  assert.equal(await header.locator('canvas').getAttribute('aria-label'), 'Kolor firmowy: #0000ff');
  // Hold an already-fetched A response until B has rendered, then release it.
  let release, started;
  const gate = new Promise(resolve => { release = resolve; });
  const intercepted = new Promise(resolve => { started = resolve; });
  const delayedPath = `${config.origin}/api/organizations/${companyA}/branding`;
  await page.route(delayedPath, async route => {
    const response = await route.fetch(); started(); await gate;
    await route.fulfill({ response }).catch(() => {}); // Selection aborted the old request.
  });
  await page.locator('#active-organization').selectOption(companyA); await intercepted;
  assert.equal(await header.count(), 0, 'Loading A must clear B branding immediately');
  await page.locator('#active-organization').selectOption(companyB);
  await header.getByRole('heading', { name: 'Firma Browser B', exact: true }).waitFor();
  release(); await page.unroute(delayedPath);
  await page.waitForTimeout(150);
  assert.equal(await header.locator('h3').textContent(), 'Firma Browser B');
  assert.equal(await settings.count(), 0);
  assert.equal(await page.locator('.company-header img').count(), 1);
  assert((await header.locator('img').getAttribute('src')).includes(companyB));
  await page.locator('#active-organization').selectOption(companyA);
  await settings.getByRole('heading', { name: 'Ustawienia firmy' }).waitFor();
  assert(await page.locator('.company-members').isVisible()); assert(await page.getByRole('heading', { name: 'Zaproszenia do firmy' }).isVisible());
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.setViewportSize({ width: 390, height: 844 });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  assert.deepEqual(errors, []); assert.deepEqual(cspErrors, []);
  console.log('PASS: login, default/logo display, name/color edit, logo upload/replacement/deletion, limits, conflict/draft/refresh, A/B roles, delayed A response, mobile overflow, existing panels, CSP');
} finally {
  if (browser) await browser.close(); if (app) await app.close(); await runtime.end(); await owner.end();
  try { await admin.query(`DROP SCHEMA ${schema} CASCADE`); } finally { await admin.end(); }
}
