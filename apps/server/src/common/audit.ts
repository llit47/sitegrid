import type { PoolClient } from 'pg';

// Use the caller's connection so audit failure rolls back the entire mutation.
export async function writeOrganizationAudit(client: PoolClient, organizationId: string, actorId: string,
  subjectId: string, event: string, details: object) {
  const { rows } = await client.query<{ id: string }>(`INSERT INTO organization_audit_events
    (organization_id, actor_id, subject_id, event, details, created_at)
    VALUES ($1, $2, $3, $4, $5, clock_timestamp()) RETURNING id`,
  [organizationId, actorId, subjectId, event, details]);
  return rows[0].id;
}
