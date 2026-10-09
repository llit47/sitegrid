import { resolve } from 'node:path';

export function readConfig(env: NodeJS.ProcessEnv = process.env) {
  const production = env.NODE_ENV === 'production';
  if (!['development', 'test', 'production'].includes(env.NODE_ENV ?? 'development')) {
    throw new Error('Invalid NODE_ENV');
  }
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl || !/^postgres(ql)?:\/\//.test(databaseUrl)) throw new Error('DATABASE_URL is required');
  const port = Number(env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
  const origin = new URL(env.PUBLIC_ORIGIN ?? (production ? '' : 'http://localhost:5173'));
  if (origin.origin !== (env.PUBLIC_ORIGIN ?? 'http://localhost:5173')) throw new Error('PUBLIC_ORIGIN must be an origin without a path');
  if (production && origin.protocol !== 'https:') throw new Error('Production requires HTTPS PUBLIC_ORIGIN');
  if (!['https:', 'http:'].includes(origin.protocol)) throw new Error('Invalid PUBLIC_ORIGIN');
  if (production && env.HOST && env.HOST !== '127.0.0.1') throw new Error('Production API must listen on loopback');
  return {
    production, databaseUrl, port, origin: origin.origin,
    host: env.HOST ?? '127.0.0.1',
    webRoot: resolve(env.WEB_ROOT ?? 'dist/web'),
    migrationsRoot: resolve(env.MIGRATIONS_ROOT ?? 'migrations'),
  };
}
export type Config = ReturnType<typeof readConfig>;
