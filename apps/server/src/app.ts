import Fastify, { LogController } from 'fastify';
import fastifyStatic from '@fastify/static';
import type { Pool } from 'pg';
import type { Config } from './config.js';
import { checkMigrations } from './migrations.js';
import { registerAuth } from './auth/routes.js';

export async function buildApp(config: Config, pool: Pool, options: { logger?: boolean; serveWeb?: boolean } = {}) {
  const app = Fastify({ logger: options.logger ? { redact: ['req.headers.cookie', 'req.headers.authorization', 'res.headers["set-cookie"]'] } : false,
    logController: new LogController({ disableRequestLogging: true }), bodyLimit: 8192,
    trustProxy: config.production ? '127.0.0.1' : false });
  app.addHook('onSend', async (_request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  });
  app.get('/health/live', async () => ({ status: 'ok' }));
  app.get('/health/ready', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    try { return { status: 'ready', schema: await checkMigrations(pool, config.migrationsRoot) }; }
    catch { return reply.code(503).send({ status: 'not_ready' }); }
  });
  await registerAuth(app, pool, config);
  if (options.serveWeb ?? config.production) {
    await app.register(fastifyStatic, { root: config.webRoot, prefix: '/' });
    app.setNotFoundHandler((request, reply) => {
      if (request.method === 'GET' && !request.url.startsWith('/api/') && !request.url.startsWith('/health/')) {
        return reply.header('Cache-Control', 'no-cache').sendFile('index.html');
      }
      return reply.code(404).send({ error: 'Not found' });
    });
  }
  return app;
}
