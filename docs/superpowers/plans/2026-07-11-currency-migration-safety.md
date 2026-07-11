# Currency Migration Safety Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make upgrades preserve all business data and require an explicit, backed-up operator decision before correcting ambiguous historical CNY price-layer values.

**Architecture:** Published migrations 0019 and 0035 become harmless version markers because no later migration can run before them. Migration 0036 reuses `system_config.pricing_needs_reentry` to quarantine existing CNY pricing, while a focused `pricing-scale.ts` service provides inspect, mark-canonical, and backed-up repair operations shared by the CLI and startup warning.

**Tech Stack:** TypeScript, Node.js 24+, better-sqlite3, SQL migrations, Vitest, existing backup/audit helpers.

---

### Task 1: Make Automatic Migrations Non-Destructive

**Files:**
- Modify: `server/src/db.test.ts`
- Modify: `server/migrations/0019_switch_to_cny.sql`
- Modify: `server/migrations/0035_cny_price_layer_scale.sql`
- Create: `server/migrations/0036_cny_price_layer_review.sql`

- [ ] **Step 1: Add a migration-directory fixture helper**

In `server/src/db.test.ts`, create a temporary directory containing migrations through a requested version:

```ts
function migrationDirThrough(maxVersion: number): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'spool-migrations-'))
  tempDirs.push(dir)
  for (const name of readdirSync(MIGRATIONS_DIR)) {
    if (/^\d{4}_.+\.sql$/.test(name) && Number(name.slice(0, 4)) <= maxVersion) {
      copyFileSync(path.join(MIGRATIONS_DIR, name), path.join(dir, name))
    }
  }
  return dir
}
```

- [ ] **Step 2: Write failing preservation tests**

Add tests that migrate a real version-18 database containing initialized JPY configuration and representative rows, then assert the latest upgrade preserves the currency and row counts. Add a version-34 CNY test with canonical prices and assert the values do not change while `pricing_needs_reentry` becomes `1`. Update the latest-version expectation from 35 to 36.

```ts
expect(migrate(db, migrationDirThrough(18))).toBe(18)
// Insert valid users, order, payment, audit, snapshot, and maintenance fixtures.
expect(migrate(db)).toBe(18)
expect(baseCurrency).toBe('JPY')
expect(afterCounts).toEqual(beforeCounts)

expect(migrate(db, migrationDirThrough(34))).toBe(34)
// Insert canonical CNY configuration prices.
expect(migrate(db)).toBe(2)
expect(pricesAfter).toEqual(pricesBefore)
expect(scaleGuard).toBe(1)
```

- [ ] **Step 3: Run the migration tests and verify RED**

Run: `pnpm --filter @spool/server exec vitest run src/db.test.ts`

Expected: the version-18 fixture loses data/base currency, the version-34 prices are multiplied, and version 36 is absent.

- [ ] **Step 4: Neutralize 0019 and 0035 and add 0036**

Replace the mutation bodies of 0019 and 0035 with a documented `SELECT 1;`. Add `0036_cny_price_layer_review.sql`:

```sql
-- Existing CNY data has ambiguous historical scale. Require explicit review.
UPDATE system_config
SET pricing_needs_reentry = 1
WHERE base_currency = 'CNY';
```

- [ ] **Step 5: Run the migration tests and verify GREEN**

Run: `pnpm --filter @spool/server exec vitest run src/db.test.ts`

Expected: all migration tests pass with `user_version=36`, preserved v18 data, unchanged v34 prices, and the CNY review guard set.

### Task 2: Implement Exact, Idempotent CNY Scale Operations

**Files:**
- Create: `server/src/pricing-scale.ts`
- Create: `server/src/pricing-scale.test.ts`
- Reuse: `server/src/backup.ts`
- Reuse: `server/src/audit.ts`

- [ ] **Step 1: Write failing service tests**

Create real temporary databases and cover:

```ts
expect(inspectPriceLayerScale(db)).toMatchObject({ currency: 'CNY', needs_review: true })
expect(() => markPriceLayerScaleCanonical(db)).not.toThrow()
expect(inspectPriceLayerScale(db).needs_review).toBe(false)
expect(() => markPriceLayerScaleCanonical(db)).toThrow(/already_resolved/)

const result = repairCnyPriceLayer(db)
expect(result.updated.printers).toBeGreaterThan(0)
expect(readAllPriceFacts(db)).toEqual(scaleBy100(before))
expect(readAllAmountSnapshots(db)).toEqual(amountsBefore)
expect(() => repairCnyPriceLayer(db)).toThrow(/already_resolved/)
```

