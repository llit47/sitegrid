-- Run as the migration owner. No new global identity privileges.
DO $$
BEGIN
  IF current_user = 'sitegrid' THEN
    RAISE EXCEPTION 'Company member migrations require a separate owner role';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sitegrid') AND EXISTS (
    SELECT 1 FROM pg_roles WHERE pg_has_role('sitegrid', oid, 'MEMBER')
      AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolname = current_user)
  ) THEN
    RAISE EXCEPTION 'sitegrid must not own tenant tables or inherit privileged roles';
  END IF;
END $$;

CREATE TABLE employee_profiles (
  organization_id uuid NOT NULL REFERENCES organizations(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  membership_id uuid,
  display_name text NOT NULL CHECK (display_name = btrim(display_name)
    AND char_length(display_name) BETWEEN 1 AND 120 AND display_name !~ '[[:cntrl:]]'),
  position text NOT NULL DEFAULT '' CHECK (position = btrim(position)
    AND char_length(position) <= 120 AND position !~ '[[:cntrl:]]'),
  phone text NOT NULL DEFAULT '' CHECK (phone = btrim(phone)
    AND char_length(phone) <= 40 AND phone !~ '[[:cntrl:]]'),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, id),
  UNIQUE (organization_id, membership_id),
  FOREIGN KEY (organization_id, membership_id) REFERENCES organization_memberships(organization_id, id)
);

CREATE TABLE organization_audit_events (
  organization_id uuid NOT NULL REFERENCES organizations(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  actor_id uuid NOT NULL REFERENCES users(id),
  subject_id uuid NOT NULL,
  event text NOT NULL CHECK (event IN ('role_assigned', 'role_removed', 'membership_deactivated',
    'membership_reactivated', 'employee_created', 'employee_updated', 'employee_deactivated', 'employee_reactivated')),
  details jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, id)
);

ALTER TABLE employee_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_profiles FORCE ROW LEVEL SECURITY;
ALTER TABLE organization_audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_audit_events FORCE ROW LEVEL SECURITY;
CREATE POLICY employee_profiles_tenant ON employee_profiles
  USING (organization_id = NULLIF(current_setting('sitegrid.organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('sitegrid.organization_id', true), '')::uuid);
CREATE POLICY organization_audit_events_tenant ON organization_audit_events
  USING (organization_id = NULLIF(current_setting('sitegrid.organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('sitegrid.organization_id', true), '')::uuid);

-- Invoker functions retain FORCE RLS. Bind names to this migration's schema.
-- Use PR9's company lock so invitation acceptance and member changes serialize together.
CREATE FUNCTION protect_company_administrator() RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE
  member_id uuid;
BEGIN
  IF TG_TABLE_NAME = 'organization_memberships' THEN
    member_id := OLD.id;
    IF TG_OP = 'UPDATE' THEN
      IF NEW.organization_id IS DISTINCT FROM OLD.organization_id THEN
        RAISE EXCEPTION 'Membership company is immutable' USING ERRCODE = '42501';
      END IF;
      IF (NEW.id, NEW.user_id) IS DISTINCT FROM (OLD.id, OLD.user_id) THEN
        RAISE EXCEPTION 'Membership identity is immutable' USING ERRCODE = '23514';
      END IF;
      IF (NEW.status = 'active' AND NEW.organization_id = OLD.organization_id) OR OLD.status <> 'active' THEN RETURN NEW; END IF;
    ELSIF OLD.status <> 'active' THEN RETURN OLD;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM membership_roles WHERE organization_id = OLD.organization_id
      AND membership_id = member_id AND role = 'organization_admin') THEN
      IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
    END IF;
  ELSE
    member_id := OLD.membership_id;
    IF OLD.role <> 'organization_admin' THEN
      IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
    END IF;
    IF TG_OP = 'UPDATE' AND (NEW.organization_id, NEW.membership_id, NEW.role)
      IS NOT DISTINCT FROM (OLD.organization_id, OLD.membership_id, OLD.role) THEN RETURN NEW; END IF;
    IF NOT EXISTS (SELECT 1 FROM organization_memberships WHERE organization_id = OLD.organization_id
      AND id = member_id AND status = 'active') THEN
      IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
    END IF;
  END IF;
  -- A fresh statement snapshot after waiting is required for the following check.
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'Administrator changes require read committed isolation' USING ERRCODE = '40001';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('sitegrid.invitation:' || OLD.organization_id::text, 0));
  IF NOT EXISTS (
    SELECT 1 FROM organization_memberships m JOIN membership_roles r
      ON (r.organization_id, r.membership_id) = (m.organization_id, m.id)
      JOIN users u ON u.id = m.user_id
    WHERE m.organization_id = OLD.organization_id AND m.id <> member_id
      AND m.status = 'active' AND r.role = 'organization_admin' AND u.blocked_at IS NULL
  ) THEN
    RAISE EXCEPTION 'The last active company administrator must be retained'
      USING ERRCODE = '23514', CONSTRAINT = 'company_last_administrator';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;
CREATE TRIGGER protect_membership_administrator BEFORE UPDATE OR DELETE ON organization_memberships
  FOR EACH ROW EXECUTE FUNCTION protect_company_administrator();
CREATE TRIGGER protect_membership_admin_role BEFORE UPDATE OR DELETE ON membership_roles
  FOR EACH ROW EXECUTE FUNCTION protect_company_administrator();

-- A linked employee and membership have one status. No pending account activation here.
CREATE FUNCTION synchronize_employee_membership() RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE member_status text;
BEGIN
  IF TG_TABLE_NAME = 'organization_memberships' THEN
    UPDATE employee_profiles SET status = NEW.status
      WHERE organization_id = NEW.organization_id AND membership_id = NEW.id AND status <> NEW.status;
    RETURN NEW;
  END IF;
  IF TG_WHEN = 'AFTER' THEN
    UPDATE organization_memberships SET status = NEW.status
      WHERE organization_id = NEW.organization_id AND id = NEW.membership_id AND status <> NEW.status;
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.organization_id, NEW.id, NEW.membership_id)
    IS DISTINCT FROM (OLD.organization_id, OLD.id, OLD.membership_id) THEN
    RAISE EXCEPTION 'Employee association is immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.membership_id IS NOT NULL THEN
    SELECT status INTO member_status FROM organization_memberships
      WHERE organization_id = NEW.organization_id AND id = NEW.membership_id;
    IF member_status = 'pending' THEN
      RAISE EXCEPTION 'Pending memberships require invitation acceptance' USING ERRCODE = '23514';
    END IF;
    IF member_status IS NOT NULL AND TG_OP = 'INSERT' AND NEW.status IS DISTINCT FROM member_status THEN
      RAISE EXCEPTION 'Employee status must match membership' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER synchronize_membership_status AFTER UPDATE OF status ON organization_memberships
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status) EXECUTE FUNCTION synchronize_employee_membership();
CREATE TRIGGER synchronize_employee_status BEFORE INSERT OR UPDATE ON employee_profiles
  FOR EACH ROW EXECUTE FUNCTION synchronize_employee_membership();
CREATE TRIGGER propagate_employee_status AFTER UPDATE OF status ON employee_profiles
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status) EXECUTE FUNCTION synchronize_employee_membership();

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sitegrid') THEN
    GRANT SELECT, INSERT, UPDATE ON employee_profiles TO sitegrid;
    GRANT SELECT, INSERT ON organization_audit_events TO sitegrid;
  END IF;
END $$;
