import { createHash } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import type { Config } from '../config.js';

export type Session = { token_hash: string; user_id: string | null; csrf_token: string; email: string | null; admin: boolean };

export async function readSession(db: Pool | PoolClient, request: FastifyRequest, config: Config): Promise<Session | undefined> {
  const raw = request.cookies[config.production ? '__Host-sitegrid' : 'sitegrid'];
  if (!raw || !/^[A-Za-z0-9_-]{43}$/.test(raw)) return;
  const { rows } = await db.query<Session>(`
    SELECT s.token_hash, s.user_id, s.csrf_token, u.email,
      EXISTS(SELECT 1 FROM platform_admins a WHERE a.user_id = u.id) AS admin
    FROM sessions s LEFT JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = $1 AND s.expires_at > now()
      AND (s.user_id IS NULL OR (u.id IS NOT NULL AND u.blocked_at IS NULL))`,
  [createHash('sha256').update(raw).digest('hex')]);
  return rows[0];
}
