// Sorting a ledger by any column, up or down (SPEC decision 147). Ties keep date order.
export type LedgerKey = 'date' | 'type' | 'desc' | 'account' | 'currency' | 'amount' | 'source' | 'unit';
// `then`: the sort before this one, kept for rows equal by this one (decision 157).
export interface LedgerSort { key: LedgerKey; desc: boolean; then?: { key: LedgerKey; desc: boolean } }
export type LedgerFields = { date: string; type: string; desc: string; account?: string; currency?: string; amount: number; source?: string; unit?: string };

export function sortLedger<T>(rows: T[], s: LedgerSort, f: (r: T) => LedgerFields): T[] {
  const he = (a = '', b = '') => a.localeCompare(b, 'he', { numeric: true });
  const by = (key: LedgerKey, x: LedgerFields, y: LedgerFields) => (key === 'amount' ? x.amount - y.amount : key === 'date' ? x.date.localeCompare(y.date) : he(x[key], y[key]));
  const dir = s.desc ? -1 : 1;
  return rows.map((r, i) => ({ r, i, v: f(r) })).sort((a, b) =>
    dir * by(s.key, a.v, b.v)
    || (s.then ? (s.then.desc ? -1 : 1) * by(s.then.key, a.v, b.v) : 0)
    || dir * a.v.date.localeCompare(b.v.date) || a.i - b.i).map((x) => x.r);
}

// A click on a column: the same column flips the direction; a new one starts up, except the
// date and the amount, which start with the newest / largest.
// The column sorted before stays as the second sort.
export const nextSort = (s: LedgerSort, key: LedgerKey): LedgerSort =>
  s.key === key ? { ...s, desc: !s.desc } : { key, desc: key === 'date' || key === 'amount', then: { key: s.key, desc: s.desc } };
