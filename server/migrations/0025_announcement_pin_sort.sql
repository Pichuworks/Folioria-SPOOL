-- 0025: Allow multiple pinned announcements with explicit sort order.

ALTER TABLE announcements ADD COLUMN pin_sort INTEGER NOT NULL DEFAULT 0;
