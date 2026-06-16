-- 0026: 会员等级系统。多轨（同轨互斥、跨轨共存），弹性升级条件，折扣取 max。

CREATE TABLE membership_tiers (
  id            INTEGER PRIMARY KEY,
  track         TEXT NOT NULL DEFAULT 'default',
  code          TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  sort          INTEGER NOT NULL DEFAULT 0,
  discount_bp   INTEGER NOT NULL DEFAULT 0,
  auto_upgrade  INTEGER NOT NULL DEFAULT 0,
  color_tag     TEXT,
  description   TEXT,
  archived      INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL
) STRICT;

CREATE TABLE tier_criteria (
  id        INTEGER PRIMARY KEY,
  tier_id   INTEGER NOT NULL REFERENCES membership_tiers(id),
  dimension TEXT NOT NULL,
  op        TEXT NOT NULL DEFAULT 'gte' CHECK (op IN ('gte','lte','eq')),
  threshold INTEGER NOT NULL,
  UNIQUE(tier_id, dimension)
) STRICT;

CREATE TABLE user_metrics (
  user_id    TEXT NOT NULL REFERENCES users(id),
  dimension  TEXT NOT NULL,
  value      INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, dimension)
) STRICT;

CREATE TABLE user_memberships (
  user_id     TEXT NOT NULL REFERENCES users(id),
  track       TEXT NOT NULL,
  tier_id     INTEGER NOT NULL REFERENCES membership_tiers(id),
  assigned_at TEXT NOT NULL,
  assigned_by TEXT REFERENCES users(id),
  manual      INTEGER NOT NULL DEFAULT 0,
  expires_at  TEXT,
  notes       TEXT,
  PRIMARY KEY (user_id, track)
) STRICT;
CREATE INDEX idx_memberships_tier ON user_memberships(tier_id);

ALTER TABLE orders ADD COLUMN membership_discount INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN membership_tier_id INTEGER REFERENCES membership_tiers(id);
