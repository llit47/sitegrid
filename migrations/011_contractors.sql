-- Additive M09C: existing projects keep their identities, versions and history.
DO $$ BEGIN
  IF current_user = 'sitegrid' THEN RAISE EXCEPTION 'Contractor migration requires a separate owner'; END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sitegrid') AND EXISTS (
    SELECT 1 FROM pg_roles WHERE pg_has_role('sitegrid', oid, 'MEMBER')
      AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolname = current_user)
  ) THEN RAISE EXCEPTION 'sitegrid must not own tenant tables or inherit privileged roles'; END IF;
END $$;

CREATE TABLE contractors (
  organization_id uuid NOT NULL REFERENCES organizations(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (name = btrim(name) AND char_length(name) BETWEEN 1 AND 200 AND name !~ '[[:cntrl:]]'),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, id)
);
ALTER TABLE projects ADD COLUMN contractor_id uuid;
ALTER TABLE projects ADD CONSTRAINT projects_contractor_fk
  FOREIGN KEY (organization_id, contractor_id) REFERENCES contractors(organization_id, id);
CREATE INDEX projects_contractor ON projects(organization_id, contractor_id);

ALTER TABLE contractors ENABLE ROW LEVEL SECURITY;
ALTER TABLE contractors FORCE ROW LEVEL SECURITY;
-- No directory for project members: only records linked to their visible projects.
-- Projects' existing policies do not consult contractors, avoiding recursive RLS.
CREATE POLICY contractors_read ON contractors FOR SELECT USING (
  can_access_organization_branding(organization_id, true) OR EXISTS (
    SELECT 1 FROM projects p WHERE p.organization_id = contractors.organization_id
      AND p.contractor_id = contractors.id AND can_access_project(p.organization_id, p.id)
  )
);
CREATE POLICY contractors_insert ON contractors FOR INSERT
  WITH CHECK (can_access_organization_branding(organization_id, true));
CREATE POLICY contractors_update ON contractors FOR UPDATE
  USING (can_access_organization_branding(organization_id, true))
  WITH CHECK (can_access_organization_branding(organization_id, true));

CREATE FUNCTION protect_contractor_write() RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('sitegrid.invitation:' || NEW.organization_id::text, 0));
  IF TG_OP = 'UPDATE' THEN
    IF (NEW.organization_id, NEW.id, NEW.created_at) IS DISTINCT FROM (OLD.organization_id, OLD.id, OLD.created_at)
      OR NEW.version <> OLD.version + 1 THEN
      RAISE EXCEPTION 'Contractor identity is immutable; version must increase once' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF NEW.version <> 1 THEN RAISE EXCEPTION 'Initial version must be one' USING ERRCODE = '23514'; END IF;
    NEW.created_at := clock_timestamp();
  END IF;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END $$;
CREATE TRIGGER protect_contractors BEFORE INSERT OR UPDATE ON contractors
  FOR EACH ROW EXECUTE FUNCTION protect_contractor_write();

CREATE FUNCTION protect_project_contractor() RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  -- A retained inactive association is historical and does not block other edits.
  IF TG_OP = 'UPDATE' AND NEW.contractor_id IS NOT DISTINCT FROM OLD.contractor_id THEN RETURN NEW; END IF;
  IF NEW.contractor_id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('sitegrid.invitation:' || NEW.organization_id::text, 0));
    IF NOT EXISTS (SELECT 1 FROM contractors c WHERE (c.organization_id, c.id) = (NEW.organization_id, NEW.contractor_id)
      AND c.status = 'active') THEN
      RAISE EXCEPTION 'Active local contractor required' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER protect_project_contractor BEFORE INSERT OR UPDATE OF contractor_id ON projects
  FOR EACH ROW EXECUTE FUNCTION protect_project_contractor();

ALTER TABLE organization_audit_events DROP CONSTRAINT organization_audit_events_event_check;
ALTER TABLE organization_audit_events ADD CONSTRAINT organization_audit_events_event_check CHECK (event IN (
  'role_assigned', 'role_removed', 'membership_deactivated', 'membership_reactivated',
  'employee_created', 'employee_updated', 'employee_deactivated', 'employee_reactivated',
  'branding_updated', 'logo_replaced', 'logo_removed', 'project_created', 'project_updated', 'project_archived',
  'project_member_assigned', 'project_member_revoked', 'task_created', 'task_updated', 'task_started', 'task_submitted',
  'contractor_created', 'contractor_updated', 'contractor_deactivated', 'contractor_reactivated'
));
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sitegrid') THEN
    GRANT SELECT, INSERT ON contractors TO sitegrid;
    GRANT UPDATE (name, status, version) ON contractors TO sitegrid;
  END IF;
END $$;
