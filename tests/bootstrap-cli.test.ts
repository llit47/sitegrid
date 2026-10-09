import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { createPool } from '../apps/server/src/db.js';
import { migrate } from '../apps/server/src/migrations.js';

test('local interactive CLI bootstraps once without echoing the password', { skip: !process.env.TEST_DATABASE_URL, timeout: 20000 }, async () => {
  const adminPool = createPool(process.env.TEST_DATABASE_URL!);
  const schema = `cli_test_${randomBytes(6).toString('hex')}`;
  await adminPool.query(`CREATE SCHEMA ${schema}`);
  const url = new URL(process.env.TEST_DATABASE_URL!);
  url.searchParams.set('options', `-c search_path=${schema}`);
  const pool = createPool(url.href);
  const password = randomBytes(24).toString('base64url');
  const env = { ...process.env, DATABASE_URL: url.href, BOOTSTRAP_DATABASE_URL: url.href };
  try {
    await migrate(pool, 'migrations');
    for (let run = 0; run < 2; run++) {
      const child = spawn('script', ['--quiet', '--return', '--command', 'node dist/server/bootstrap-cli.js', '/dev/null'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
      let output = '';
      child.stdout.on('data', data => { output += data.toString(); });
      child.stderr.on('data', data => { output += data.toString(); });
      const exited = once(child, 'exit');
      const waitFor = async (prompt: string) => {
        for (let i = 0; i < 100 && !output.includes(prompt) && child.exitCode === null; i++) await delay(20);
        assert(output.includes(prompt), 'Expected interactive prompt not received');
      };
      try {
        await waitFor('Email pierwszego administratora:'); child.stdin.write('cli-admin@example.test\n');
        await waitFor('niewidoczne):'); child.stdin.write(password + '\n');
        await waitFor('Powtórz hasło:'); child.stdin.write(password + '\n');
        assert.equal((await exited)[0], run === 0 ? 0 : 1);
        assert(!output.includes(password), 'Password was echoed');
        if (run === 0) assert(output.includes('Administrator utworzony'));
      } finally { if (child.exitCode === null) child.kill('SIGKILL'); }
    }
    assert.equal((await pool.query('SELECT count(*) FROM users')).rows[0].count, '1');
    const child = spawn(process.execPath, ['dist/server/bootstrap-cli.js'], { env, stdio: 'ignore' });
    assert.equal((await once(child, 'exit'))[0], 1);
  } finally { await pool.end(); await adminPool.query(`DROP SCHEMA ${schema} CASCADE`); await adminPool.end(); }
});
