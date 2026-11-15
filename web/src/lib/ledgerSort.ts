// Sorting a ledger by any column, up or down (SPEC decision 147). Ties keep date order.
export type LedgerKey = 'date' | 'type' | 'desc' | 'account' | 'currency' | 'amount' | 'source';
export interface LedgerSort { key: LedgerKey; desc: boolean }
export type LedgerFields = { date: string; type: string; desc: string; account?: string; currency?: string; amount: number; source?: string };

export function sortLedger<T>(rows: T[], s: LedgerSort, f: (r: T) => LedgerFields): T[] {
  const dir = s.desc ? -1 : 1;
  const he = (a = '', b = '') => a.localeCompare(b, 'he', { numeric: true });
  return rows.map((r, i) => ({ r, i, v: f(r) })).sort((a, b) => {
    const k = s.key === 'amount' ? a.v.amount - b.v.amount : s.key === 'date' ? a.v.date.localeCompare(b.v.date) : he(a.v[s.key], b.v[s.key]);
    return dir * k || dir * a.v.date.localeCompare(b.v.date) || a.i - b.i;
  }).map((x) => x.r);
}

// A click on a column: the same column flips the direction; a new one starts up, except the
// date and the amount, which start with the newest / largest.
export const nextSort = (s: LedgerSort, key: LedgerKey): LedgerSort =>
  s.key === key ? { key, desc: !s.desc } : { key, desc: key === 'date' || key === 'amount' };
