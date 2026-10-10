import type { PoolClient } from 'pg';
import { contractorFailure } from './domain.js';

const columns = 'id, name, status, version, created_at AS "createdAt", updated_at AS "updatedAt"';
export type Contractor = { id: string; name: string; status: string; version: number; createdAt: Date; updatedAt: Date };
export async function listContractors(client: PoolClient, organizationId: string) {
  return (await client.query<Contractor>(`SELECT ${columns} FROM contractors WHERE organization_id = $1 ORDER BY name, id`, [organizationId])).rows;
}
export async function createContractor(client: PoolClient, organizationId: string, name: string) {
  return (await client.query<Contractor>(`INSERT INTO contractors(organization_id, name) VALUES ($1, $2) RETURNING ${columns}`, [organizationId, name])).rows[0];
}
export async function readContractor(client: PoolClient, organizationId: string, id: string) {
  const current = (await client.query<Contractor>(`SELECT ${columns} FROM contractors WHERE organization_id = $1 AND id = $2`, [organizationId, id])).rows[0];
  if (!current) throw contractorFailure(404);
  return current;
}
export async function updateContractor(client: PoolClient, organizationId: string, id: string, name: string, status: string, expected: number) {
  const updated = (await client.query<Contractor>(`UPDATE contractors SET name = $3, status = $4, version = version + 1
    WHERE organization_id = $1 AND id = $2 AND version = $5 RETURNING ${columns}`, [organizationId, id, name, status, expected])).rows[0];
  if (!updated) throw contractorFailure(409);
  return updated;
}
// Called under the company lock, before project writes; foreign/missing/inactive IDs
// all have the same response. Keeping a historical association needs no new grant.
export async function requireActiveContractor(client: PoolClient, organizationId: string, id: string | null) {
  if (id !== null && !(await client.query("SELECT id FROM contractors WHERE organization_id = $1 AND id = $2 AND status = 'active'", [organizationId, id])).rows[0]) throw contractorFailure(400);
}
