import { type DB } from './db.js'

const GRID_INSERT_SQL = `
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
    ) > 0`

/** Rebuild deterministic trim-yield rules after the size registry changes. */
export function rebuildSizeConversions(db: DB): void {
  db.prepare('DELETE FROM size_conversions').run()
  db.exec(GRID_INSERT_SQL)
  db.prepare(
    `INSERT INTO size_conversions (source_size_key, target_size_key, yield_count)
     SELECT 'A3', '6', 6
     WHERE EXISTS (SELECT 1 FROM sizes WHERE key = 'A3')
       AND EXISTS (SELECT 1 FROM sizes WHERE key = '6')
     ON CONFLICT(source_size_key, target_size_key)
     DO UPDATE SET yield_count = excluded.yield_count`,
  ).run()
}
