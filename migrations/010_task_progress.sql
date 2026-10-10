-- M08 is additive: keep all M07 identities, assignments, versions and history.
DO $$ BEGIN
  IF current_user = 'sitegrid' THEN RAISE EXCEPTION 'Progress migration requires a separate owner'; END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sitegrid') AND EXISTS (
    SELECT 1 FROM pg_roles WHERE pg_has_role('sitegrid', oid, 'MEMBER')
      AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolname = current_user)
  ) THEN RAISE EXCEPTION 'sitegrid must not own tenant tables or inherit privileged roles'; END IF;
END $$;

ALTER TABLE tasks DROP CONSTRAINT tasks_status_check;
ALTER TABLE tasks ADD CONSTRAINT tasks_status_check CHECK (status IN ('planned', 'in_progress', 'submitted'));

-- Invoker function; never bypass FORCE RLS or infer permissions from client flags.
CREATE FUNCTION can_progress_assignment(tenant uuid, project uuid, assignee uuid)
RETURNS boolean LANGUAGE sql STABLE SET search_path FROM CURRENT AS $$
  SELECT project = NULLIF(current_setting('sitegrid.project_id', true), '')::uuid
    AND can_access_project(tenant, project, ARRAY['manager', 'foreman', 'worker'])
    AND EXISTS (SELECT 1 FROM organization_memberships m
      WHERE (m.organization_id, m.id) = (tenant, assignee) AND m.status = 'active'
        AND m.user_id = NULLIF(current_setting('sitegrid.user_id', true), '')::uuid)
$$;
CREATE POLICY tasks_progress ON tasks FOR UPDATE
  USING (can_progress_assignment(organization_id, project_id, assignee_membership_id))
  WITH CHECK (can_progress_assignment(organization_id, project_id, assignee_membership_id));

-- Separate the task guard from M07 project/membership guards. Ordinary edits retain
-- status; only a server-established command context permits a progress transition.
DROP TRIGGER protect_tasks ON tasks;
CREATE FUNCTION protect_task_write() RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE action text := NULLIF(current_setting('sitegrid.task_progress_action', true), '');
BEGIN
  IF NOT EXISTS (SELECT 1 FROM projects WHERE organization_id = NEW.organization_id AND id = NEW.project_id AND status = 'active') THEN
    RAISE EXCEPTION 'Active project required' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM project_memberships pm JOIN organization_memberships m
    ON (m.organization_id, m.id) = (pm.organization_id, pm.membership_id) JOIN users u ON u.id = m.user_id
    WHERE (pm.organization_id, pm.project_id, pm.membership_id) = (NEW.organization_id, NEW.project_id, NEW.assignee_membership_id)
      AND pm.status = 'active' AND m.status = 'active' AND u.blocked_at IS NULL) THEN
    RAISE EXCEPTION 'Eligible project assignee required' USING ERRCODE = '23514';
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
    IF action IS NULL THEN
      IF NEW.status IS DISTINCT FROM OLD.status OR NOT can_access_project(OLD.organization_id, OLD.project_id, ARRAY['manager']) THEN
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
CREATE TRIGGER protect_tasks BEFORE INSERT OR UPDATE ON tasks FOR EACH ROW EXECUTE FUNCTION protect_task_write();

ALTER TABLE organization_audit_events DROP CONSTRAINT organization_audit_events_event_check;
ALTER TABLE organization_audit_events ADD CONSTRAINT organization_audit_events_event_check CHECK (event IN (
  'role_assigned', 'role_removed', 'membership_deactivated', 'membership_reactivated',
  'employee_created', 'employee_updated', 'employee_deactivated', 'employee_reactivated',
  'branding_updated', 'logo_replaced', 'logo_removed', 'project_created', 'project_updated', 'project_archived',
  'project_member_assigned', 'project_member_revoked', 'task_created', 'task_updated', 'task_started', 'task_submitted'
));
CREATE TABLE task_progress_receipts (
  organization_id uuid NOT NULL,
  actor_id uuid NOT NULL REFERENCES users(id),
  operation_id uuid NOT NULL,
  project_id uuid NOT NULL,
  task_id uuid NOT NULL,
  schema_version integer NOT NULL CHECK (schema_version = 1),
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  result jsonb NOT NULL CHECK (jsonb_typeof(result) = 'object'),
  audit_id uuid NOT NULL,
  committed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, actor_id, operation_id),
  FOREIGN KEY (organization_id, project_id, task_id) REFERENCES tasks(organization_id, project_id, id),
  FOREIGN KEY (organization_id, audit_id) REFERENCES organization_audit_events(organization_id, id)
);
ALTER TABLE task_progress_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE task_progress_receipts FORCE ROW LEVEL SECURITY;
-- The actor must STILL be this task's authorized assignee when replaying a receipt.
CREATE POLICY task_progress_receipts_read ON task_progress_receipts FOR SELECT USING (
  organization_id = NULLIF(current_setting('sitegrid.organization_id', true), '')::uuid
  AND actor_id = NULLIF(current_setting('sitegrid.user_id', true), '')::uuid
  AND EXISTS (SELECT 1 FROM tasks t WHERE (t.organization_id, t.project_id, t.id) =
    (task_progress_receipts.organization_id, task_progress_receipts.project_id, task_progress_receipts.task_id)
    AND can_progress_assignment(t.organization_id, t.project_id, t.assignee_membership_id))
);
CREATE POLICY task_progress_receipts_insert ON task_progress_receipts FOR INSERT WITH CHECK (
  organization_id = NULLIF(current_setting('sitegrid.organization_id', true), '')::uuid
  AND actor_id = NULLIF(current_setting('sitegrid.user_id', true), '')::uuid
  AND EXISTS (SELECT 1 FROM tasks t WHERE (t.organization_id, t.project_id, t.id) =
    (task_progress_receipts.organization_id, task_progress_receipts.project_id, task_progress_receipts.task_id)
    AND can_progress_assignment(t.organization_id, t.project_id, t.assignee_membership_id))
);
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sitegrid') THEN
    GRANT SELECT, INSERT ON task_progress_receipts TO sitegrid;
  END IF;
END $$;
