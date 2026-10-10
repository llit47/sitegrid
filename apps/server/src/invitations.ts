import { lockOrganization } from './common/organization-lock.js';
import { createHash, randomBytes } from 'node:crypto';
import nodemailer from 'nodemailer';
import type { PoolClient } from 'pg';
import type { Config } from './config.js';
import type { OrganizationRole } from './organization-access.js';

export const invitationHash = (token: string) => createHash('sha256').update(token).digest('hex');
export const invitationColumns = `id, email, role, first_administrator AS "firstAdministrator",
  created_at AS "createdAt", expires_at AS "expiresAt",
  CASE WHEN accepted_at IS NOT NULL THEN 'accepted' WHEN revoked_at IS NOT NULL THEN 'revoked'
    WHEN expires_at <= clock_timestamp() THEN 'expired' ELSE 'pending' END AS status`;
export const invitationError = () => Object.assign(new Error('Invitation unavailable'), { statusCode: 409 });

export async function requireFirstAdministrator(client: PoolClient, organizationId: string) {
  const { rows } = await client.query(`SELECT
    EXISTS(SELECT 1 FROM organization_memberships WHERE organization_id = $1) OR
    EXISTS(SELECT 1 FROM organization_invitations WHERE organization_id = $1
      AND first_administrator AND accepted_at IS NOT NULL) AS activated`, [organizationId]);
  if (rows[0].activated) throw invitationError();
}
export function requireInvitationDelivery(config: Config) {
  if (!config.smtp && (config.production || !config.manualInvitationLinks)) {
    throw new Error('SMTP must be configured before issuing invitations');
  }
}
export async function createInvitation(client: PoolClient, organizationId: string, issuerId: string,
  email: string, role: OrganizationRole, firstAdministrator: boolean) {
  await lockOrganization(client, organizationId);
  const { rows: organizations } = await client.query("SELECT name FROM organizations WHERE id = $1 AND status = 'active'", [organizationId]);
  if (!organizations[0]) throw invitationError();
  if (firstAdministrator) await requireFirstAdministrator(client, organizationId);
  // A new invitation replaces every outstanding link for this recipient (or first administrator).
  await client.query(`UPDATE organization_invitations SET revoked_at = clock_timestamp()
    WHERE organization_id = $1 AND accepted_at IS NULL AND revoked_at IS NULL
      AND (email = $2 OR ($3 AND first_administrator))`, [organizationId, email, firstAdministrator]);
  const token = randomBytes(32).toString('base64url');
  const { rows } = await client.query(`INSERT INTO organization_invitations
    (organization_id, issuer_id, email, role, first_administrator, token_hash)
    VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${invitationColumns}`,
  [organizationId, issuerId, email, role, firstAdministrator, invitationHash(token)]);
  return { invitation: rows[0], token, organizationName: organizations[0].name as string };
}

// Call only after commit. SMTP errors must never reach logs: they may contain message content.
export async function deliverInvitation(config: Config, created: Awaited<ReturnType<typeof createInvitation>>) {
  const link = `${config.origin}/invitations/accept#${created.token}`;
  if (!config.smtp) {
    requireInvitationDelivery(config);
    return { invitation: created.invitation, delivery: 'manual', acceptanceLink: link };
  }
  const { from, ...smtp } = config.smtp;
  const transport = nodemailer.createTransport({ ...smtp, requireTLS: config.production && !smtp.secure,
    logger: false, debug: false, disableFileAccess: true, disableUrlAccess: true,
    connectionTimeout: 5000, greetingTimeout: 5000, socketTimeout: 10000 });
  try {
    await transport.sendMail({ from: { name: 'SiteGrid', address: from }, to: { address: created.invitation.email, name: '' },
      subject: 'Zaproszenie do SiteGrid',
      text: `Zaproszenie do firmy ${created.organizationName}.\n\nOtwórz link i zaakceptuj zaproszenie w ciągu 24 godzin:\n${link}\n\nJeśli masz już konto, zaloguj się na zaproszony adres email.`,
    });
    return { invitation: created.invitation, delivery: 'sent' };
  } catch {
    return { invitation: created.invitation, delivery: 'failed' };
  } finally { transport.close(); }
}
