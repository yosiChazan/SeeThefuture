// Management statistics from the ledger (SPEC decision 96). Pure, tested.
//
// Only posted transactions count, and only their entries on accounts (the clients' and
// the managers' money); a transfer, a currency exchange, a deposit held or an opening
// balance is money moving, not income or expense. Sums stay per currency: money is never
// converted (CLAUDE.md), so every figure is shown in its own currency.

export type Flow = 'income' | 'expense';
const INCOME = new Set(['rent', 'hotel_share']);
const NOT_COUNTED = new Set(['transfer', 'fx', 'deposit', 'opening_balance', 'purchase_installment', 'deal_fee']);

export function flowOf(category: string): Flow | null {
  if (NOT_COUNTED.has(category)) return null;
  return INCOME.has(category) ? 'income' : 'expense';
}

export interface StatEntry { amount: number; currency: string; property_id: string | null; period: string; category: string }
export interface MonthRow { period: string; gross: number; expenses: number; net: number }
export interface CityRow { city: string; currency: string; units: number; earning: number; gross: number; expenses: number; net: number; months: number; perUnit: number }
export interface CategoryRow { category: string; amount: number }

const round = (n: number) => Math.round(n * 100) / 100;

// Per currency, per month: gross income, expenses (a positive number) and net.
export function monthly(entries: StatEntry[]): Map<string, MonthRow[]> {
  const out = new Map<string, Map<string, MonthRow>>();
  for (const e of entries) {
    const flow = flowOf(e.category);
    if (!flow) continue;
    const months = out.get(e.currency) ?? out.set(e.currency, new Map()).get(e.currency)!;
    const row = months.get(e.period) ?? months.set(e.period, { period: e.period, gross: 0, expenses: 0, net: 0 }).get(e.period)!;
    if (flow === 'income') row.gross += e.amount; else row.expenses -= e.amount;
    row.net += e.amount;
  }
  return new Map([...out].map(([cur, m]) => [cur, [...m.values()].sort((a, b) => a.period.localeCompare(b.period))
    .map((r) => ({ period: r.period, gross: round(r.gross), expenses: round(r.expenses), net: round(r.net) }))]));
}

// Per city and currency. "units": apartments in the city that are not sold; "earning":
// those with any income in the range. perUnit = gross ÷ earning units ÷ months with
// income in that city: what an apartment that earns brings in a month.
export function byCity(entries: StatEntry[], cityOf: Map<string, string>, unitsIn: Map<string, number>): CityRow[] {
  const acc = new Map<string, { city: string; currency: string; gross: number; expenses: number; earning: Set<string>; months: Set<string> }>();
  for (const e of entries) {
    const flow = flowOf(e.category);
    const city = e.property_id ? cityOf.get(e.property_id) : undefined;
    if (!flow || !city) continue;
    const k = `${city}|${e.currency}`;
    const a = acc.get(k) ?? acc.set(k, { city, currency: e.currency, gross: 0, expenses: 0, earning: new Set(), months: new Set() }).get(k)!;
    if (flow === 'income') { a.gross += e.amount; if (e.amount > 0) { a.earning.add(e.property_id!); a.months.add(e.period); } } else a.expenses -= e.amount;
  }
  return [...acc.values()].map((a) => ({
    city: a.city, currency: a.currency, units: unitsIn.get(a.city) ?? 0, earning: a.earning.size,
    gross: round(a.gross), expenses: round(a.expenses), net: round(a.gross - a.expenses), months: a.months.size,
    perUnit: a.earning.size && a.months.size ? round(a.gross / a.earning.size / a.months.size) : 0,
  })).sort((x, y) => x.currency.localeCompare(y.currency) || y.gross - x.gross);
}

// Expenses by category within one currency, largest first.
export function expensesByCategory(entries: StatEntry[], currency: string): CategoryRow[] {
  const m = new Map<string, number>();
  for (const e of entries) if (e.currency === currency && flowOf(e.category) === 'expense') m.set(e.category, (m.get(e.category) ?? 0) - e.amount);
  return [...m].map(([category, amount]) => ({ category, amount: round(amount) })).filter((r) => r.amount !== 0).sort((a, b) => b.amount - a.amount);
}
