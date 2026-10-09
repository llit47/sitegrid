import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { hashPassword, normalizeEmail } from './password.js';

export async function bootstrapAdmin(pool: Pool, emailInput: string, password: string) {
  const email = normalizeEmail(emailInput);
  const hash = await hashPassword(password);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT bootstrap_completed_at FROM installation WHERE id = true FOR UPDATE');
    if (rows.length !== 1 || rows[0].bootstrap_completed_at) throw new Error('Bootstrap already completed or installation unavailable');
    const id = randomUUID();
    await client.query('INSERT INTO users(id, email) VALUES ($1, $2)', [id, email]);
    await client.query('INSERT INTO credentials(user_id, password_hash) VALUES ($1, $2)', [id, hash]);
    await client.query('INSERT INTO platform_admins(user_id) VALUES ($1)', [id]);
    await client.query('UPDATE installation SET bootstrap_completed_at = now() WHERE id = true');
    await client.query("INSERT INTO platform_audit_events(actor_id, event) VALUES ($1, 'admin_bootstrap')", [id]);
    await client.query('COMMIT');
    return id;
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