Also test non-CNY rejection, nullable values, and preflight overflow leaving every value and the guard unchanged.

- [ ] **Step 2: Run the service tests and verify RED**

Run: `pnpm --filter @spool/server exec vitest run src/pricing-scale.test.ts`

Expected: FAIL because `pricing-scale.ts` does not exist.

- [ ] **Step 3: Implement inspection and exact preflight**

Define the ten approved table/column pairs in one constant. `inspectPriceLayerScale(db)` returns currency, guard state, affected non-null row counts, maxima, and representative samples. Before repair, reject any maximum greater than `Math.floor(Number.MAX_SAFE_INTEGER / 100)`.

```ts
export interface PriceLayerScaleInspection {
  currency: string
  needs_review: boolean
  fields: Array<{ table: string; column: string; rows: number; max: number | null }>
}
```

- [ ] **Step 4: Implement mark and repair transactions**

Both operations require CNY plus `pricing_needs_reentry=1`. `markPriceLayerScaleCanonical` clears the guard and writes audit action `pricing.scale.mark_canonical`. `repairCnyPriceLayer` performs every `column = column * 100`, clears the guard, and writes `pricing.scale.repair_cny` in one transaction. A second invocation throws `pricing scale: already_resolved`.

- [ ] **Step 5: Run service tests and verify GREEN**

Run: `pnpm --filter @spool/server exec vitest run src/pricing-scale.test.ts`

Expected: all inspection, canonical-mark, repair, idempotency, non-CNY, nullable, and overflow tests pass.

### Task 3: Wire the Guarded Workflow into CLI and Operations

**Files:**
- Modify: `server/src/cli.ts`
- Modify: `server/src/serve.ts`
- Modify: `server/src/pricing-scale.test.ts`
- Modify: `deploy/README.md`
- Modify: `docs/prd.md`
- Modify: `docs/tasks-phase1.md`

- [ ] **Step 1: Write a failing backed-up repair test**

Test the file-level operation with a temporary database and backup directory:

```ts
const result = repairCnyPriceLayerFile(dbPath, backupDir, { confirm: true })
expect(verifyBackup(result.backup).ok).toBe(true)
expect(result.before.needs_review).toBe(true)
expect(result.after.needs_review).toBe(false)
```

Add a failure test where `confirm:false` and assert no backup or database mutation occurs.

- [ ] **Step 2: Run the backed-up repair test and verify RED**

Run: `pnpm --filter @spool/server exec vitest run src/pricing-scale.test.ts src/backup.test.ts`

Expected: FAIL because the file-level repair operation is missing.

- [ ] **Step 3: Implement backup-before-migration repair**

`repairCnyPriceLayerFile` must call `backupDb` and `verifyBackup` before opening the source for migration or repair. A failed verification throws before source mutation. After verification it opens the source, runs safe migrations, repairs in one transaction, and closes the connection in `finally`.

- [ ] **Step 4: Add CLI commands and startup warning**

Add these commands to `server/src/cli.ts`:

```text
pricing-scale inspect --db <file>
pricing-scale mark-canonical --db <file> --confirm
pricing-scale repair-cny --db <file> --backup-dir <dir> --confirm
```

Print inspection JSON before every decision. Reject missing `--confirm`, missing backup directory, non-CNY, and already-resolved state with a non-zero exit. In `serve.ts`, log a warning when an initialized CNY database has `pricing_needs_reentry=1`.

- [ ] **Step 5: Update decision and deployment documentation**

Append PRD decision D42 documenting neutralized migrations and explicit scale review. Add the exact backup/inspect/mark/repair deployment sequence to `deploy/README.md`. Add and check a review-remediation item in `docs/tasks-phase1.md`.

- [ ] **Step 6: Run complete verification**

Run:

```text
npm run typecheck
npm test
npm run lint
```

Expected: typecheck exits 0, all Vitest tests pass, and ESLint exits 0. If the pinned pnpm store mismatch blocks the command, align local dependencies with pnpm 11.0.9 and rerun; do not claim completion from partial checks.

- [ ] **Step 7: Review and commit the scoped diff**

Verify `git diff --check`, confirm only migration-safety files are staged, then commit:

```text
fix(migrations): require explicit cny scale repair
```

Push the commit directly to `origin/main` as required by `AGENTS.md`.
