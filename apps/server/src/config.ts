import { resolve } from 'node:path';
import { normalizeEmail } from './auth/password.js';

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
  const manualInvitationLinks = env.INVITATION_MANUAL_LINKS === 'true';
  if (env.INVITATION_MANUAL_LINKS && !['true', 'false'].includes(env.INVITATION_MANUAL_LINKS)) throw new Error('Invalid INVITATION_MANUAL_LINKS');
  if (production && manualInvitationLinks) throw new Error('Manual invitation links are development-only');
  const smtpSecure = env.SMTP_SECURE === 'true';
  if (env.SMTP_SECURE && !['true', 'false'].includes(env.SMTP_SECURE)) throw new Error('Invalid SMTP_SECURE');
  const smtpPort = Number(env.SMTP_PORT ?? (smtpSecure ? 465 : 587));
  if (!Number.isInteger(smtpPort) || smtpPort < 1 || smtpPort > 65535) throw new Error('Invalid SMTP_PORT');
  if (Boolean(env.SMTP_USER) !== Boolean(env.SMTP_PASSWORD)) throw new Error('SMTP_USER and SMTP_PASSWORD must be set together');
  const smtp = env.SMTP_HOST ? {
    host: env.SMTP_HOST, port: smtpPort, secure: smtpSecure,
    from: normalizeEmail(env.SMTP_FROM ?? ''),
    auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASSWORD! } : undefined,
  } : undefined;
  if (!smtp && [env.SMTP_PORT, env.SMTP_SECURE, env.SMTP_FROM, env.SMTP_USER, env.SMTP_PASSWORD].some(Boolean)) throw new Error('SMTP_HOST is required for SMTP settings');
  return {
    production, databaseUrl, port, origin: origin.origin, smtp, manualInvitationLinks,
    host: env.HOST ?? '127.0.0.1',
    webRoot: resolve(env.WEB_ROOT ?? 'dist/web'),
    migrationsRoot: resolve(env.MIGRATIONS_ROOT ?? 'migrations'),
  };
}
export type Config = ReturnType<typeof readConfig>;
