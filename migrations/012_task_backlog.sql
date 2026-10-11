-- PR21: task assignment is a company relationship; preserve all M07/M08 history.
DO $$ BEGIN
  IF current_user = 'sitegrid' THEN RAISE EXCEPTION 'Task migration requires a separate owner'; END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sitegrid') AND EXISTS (
    SELECT 1 FROM pg_roles WHERE pg_has_role('sitegrid', oid, 'MEMBER')
      AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolname = current_user)
  ) THEN RAISE EXCEPTION 'sitegrid must not inherit privileged roles'; END IF;
END $$;
ALTER TABLE tasks ALTER COLUMN assignee_membership_id DROP NOT NULL;
ALTER TABLE tasks DROP CONSTRAINT tasks_organization_id_project_id_assignee_membership_id_fkey;
ALTER TABLE tasks DROP CONSTRAINT tasks_organization_id_project_id_author_membership_id_fkey;
ALTER TABLE tasks ADD CONSTRAINT tasks_assignee_company_fk FOREIGN KEY (organization_id, assignee_membership_id)
  REFERENCES organization_memberships(organization_id, id);
ALTER TABLE tasks ADD CONSTRAINT tasks_author_company_fk FOREIGN KEY (organization_id, author_membership_id)
  REFERENCES organization_memberships(organization_id, id);
ALTER TABLE tasks ADD CONSTRAINT tasks_unassigned_planned CHECK (assignee_membership_id IS NOT NULL OR status = 'planned');
CREATE INDEX tasks_company_work ON tasks(organization_id, status, assignee_membership_id, created_at DESC, id);

-- Invoker functions. Task policies do not read projects or call can_access_project:
-- this prevents recursion when project discovery is derived from visible tasks.
CREATE FUNCTION can_manage_tasks(tenant uuid) RETURNS boolean LANGUAGE sql STABLE SET search_path FROM CURRENT AS $$
  SELECT can_access_organization_branding(tenant) AND EXISTS (
    SELECT 1 FROM organization_memberships m JOIN membership_roles r
      ON (r.organization_id, r.membership_id) = (m.organization_id, m.id)
    WHERE m.organization_id = tenant AND m.status = 'active'
      AND m.user_id = NULLIF(current_setting('sitegrid.user_id', true), '')::uuid
      AND r.role IN ('organization_admin', 'manager', 'foreman'))
$$;
CREATE FUNCTION can_read_task(tenant uuid, assignee uuid) RETURNS boolean LANGUAGE sql STABLE SET search_path FROM CURRENT AS $$
  SELECT can_manage_tasks(tenant) OR (can_access_organization_branding(tenant) AND EXISTS (
    SELECT 1 FROM organization_memberships m JOIN membership_roles r
      ON (r.organization_id, r.membership_id) = (m.organization_id, m.id)
    WHERE (m.organization_id, m.id) = (tenant, assignee) AND m.status = 'active'
      AND m.user_id = NULLIF(current_setting('sitegrid.user_id', true), '')::uuid AND r.role = 'worker'))
$$;
CREATE OR REPLACE FUNCTION can_access_project(tenant uuid, project uuid, required_roles text[] DEFAULT ARRAY[]::text[])
RETURNS boolean LANGUAGE sql STABLE SET search_path FROM CURRENT AS $$
  SELECT can_access_organization_branding(tenant) AND (
    (can_manage_tasks(tenant) AND (cardinality(required_roles) = 0 OR required_roles && ARRAY['organization_admin','manager','foreman']))
    OR EXISTS (SELECT 1 FROM organization_memberships m
      WHERE m.organization_id = tenant AND m.status = 'active'
        AND m.user_id = NULLIF(current_setting('sitegrid.user_id', true), '')::uuid
        AND (cardinality(required_roles) = 0 OR EXISTS (SELECT 1 FROM membership_roles r
          WHERE (r.organization_id,r.membership_id) = (m.organization_id,m.id) AND r.role = ANY(required_roles)))
        AND (EXISTS (SELECT 1 FROM project_memberships pm
          WHERE (pm.organization_id,pm.project_id,pm.membership_id) = (tenant,project,m.id) AND pm.status = 'active'
          AND NOT EXISTS (SELECT 1 FROM membership_roles r WHERE (r.organization_id,r.membership_id)=(m.organization_id,m.id) AND r.role='worker'))
          OR EXISTS (SELECT 1 FROM tasks t WHERE t.organization_id = tenant AND t.project_id = project AND t.assignee_membership_id = m.id)))
  )
$$;
DROP POLICY tasks_read ON tasks;
CREATE POLICY tasks_read ON tasks FOR SELECT USING (can_read_task(organization_id, assignee_membership_id));
DROP POLICY tasks_insert ON tasks;
CREATE POLICY tasks_insert ON tasks FOR INSERT WITH CHECK (
  project_id = NULLIF(current_setting('sitegrid.project_id', true), '')::uuid AND can_manage_tasks(organization_id));
