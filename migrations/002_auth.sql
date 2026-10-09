ALTER TABLE installation ADD COLUMN bootstrap_completed_at timestamptz;
CREATE TABLE users (
  id uuid PRIMARY KEY,
  email text NOT NULL UNIQUE CHECK (email = lower(email)),
  created_at timestamptz NOT NULL DEFAULT now(),
  blocked_at timestamptz
);
CREATE TABLE credentials (
  user_id uuid PRIMARY KEY REFERENCES users(id),
  password_hash text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE platform_admins (user_id uuid PRIMARY KEY REFERENCES users(id));
CREATE TABLE sessions (
  token_hash text PRIMARY KEY,
  user_id uuid REFERENCES users(id),
  csrf_token text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX sessions_expiry ON sessions(expires_at);
CREATE INDEX sessions_user ON sessions(user_id);
CREATE TABLE auth_rate_limits (
  key_hash text PRIMARY KEY,
  attempts integer NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX auth_rate_expiry ON auth_rate_limits(expires_at);
CREATE TABLE platform_audit_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_id uuid REFERENCES users(id),
  event text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
