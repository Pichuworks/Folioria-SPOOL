import { type DB } from './db.js'
import { type Currency } from './money.js'

export function baseCurrency(db: DB): Currency {
  const row = db
    .prepare(
      `SELECT cur.code, cur.symbol, cur.decimal_places
       FROM system_config sc JOIN currencies cur ON cur.code = sc.base_currency
       WHERE sc.id = 1`,
    )
    .get() as Currency | undefined
  if (!row) throw new Error('currency: system_config missing (run spool init)')
  return row
}
