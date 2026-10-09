CREATE TABLE installation (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO installation (id) VALUES (true);
