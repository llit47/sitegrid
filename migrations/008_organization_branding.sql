-- Run with the separate migration owner, never the runtime role.
DO $$
BEGIN
  IF current_user = 'sitegrid' THEN
    RAISE EXCEPTION 'Branding migrations require a separate owner role';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sitegrid') AND EXISTS (
    SELECT 1 FROM pg_roles WHERE pg_has_role('sitegrid', oid, 'MEMBER')
      AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolname = current_user)
  ) THEN
    RAISE EXCEPTION 'sitegrid must not own tenant tables or inherit privileged roles';
  END IF;
END $$;

-- Missing rows represent defaults at version 1; the first mutation materializes them.
CREATE TABLE organization_settings (
  organization_id uuid PRIMARY KEY REFERENCES organizations(id),
  accent_color text NOT NULL DEFAULT '#163638' CHECK (accent_color ~ '^#[0-9a-f]{6}$'),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE organization_logos (
  organization_id uuid PRIMARY KEY REFERENCES organization_settings(organization_id),
  data bytea NOT NULL CHECK (octet_length(data) BETWEEN 1 AND 262144),
  mime_type text NOT NULL CHECK (mime_type IN ('image/png', 'image/jpeg', 'image/webp')),
  version integer NOT NULL CHECK (version > 1),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Invoker rights retain existing membership RLS; no SECURITY DEFINER or platform bypass.
CREATE FUNCTION can_access_organization_branding(tenant uuid, administer boolean DEFAULT false)
RETURNS boolean LANGUAGE sql STABLE SET search_path FROM CURRENT AS $$
  SELECT tenant = NULLIF(current_setting('sitegrid.organization_id', true), '')::uuid
    AND EXISTS (
      SELECT 1 FROM organization_memberships m
      JOIN organizations o ON o.id = m.organization_id
      JOIN users u ON u.id = m.user_id
      WHERE m.organization_id = tenant AND m.status = 'active' AND o.status = 'active'
        AND u.blocked_at IS NULL AND m.user_id = NULLIF(current_setting('sitegrid.user_id', true), '')::uuid
        AND (NOT administer OR EXISTS (
          SELECT 1 FROM membership_roles r WHERE (r.organization_id, r.membership_id) = (m.organization_id, m.id)
            AND r.role = 'organization_admin'
        ))
    )
$$;
ALTER TABLE organization_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_settings FORCE ROW LEVEL SECURITY;
ALTER TABLE organization_logos ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_logos FORCE ROW LEVEL SECURITY;
CREATE POLICY organization_settings_read ON organization_settings FOR SELECT
  USING (can_access_organization_branding(organization_id));
CREATE POLICY organization_settings_insert ON organization_settings FOR INSERT
  WITH CHECK (can_access_organization_branding(organization_id, true));
CREATE POLICY organization_settings_update ON organization_settings FOR UPDATE
  USING (can_access_organization_branding(organization_id, true))
  WITH CHECK (can_access_organization_branding(organization_id, true));
CREATE POLICY organization_logos_read ON organization_logos FOR SELECT
  USING (can_access_organization_branding(organization_id));
CREATE POLICY organization_logos_write ON organization_logos FOR ALL
  USING (can_access_organization_branding(organization_id, true))
  WITH CHECK (can_access_organization_branding(organization_id, true));

-- Organizations remain a platform directory. Only name UPDATE is granted to runtime,
-- with a tenant/actor guard; status/identity and platform provisioning stay separate.
CREATE FUNCTION protect_organization_branding_name() RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF current_user = 'sitegrid' AND NOT COALESCE(can_access_organization_branding(OLD.id, true), false) THEN
    RAISE EXCEPTION 'Company name update denied' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER protect_organization_branding_name BEFORE UPDATE OF name ON organizations
  FOR EACH ROW EXECUTE FUNCTION protect_organization_branding_name();

ALTER TABLE organization_audit_events DROP CONSTRAINT organization_audit_events_event_check;
ALTER TABLE organization_audit_events ADD CONSTRAINT organization_audit_events_event_check
  CHECK (event IN ('role_assigned', 'role_removed', 'membership_deactivated', 'membership_reactivated',
    'employee_created', 'employee_updated', 'employee_deactivated', 'employee_reactivated',
    'branding_updated', 'logo_replaced', 'logo_removed'));
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sitegrid') THEN
    GRANT SELECT, INSERT, UPDATE ON organization_settings TO sitegrid;
    GRANT SELECT, INSERT, UPDATE, DELETE ON organization_logos TO sitegrid;
    GRANT UPDATE (name) ON organizations TO sitegrid;
  END IF;
END $$;
