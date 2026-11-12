// Pure helpers for the shopping-trip calculator. Kept out of the screen so the
// arithmetic can be tested without a browser, and so the preview the owner sees
// is provably the same formula `engine_save_trip` writes.

export function tripTotals(items = [], expenses = []) {
  const goods = items.reduce((sum, row) => sum + Number(row.quantity || 0) * Number(row.unit_cost || 0), 0)
  const units = items.reduce((sum, row) => sum + Number(row.quantity || 0), 0)
  const extras = expenses.reduce((sum, row) => sum + Math.round(Number(row.amount) || 0), 0)
  // Floored, exactly like the SQL: the screen must never preview a cost the
  // database will not write.
  const spread = units > 0 ? Math.floor(extras / units) : 0
  return { goods, units, extras, spread }
}
