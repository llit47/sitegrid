import type { PoolClient } from 'pg';

// Keep the historical lock key: DB triggers and all company writers share it.
export async function lockOrganization(client: PoolClient, organizationId: string) {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended('sitegrid.invitation:' || $1::uuid::text, 0))", [organizationId]);
}
