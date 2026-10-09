// Run against the disposable VM only. Secrets remain in memory/outside the repo.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
assert.equal(process.env.SITEGRID_DISPOSABLE_TEST, 'YES');
const { chromium } = await import(process.env.SITEGRID_PLAYWRIGHT_MODULE ? pathToFileURL(process.env.SITEGRID_PLAYWRIGHT_MODULE).href : 'playwright');
const credentials = JSON.parse(await readFile(process.env.SITEGRID_TEST_CREDENTIALS, 'utf8'));
const run = promisify(execFile);
const quote = s => "'" + s.replaceAll("'", "'\\''") + "'";
const remote = async args => (await run('ssh', ['-i', process.env.SITEGRID_TEST_SSH_KEY, '-p', '12222', '-o', `UserKnownHostsFile=${process.env.SITEGRID_TEST_KNOWN_HOSTS}`, 'root@127.0.0.1', args.map(quote).join(' ')], { timeout: 180000, maxBuffer: 512000 })).stdout;
const browser = await chromium.launch({ headless: true, args: ['--renderer-process-limit=1', '--js-flags=--max-old-space-size=128', '--no-proxy-server', '--host-resolver-rules=MAP sitegrid.example.test 127.0.0.1:12443'] });
const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 900 } });
const page = await context.newPage();
const origin = 'https://sitegrid.example.test';
const status = path => page.evaluate(async path => (await fetch(path)).status, path);
const ready = async version => {
  for (let i = 0; i < 60; i++) {
    const result = await page.evaluate(async () => { try { return await (await fetch('/health/ready')).json(); } catch { return {}; } });
    if (result.status === 'ready' && result.version === version) return;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  assert.fail('Expected deployment readiness');
};
const panel = async () => {
  await page.reload();
  await page.getByRole('heading', { name: 'Witaj w SiteGrid.' }).waitFor();
  assert.equal(await status('/api/admin/overview'), 200);
};
let step = 'HTTPS login';
try {
  await page.goto(origin);
  await page.waitForFunction(() => !document.querySelector('button[type=submit]')?.disabled);
  assert.equal(await status('/api/admin/overview'), 401);
  await page.getByLabel('Email', { exact: true }).fill(credentials.email);
  await page.getByLabel('Hasło', { exact: true }).fill('invalid-random-test-password');
  await page.getByRole('button', { name: 'Zaloguj się', exact: true }).click();
  await page.getByRole('alert').waitFor();
  await page.getByLabel('Hasło', { exact: true }).fill(credentials.password);
  await page.getByRole('button', { name: 'Zaloguj się', exact: true }).click();
  await page.getByRole('heading', { name: 'Witaj w SiteGrid.' }).waitFor();
  const cookie = (await context.cookies()).find(c => c.name === '__Host-sitegrid');
  assert(cookie && cookie.secure && cookie.httpOnly && cookie.sameSite === 'Strict');
  assert.equal(await status('/api/admin/overview'), 200);
  console.log('PASS: HTTPS browser denial, invalid password, real login, protected panel, Secure cookie');
  step = 'restart/update/rollback';
  await remote(['systemctl', 'restart', 'sitegrid']);
  await ready('0.1.0'); await panel();
  await remote(['sitegrid', 'update', '--bundle', '/root/sitegrid-0.1.1-linux-x64.tar.gz', '--version', '0.1.1', '--sha256', process.env.SITEGRID_TEST_UPDATE_SHA, '--yes']);
  await ready('0.1.1'); await panel();
  await remote(['sitegrid', 'rollback', '--yes']);
  await ready('0.1.0'); await panel();
  assert((await context.cookies()).find(c => c.name === '__Host-sitegrid').value === cookie.value, 'Session token changed');
  console.log('PASS: same deployed account/session through systemd restart, installed CLI update and rollback');
  step = 'logout/mobile layout';
  await page.getByRole('button', { name: 'Wyloguj się' }).click();
  await page.getByRole('heading', { name: 'Zaloguj się.' }).waitFor();
  assert.equal(await status('/api/admin/overview'), 401);
  await context.addCookies([{ ...cookie, url: undefined }]);
  assert.equal(await status('/api/admin/overview'), 401, 'Logged-out session was reused');
  await context.clearCookies();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await page.getByRole('heading', { name: 'Zaloguj się.' }).waitFor();
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  console.log('PASS: logout revocation and mobile login layout');
} catch {
  // Playwright call logs can include fill values; never print a raw exception.
  console.error(`FAIL: deployed browser smoke at ${step}`);
  process.exitCode = 1;
} finally { await browser.close(); }
