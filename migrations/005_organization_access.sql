-- Discovery is read-only and available only before a tenant context is selected.
-- The server sets user_id locally after checking a live session and unblocked account.
-- These policies run as the runtime role, with RLS enabled; no SECURITY DEFINER.
CREATE POLICY organization_memberships_self ON organization_memberships FOR SELECT
  USING (
    NULLIF(current_setting('sitegrid.organization_id', true), '') IS NULL
    AND user_id = NULLIF(current_setting('sitegrid.user_id', true), '')::uuid
    AND status = 'active'
    AND EXISTS (SELECT 1 FROM organizations o WHERE o.id = organization_id AND o.status = 'active')
  );

CREATE POLICY membership_roles_self ON membership_roles FOR SELECT
  USING (
    NULLIF(current_setting('sitegrid.organization_id', true), '') IS NULL
    AND EXISTS (
      SELECT 1 FROM organization_memberships m
      WHERE (m.organization_id, m.id) = (membership_roles.organization_id, membership_roles.membership_id)
        AND m.user_id = NULLIF(current_setting('sitegrid.user_id', true), '')::uuid
        AND m.status = 'active'
    )
  );
