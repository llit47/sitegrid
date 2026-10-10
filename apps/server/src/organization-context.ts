import type { Pool, PoolClient } from 'pg';
export type TransactionOptions = { isolation: 'repeatable read'; readOnly: true };

// Callbacks share one connection and must not manage the transaction themselves.
export async function withTransaction<T>(
  pool: Pool,
  work: (client: PoolClient) => Promise<T>,
  options?: TransactionOptions,
): Promise<T> {
  const client = await pool.connect();
  let discard = false;
  try {
    await client.query(options ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' : 'BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); }
    catch { discard = true; }
    throw error;
  } finally { client.release(discard); }
}

// API callers supply authorization, executed in the same transaction BEFORE tenant setup.
// Without it, callers are responsible for passing an already authorized organization.
export async function withOrganization<T>(
  pool: Pool,
  organizationId: string,
  work: (client: PoolClient) => Promise<T>,
  authorize?: (client: PoolClient) => Promise<void>,
  options?: TransactionOptions,
): Promise<T> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(organizationId)) {
    throw new Error('A valid organization UUID is required');
  }
  return withTransaction(pool, async client => {
    if (authorize) await authorize(client);
    await client.query("SELECT set_config('sitegrid.organization_id', $1::uuid::text, true)", [organizationId]);
    return work(client);
  }, options);
}
