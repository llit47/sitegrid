-- Run as the migration owner, never as the application runtime role.
DO $$
BEGIN
  IF current_user = 'sitegrid' THEN
    RAISE EXCEPTION 'Membership migrations require a separate owner role';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sitegrid') THEN
    IF EXISTS (
      SELECT 1 FROM pg_roles
      WHERE pg_has_role('sitegrid', oid, 'MEMBER')
        AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolname = current_user)
    ) THEN
      RAISE EXCEPTION 'sitegrid must not own tenant tables or inherit privileged roles';
    END IF;
  END IF;
END $$;

CREATE TABLE organization_memberships (
  organization_id uuid NOT NULL REFERENCES organizations(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'inactive')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, id),
  UNIQUE (organization_id, user_id)
);
CREATE INDEX organization_memberships_user ON organization_memberships(user_id);

CREATE TABLE membership_roles (
  organization_id uuid NOT NULL,
  membership_id uuid NOT NULL,
  role text NOT NULL CHECK (role IN ('organization_admin', 'manager', 'foreman', 'worker')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, membership_id, role),
  FOREIGN KEY (organization_id, membership_id)
    REFERENCES organization_memberships(organization_id, id)
);

ALTER TABLE organization_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_memberships FORCE ROW LEVEL SECURITY;
ALTER TABLE membership_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE membership_roles FORCE ROW LEVEL SECURITY;

-- An unset or transaction-reset (empty) context matches no tenant.
CREATE POLICY organization_memberships_tenant ON organization_memberships
  USING (organization_id = NULLIF(current_setting('sitegrid.organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('sitegrid.organization_id', true), '')::uuid);
CREATE POLICY membership_roles_tenant ON membership_roles
  USING (organization_id = NULLIF(current_setting('sitegrid.organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('sitegrid.organization_id', true), '')::uuid);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sitegrid') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON organization_memberships, membership_roles TO sitegrid;
  END IF;
END $$;
