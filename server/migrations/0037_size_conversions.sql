-- D43: complete standard size registry + explicit source-sheet conversion yields.
-- Existing initialized instances receive the catalog here. Fresh instances stay empty
-- until importSeed(), preserving the init/seed transaction boundary.

CREATE TABLE size_conversions (
  source_size_key TEXT NOT NULL REFERENCES sizes(key),
  target_size_key TEXT NOT NULL REFERENCES sizes(key),
  yield_count     INTEGER NOT NULL CHECK (yield_count > 0),
  PRIMARY KEY (source_size_key, target_size_key),
  CHECK (source_size_key <> target_size_key)
) STRICT;

CREATE INDEX idx_size_conversions_target
  ON size_conversions(target_size_key, source_size_key);

WITH catalog(key, label, area, sort, width_mm, height_mm) AS (
  VALUES
    ('6', '6寸', 24, 0, 152, 102),
    ('A8', 'A8', 6, 10, 52, 74),
    ('A7', 'A7', 12, 20, 74, 105),
    ('A6', 'A6', 24, 30, 105, 148),
    ('A5', 'A5', 48, 40, 148, 210),
    ('A4', 'A4', 97, 50, 210, 297),
    ('A3', 'A3', 193, 60, 297, 420),
    ('A2', 'A2', 386, 70, 420, 594),
    ('A1', 'A1', 772, 80, 594, 841),
    ('A0', 'A0', 1544, 90, 841, 1189),
    ('B8', 'B8', 9, 110, 62, 88),
    ('B7', 'B7', 17, 120, 88, 125),
    ('B6', 'B6', 34, 130, 125, 176),
    ('B5', 'B5', 68, 140, 176, 250),
    ('B4', 'B4', 137, 150, 250, 353),
    ('B3', 'B3', 273, 160, 353, 500),
    ('B2', 'B2', 546, 170, 500, 707),
    ('B1', 'B1', 1092, 180, 707, 1000),
    ('B0', 'B0', 2184, 190, 1000, 1414),
    ('RA4', 'RA4', 115, 210, 215, 305),
    ('RA3', 'RA3', 230, 220, 305, 430),
    ('RA2', 'RA2', 460, 230, 430, 610),
    ('RA1', 'RA1', 920, 240, 610, 860),
    ('RA0', 'RA0', 1840, 250, 860, 1220),
    ('SRA4', 'SRA4', 125, 310, 225, 320),
    ('A3P', 'A3+', 230, 319, NULL, NULL),
    ('SRA3', 'A3++', 250, 320, 320, 450),
    ('A3PP', 'A3+++', 270, 321, NULL, NULL),
    ('SRA2', 'SRA2', 500, 330, 450, 640),
    ('SRA1', 'SRA1', 1000, 340, 640, 900),
    ('SRA0', 'SRA0', 2000, 350, 900, 1280)
)
INSERT INTO sizes (key, label, area, sort, width_mm, height_mm)
SELECT key, label, area, sort, width_mm, height_mm
FROM catalog
WHERE EXISTS (SELECT 1 FROM sizes)
ON CONFLICT(key) DO UPDATE SET
  label = excluded.label,
  area = excluded.area,
  sort = excluded.sort,
  width_mm = COALESCE(sizes.width_mm, excluded.width_mm),
  height_mm = COALESCE(sizes.height_mm, excluded.height_mm);

INSERT INTO size_conversions (source_size_key, target_size_key, yield_count)
SELECT
  source.key,
  target.key,
  MAX(
    CAST(source.width_mm / target.width_mm AS INTEGER)
      * CAST(source.height_mm / target.height_mm AS INTEGER),
    CAST(source.width_mm / target.height_mm AS INTEGER)
      * CAST(source.height_mm / target.width_mm AS INTEGER)
  )
FROM sizes AS source
CROSS JOIN sizes AS target
WHERE source.key <> target.key
  AND source.width_mm IS NOT NULL
  AND source.height_mm IS NOT NULL
  AND target.width_mm IS NOT NULL
  AND target.height_mm IS NOT NULL
  AND MAX(
    CAST(source.width_mm / target.width_mm AS INTEGER)
      * CAST(source.height_mm / target.height_mm AS INTEGER),
    CAST(source.width_mm / target.height_mm AS INTEGER)
      * CAST(source.height_mm / target.width_mm AS INTEGER)
  ) > 0;

-- A3 can guillotine-pack six 6-inch sheets with mixed orientation; the two pure grids yield four.
INSERT INTO size_conversions (source_size_key, target_size_key, yield_count)
SELECT 'A3', '6', 6
WHERE EXISTS (SELECT 1 FROM sizes WHERE key = 'A3')
  AND EXISTS (SELECT 1 FROM sizes WHERE key = '6')
ON CONFLICT(source_size_key, target_size_key)
DO UPDATE SET yield_count = excluded.yield_count;
