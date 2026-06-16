-- 0024: 管理员公告系统。草稿/发布生命周期、受众分级、置顶横幅、已读追踪。

CREATE TABLE announcements (
  id            TEXT PRIMARY KEY,
  title         TEXT NOT NULL,
  body          TEXT NOT NULL DEFAULT '',
  audience      TEXT NOT NULL DEFAULT 'all'
                CHECK (audience IN ('public','all','customers','staff')),
  pinned        INTEGER NOT NULL DEFAULT 0,
  published_at  TEXT,                        -- NULL = 草稿
  expires_at    TEXT,                        -- NULL = 不过期
  author_id     TEXT NOT NULL REFERENCES users(id),
  archived      INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
) STRICT;

CREATE INDEX idx_ann_visible
  ON announcements(published_at, audience) WHERE archived = 0;

CREATE TABLE announcement_reads (
  announcement_id  TEXT NOT NULL REFERENCES announcements(id),
  user_id          TEXT NOT NULL REFERENCES users(id),
  read_at          TEXT NOT NULL,
  PRIMARY KEY (announcement_id, user_id)
) STRICT;
