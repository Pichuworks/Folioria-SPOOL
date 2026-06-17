/**
 * Lightweight runtime type guards for safety-critical DB results.
 *
 * These guard functions validate the shape of critical fields (especially
 * money fields) returned from better-sqlite3 queries.  They are intentionally
 * minimal — the STRICT tables already enforce column types at the DB layer,
 * so the guards here protect against schema drift or query-mapping errors,
 * not arbitrary input.  No external validation library is used.
 */

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

function isInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v)
}

function isStr(v: unknown): v is string {
  return typeof v === 'string'
}

function isIntOrNull(v: unknown): v is number | null {
  return v === null || isInt(v)
}

// ---------------------------------------------------------------------------
// Generic assert helper
// ---------------------------------------------------------------------------

function fail(label: string, field: string, value: unknown): never {
  throw new TypeError(
    `db-guard ${label}: field "${field}" expected integer, got ${typeof value} (${String(value)})`,
  )
}

// ---------------------------------------------------------------------------
// OrderRow guard — money & status fields
// ---------------------------------------------------------------------------

/**
 * Validate the money-critical fields of an OrderRow returned by `SELECT * FROM orders`.
 * Throws TypeError on mismatch so the error surfaces loudly during development
 * rather than producing silent wrong-amount bugs.
 */
export function assertOrderRow(row: Record<string, unknown>, label = 'OrderRow'): void {
  if (!isInt(row['subtotal'])) fail(label, 'subtotal', row['subtotal'])
  if (!isInt(row['discount'])) fail(label, 'discount', row['discount'])
  if (!isInt(row['total'])) fail(label, 'total', row['total'])
  if (!isInt(row['paid_amount'])) fail(label, 'paid_amount', row['paid_amount'])
  if (!isStr(row['id'])) fail(label, 'id', row['id'])
  if (!isStr(row['status'])) fail(label, 'status', row['status'])
}

// ---------------------------------------------------------------------------
// OrderItemRow guard — unit_price_c and line_total
// ---------------------------------------------------------------------------

/**
 * Validate money fields on an order item row (unit_price_c, line_total, quantity).
 */
export function assertOrderItemRow(row: Record<string, unknown>, label = 'OrderItemRow'): void {
  if (!isInt(row['unit_price_c'])) fail(label, 'unit_price_c', row['unit_price_c'])
  if (!isInt(row['line_total'])) fail(label, 'line_total', row['line_total'])
  if (!isInt(row['quantity'])) fail(label, 'quantity', row['quantity'])
  if (!isStr(row['id'])) fail(label, 'id', row['id'])
}

// ---------------------------------------------------------------------------
// Job money fields guard
// ---------------------------------------------------------------------------

/**
 * Validate cost/money fields on a job row.
 * Cost fields are null before `done`, so all money fields are int-or-null.
 */
export function assertJobCostFields(row: Record<string, unknown>, label = 'JobCost'): void {
  if (!isIntOrNull(row['total_cost'])) fail(label, 'total_cost', row['total_cost'])
  if (!isIntOrNull(row['quoted_price'])) fail(label, 'quoted_price', row['quoted_price'])
  if (!isIntOrNull(row['profit'])) fail(label, 'profit', row['profit'])
  if (!isInt(row['quantity'])) fail(label, 'quantity', row['quantity'])
}

// ---------------------------------------------------------------------------
// PaymentRow guard
// ---------------------------------------------------------------------------

export function assertPaymentRow(row: Record<string, unknown>, label = 'PaymentRow'): void {
  if (!isInt(row['amount'])) fail(label, 'amount', row['amount'])
  if (!isStr(row['id'])) fail(label, 'id', row['id'])
  if (!isStr(row['order_id'])) fail(label, 'order_id', row['order_id'])
}

// ---------------------------------------------------------------------------
// Inventory quantity guard
// ---------------------------------------------------------------------------

export function assertStockQuantity(row: Record<string, unknown>, label = 'Stock'): void {
  if (!isInt(row['quantity'])) fail(label, 'quantity', row['quantity'])
}

// ---------------------------------------------------------------------------
// Job-count / aggregate guards (for status-transition decisions)
// ---------------------------------------------------------------------------

export function assertJobCounts(row: Record<string, unknown>, label = 'JobCounts'): void {
  if (!isInt(row['pending'])) fail(label, 'pending', row['pending'])
  if (!isInt(row['done'])) fail(label, 'done', row['done'])
}

// ---------------------------------------------------------------------------
// Batch guard: validate an array of rows with a per-row assertion
// ---------------------------------------------------------------------------

export function assertRows<T extends Record<string, unknown>>(
  rows: T[],
  assertFn: (row: Record<string, unknown>, label?: string) => void,
  label: string,
): void {
  for (let i = 0; i < rows.length; i++) {
    assertFn(rows[i]!, `${label}[${i}]`)
  }
}
