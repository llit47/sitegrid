-- Separate migration owner; the application role must retain FORCE RLS.
DO $$
BEGIN
  IF current_user = 'sitegrid' THEN RAISE EXCEPTION 'Project migrations require a separate owner'; END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sitegrid') AND EXISTS (
    SELECT 1 FROM pg_roles WHERE pg_has_role('sitegrid', oid, 'MEMBER')
      AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolname = current_user)
  ) THEN RAISE EXCEPTION 'sitegrid must not own tenant tables or inherit privileged roles'; END IF;
END $$;

CREATE TABLE projects (
  organization_id uuid NOT NULL REFERENCES organizations(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (name = btrim(name) AND char_length(name) BETWEEN 1 AND 200 AND name !~ '[[:cntrl:]]'),
  description text NOT NULL DEFAULT '' CHECK (description = btrim(description) AND char_length(description) <= 4000 AND description !~ '[[:cntrl:]]'),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, id)
);
CREATE TABLE project_memberships (
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  membership_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, project_id, membership_id),
  FOREIGN KEY (organization_id, project_id) REFERENCES projects(organization_id, id),
  FOREIGN KEY (organization_id, membership_id) REFERENCES organization_memberships(organization_id, id)
);
CREATE INDEX project_memberships_member ON project_memberships(organization_id, membership_id, project_id);
CREATE TABLE tasks (
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  title text NOT NULL CHECK (title = btrim(title) AND char_length(title) BETWEEN 1 AND 200 AND title !~ '[[:cntrl:]]'),
  description text NOT NULL DEFAULT '' CHECK (description = btrim(description) AND char_length(description) <= 4000 AND description !~ '[[:cntrl:]]'),
  assignee_membership_id uuid NOT NULL,
  author_membership_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'planned' CHECK (status = 'planned'),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, project_id, id),
  FOREIGN KEY (organization_id, project_id) REFERENCES projects(organization_id, id),
  FOREIGN KEY (organization_id, project_id, assignee_membership_id)
    REFERENCES project_memberships(organization_id, project_id, membership_id),
  FOREIGN KEY (organization_id, project_id, author_membership_id)
    REFERENCES project_memberships(organization_id, project_id, membership_id)
);
CREATE INDEX tasks_assignee ON tasks(organization_id, project_id, assignee_membership_id);

CREATE FUNCTION can_access_project(tenant uuid, project uuid, required_roles text[] DEFAULT ARRAY[]::text[])
RETURNS boolean LANGUAGE sql STABLE SET search_path FROM CURRENT AS $$
  SELECT can_access_organization_branding(tenant) AND EXISTS (
    SELECT 1 FROM project_memberships pm JOIN organization_memberships m
      ON (m.organization_id, m.id) = (pm.organization_id, pm.membership_id)
    WHERE pm.organization_id = tenant AND pm.project_id = project AND pm.status = 'active'
      AND m.status = 'active' AND m.user_id = NULLIF(current_setting('sitegrid.user_id', true), '')::uuid
      AND (cardinality(required_roles) = 0 OR EXISTS (
        SELECT 1 FROM membership_roles r WHERE (r.organization_id, r.membership_id) = (m.organization_id, m.id)
          AND r.role = ANY(required_roles)))
  )
$$;
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE projects FORCE ROW LEVEL SECURITY;
ALTER TABLE project_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_memberships FORCE ROW LEVEL SECURITY;
ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE tasks FORCE ROW LEVEL SECURITY;
CREATE POLICY projects_read ON projects FOR SELECT
  USING (can_access_organization_branding(organization_id, true) OR can_access_project(organization_id, id));
CREATE POLICY projects_insert ON projects FOR INSERT
  WITH CHECK (can_access_organization_branding(organization_id, true));
CREATE POLICY projects_update ON projects FOR UPDATE
  USING (can_access_organization_branding(organization_id, true))
  WITH CHECK (can_access_organization_branding(organization_id, true));
-- Own assignments support discovery without a selected project. Roster reads use a
-- transaction-local project context set by the API after checking own assignment.
-- This avoids recursive membership policies and never confers task/project access.
CREATE POLICY project_memberships_read ON project_memberships FOR SELECT USING (
  can_access_organization_branding(organization_id) AND (
    can_access_organization_branding(organization_id, true)
    OR EXISTS (SELECT 1 FROM organization_memberships m WHERE (m.organization_id, m.id) = (project_memberships.organization_id, project_memberships.membership_id)
      AND m.user_id = NULLIF(current_setting('sitegrid.user_id', true), '')::uuid)
    OR (project_id = NULLIF(current_setting('sitegrid.project_id', true), '')::uuid
      AND EXISTS (SELECT 1 FROM organization_memberships m JOIN membership_roles r
        ON (r.organization_id, r.membership_id) = (m.organization_id, m.id)
        WHERE m.organization_id = project_memberships.organization_id AND m.status = 'active'
          AND m.user_id = NULLIF(current_setting('sitegrid.user_id', true), '')::uuid AND r.role = 'manager'))
  ));
CREATE POLICY project_memberships_insert ON project_memberships FOR INSERT
  WITH CHECK (can_access_organization_branding(organization_id, true));
CREATE POLICY project_memberships_update ON project_memberships FOR UPDATE
  USING (can_access_organization_branding(organization_id, true))
  WITH CHECK (can_access_organization_branding(organization_id, true));
