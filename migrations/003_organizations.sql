CREATE TABLE organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (name = btrim(name) AND char_length(name) BETWEEN 1 AND 200 AND name !~ '[[:cntrl:]]'),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE platform_audit_events ADD COLUMN organization_id uuid REFERENCES organizations(id);

-- The installer already creates this runtime role; development databases may not have it.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sitegrid') THEN
    GRANT SELECT, INSERT ON organizations TO sitegrid;
    GRANT INSERT ON platform_audit_events TO sitegrid;
    GRANT USAGE ON SEQUENCE platform_audit_events_id_seq TO sitegrid;
  END IF;
END $$;