DROP POLICY tasks_update ON tasks;
CREATE POLICY tasks_update ON tasks FOR UPDATE USING (
  project_id = NULLIF(current_setting('sitegrid.project_id', true), '')::uuid AND can_manage_tasks(organization_id))
  WITH CHECK (project_id = NULLIF(current_setting('sitegrid.project_id', true), '')::uuid AND can_manage_tasks(organization_id));
CREATE OR REPLACE FUNCTION can_progress_assignment(tenant uuid, project uuid, assignee uuid)
RETURNS boolean LANGUAGE sql STABLE SET search_path FROM CURRENT AS $$
  SELECT project = NULLIF(current_setting('sitegrid.project_id', true), '')::uuid
    AND can_access_organization_branding(tenant) AND EXISTS (
      SELECT 1 FROM organization_memberships m JOIN membership_roles r
        ON (r.organization_id,r.membership_id) = (m.organization_id,m.id)
      WHERE (m.organization_id,m.id) = (tenant,assignee) AND m.status = 'active'
        AND m.user_id = NULLIF(current_setting('sitegrid.user_id', true), '')::uuid
        AND r.role IN ('worker','foreman','manager'))
$$;
DROP POLICY project_memberships_read ON project_memberships;
CREATE POLICY project_memberships_read ON project_memberships FOR SELECT USING (
  can_access_organization_branding(organization_id) AND (
    can_manage_tasks(organization_id)
    OR EXISTS (SELECT 1 FROM organization_memberships m
      WHERE (m.organization_id,m.id) = (project_memberships.organization_id,project_memberships.membership_id)
        AND m.user_id = NULLIF(current_setting('sitegrid.user_id', true), '')::uuid)));

CREATE OR REPLACE FUNCTION protect_task_write() RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE action text := NULLIF(current_setting('sitegrid.task_progress_action', true), '');
BEGIN
  IF NOT EXISTS (SELECT 1 FROM projects WHERE organization_id = NEW.organization_id AND id = NEW.project_id AND status = 'active') THEN
    RAISE EXCEPTION 'Active project required' USING ERRCODE = '23514';
  END IF;
  IF NEW.assignee_membership_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM organization_memberships m JOIN users u ON u.id = m.user_id
    WHERE (m.organization_id,m.id) = (NEW.organization_id,NEW.assignee_membership_id)
      AND m.status = 'active' AND u.blocked_at IS NULL) THEN
    RAISE EXCEPTION 'Eligible company assignee required' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.version <> 1 OR NEW.status <> 'planned' OR action IS NOT NULL THEN
      RAISE EXCEPTION 'Tasks begin planned at version one' USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM organization_memberships m
      WHERE (m.organization_id, m.id) = (NEW.organization_id, NEW.author_membership_id)
        AND m.status = 'active' AND m.user_id = NULLIF(current_setting('sitegrid.user_id', true), '')::uuid) THEN
      RAISE EXCEPTION 'Author must be the current actor' USING ERRCODE = '23514';
    END IF;
    NEW.created_at := clock_timestamp();
  ELSE
    IF (NEW.organization_id, NEW.project_id, NEW.id, NEW.author_membership_id, NEW.created_at)
      IS DISTINCT FROM (OLD.organization_id, OLD.project_id, OLD.id, OLD.author_membership_id, OLD.created_at)
      OR NEW.version <> OLD.version + 1 THEN
      RAISE EXCEPTION 'Task identity is immutable; version must increase once' USING ERRCODE = '23514';
    END IF;
    IF NEW.assignee_membership_id IS DISTINCT FROM OLD.assignee_membership_id AND OLD.status <> 'planned' THEN
      RAISE EXCEPTION 'Started task assignment is immutable' USING ERRCODE = '23514';
    END IF;
    IF action IS NULL THEN
      IF NEW.status IS DISTINCT FROM OLD.status OR NOT can_manage_tasks(OLD.organization_id) THEN
        RAISE EXCEPTION 'Ordinary edits cannot change progress' USING ERRCODE = '23514';
      END IF;
    ELSE
      IF NOT can_progress_assignment(OLD.organization_id, OLD.project_id, OLD.assignee_membership_id)
        OR (NEW.title, NEW.description, NEW.assignee_membership_id) IS DISTINCT FROM (OLD.title, OLD.description, OLD.assignee_membership_id)
        OR NOT ((action = 'start' AND OLD.status = 'planned' AND NEW.status = 'in_progress')
          OR (action = 'submit' AND OLD.status = 'in_progress' AND NEW.status = 'submitted')) THEN
        RAISE EXCEPTION 'Invalid progress command' USING ERRCODE = '23514';
      END IF;
    END IF;
  END IF;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END $$;
