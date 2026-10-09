import type { Pool, PoolClient } from 'pg';

// The caller must authorize the actor and organization before using this helper (M03).
// The callback shares one connection and must not manage the transaction itself.
export async function withOrganization<T>(
  pool: Pool,
  organizationId: string,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(organizationId)) {
    throw new Error('A valid organization UUID is required');
  }
  const client = await pool.connect();
  let discard = false;
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('sitegrid.organization_id', $1::uuid::text, true)", [organizationId]);
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); }
    catch { discard = true; }
    throw error;
  } finally { client.release(discard); }
}
