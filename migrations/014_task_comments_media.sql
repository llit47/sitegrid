-- PR23: immutable discussions and private files, no changes to historical rows.
CREATE TABLE task_comments (
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  task_id uuid NOT NULL,
  id uuid NOT NULL,
  author_membership_id uuid NOT NULL,
  author_name text NOT NULL CHECK (length(author_name) BETWEEN 1 AND 254),
  text text NOT NULL CHECK (length(text) <= 4000),
  photo_count integer NOT NULL CHECK (photo_count BETWEEN 0 AND 5),
  payload_sha256 text NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  creation_xid xid8 NOT NULL DEFAULT pg_current_xact_id(),
  PRIMARY KEY (organization_id, project_id, task_id, id),
  FOREIGN KEY (organization_id, project_id, task_id) REFERENCES tasks(organization_id, project_id, id),
  FOREIGN KEY (organization_id, author_membership_id) REFERENCES organization_memberships(organization_id, id),
  CHECK (length(trim(text)) > 0 OR photo_count > 0)
);
CREATE INDEX task_comments_chronology ON task_comments(organization_id, project_id, task_id, created_at, id);
CREATE TABLE task_comment_media (
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  task_id uuid NOT NULL,
  comment_id uuid NOT NULL,
  id uuid NOT NULL,
  position integer NOT NULL CHECK (position BETWEEN 0 AND 4),
  original_bytes integer NOT NULL CHECK (original_bytes BETWEEN 1 AND 10485760),
  thumbnail_bytes integer NOT NULL CHECK (thumbnail_bytes BETWEEN 1 AND 10485760),
  original_sha256 text NOT NULL CHECK (original_sha256 ~ '^[0-9a-f]{64}$'),
  thumbnail_sha256 text NOT NULL CHECK (thumbnail_sha256 ~ '^[0-9a-f]{64}$'),
  width integer NOT NULL CHECK (width BETWEEN 1 AND 12000),
  height integer NOT NULL CHECK (height BETWEEN 1 AND 12000),
  PRIMARY KEY (id),
  UNIQUE (organization_id, project_id, task_id, comment_id, position),
  FOREIGN KEY (organization_id, project_id, task_id, comment_id) REFERENCES task_comments(organization_id, project_id, task_id, id),
  CHECK (width::bigint * height <= 40000000)
);
CREATE FUNCTION can_read_task_discussion(tenant uuid, project uuid, task uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path FROM CURRENT AS $$
  SELECT tenant = NULLIF(current_setting('sitegrid.organization_id', true), '')::uuid
    AND EXISTS (SELECT 1 FROM tasks t WHERE (t.organization_id,t.project_id,t.id)=(tenant,project,task))
$$;
CREATE FUNCTION can_write_task_discussion(tenant uuid, project uuid, task uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path FROM CURRENT AS $$
  SELECT can_read_task_discussion(tenant,project,task)
    AND project = NULLIF(current_setting('sitegrid.project_id', true), '')::uuid
    AND EXISTS (SELECT 1 FROM projects p WHERE (p.organization_id,p.id)=(tenant,project) AND p.status='active')
$$;
ALTER TABLE task_comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE task_comments FORCE ROW LEVEL SECURITY;
ALTER TABLE task_comment_media ENABLE ROW LEVEL SECURITY;
ALTER TABLE task_comment_media FORCE ROW LEVEL SECURITY;
CREATE POLICY task_comments_read ON task_comments FOR SELECT USING (can_read_task_discussion(organization_id,project_id,task_id));
CREATE POLICY task_comments_insert ON task_comments FOR INSERT WITH CHECK (
  can_write_task_discussion(organization_id,project_id,task_id) AND EXISTS (
    SELECT 1 FROM organization_memberships m WHERE (m.organization_id,m.id)=(task_comments.organization_id,task_comments.author_membership_id)
      AND m.status='active' AND m.user_id=NULLIF(current_setting('sitegrid.user_id', true), '')::uuid));
CREATE POLICY task_media_read ON task_comment_media FOR SELECT USING (can_read_task_discussion(organization_id,project_id,task_id));
CREATE POLICY task_media_insert ON task_comment_media FOR INSERT WITH CHECK (
  can_write_task_discussion(organization_id,project_id,task_id) AND EXISTS (
    SELECT 1 FROM task_comments c JOIN organization_memberships m ON (m.organization_id,m.id)=(c.organization_id,c.author_membership_id)
    WHERE (c.organization_id,c.project_id,c.task_id,c.id)=(task_comment_media.organization_id,task_comment_media.project_id,task_comment_media.task_id,task_comment_media.comment_id)
      AND m.user_id=NULLIF(current_setting('sitegrid.user_id', true), '')::uuid));
CREATE FUNCTION protect_task_discussion() RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'Discussion history is immutable' USING ERRCODE='23514'; END IF;
  IF TG_TABLE_NAME='task_comments' THEN
    NEW.created_at := clock_timestamp(); NEW.creation_xid := pg_current_xact_id();
  ELSE
    IF NOT EXISTS (SELECT 1 FROM task_comments c WHERE (c.organization_id,c.project_id,c.task_id,c.id)=(NEW.organization_id,NEW.project_id,NEW.task_id,NEW.comment_id)
      AND c.creation_xid=pg_current_xact_id() AND c.xmin=pg_current_xact_id()::xid AND NEW.position<c.photo_count) THEN
      RAISE EXCEPTION 'Attachments belong to the creating transaction' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER protect_task_comments BEFORE INSERT OR UPDATE OR DELETE ON task_comments FOR EACH ROW EXECUTE FUNCTION protect_task_discussion();
CREATE TRIGGER protect_task_media BEFORE INSERT OR UPDATE OR DELETE ON task_comment_media FOR EACH ROW EXECUTE FUNCTION protect_task_discussion();
CREATE FUNCTION check_comment_attachments() RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE expected integer; actual integer;
BEGIN
  SELECT photo_count INTO expected FROM task_comments WHERE (organization_id,project_id,task_id,id)=(NEW.organization_id,NEW.project_id,NEW.task_id,NEW.id);
  SELECT count(*) INTO actual FROM task_comment_media WHERE (organization_id,project_id,task_id,comment_id)=(NEW.organization_id,NEW.project_id,NEW.task_id,NEW.id);
  IF actual <> expected THEN RAISE EXCEPTION 'Incomplete comment attachments' USING ERRCODE='23514'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER comment_attachments_complete AFTER INSERT ON task_comments DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_comment_attachments();
ALTER TABLE organization_audit_events DROP CONSTRAINT organization_audit_events_event_check;
ALTER TABLE organization_audit_events ADD CONSTRAINT organization_audit_events_event_check CHECK (event IN (
  'role_assigned','role_removed','membership_deactivated','membership_reactivated',
  'employee_created','employee_updated','employee_deactivated','employee_reactivated',
  'branding_updated','logo_replaced','logo_removed','project_created','project_updated','project_archived',
  'project_member_assigned','project_member_revoked','task_created','task_updated','task_started','task_submitted',
  'contractor_created','contractor_updated','contractor_deactivated','contractor_reactivated','task_comment_created','task_media_attached'
));
DROP POLICY organization_audit_read ON organization_audit_events;
CREATE POLICY organization_audit_read ON organization_audit_events FOR SELECT USING (
  organization_id=NULLIF(current_setting('sitegrid.organization_id', true), '')::uuid AND
  (event NOT IN ('task_created','task_updated','task_started','task_submitted','task_comment_created','task_media_attached') OR EXISTS (
    SELECT 1 FROM tasks t WHERE t.organization_id=organization_audit_events.organization_id AND t.id=organization_audit_events.subject_id
      AND t.project_id::text=lower(organization_audit_events.details->>'projectId'))));
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='sitegrid') THEN
    GRANT SELECT,INSERT ON task_comments,task_comment_media TO sitegrid;
  END IF;
END $$;
