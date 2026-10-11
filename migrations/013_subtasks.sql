-- PR22: one level, same company/project; no rewrites of task or receipt history.
DO $$ BEGIN
  IF current_user = 'sitegrid' THEN RAISE EXCEPTION 'Subtask migration requires a separate owner'; END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='sitegrid') AND EXISTS (SELECT 1 FROM pg_roles WHERE pg_has_role('sitegrid', oid, 'MEMBER')
    AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolname = current_user)) THEN
    RAISE EXCEPTION 'Runtime must not inherit privileged roles';
  END IF;
END $$;
ALTER TABLE tasks ADD COLUMN parent_task_id uuid;
ALTER TABLE tasks ADD COLUMN hierarchy_root boolean GENERATED ALWAYS AS (parent_task_id IS NULL) STORED;
ALTER TABLE tasks ADD CONSTRAINT tasks_root_key UNIQUE (organization_id, project_id, id, hierarchy_root);
ALTER TABLE tasks ADD CONSTRAINT tasks_not_self_parent CHECK (parent_task_id IS DISTINCT FROM id);
-- This projection is the only parent data readable through a child's assignment.
-- Its FK references the generated root flag, enforcing depth even without triggers.
CREATE TABLE task_parent_contexts (
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  task_id uuid NOT NULL,
  hierarchy_root boolean NOT NULL DEFAULT true CHECK (hierarchy_root),
  title text NOT NULL,
  PRIMARY KEY (organization_id, project_id, task_id),
  FOREIGN KEY (organization_id, project_id, task_id, hierarchy_root)
    REFERENCES tasks(organization_id, project_id, id, hierarchy_root) ON DELETE CASCADE
);
INSERT INTO task_parent_contexts(organization_id, project_id, task_id, title)
  SELECT organization_id, project_id, id, title FROM tasks;
ALTER TABLE tasks ADD CONSTRAINT tasks_parent_root_fk FOREIGN KEY (organization_id, project_id, parent_task_id)
  REFERENCES task_parent_contexts(organization_id, project_id, task_id);
CREATE INDEX tasks_parent ON tasks(organization_id, project_id, parent_task_id, created_at, id) WHERE parent_task_id IS NOT NULL;
ALTER TABLE task_parent_contexts ENABLE ROW LEVEL SECURITY;
ALTER TABLE task_parent_contexts FORCE ROW LEVEL SECURITY;
CREATE POLICY parent_context_read ON task_parent_contexts FOR SELECT USING (
  can_manage_tasks(organization_id) OR EXISTS (SELECT 1 FROM tasks t
    WHERE (t.organization_id,t.project_id,t.parent_task_id) =
      (task_parent_contexts.organization_id,task_parent_contexts.project_id,task_parent_contexts.task_id)));
CREATE POLICY parent_context_insert ON task_parent_contexts FOR INSERT WITH CHECK (
  project_id = NULLIF(current_setting('sitegrid.project_id', true), '')::uuid AND can_manage_tasks(organization_id));
CREATE POLICY parent_context_update ON task_parent_contexts FOR UPDATE USING (
  project_id = NULLIF(current_setting('sitegrid.project_id', true), '')::uuid AND can_manage_tasks(organization_id))
  WITH CHECK (project_id = NULLIF(current_setting('sitegrid.project_id', true), '')::uuid AND can_manage_tasks(organization_id));
CREATE FUNCTION protect_parent_context() RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.organization_id,NEW.project_id,NEW.task_id,NEW.hierarchy_root)
    IS DISTINCT FROM (OLD.organization_id,OLD.project_id,OLD.task_id,OLD.hierarchy_root) THEN
    RAISE EXCEPTION 'Parent context identity is immutable' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM tasks t WHERE (t.organization_id,t.project_id,t.id) = (NEW.organization_id,NEW.project_id,NEW.task_id)
    AND t.parent_task_id IS NULL AND t.title = NEW.title) THEN
    RAISE EXCEPTION 'Parent context must match its root' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER protect_parent_context BEFORE INSERT OR UPDATE ON task_parent_contexts FOR EACH ROW EXECUTE FUNCTION protect_parent_context();
CREATE FUNCTION maintain_task_hierarchy() RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF TG_WHEN = 'BEFORE' THEN
    IF NEW.parent_task_id IS DISTINCT FROM OLD.parent_task_id THEN
      RAISE EXCEPTION 'Task parent is immutable' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.parent_task_id IS NULL THEN
    IF TG_OP = 'INSERT' THEN
      INSERT INTO task_parent_contexts(organization_id,project_id,task_id,title) VALUES (NEW.organization_id,NEW.project_id,NEW.id,NEW.title);
    ELSIF NEW.title IS DISTINCT FROM OLD.title THEN
      UPDATE task_parent_contexts SET title=NEW.title WHERE (organization_id,project_id,task_id)=(NEW.organization_id,NEW.project_id,NEW.id);
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER task_parent_immutable BEFORE UPDATE ON tasks FOR EACH ROW EXECUTE FUNCTION maintain_task_hierarchy();
CREATE TRIGGER task_parent_projection AFTER INSERT OR UPDATE ON tasks FOR EACH ROW EXECUTE FUNCTION maintain_task_hierarchy();
CREATE INDEX task_progress_history ON organization_audit_events(organization_id,subject_id,created_at,id)
  WHERE event IN ('task_started','task_submitted');
-- Task audit must not disclose inaccessible sibling IDs/details through raw SQL.
DROP POLICY organization_audit_events_tenant ON organization_audit_events;
CREATE POLICY organization_audit_read ON organization_audit_events FOR SELECT USING (
  organization_id = NULLIF(current_setting('sitegrid.organization_id', true), '')::uuid AND
  (event NOT IN ('task_created','task_updated','task_started','task_submitted') OR EXISTS (
    SELECT 1 FROM tasks t WHERE t.organization_id=organization_audit_events.organization_id AND t.id=organization_audit_events.subject_id
      AND t.project_id::text=lower(organization_audit_events.details->>'projectId'))));
CREATE POLICY organization_audit_insert ON organization_audit_events FOR INSERT WITH CHECK (
  organization_id = NULLIF(current_setting('sitegrid.organization_id', true), '')::uuid);
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='sitegrid') THEN
    GRANT SELECT,INSERT,UPDATE ON task_parent_contexts TO sitegrid;
  END IF;
END $$;
