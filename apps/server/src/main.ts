import { readConfig } from './config.js';
import { createPool } from './db.js';
import { buildApp } from './app.js';

const config = readConfig();
const pool = createPool(config.databaseUrl);
pool.on('error', () => console.error('Idle database connection failed'));
const app = await buildApp(config, pool, { logger: true });
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  void app.close().then(() => pool.end());
});
try { await app.listen({ host: config.host, port: config.port }); }
catch { console.error('Unable to start SiteGrid'); await pool.end(); process.exitCode = 1; }
