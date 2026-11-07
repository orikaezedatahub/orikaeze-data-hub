-- Security rate limiting. Only a one-way hash of the client IP is stored.
CREATE TABLE IF NOT EXISTS security_rate_limits (
  scope TEXT NOT NULL,
  ip_hash TEXT NOT NULL,
  window_started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  attempts INTEGER NOT NULL DEFAULT 0,
  blocked_until TEXT,
  PRIMARY KEY (scope, ip_hash)
);
CREATE INDEX IF NOT EXISTS idx_security_rate_limits_blocked
  ON security_rate_limits(blocked_until);
