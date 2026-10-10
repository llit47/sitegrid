// A fresh Node process: no in-memory receipt state can survive from the first request.
import pg from 'pg';
import { buildApp } from '../../apps/server/src/app.ts';
import { readConfig } from '../../apps/server/src/config.ts';
let input = '';
for await (const chunk of process.stdin) input += chunk;
const { databaseUrl, origin, url, headers, payload } = JSON.parse(input);
const pool = new pg.Pool({ connectionString: databaseUrl });
const config = readConfig({ NODE_ENV: 'test', DATABASE_URL: databaseUrl, PUBLIC_ORIGIN: origin });
const app = await buildApp(config, pool);
try {
  const result = await app.inject({ method: 'POST', url, headers, payload });
  process.stdout.write(JSON.stringify({ statusCode: result.statusCode, body: result.json() }));
} finally { await app.close(); await pool.end(); }