CREATE POLICY tasks_read ON tasks FOR SELECT USING (
  project_id = NULLIF(current_setting('sitegrid.project_id', true), '')::uuid
  AND can_access_project(organization_id, project_id, ARRAY['manager', 'foreman', 'worker'])
  AND (can_access_project(organization_id, project_id, ARRAY['manager', 'foreman'])
    OR EXISTS (SELECT 1 FROM organization_memberships m WHERE (m.organization_id, m.id) = (tasks.organization_id, tasks.assignee_membership_id)
      AND m.user_id = NULLIF(current_setting('sitegrid.user_id', true), '')::uuid))
);
CREATE POLICY tasks_insert ON tasks FOR INSERT WITH CHECK (
  project_id = NULLIF(current_setting('sitegrid.project_id', true), '')::uuid
  AND can_access_project(organization_id, project_id, ARRAY['manager'])
);
CREATE POLICY tasks_update ON tasks FOR UPDATE USING (
  project_id = NULLIF(current_setting('sitegrid.project_id', true), '')::uuid
  AND can_access_project(organization_id, project_id, ARRAY['manager'])
) WITH CHECK (
  project_id = NULLIF(current_setting('sitegrid.project_id', true), '')::uuid
  AND can_access_project(organization_id, project_id, ARRAY['manager'])
);

CREATE FUNCTION protect_project_records() RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.organization_id IS DISTINCT FROM OLD.organization_id OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'Record identity is immutable' USING ERRCODE = '23514';
    END IF;
    IF TG_TABLE_NAME = 'projects' THEN
      IF NEW.id IS DISTINCT FROM OLD.id OR OLD.status = 'archived' THEN
        RAISE EXCEPTION 'Archived projects are read only' USING ERRCODE = '23514';
      END IF;
    ELSE
      IF NEW.project_id IS DISTINCT FROM OLD.project_id THEN RAISE EXCEPTION 'Project is immutable' USING ERRCODE = '23514'; END IF;
      IF TG_TABLE_NAME = 'tasks' THEN
        IF (NEW.id, NEW.author_membership_id, NEW.status) IS DISTINCT FROM (OLD.id, OLD.author_membership_id, OLD.status) THEN
          RAISE EXCEPTION 'Task identity, author and initial status are immutable in M07' USING ERRCODE = '23514';
        END IF;
      ELSIF NEW.membership_id IS DISTINCT FROM OLD.membership_id THEN
        RAISE EXCEPTION 'Membership is immutable' USING ERRCODE = '23514';
      END IF;
    END IF;
    IF NEW.version <> OLD.version + 1 THEN RAISE EXCEPTION 'Version must increase by one' USING ERRCODE = '23514'; END IF;
  ELSIF NEW.version <> 1 THEN RAISE EXCEPTION 'Initial version must be one' USING ERRCODE = '23514';
  END IF;
  IF TG_TABLE_NAME <> 'projects' THEN
    IF NOT EXISTS (SELECT 1 FROM projects WHERE organization_id = NEW.organization_id AND id = NEW.project_id AND status = 'active') THEN
      RAISE EXCEPTION 'Active project required' USING ERRCODE = '23514';
    END IF;
    IF TG_TABLE_NAME = 'project_memberships' AND NEW.status = 'active' THEN
      IF NOT EXISTS (SELECT 1 FROM organization_memberships m JOIN users u ON u.id = m.user_id
        WHERE m.organization_id = NEW.organization_id AND m.id = NEW.membership_id AND m.status = 'active' AND u.blocked_at IS NULL) THEN
        RAISE EXCEPTION 'Active company member required' USING ERRCODE = '23514';
      END IF;
    ELSIF TG_TABLE_NAME = 'tasks' THEN
      IF NOT EXISTS (SELECT 1 FROM project_memberships pm JOIN organization_memberships m
        ON (m.organization_id, m.id) = (pm.organization_id, pm.membership_id) JOIN users u ON u.id = m.user_id
        WHERE pm.organization_id = NEW.organization_id AND pm.project_id = NEW.project_id
          AND pm.membership_id = NEW.assignee_membership_id AND pm.status = 'active' AND m.status = 'active' AND u.blocked_at IS NULL) THEN
        RAISE EXCEPTION 'Eligible project assignee required' USING ERRCODE = '23514';
      END IF;
      IF TG_OP = 'INSERT' AND NOT EXISTS (SELECT 1 FROM organization_memberships m
        WHERE m.organization_id = NEW.organization_id AND m.id = NEW.author_membership_id
          AND m.status = 'active' AND m.user_id = NULLIF(current_setting('sitegrid.user_id', true), '')::uuid) THEN
        RAISE EXCEPTION 'Author must be the current actor' USING ERRCODE = '23514';
      END IF;
    END IF;
  END IF;
  IF TG_OP = 'INSERT' THEN NEW.created_at := clock_timestamp(); END IF;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END $$;
CREATE TRIGGER protect_projects BEFORE INSERT OR UPDATE ON projects FOR EACH ROW EXECUTE FUNCTION protect_project_records();
CREATE TRIGGER protect_project_memberships BEFORE INSERT OR UPDATE ON project_memberships FOR EACH ROW EXECUTE FUNCTION protect_project_records();
CREATE TRIGGER protect_tasks BEFORE INSERT OR UPDATE ON tasks FOR EACH ROW EXECUTE FUNCTION protect_project_records();

ALTER TABLE organization_audit_events DROP CONSTRAINT organization_audit_events_event_check;
ALTER TABLE organization_audit_events ADD CONSTRAINT organization_audit_events_event_check CHECK (event IN (
  'role_assigned', 'role_removed', 'membership_deactivated', 'membership_reactivated',
  'employee_created', 'employee_updated', 'employee_deactivated', 'employee_reactivated',
  'branding_updated', 'logo_replaced', 'logo_removed', 'project_created', 'project_updated', 'project_archived',
  'project_member_assigned', 'project_member_revoked', 'task_created', 'task_updated'
));
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sitegrid') THEN
    GRANT SELECT, INSERT, UPDATE ON projects, project_memberships, tasks TO sitegrid;
  END IF;
END $$;
