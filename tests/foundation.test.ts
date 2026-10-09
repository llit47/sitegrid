import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readConfig } from '../apps/server/src/config.js';
import { createPool } from '../apps/server/src/db.js';
import { buildApp } from '../apps/server/src/app.js';
import { migrate, checkMigrations, migrationFiles } from '../apps/server/src/migrations.js';

test('production rejects incomplete and insecure config', () => {
  assert.throws(() => readConfig({ NODE_ENV: 'production' }));
  assert.throws(() => readConfig({ NODE_ENV: 'production', DATABASE_URL: 'postgresql://localhost/test', PUBLIC_ORIGIN: 'http://example.test' }));
  assert.throws(() => readConfig({ DATABASE_URL: 'postgresql://localhost/test', PORT: '0' }));
});

test('liveness survives unavailable PostgreSQL; readiness fails closed', async () => {
  const config = readConfig({ DATABASE_URL: 'postgresql://127.0.0.1:1/missing', NODE_ENV: 'test' });
  const pool = createPool(config.databaseUrl);
  const app = await buildApp(config, pool);
  try {
    assert.equal((await app.inject('/health/live')).statusCode, 200);
    const response = await app.inject('/health/ready');
    assert.equal(response.statusCode, 503);
    assert.deepEqual(response.json(), { status: 'not_ready' });
    assert.equal((await app.inject('/api/missing')).statusCode, 404);
  } finally { await app.close(); await pool.end(); }
});

test('real PostgreSQL migrations are repeatable and readiness checks schema', { skip: !process.env.TEST_DATABASE_URL }, async () => {
  const config = readConfig({ DATABASE_URL: process.env.TEST_DATABASE_URL, NODE_ENV: 'test' });
  const pool = createPool(config.databaseUrl);
  const app = await buildApp(config, pool);
  try {
    const version = await migrate(pool, config.migrationsRoot);
    assert.equal(await migrate(pool, config.migrationsRoot), version);
    assert.equal(await checkMigrations(pool, config.migrationsRoot), version);
    assert.equal((await app.inject('/health/ready')).statusCode, 200);
    await pool.query('UPDATE schema_migrations SET checksum = $1 WHERE version = 1', ['invalid']);
    assert.equal((await app.inject('/health/ready')).statusCode, 503);
    await assert.rejects(migrate(pool, config.migrationsRoot), /history mismatch/);
    await pool.query('UPDATE schema_migrations SET checksum = $1 WHERE version = 1', [(await migrationFiles(config.migrationsRoot))[0].checksum]);
  } finally { await app.close(); await pool.end(); }
});
