import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import type { Pool, PoolClient } from 'pg';

export async function migrationFiles(directory: string) {
  const names = (await readdir(directory)).filter(n => /^\d{3}_[a-z0-9_]+\.sql$/.test(n)).sort();
  if (!names.length) throw new Error('No migrations found');
  return Promise.all(names.map(async (name, i) => {
    const version = Number(name.slice(0, 3));
    if (version !== i + 1) throw new Error('Migrations must be consecutive');
    const sql = await readFile(`${directory}/${name}`, 'utf8');
    return { version, name, sql, checksum: createHash('sha256').update(sql).digest('hex') };
  }));
}

export async function checkMigrations(db: Pool | PoolClient, directory: string) {
  const files = await migrationFiles(directory);
  const result = await db.query<{ version: number; checksum: string }>('SELECT version, checksum FROM schema_migrations ORDER BY version');
  if (result.rows.length !== files.length || result.rows.some((row, i) => row.version !== files[i].version || row.checksum !== files[i].checksum)) {
    throw new Error('Database schema does not match this release');
  }
  return files.length;
}

export async function migrate(pool: Pool, directory: string) {
  const files = await migrationFiles(directory);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(73104101)');
    const { rows } = await client.query<{ server_version_num: string }>('SHOW server_version_num');
    if (Number(rows[0].server_version_num) < 170000) throw new Error('PostgreSQL 17+ required');
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY, name text NOT NULL, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())');
    const applied = await client.query<{ version: number; checksum: string }>('SELECT version, checksum FROM schema_migrations ORDER BY version');
    for (const [i, row] of applied.rows.entries()) {
      if (!files[i] || row.version !== files[i].version || row.checksum !== files[i].checksum) throw new Error('Migration history mismatch; restore/check release before continuing');
    }
    for (const file of files.slice(applied.rows.length)) {
      await client.query(file.sql);
      await client.query('INSERT INTO schema_migrations(version, name, checksum) VALUES ($1, $2, $3)', [file.version, file.name, file.checksum]);
    }
    await client.query('COMMIT');
    return files.length;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}
