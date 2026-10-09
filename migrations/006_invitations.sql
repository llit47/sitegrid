-- Runtime grants are limited to the new onboarding writes. Existing tenant policies stay intact.
DO $$
BEGIN
  IF current_user = 'sitegrid' THEN
    RAISE EXCEPTION 'Invitation migrations require a separate owner role';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sitegrid') AND EXISTS (
    SELECT 1 FROM pg_roles WHERE pg_has_role('sitegrid', oid, 'MEMBER')
      AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolname = current_user)
  ) THEN
    RAISE EXCEPTION 'sitegrid must not own tenant tables or inherit privileged roles';
  END IF;
END $$;

CREATE TABLE organization_invitations (
  organization_id uuid NOT NULL REFERENCES organizations(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  email text NOT NULL CHECK (email = lower(btrim(email))),
  role text NOT NULL CHECK (role IN ('organization_admin', 'manager', 'foreman', 'worker')),
  first_administrator boolean NOT NULL DEFAULT false,
  issuer_id uuid NOT NULL REFERENCES users(id),
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '24 hours'),
  accepted_at timestamptz,
  accepted_by uuid REFERENCES users(id),
  revoked_at timestamptz,
  PRIMARY KEY (organization_id, id),
  CHECK (expires_at > created_at),
  CHECK ((accepted_at IS NULL) = (accepted_by IS NULL)),
  CHECK (accepted_at IS NULL OR revoked_at IS NULL),
  CHECK (NOT first_administrator OR role = 'organization_admin')
);
CREATE UNIQUE INDEX invitation_pending_email ON organization_invitations(organization_id, email)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;
CREATE UNIQUE INDEX invitation_pending_first_admin ON organization_invitations(organization_id)
  WHERE first_administrator AND accepted_at IS NULL AND revoked_at IS NULL;

ALTER TABLE organization_invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_invitations FORCE ROW LEVEL SECURITY;
CREATE POLICY organization_invitations_tenant ON organization_invitations
  USING (organization_id = NULLIF(current_setting('sitegrid.organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('sitegrid.organization_id', true), '')::uuid);
-- Read-only capability lookup, set locally only from the hash of a supplied token.
CREATE POLICY organization_invitations_token ON organization_invitations FOR SELECT
  USING (token_hash = NULLIF(current_setting('sitegrid.invitation_hash', true), ''));

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sitegrid') THEN
    GRANT SELECT, INSERT, UPDATE ON organization_invitations TO sitegrid;
    GRANT INSERT ON users, credentials TO sitegrid;
  END IF;
END $$;
