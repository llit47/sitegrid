import { createPool } from './db.js';
import { migrate } from './migrations.js';
import { resolve } from 'node:path';

const url = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
if (!url) throw new Error('MIGRATION_DATABASE_URL or DATABASE_URL required');
const pool = createPool(url);
try {
  console.log(`Schema ready: ${await migrate(pool, resolve(process.env.MIGRATIONS_ROOT ?? 'migrations'))}`);
} catch {
  console.error('Migration failed. Check PostgreSQL availability, privileges and migration history. No credentials are printed.');
  process.exitCode = 1;
} finally { await pool.end(); }
