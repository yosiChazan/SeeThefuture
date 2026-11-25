// Marking rows to add them up, as in Excel (SPEC decision 148). Pure, tested.

// A click on a row's box: on its own it flips that row; with Shift it sets every row between
// the last one clicked and this one (in the order shown) to this row's new state.
export function toggleRows(selected: Set<string>, order: string[], id: string, last: string | null, shift: boolean): Set<string> {
  const next = new Set(selected);
  const on = !selected.has(id);
  const a = last ? order.indexOf(last) : -1, b = order.indexOf(id);
  const ids = shift && a >= 0 && b >= 0 ? order.slice(Math.min(a, b), Math.max(a, b) + 1) : [id];
  for (const x of ids) { if (on) next.add(x); else next.delete(x); }
  return next;
}

// The total of the marked rows, per currency (amounts in different currencies are not added).
export function totalsByCurrency(rows: { amount: number; currency: string }[]): { currency: string; total: number; count: number }[] {
  const m = new Map<string, { total: number; count: number }>();
  for (const r of rows) {
    const t = m.get(r.currency) ?? { total: 0, count: 0 };
    t.total += Number(r.amount); t.count += 1;
    m.set(r.currency, t);
  }
  return [...m].map(([currency, t]) => ({ currency, total: Math.round(t.total * 100) / 100 + 0, count: t.count })).sort((a, b) => a.currency.localeCompare(b.currency));
}
