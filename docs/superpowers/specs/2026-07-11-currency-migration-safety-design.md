# Currency Migration Safety Design

## Scope

This task prevents automatic upgrades from deleting business data or changing correctly scaled CNY price-layer values. It does not change pricing formulas, setup defaults, report behavior, or the `force_min_margin` and membership decisions; those remain separate tasks and commits.

## Problem

Migration 0019 deletes operational history and changes every initialized instance to CNY. Migration 0035 multiplies every CNY price-layer value by 100 without evidence that the stored data uses the obsolete scale. Both migrations run automatically during server startup.

A new migration alone cannot make this safe: an instance at user version 18 or 34 executes the dangerous older migration before it can reach a later corrective migration.

## Considered Approaches

### 1. Neutralize the old migrations and add an explicit repair workflow

Change 0019 and 0035 into version-preserving no-ops. Add a CLI workflow that inspects a CNY database, creates and verifies a backup, previews affected values, and requires an explicit operator decision before multiplying price-layer fields. Record the completed decision so the repair cannot run twice.

This is the selected approach. It protects every database that has not yet applied the migrations and makes ambiguous historical scale a deliberate operational decision.

### 2. Special-case versions in the migration runner

Teach `migrate()` to skip or intercept versions 19 and 35. This keeps the SQL files dangerous for any other runner, hides business-specific behavior inside generic infrastructure, and makes migration behavior disagree with the migration files. Rejected.

### 3. Add only a corrective migration

Add migration 0036 to restore deleted data or divide prices by 100. Deleted data cannot be reconstructed, and dividing prices would corrupt instances where 0035 correctly repaired old-scale data. Rejected.

## Migration Behavior

`0019_switch_to_cny.sql` will retain its version number but perform no data mutation. Existing instances that already applied it are unchanged; instances below version 19 keep all rows and their configured base currency.

`0035_cny_price_layer_scale.sql` will also become a no-op. Existing instances that already applied it remain unchanged. Instances below version 35 will not receive an automatic scale conversion.

Changing an already published migration is normally avoided, but it is necessary here because the unsafe action occurs before any new migration can intervene. The change must be recorded in PRD Appendix A.

## Explicit CNY Scale Decision

A new migration will add a small operational marker to `system_config` with three states:

- `canonical`: price-layer values are already stored as minor currency unit x100.
- `unknown`: an upgraded CNY instance requires operator review.
- `repaired`: the explicit repair command multiplied the known old-scale values once.

Fresh setup and CNY seed import write `canonical`. Existing initialized CNY databases receive `unknown`; JPY and USD databases receive `canonical` because the CNY repair does not apply.

The CLI will expose two explicit actions for an `unknown` CNY instance:

- `pricing-scale mark-canonical`: record that inspected values are already correct without changing data.
- `pricing-scale repair-cny`: back up and verify the database, print before/after samples and affected row counts, multiply the defined price-layer columns in one transaction, then set `repaired`.

Both actions require a confirmation flag in non-interactive use. Neither action is available for non-CNY instances or an instance already marked `canonical`/`repaired`.

The server may continue serving an `unknown` instance, but it must emit a high-visibility startup warning. Blocking startup is intentionally avoided because it would turn a safe upgrade into an outage.

## Repair Surface

The repair transaction covers only price/configuration facts historically affected by migration 0035:

- `printers.equipment_cost_c`
- `printers.monthly_cost_c`
- `print_modes.ink_price_c`
- `paper_size_costs.pack_price_c`
- `combo_prices.sell_c`
- `combo_prices.internal_sell_c`
- `combo_price_tiers.sell_c`
- `combo_price_tiers.internal_sell_c`
- `consumables.unit_cost_c`
- `finishing_ops.price_c`

It must not change orders, jobs, payments, report snapshots, maintenance costs, inventory log snapshots, or audit history.

## Failure Handling

Backup verification must finish before any price update begins. A failed backup or integrity check aborts without changing the database. All scale updates and the marker transition run in one SQLite transaction. Overflow is checked before the transaction; any value whose product is outside SQLite or JavaScript safe integer limits aborts the entire repair.

## Tests

Migration tests will construct real versioned databases rather than only fresh in-memory schemas:

1. A version-18 JPY database containing orders, payments, jobs, inventory logs, alerts, audit entries, snapshots, and maintenance events upgrades to latest with identical row counts and base currency.
2. A version-34 CNY database containing canonical values upgrades without changing any price-layer value and receives `unknown` state.
3. `mark-canonical` changes only the marker and is not repeatable.
4. `repair-cny` multiplies every listed nullable/non-nullable field exactly once, preserves all amount-layer history, and records `repaired`.
5. A failed backup, overflow, or non-CNY invocation changes neither values nor marker.
6. Fresh CNY setup plus seed is marked `canonical` and never needs repair.

Each test must be observed failing before the implementation is added. Final verification is `npm run typecheck && npm test && npm run lint` after aligning the local pnpm installation with the repository's pinned version.

## Documentation and Release

Append an Appendix A decision explaining why published migrations 0019 and 0035 were neutralized and how operators classify or repair historical CNY scale. Update deployment instructions to require a verified backup and `pricing-scale` inspection before the first restart of an older instance.

This task is released before all other review remediation. Deployment must not include unrelated schema, pricing, report, or UI changes.
